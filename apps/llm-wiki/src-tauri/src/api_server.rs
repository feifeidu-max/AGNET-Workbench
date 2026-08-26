use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::fs;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU8, AtomicUsize, Ordering};
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use tauri::{AppHandle, Emitter, Manager};
use tiny_http::{Header, Method, Response, Server, StatusCode};
use uuid::Uuid;
use walkdir::WalkDir;

use crate::cors::{local_cors_headers, request_origin};
use crate::{agent, clip_server, commands, server_bind};

const PORT: u16 = 19828;
const API_PREFIX: &str = "/api/v1";
const MAX_BODY_BYTES: usize = 1024 * 1024;
const MAX_CHAT_BODY_BYTES: usize = 40 * 1024 * 1024;
const MAX_PDF_BODY_BYTES: usize = crate::ingest_gate::MAX_PDF_BYTES;
const MAX_FILE_CONTENT_BYTES: u64 = 2 * 1024 * 1024;
const MAX_FILE_EDIT_BODY_BYTES: usize = MAX_FILE_CONTENT_BYTES as usize + 128 * 1024;
const DEFAULT_MAX_FILES: usize = 2_000;
const HARD_MAX_FILES: usize = 10_000;
const DEFAULT_MAX_REVIEWS: usize = 200;
const HARD_MAX_REVIEWS: usize = 1_000;
const MAX_SEARCH_RESULTS: usize = 50;
const BIND_RETRY_DELAY_SECS: u64 = 2;
const MAX_BIND_RETRIES: u32 = 3;
const APP_STATE_CACHE_TTL: Duration = Duration::from_secs(5);
const RATE_LIMIT_WINDOW: Duration = Duration::from_secs(1);
const RATE_LIMIT_MAX_REQUESTS: usize = 120;
const MAX_IN_FLIGHT_REQUESTS: usize = 64;

/// API status: 0=starting, 1=running, 2=port_conflict, 3=error
static API_STATUS: AtomicU8 = AtomicU8::new(0);
static IN_FLIGHT_REQUESTS: AtomicUsize = AtomicUsize::new(0);
static APP_STATE_CACHE: OnceLock<Mutex<Option<CachedAppState>>> = OnceLock::new();
static RATE_LIMIT: OnceLock<Mutex<VecDeque<Instant>>> = OnceLock::new();

#[derive(Clone)]
struct CachedAppState {
    loaded_at: Instant,
    value: Option<Value>,
}

pub fn get_api_status() -> &'static str {
    match API_STATUS.load(Ordering::Relaxed) {
        0 => "starting",
        1 => "running",
        2 => "port_conflict",
        _ => "error",
    }
}

pub fn invalidate_config_cache() {
    if let Some(lock) = APP_STATE_CACHE.get() {
        if let Ok(mut cache) = lock.lock() {
            *cache = None;
        }
    }
}

pub fn start_api_server(app: AppHandle) {
    thread::spawn(move || loop {
        API_STATUS.store(0, Ordering::Relaxed);
        let (server, addr) = match bind_server_with_retry(&app) {
            Some(bound) => bound,
            None => {
                API_STATUS.store(2, Ordering::Relaxed);
                thread::sleep(Duration::from_secs(BIND_RETRY_DELAY_SECS));
                continue;
            }
        };

        API_STATUS.store(1, Ordering::Relaxed);
        eprintln!("[API Server] Listening on http://{addr}{API_PREFIX}");
        // A headless restart can leave generated proposals staged as
        // `uploaded`; kick the strict-ingest worker so the review queue does
        // not depend on a later upload request.
        crate::ingest_gate::resume_queued_drafts(clip_server::current_project_path());

        for request in server.incoming_requests() {
            let method = request.method().clone();
            let url = request.url().to_string();
            let origin = request_origin(&request);
            if should_rate_limit(&method, &url) && !allow_request() {
                respond_error(request, 429, "Too many requests", origin.as_deref());
                continue;
            }
            let Some(slot) = try_acquire_request_slot() else {
                respond_error(request, 503, "API server is busy", origin.as_deref());
                continue;
            };
            let app = app.clone();
            thread::spawn(move || {
                let _slot = slot;
                let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    process_request(app, request);
                }));
                if let Err(payload) = result {
                    eprintln!("[API Server] request handler panicked: {payload:?}");
                }
            });
        }

        API_STATUS.store(3, Ordering::Relaxed);
        eprintln!("[API Server] server loop exited; restarting");
        thread::sleep(Duration::from_secs(BIND_RETRY_DELAY_SECS));
    });
}

fn bind_server_with_retry(app: &AppHandle) -> Option<(Server, String)> {
    let host = server_bind::configured_bind_host(app);
    let addr = server_bind::bind_addr(&host, PORT);
    for attempt in 1..=MAX_BIND_RETRIES {
        match Server::http(&addr) {
            Ok(server) => return Some((server, addr)),
            Err(err) => {
                eprintln!(
                    "[API Server] Failed to bind {addr} (attempt {attempt}/{MAX_BIND_RETRIES}): {err}"
                );
                if attempt < MAX_BIND_RETRIES {
                    thread::sleep(Duration::from_secs(BIND_RETRY_DELAY_SECS));
                }
            }
        }
    }
    None
}

struct RequestSlot;

impl Drop for RequestSlot {
    fn drop(&mut self) {
        IN_FLIGHT_REQUESTS.fetch_sub(1, Ordering::Relaxed);
    }
}

fn try_acquire_request_slot() -> Option<RequestSlot> {
    let mut current = IN_FLIGHT_REQUESTS.load(Ordering::Relaxed);
    loop {
        if current >= MAX_IN_FLIGHT_REQUESTS {
            return None;
        }
        match IN_FLIGHT_REQUESTS.compare_exchange_weak(
            current,
            current + 1,
            Ordering::Relaxed,
            Ordering::Relaxed,
        ) {
            Ok(_) => return Some(RequestSlot),
            Err(next) => current = next,
        }
    }
}

fn process_request(app: AppHandle, mut request: tiny_http::Request) {
    let method = request.method().clone();
    let url = request.url().to_string();
    let origin = request_origin(&request);
    if method == Method::Options {
        respond_options(request, origin.as_deref());
        return;
    }

    let headers: Vec<(String, String)> = request
        .headers()
        .iter()
        .map(|header| {
            (
                header.field.as_str().to_ascii_lowercase().to_string(),
                header.value.as_str().to_string(),
            )
        })
        .collect();

    if is_pdf_download_request(&method, &url) {
        process_pdf_download(app, request, &url, &headers, origin.as_deref());
        return;
    }

    let body = match read_body_bytes(&mut request, body_limit_for_request(&method, &url)) {
        Ok(body) => body,
        Err(err) => {
            respond_error(request, 400, &err, origin.as_deref());
            return;
        }
    };

    let response = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        handle_request(&app, &method, &url, &body, &headers)
    }))
    .unwrap_or_else(|payload| {
        eprintln!("[API Server] request panicked: {payload:?}");
        err(500, "Internal API server error")
    });
    respond_json(request, response.status, response.body, origin.as_deref());
}

struct ApiResponse {
    status: u16,
    body: Value,
}

fn ok(body: Value) -> ApiResponse {
    ApiResponse { status: 200, body }
}

fn err(status: u16, message: impl Into<String>) -> ApiResponse {
    ApiResponse {
        status,
        body: json!({ "ok": false, "error": message.into() }),
    }
}

fn handle_request(
    app: &AppHandle,
    method: &Method,
    url: &str,
    body: &[u8],
    headers: &[(String, String)],
) -> ApiResponse {
    let (path, query) = split_url(url);
    if path == "/health" || path == format!("{API_PREFIX}/health") {
        let runtime_config = load_agent_runtime_config(app);
        let llm_configured = runtime_config
            .llm
            .as_ref()
            .is_some_and(agent::provider::LlmConfig::is_usable_for_backend_http);
        // /health stays reachable even when the user has disabled the
        // API in Settings — the desktop UI uses it to render the
        // "Enabled / disabled / port_conflict" line, and curl-from-
        // terminal users need a way to confirm the server is alive
        // before they go hunting for why other endpoints 503.
        return ok(json!({
            "ok": true,
            "status": get_api_status(),
            "version": env!("CARGO_PKG_VERSION"),
            "authRequired": api_auth_required(app),
            "authConfigured": api_token(app).is_some(),
            "tokenSource": api_token_source(app),
            "enabled": api_enabled(app),
            "studioManaged": crate::studio_managed_headless(),
            "mcpEnabled": api_mcp_enabled(app),
            "allowUnauthenticated": api_allow_unauthenticated(app),
            "allowLanAccess": api_allow_lan_access(app),
            "llmConfigured": llm_configured,
            "llmConfigSource": llm_config_source(app),
            "retrievalMode": if commands::search::keyword_only_mode() {
                "keyword_graph"
            } else {
                "default"
            },
            "agent": {
                "chat": true,
                "streaming": false,
            },
            "clipServerStatus": clip_server::get_daemon_status().to_string(),
        }));
    }
    if !path.starts_with(API_PREFIX) {
        return err(404, "Not found");
    }
    if !api_enabled(app) {
        // Kill-switch path: token may be configured and valid, but the
        // user toggled the API off in Settings → API Server. 503 is
        // the right code semantically ("temporarily unavailable")
        // and tells well-behaved clients to back off rather than
        // retry instantly the way 401 would.
        return err(503, "API server is disabled in Settings → API Server");
    }
    if is_agent_chat_request(&method, &path) && !is_token_authorized(app, query, headers) {
        return err(401, "Unauthorized");
    }
    if !is_authorized(app, query, headers) {
        return err(401, "Unauthorized");
    }
    if !matches!(method, &Method::Get | &Method::Post | &Method::Patch) {
        return err(405, "Method not allowed");
    }

    let parts: Vec<&str> = path
        .trim_start_matches(API_PREFIX)
        .trim_start_matches('/')
        .split('/')
        .filter(|part| !part.is_empty())
        .collect();
    let body_text = std::str::from_utf8(body).unwrap_or("");

    match (method, parts.as_slice()) {
        (&Method::Get, ["projects"]) => handle_projects(app),
        (&Method::Post, ["projects"]) => handle_create_managed_project(app, body_text),
        (&Method::Post, ["projects", "current", "select"]) => {
            handle_select_current_project(app, body_text)
        }
        (&Method::Get, ["projects", project_id, "files"]) => handle_files(app, project_id, query),
        (&Method::Get, ["projects", project_id, "files", "content"]) => {
            handle_file_content(app, project_id, query)
        }
        (&Method::Get, ["projects", project_id, "files", "history"]) => {
            handle_file_history(app, project_id, query)
        }
        (&Method::Get, ["projects", project_id, "files", "links"]) => {
            handle_page_links(app, project_id, query)
        }
        (&Method::Post, ["projects", project_id, "files", "write"]) => {
            handle_write_file(app, project_id, body_text)
        }
        (&Method::Post, ["projects", project_id, "files", "create-missing"]) => {
            handle_create_missing_page(app, project_id, body_text)
        }
        (&Method::Post, ["projects", project_id, "files", "restore"]) => {
            handle_restore_file_history(app, project_id, body_text)
        }
        (&Method::Post, ["projects", project_id, "files", "delete"]) => {
            handle_delete_file(app, project_id, body_text)
        }
        (&Method::Get, ["projects", project_id, "reviews"]) => {
            handle_reviews(app, project_id, query)
        }
        (&Method::Post, ["projects", project_id, "reviews", "resolve"]) => {
            handle_bulk_resolve_reviews(app, project_id, body_text)
        }
        (&Method::Patch, ["projects", project_id, "reviews", review_id]) => {
            handle_patch_review(app, project_id, review_id, body_text)
        }
        (&Method::Post, ["projects", project_id, "search"]) => {
            handle_search(app, project_id, body_text)
        }
        (&Method::Get, ["projects", project_id, "graph"]) => handle_graph(app, project_id, query),
        (&Method::Post, ["projects", project_id, "enrich"]) => {
            handle_enrich_start(app, project_id, body_text)
        }
        (&Method::Post, ["projects", project_id, "enrich", "cancel"]) => {
            handle_enrich_cancel(app, project_id)
        }
        (&Method::Get, ["projects", project_id, "enrich"]) => handle_enrich_info(app, project_id),
        (&Method::Get, ["projects", project_id, "enrich", "status"]) => {
            handle_enrich_status(app, project_id)
        }
        (&Method::Post, ["projects", project_id, "sources", "rescan"]) => {
            handle_rescan(app, project_id)
        }
        (&Method::Get, ["projects", project_id, "sources"]) => handle_sources(app, project_id),
        (&Method::Get, ["projects", project_id, "skills"]) => handle_skills(app, project_id),
        (&Method::Get, ["projects", project_id, "settings"]) => handle_settings(app, project_id),
        (&Method::Get, ["projects", project_id, "lint"]) => handle_lint(app, project_id),
        (&Method::Post, ["projects", project_id, "maintenance", "rebuild-index"]) => {
            handle_rebuild_index(app, project_id)
        }
        (&Method::Get, ["projects", project_id, "chat", "sessions"]) => {
            handle_chat_sessions(app, project_id)
        }
        (&Method::Get, ["projects", project_id, "chat", "sessions", session_id]) => {
            handle_chat_session(app, project_id, session_id)
        }
        (&Method::Post, ["projects", project_id, "chat"]) => {
            handle_chat(app, project_id, body_text)
        }
        (&Method::Post, ["projects", project_id, "chat", session_id, "cancel"]) => {
            handle_cancel_chat(app, project_id, session_id)
        }
        (&Method::Get, ["projects", project_id, "ingest-drafts"]) => {
            handle_ingest_drafts(app, project_id)
        }
        (&Method::Post, ["projects", project_id, "ingest-drafts"]) => {
            handle_create_ingest_draft(app, project_id, body, headers)
        }
        (&Method::Post, ["projects", project_id, "generated-drafts"]) => {
            handle_create_generated_draft(app, project_id, body_text)
        }
        (&Method::Get, ["projects", project_id, "ingest-drafts", draft_id]) => {
            handle_ingest_draft_detail(app, project_id, draft_id)
        }
        (&Method::Post, ["projects", project_id, "ingest-drafts", draft_id, "approve"]) => {
            handle_approve_ingest_draft(app, project_id, draft_id)
        }
        (&Method::Post, ["projects", project_id, "ingest-drafts", draft_id, "revise"]) => {
            handle_revise_ingest_draft(app, project_id, draft_id, body_text)
        }
        (&Method::Post, ["projects", project_id, "ingest-drafts", draft_id, "reject"]) => {
            handle_reject_ingest_draft(app, project_id, draft_id, body_text)
        }
        (&Method::Get, ["projects", project_id, "reading-candidates"]) => {
            handle_reading_candidates(app, project_id, query)
        }
        (&Method::Post, ["projects", project_id, "reading-candidates", "search"]) => {
            handle_search_reading_candidates(app, project_id, body_text)
        }
        (
            &Method::Post,
            ["projects", project_id, "reading-candidates", candidate_id, "dismiss"],
        ) => handle_dismiss_reading_candidate(app, project_id, candidate_id),
        _ => err(404, "Not found"),
    }
}

fn should_rate_limit(method: &Method, url: &str) -> bool {
    if method == &Method::Options {
        return false;
    }
    let (path, _) = split_url(url);
    !(path == "/health" || path == format!("{API_PREFIX}/health"))
}

fn allow_request() -> bool {
    let now = Instant::now();
    let window_start = now - RATE_LIMIT_WINDOW;
    let lock = RATE_LIMIT.get_or_init(|| Mutex::new(VecDeque::new()));
    let Ok(mut hits) = lock.lock() else {
        return false;
    };
    while hits.front().map(|t| *t < window_start).unwrap_or(false) {
        hits.pop_front();
    }
    if hits.len() >= RATE_LIMIT_MAX_REQUESTS {
        return false;
    }
    hits.push_back(now);
    true
}

fn is_agent_chat_request(method: &Method, path: &str) -> bool {
    let parts = path
        .trim_start_matches(API_PREFIX)
        .trim_start_matches('/')
        .split('/')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>();
    method == &Method::Post
        && matches!(
            parts.as_slice(),
            ["projects", _, "chat"] | ["projects", _, "chat", _, "cancel"]
        )
}

fn body_limit_for_request(method: &Method, url: &str) -> usize {
    let (path, _) = split_url(url);
    let parts = path
        .trim_start_matches(API_PREFIX)
        .trim_start_matches('/')
        .split('/')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>();
    if method == &Method::Post && matches!(parts.as_slice(), ["projects", _, "chat"]) {
        MAX_CHAT_BODY_BYTES
    } else if method == &Method::Post
        && matches!(parts.as_slice(), ["projects", _, "ingest-drafts"])
    {
        MAX_PDF_BODY_BYTES
    } else if method == &Method::Post
        && matches!(
            parts.as_slice(),
            ["projects", _, "files", "write"]
                | ["projects", _, "files", "create-missing"]
                | ["projects", _, "generated-drafts"]
        )
    {
        MAX_FILE_EDIT_BODY_BYTES
    } else {
        MAX_BODY_BYTES
    }
}

fn read_body_bytes(
    request: &mut tiny_http::Request,
    max_body_bytes: usize,
) -> Result<Vec<u8>, String> {
    let mut limited = request.as_reader().take(max_body_bytes as u64 + 1);
    let mut bytes = Vec::new();
    limited
        .read_to_end(&mut bytes)
        .map_err(|e| format!("Failed to read body: {e}"))?;
    if bytes.len() > max_body_bytes {
        return Err("Request body too large".to_string());
    }
    Ok(bytes)
}

fn is_pdf_download_request(method: &Method, url: &str) -> bool {
    if method != &Method::Get {
        return false;
    }
    let (path, _) = split_url(url);
    let parts = path
        .trim_start_matches(API_PREFIX)
        .trim_start_matches('/')
        .split('/')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>();
    matches!(parts.as_slice(), ["projects", _, "sources", _, "pdf"])
}

fn process_pdf_download(
    app: AppHandle,
    request: tiny_http::Request,
    url: &str,
    headers: &[(String, String)],
    origin: Option<&str>,
) {
    let (path, query) = split_url(url);
    if !api_enabled(&app) {
        respond_error(request, 503, "API server is disabled", origin);
        return;
    }
    if !is_authorized(&app, query, headers) {
        respond_error(request, 401, "Unauthorized", origin);
        return;
    }
    let parts = path
        .trim_start_matches(API_PREFIX)
        .trim_start_matches('/')
        .split('/')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>();
    let ["projects", project_id, "sources", source_id, "pdf"] = parts.as_slice() else {
        respond_error(request, 404, "Not found", origin);
        return;
    };
    let project = match resolve_project(&app, project_id) {
        Ok(project) => project,
        Err(error) => {
            respond_error(request, 404, &error, origin);
            return;
        }
    };
    let (pdf_path, filename) =
        match crate::ingest_gate::trusted_source_pdf(&project.path, &percent_decode(source_id)) {
            Ok(source) => source,
            Err(error) => {
                respond_error(request, error.status, &error.message, origin);
                return;
            }
        };
    let total = match fs::metadata(&pdf_path) {
        Ok(metadata) => metadata.len(),
        Err(error) => {
            respond_error(
                request,
                404,
                &format!("PDF file is missing: {error}"),
                origin,
            );
            return;
        }
    };
    if total == 0 {
        respond_error(request, 404, "PDF file is empty", origin);
        return;
    }
    let requested_range = request_header(headers, "range");
    let range = match parse_byte_range(requested_range, total) {
        Ok(range) => range,
        Err(message) => {
            let mut response =
                Response::from_string(json!({ "ok": false, "error": message }).to_string())
                    .with_status_code(StatusCode(416));
            response.add_header(
                Header::from_bytes("Content-Range", format!("bytes */{total}")).unwrap(),
            );
            response.add_header(
                Header::from_bytes("Content-Type", "application/json; charset=utf-8").unwrap(),
            );
            for header in cors_headers(origin) {
                response.add_header(header);
            }
            let _ = request.respond(response);
            return;
        }
    };
    let (start, end) = range.unwrap_or((0, total - 1));
    let length = end - start + 1;
    let mut file = match fs::File::open(&pdf_path) {
        Ok(file) => file,
        Err(error) => {
            respond_error(
                request,
                404,
                &format!("PDF file cannot be opened: {error}"),
                origin,
            );
            return;
        }
    };
    if let Err(error) = file.seek(SeekFrom::Start(start)) {
        respond_error(
            request,
            500,
            &format!("PDF range seek failed: {error}"),
            origin,
        );
        return;
    }
    let mut data = Vec::with_capacity(length.min(8 * 1024 * 1024) as usize);
    if let Err(error) = file.take(length).read_to_end(&mut data) {
        respond_error(
            request,
            500,
            &format!("PDF range read failed: {error}"),
            origin,
        );
        return;
    }

    let status = if range.is_some() { 206 } else { 200 };
    let mut response = Response::from_data(data).with_status_code(StatusCode(status));
    response.add_header(Header::from_bytes("Content-Type", "application/pdf").unwrap());
    response.add_header(Header::from_bytes("Accept-Ranges", "bytes").unwrap());
    response.add_header(Header::from_bytes("Content-Length", length.to_string()).unwrap());
    response.add_header(Header::from_bytes("Cache-Control", "private, no-store").unwrap());
    let ascii_filename = filename
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '.' | '-' | '_' | ' ') {
                character
            } else {
                '_'
            }
        })
        .collect::<String>();
    response.add_header(
        Header::from_bytes(
            "Content-Disposition",
            format!("inline; filename=\"{ascii_filename}\""),
        )
        .unwrap(),
    );
    if range.is_some() {
        response.add_header(
            Header::from_bytes("Content-Range", format!("bytes {start}-{end}/{total}")).unwrap(),
        );
    }
    let page = parse_query(query)
        .get("page")
        .and_then(|value| value.parse::<usize>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(1);
    response.add_header(Header::from_bytes("X-PDF-Page", page.to_string()).unwrap());
    response.add_header(
        Header::from_bytes(
            "Access-Control-Expose-Headers",
            "Accept-Ranges, Content-Length, Content-Range, Content-Disposition, X-PDF-Page",
        )
        .unwrap(),
    );
    for header in cors_headers(origin) {
        if !header.field.equiv("Content-Type") {
            response.add_header(header);
        }
    }
    let _ = request.respond(response);
}

fn parse_byte_range(value: Option<&str>, total: u64) -> Result<Option<(u64, u64)>, String> {
    let Some(value) = value else {
        return Ok(None);
    };
    let raw = value
        .strip_prefix("bytes=")
        .ok_or_else(|| "Only byte ranges are supported".to_string())?;
    if raw.contains(',') {
        return Err("Multiple ranges are not supported".to_string());
    }
    let (start_raw, end_raw) = raw
        .split_once('-')
        .ok_or_else(|| "Invalid byte range".to_string())?;
    if start_raw.is_empty() {
        let suffix = end_raw
            .parse::<u64>()
            .map_err(|_| "Invalid suffix byte range".to_string())?;
        if suffix == 0 {
            return Err("Invalid suffix byte range".to_string());
        }
        let start = total.saturating_sub(suffix.min(total));
        return Ok(Some((start, total - 1)));
    }
    let start = start_raw
        .parse::<u64>()
        .map_err(|_| "Invalid byte range start".to_string())?;
    if start >= total {
        return Err("Byte range starts after the end of the file".to_string());
    }
    let end = if end_raw.is_empty() {
        total - 1
    } else {
        end_raw
            .parse::<u64>()
            .map_err(|_| "Invalid byte range end".to_string())?
            .min(total - 1)
    };
    if end < start {
        return Err("Byte range end precedes its start".to_string());
    }
    Ok(Some((start, end)))
}

fn respond_error(request: tiny_http::Request, status: u16, message: &str, origin: Option<&str>) {
    respond_json(
        request,
        status,
        json!({ "ok": false, "error": message }),
        origin,
    );
}

fn respond_options(request: tiny_http::Request, origin: Option<&str>) {
    let mut response = Response::empty(StatusCode(204));
    for header in cors_headers(origin) {
        response.add_header(header);
    }
    response.add_header(Header::from_bytes("Access-Control-Max-Age", "600").unwrap());
    let _ = request.respond(response);
}

fn respond_json(request: tiny_http::Request, status: u16, body: Value, origin: Option<&str>) {
    let mut response = Response::from_string(body.to_string()).with_status_code(StatusCode(status));
    response
        .add_header(Header::from_bytes("Content-Type", "application/json; charset=utf-8").unwrap());
    for header in cors_headers(origin) {
        if !header.field.equiv("Content-Type") {
            response.add_header(header);
        }
    }
    let _ = request.respond(response);
}

fn cors_headers(origin: Option<&str>) -> Vec<Header> {
    local_cors_headers(
        origin,
        "Content-Type, Authorization, X-LLM-Wiki-Token, X-Filename, Range",
    )
}

fn split_url(url: &str) -> (String, &str) {
    match url.split_once('?') {
        Some((path, query)) => (path.to_string(), query),
        None => (url.to_string(), ""),
    }
}

fn parse_query(query: &str) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    for pair in query.split('&').filter(|s| !s.is_empty()) {
        let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
        out.insert(percent_decode(k), percent_decode(v));
    }
    out
}

fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(v) = u8::from_str_radix(&input[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(if bytes[i] == b'+' { b' ' } else { bytes[i] });
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn is_authorized(app: &AppHandle, query: &str, headers: &[(String, String)]) -> bool {
    if !api_auth_required(app) {
        return true;
    }
    is_token_authorized(app, query, headers)
}

fn is_token_authorized(app: &AppHandle, query: &str, headers: &[(String, String)]) -> bool {
    let Some(token) = api_token(app) else {
        return false;
    };
    let params = parse_query(query);
    if params
        .get("token")
        .map(|v| constant_time_eq(v.as_bytes(), token.as_bytes()))
        .unwrap_or(false)
    {
        return true;
    }
    headers.iter().any(|(key, value)| {
        if key == "x-llm-wiki-token" {
            return constant_time_eq(value.as_bytes(), token.as_bytes());
        }
        if key == "authorization" {
            return value
                .strip_prefix("Bearer ")
                .map(|v| constant_time_eq(v.as_bytes(), token.as_bytes()))
                .unwrap_or(false);
        }
        false
    })
}

fn api_token(app: &AppHandle) -> Option<String> {
    if let Ok(token) = std::env::var("LLM_WIKI_API_TOKEN") {
        let trimmed = token.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.to_string());
        }
    }
    let parsed = load_app_state(app)?;
    parsed
        .get("apiConfig")
        .and_then(|v| v.get("token"))
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(ToOwned::to_owned)
}

fn api_token_source(app: &AppHandle) -> &'static str {
    if let Ok(token) = std::env::var("LLM_WIKI_API_TOKEN") {
        if !token.trim().is_empty() {
            return "env";
        }
    }
    if load_app_state(app)
        .and_then(|parsed| {
            parsed
                .get("apiConfig")
                .and_then(|v| v.get("token"))
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .map(|_| ())
        })
        .is_some()
    {
        return "store";
    }
    "none"
}

fn api_auth_required(app: &AppHandle) -> bool {
    !api_allow_unauthenticated(app)
}

fn api_allow_unauthenticated(app: &AppHandle) -> bool {
    if crate::studio_managed_headless() {
        return false;
    }
    let Some(parsed) = load_app_state(app) else {
        return false;
    };
    parsed
        .get("apiConfig")
        .and_then(|v| v.get("allowUnauthenticated"))
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

fn api_allow_lan_access(app: &AppHandle) -> bool {
    if crate::studio_managed_headless() {
        return false;
    }
    let Some(parsed) = load_app_state(app) else {
        return false;
    };
    parsed
        .get("apiConfig")
        .and_then(|v| v.get("allowLanAccess"))
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

/// Whether the API server should accept non-/health requests.
///
/// Defaults to `true` when no config has been written yet — keeps
/// existing setups (env-token-only, hand-edited app-state.json) working
/// after the kill-switch was introduced. New users still land in
/// "enabled + no token = 401" which is fail-closed by virtue of the
/// missing token, not the enable flag.
fn api_enabled(app: &AppHandle) -> bool {
    if crate::studio_managed_headless() {
        return true;
    }
    let Some(parsed) = load_app_state(app) else {
        return true;
    };
    parsed
        .get("apiConfig")
        .and_then(|v| v.get("enabled"))
        .and_then(Value::as_bool)
        .unwrap_or(true)
}

fn api_mcp_enabled(app: &AppHandle) -> bool {
    let Some(parsed) = load_app_state(app) else {
        return false;
    };
    parsed
        .get("apiConfig")
        .and_then(|v| v.get("mcpEnabled"))
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    let max_len = left.len().max(right.len());
    let mut diff = left.len() ^ right.len();
    for i in 0..max_len {
        let a = left.get(i).copied().unwrap_or(0);
        let b = right.get(i).copied().unwrap_or(0);
        diff |= (a ^ b) as usize;
    }
    diff == 0
}

fn load_app_state(app: &AppHandle) -> Option<Value> {
    let now = Instant::now();
    let lock = APP_STATE_CACHE.get_or_init(|| Mutex::new(None));
    let mut previous = None;
    if let Ok(cache) = lock.lock() {
        if let Some(cached) = cache.as_ref() {
            if now.duration_since(cached.loaded_at) < APP_STATE_CACHE_TTL {
                return cached.value.clone();
            }
            previous = cached.value.clone();
        }
    }

    let path = app.path().app_data_dir().ok()?.join("app-state.json");
    let loaded = fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok());
    let value = loaded.or(previous);

    if let Ok(mut cache) = lock.lock() {
        *cache = Some(CachedAppState {
            loaded_at: now,
            value: value.clone(),
        });
    }
    value
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ProjectEntry {
    id: String,
    name: String,
    path: String,
    current: bool,
}

fn handle_projects(app: &AppHandle) -> ApiResponse {
    let projects = load_projects(app);
    let current_project = projects.iter().find(|project| project.current).cloned();
    ok(json!({
        "ok": true,
        "projects": projects,
        "currentProject": current_project,
    }))
}

fn handle_select_current_project(app: &AppHandle, body: &str) -> ApiResponse {
    let payload: Value = match serde_json::from_str(body) {
        Ok(payload) => payload,
        Err(_) => return err(400, "Invalid JSON"),
    };
    let project_id = payload
        .get("projectId")
        .or_else(|| payload.get("id"))
        .or_else(|| payload.get("path"))
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("");
    if project_id.is_empty() {
        return err(400, "projectId is required");
    }

    let mut project = match resolve_project(app, project_id) {
        Ok(project) => project,
        Err(error) => return err(404, &error),
    };
    if let Err(error) = clip_server::set_current_project(&project.path) {
        return err(500, &error);
    }
    crate::ingest_gate::resume_queued_drafts(project.path.clone());
    project.current = true;
    ok(json!({ "ok": true, "project": project }))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateManagedProjectRequest {
    name: String,
}

/// Studio may create projects, but never opens an arbitrary browser-supplied
/// filesystem path. Keeping new projects under the application's managed data
/// directory is both predictable for backup and keeps the local API from
/// becoming a generic file creation surface.
fn handle_create_managed_project(app: &AppHandle, body: &str) -> ApiResponse {
    let request: CreateManagedProjectRequest = match serde_json::from_str(body) {
        Ok(request) => request,
        Err(error) => return err(400, format!("Invalid project request: {error}")),
    };
    let name = match safe_managed_project_name(&request.name) {
        Ok(name) => name,
        Err(error) => return err(400, error),
    };
    let base = match managed_projects_dir(app) {
        Ok(path) => path,
        Err(error) => return err(500, error),
    };
    if let Err(error) = fs::create_dir_all(&base) {
        return err(
            500,
            format!("Failed to create managed project directory: {error}"),
        );
    }
    let project = match commands::project::create_project_impl(
        name.clone(),
        base.to_string_lossy().into_owned(),
    ) {
        Ok(project) => project,
        Err(error) => return err(409, error),
    };
    let project_path = normalize_path(&project.path);
    let project_id = Uuid::new_v4().to_string();
    let project_state_dir = Path::new(&project_path).join(".llm-wiki");
    if let Err(error) = fs::create_dir_all(&project_state_dir) {
        return err(500, format!("Failed to initialize project state: {error}"));
    }
    if let Err(error) = write_atomic_file(
        &project_state_dir.join("project.json"),
        serde_json::to_vec_pretty(&json!({ "id": project_id, "createdAt": now_ms() }))
            .unwrap_or_default()
            .as_slice(),
    ) {
        return err(500, format!("Failed to write project identity: {error}"));
    }
    if let Err(error) = clip_server::set_current_project(&project_path) {
        return err(500, error);
    }

    let mut state = load_app_state(app).unwrap_or_else(|| json!({}));
    if !state.is_object() {
        state = json!({});
    }
    let state_object = state.as_object_mut().expect("object checked above");
    let registry = state_object
        .entry("projectRegistry".to_string())
        .or_insert_with(|| json!({}));
    if !registry.is_object() {
        *registry = json!({});
    }
    registry
        .as_object_mut()
        .expect("object initialized")
        .insert(
            project_id.clone(),
            json!({
                "id": project_id,
                "name": name,
                "path": project_path,
                "lastOpened": now_ms(),
            }),
        );
    state_object.insert(
        "lastProject".to_string(),
        json!({ "name": project.name, "path": project.path }),
    );
    let recent = state_object
        .entry("recentProjects".to_string())
        .or_insert_with(|| json!([]));
    if !recent.is_array() {
        *recent = json!([]);
    }
    let recents = recent.as_array_mut().expect("array initialized");
    recents.retain(|entry| {
        entry
            .get("path")
            .and_then(Value::as_str)
            .map(|path| !project_path_matches(path, &project_path))
            .unwrap_or(false)
    });
    recents.insert(0, json!({ "name": project.name, "path": project.path }));
    recents.truncate(10);
    if let Err(error) = write_app_state(app, &state) {
        return err(500, error);
    }
    invalidate_config_cache();
    ok(json!({
        "ok": true,
        "project": { "id": project_id, "name": project.name, "current": true },
    }))
}

fn managed_projects_dir(app: &AppHandle) -> Result<PathBuf, String> {
    if let Some(configured) = std::env::var("LLM_WIKI_MANAGED_PROJECTS_DIR")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
    {
        let path = PathBuf::from(configured);
        if !path.is_absolute() {
            return Err("LLM_WIKI_MANAGED_PROJECTS_DIR must be an absolute path".to_string());
        }
        return Ok(path);
    }
    app.path()
        .app_data_dir()
        .map(|path| path.join("studio-projects"))
        .map_err(|error| format!("Failed to resolve managed project directory: {error}"))
}

fn safe_managed_project_name(raw: &str) -> Result<String, String> {
    let name = raw.trim();
    if name.is_empty() || name.chars().count() > 80 {
        return Err("Project name must contain 1 to 80 characters".to_string());
    }
    if name.starts_with('.') || name.ends_with('.') || name.ends_with(' ') {
        return Err("Project name cannot begin or end with a dot or space".to_string());
    }
    if name.chars().any(|character| {
        character.is_control()
            || matches!(
                character,
                '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*'
            )
    }) {
        return Err("Project name contains unsupported filename characters".to_string());
    }
    let device = name
        .split('.')
        .next()
        .unwrap_or_default()
        .to_ascii_uppercase();
    if matches!(device.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (device.len() == 4
            && (device.starts_with("COM") || device.starts_with("LPT"))
            && device.as_bytes()[3].is_ascii_digit()
            && device.as_bytes()[3] != b'0')
    {
        return Err("Project name is reserved by Windows".to_string());
    }
    Ok(name.to_string())
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0)
}

fn write_app_state(app: &AppHandle, value: &Value) -> Result<(), String> {
    let path = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Failed to resolve app state directory: {error}"))?
        .join("app-state.json");
    let bytes = serde_json::to_vec_pretty(value)
        .map_err(|error| format!("Failed to serialize app state: {error}"))?;
    write_atomic_file(&path, &bytes)
}

fn load_projects(app: &AppHandle) -> Vec<ProjectEntry> {
    let current = normalize_path(&clip_server::current_project_path());
    let mut by_path: BTreeMap<String, ProjectEntry> = BTreeMap::new();

    if let Some(parsed) = load_app_state(app) {
        if let Some(registry) = parsed.get("projectRegistry").and_then(Value::as_object) {
            for (id, value) in registry {
                let path = value.get("path").and_then(Value::as_str).unwrap_or("");
                if path.is_empty() {
                    continue;
                }
                let path = normalize_path(path);
                let name = value
                    .get("name")
                    .and_then(Value::as_str)
                    .map(ToOwned::to_owned)
                    .unwrap_or_else(|| project_name_from_path(&path));
                by_path.insert(
                    path.clone(),
                    ProjectEntry {
                        id: id.clone(),
                        name,
                        current: path == current,
                        path,
                    },
                );
            }
        }
        if let Some(recents) = parsed.get("recentProjects").and_then(Value::as_array) {
            for value in recents {
                let path = value.get("path").and_then(Value::as_str).unwrap_or("");
                if path.is_empty() {
                    continue;
                }
                let path = normalize_path(path);
                by_path.entry(path.clone()).or_insert_with(|| {
                    let id = read_project_id(&path).unwrap_or_else(|| path.clone());
                    let name = value
                        .get("name")
                        .and_then(Value::as_str)
                        .map(ToOwned::to_owned)
                        .unwrap_or_else(|| project_name_from_path(&path));
                    ProjectEntry {
                        id,
                        name,
                        current: path == current,
                        path,
                    }
                });
            }
        }
    }

    for (name, path) in clip_server::all_projects() {
        let path = normalize_path(&path);
        by_path.entry(path.clone()).or_insert_with(|| ProjectEntry {
            id: read_project_id(&path).unwrap_or_else(|| path.clone()),
            name: if name.is_empty() {
                project_name_from_path(&path)
            } else {
                name
            },
            current: path == current,
            path,
        });
    }

    if !current.is_empty() {
        by_path
            .entry(current.clone())
            .or_insert_with(|| ProjectEntry {
                id: read_project_id(&current).unwrap_or_else(|| current.clone()),
                name: project_name_from_path(&current),
                current: true,
                path: current.clone(),
            });
    }

    by_path.into_values().collect()
}

fn resolve_project(app: &AppHandle, project_id: &str) -> Result<ProjectEntry, String> {
    let project_id = percent_decode(project_id);
    let wants_current = project_id.eq_ignore_ascii_case("current");
    load_projects(app)
        .into_iter()
        .find(|p| {
            p.id == project_id
                || project_path_matches(&p.path, &project_id)
                || (wants_current && p.current)
        })
        .ok_or_else(|| format!("Unknown project: {project_id}"))
}

fn project_path_matches(stored_path: &str, candidate: &str) -> bool {
    let stored = normalize_path(stored_path);
    let candidate = normalize_path(candidate);
    if cfg!(windows) {
        stored.eq_ignore_ascii_case(&candidate)
    } else {
        stored == candidate
    }
}

fn read_project_id(path: &str) -> Option<String> {
    let raw = fs::read_to_string(Path::new(path).join(".llm-wiki/project.json")).ok()?;
    let parsed: Value = serde_json::from_str(&raw).ok()?;
    parsed
        .get("id")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
}

fn project_name_from_path(path: &str) -> String {
    Path::new(path)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("Project")
        .to_string()
}

fn normalize_path(path: &str) -> String {
    path.replace('\\', "/").trim_end_matches('/').to_string()
}

fn gate_error(error: crate::ingest_gate::GateError) -> ApiResponse {
    err(error.status, error.message)
}

fn request_header<'a>(headers: &'a [(String, String)], name: &str) -> Option<&'a str> {
    headers
        .iter()
        .find(|(key, _)| key.eq_ignore_ascii_case(name))
        .map(|(_, value)| value.as_str())
}

fn handle_ingest_drafts(app: &AppHandle, project_id: &str) -> ApiResponse {
    let project = match resolve_project(app, project_id) {
        Ok(project) => project,
        Err(error) => return err(404, error),
    };
    match crate::ingest_gate::list_drafts(&project.path) {
        Ok(drafts) => ok(json!({
            "ok": true,
            "projectId": project.id,
            "count": drafts.len(),
            "drafts": drafts,
        })),
        Err(error) => gate_error(error),
    }
}

fn handle_create_ingest_draft(
    app: &AppHandle,
    project_id: &str,
    body: &[u8],
    headers: &[(String, String)],
) -> ApiResponse {
    let project = match resolve_project(app, project_id) {
        Ok(project) => project,
        Err(error) => return err(404, error),
    };
    let content_type = request_header(headers, "content-type")
        .unwrap_or("")
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    if !matches!(
        content_type.as_str(),
        "application/pdf" | "application/octet-stream"
    ) {
        return err(415, "Upload the PDF as a raw binary request body");
    }
    let filename = request_header(headers, "x-filename")
        .map(percent_decode)
        .unwrap_or_default();
    if filename.is_empty() {
        return err(400, "Missing X-Filename header");
    }
    match crate::ingest_gate::create_draft(&project.path, &filename, body) {
        Ok(draft) => ApiResponse {
            status: 202,
            body: json!({
                "ok": true,
                "projectId": project.id,
                "draft": draft,
            }),
        },
        Err(error) => gate_error(error),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GeneratedDraftRequest {
    title: String,
    target_path: String,
    content: String,
}

/// Deep Research results may become Wiki pages only by entering the same
/// staged review queue used for PDFs. The browser never supplies the origin
/// label and cannot direct this endpoint at a non-Wiki path.
fn handle_create_generated_draft(app: &AppHandle, project_id: &str, body: &str) -> ApiResponse {
    let project = match resolve_project(app, project_id) {
        Ok(project) => project,
        Err(error) => return err(404, error),
    };
    let request: GeneratedDraftRequest = match serde_json::from_str(body) {
        Ok(request) => request,
        Err(error) => return err(400, format!("Invalid generated draft request: {error}")),
    };
    let target_path = match editable_wiki_rel(&request.target_path) {
        Ok(path) => path,
        Err(error) => return err(403, error),
    };
    match crate::ingest_gate::create_generated_page_draft(
        &project.path,
        &request.title,
        &target_path,
        &request.content,
        "Studio Deep Research",
    ) {
        Ok(draft) => ok(json!({ "ok": true, "projectId": project.id, "draft": draft })),
        Err(error) => gate_error(error),
    }
}

fn handle_ingest_draft_detail(app: &AppHandle, project_id: &str, draft_id: &str) -> ApiResponse {
    let project = match resolve_project(app, project_id) {
        Ok(project) => project,
        Err(error) => return err(404, error),
    };
    match crate::ingest_gate::draft_detail(&project.path, &percent_decode(draft_id)) {
        Ok(mut body) => {
            if let Some(object) = body.as_object_mut() {
                object.insert("projectId".to_string(), json!(project.id));
            }
            ok(body)
        }
        Err(error) => gate_error(error),
    }
}

fn handle_approve_ingest_draft(app: &AppHandle, project_id: &str, draft_id: &str) -> ApiResponse {
    let project = match resolve_project(app, project_id) {
        Ok(project) => project,
        Err(error) => return err(404, error),
    };
    match crate::ingest_gate::approve_draft(&project.path, &percent_decode(draft_id)) {
        Ok(draft) => {
            let sync_paths = crate::ingest_gate::publication_sync_paths(&draft);
            if let Err(error) =
                commands::file_sync::sync_app_written_paths(&project.path, &sync_paths)
            {
                eprintln!("[ingest-gate] publication snapshot sync failed: {error}");
            }
            let rescan_triggered = commands::file_sync::rescan_project_files(
                app.clone(),
                project.id.clone(),
                project.path.clone(),
                load_source_watch_config(app, &project.id),
            )
            .map(|_| true)
            .unwrap_or_else(|error| {
                eprintln!("[ingest-gate] explicit publication rescan failed: {error}");
                false
            });
            if let Err(error) = app.emit(
                "strict-ingest://published",
                json!({
                    "projectId": project.id,
                    "projectPath": project.path,
                    "draftId": draft.id,
                    "sourcePath": draft.source_path,
                    "pagePaths": draft.published_pages,
                }),
            ) {
                eprintln!("[ingest-gate] publication index event failed: {error}");
            }
            ok(json!({
                "ok": true,
                "projectId": project.id,
                "draft": draft,
                "indexingTriggered": true,
                "rescanTriggered": rescan_triggered,
            }))
        }
        Err(error) => gate_error(error),
    }
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DraftDecisionRequest {
    #[serde(default)]
    feedback: Option<String>,
    #[serde(default)]
    reason: Option<String>,
    #[serde(default)]
    guidance: Option<String>,
}

fn parse_draft_decision(body: &str) -> Result<DraftDecisionRequest, ApiResponse> {
    if body.trim().is_empty() {
        return Ok(DraftDecisionRequest::default());
    }
    serde_json::from_str(body).map_err(|error| err(400, format!("Invalid decision body: {error}")))
}

fn handle_revise_ingest_draft(
    app: &AppHandle,
    project_id: &str,
    draft_id: &str,
    body: &str,
) -> ApiResponse {
    let project = match resolve_project(app, project_id) {
        Ok(project) => project,
        Err(error) => return err(404, error),
    };
    let request = match parse_draft_decision(body) {
        Ok(request) => request,
        Err(response) => return response,
    };
    match crate::ingest_gate::request_revision(
        &project.path,
        &percent_decode(draft_id),
        request.feedback.or(request.guidance).or(request.reason),
    ) {
        Ok(draft) => ok(json!({ "ok": true, "projectId": project.id, "draft": draft })),
        Err(error) => gate_error(error),
    }
}

fn handle_reject_ingest_draft(
    app: &AppHandle,
    project_id: &str,
    draft_id: &str,
    body: &str,
) -> ApiResponse {
    let project = match resolve_project(app, project_id) {
        Ok(project) => project,
        Err(error) => return err(404, error),
    };
    let request = match parse_draft_decision(body) {
        Ok(request) => request,
        Err(response) => return response,
    };
    match crate::ingest_gate::reject_draft(
        &project.path,
        &percent_decode(draft_id),
        request.reason.or(request.feedback).or(request.guidance),
    ) {
        Ok(draft) => ok(json!({ "ok": true, "projectId": project.id, "draft": draft })),
        Err(error) => gate_error(error),
    }
}

fn handle_reading_candidates(app: &AppHandle, project_id: &str, query: &str) -> ApiResponse {
    let project = match resolve_project(app, project_id) {
        Ok(project) => project,
        Err(error) => return err(404, error),
    };
    let include_dismissed = parse_query(query)
        .get("includeDismissed")
        .map(|value| value == "true")
        .unwrap_or(false);
    match crate::ingest_gate::list_candidates(&project.path, include_dismissed) {
        Ok(candidates) => ok(json!({
            "ok": true,
            "projectId": project.id,
            "count": candidates.len(),
            "candidates": candidates,
        })),
        Err(error) => gate_error(error),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CandidateSearchRequest {
    query: String,
    #[serde(default)]
    providers: Vec<String>,
}

fn handle_search_reading_candidates(app: &AppHandle, project_id: &str, body: &str) -> ApiResponse {
    let project = match resolve_project(app, project_id) {
        Ok(project) => project,
        Err(error) => return err(404, error),
    };
    let request: CandidateSearchRequest = match serde_json::from_str(body) {
        Ok(request) => request,
        Err(error) => return err(400, format!("Invalid candidate search request: {error}")),
    };
    match tauri::async_runtime::block_on(crate::ingest_gate::search_candidates(
        &project.path,
        &request.query,
        &request.providers,
    )) {
        Ok(result) => ok(json!({
            "ok": true,
            "projectId": project.id,
            "count": result.candidates.len(),
            "candidates": result.candidates,
            "providerErrors": result.provider_errors,
        })),
        Err(error) => gate_error(error),
    }
}

fn handle_dismiss_reading_candidate(
    app: &AppHandle,
    project_id: &str,
    candidate_id: &str,
) -> ApiResponse {
    let project = match resolve_project(app, project_id) {
        Ok(project) => project,
        Err(error) => return err(404, error),
    };
    match crate::ingest_gate::dismiss_candidate(&project.path, &percent_decode(candidate_id)) {
        Ok(candidate) => ok(json!({
            "ok": true,
            "projectId": project.id,
            "candidate": candidate,
        })),
        Err(error) => gate_error(error),
    }
}

fn handle_sources(app: &AppHandle, project_id: &str) -> ApiResponse {
    let project = match resolve_project(app, project_id) {
        Ok(project) => project,
        Err(error) => return err(404, error),
    };
    match crate::ingest_gate::list_trusted_sources(&project.path) {
        Ok(sources) => ok(json!({
            "ok": true,
            "projectId": project.id,
            "sources": sources,
        })),
        Err(error) => gate_error(error),
    }
}

fn handle_files(app: &AppHandle, project_id: &str, query: &str) -> ApiResponse {
    let project = match resolve_project(app, project_id) {
        Ok(project) => project,
        Err(e) => return err(404, e),
    };
    let params = parse_query(query);
    let root = params.get("root").map(String::as_str).unwrap_or("wiki");
    let recursive = params
        .get("recursive")
        .map(|v| v != "false")
        .unwrap_or(true);
    let max_files = params
        .get("maxFiles")
        .and_then(|v| v.parse::<usize>().ok())
        .unwrap_or(DEFAULT_MAX_FILES)
        .clamp(1, HARD_MAX_FILES);
    let rel = match root {
        "wiki" => "wiki",
        "sources" | "raw" | "raw/sources" => "raw/sources",
        "all" | "" => "",
        _ => return err(400, "root must be wiki, sources, or all"),
    };
    if rel.is_empty() {
        return match list_public_roots(&project.path, recursive, max_files) {
            Ok(files) => ok(json!({
                "ok": true,
                "projectId": project.id,
                "root": "all",
                "files": files,
                "truncated": false,
            })),
            Err(e) => err(if e.contains("exceeds") { 413 } else { 500 }, e),
        };
    }
    let dir = match safe_join(&project.path, rel) {
        Ok(path) => path,
        Err(e) => return err(400, e),
    };
    let mut count = 0;
    match list_tree(&project.path, &dir, recursive, max_files, &mut count) {
        Ok(files) => ok(json!({
            "ok": true,
            "projectId": project.id,
            "root": rel,
            "files": files,
            "truncated": false,
        })),
        Err(e) => err(if e.contains("exceeds") { 413 } else { 500 }, e),
    }
}

fn handle_file_content(app: &AppHandle, project_id: &str, query: &str) -> ApiResponse {
    let project = match resolve_project(app, project_id) {
        Ok(project) => project,
        Err(e) => return err(404, e),
    };
    let params = parse_query(query);
    let Some(rel) = params.get("path") else {
        return err(400, "Missing path query parameter");
    };
    if !is_public_project_rel(rel) {
        return err(403, "Path is not exposed by the local API");
    }
    if !is_text_content_rel(rel) {
        return err(
            415,
            "Only text-like project files can be read via this endpoint",
        );
    }
    let path = match safe_join(&project.path, rel) {
        Ok(path) => path,
        Err(e) => return err(400, e),
    };
    let meta = match fs::metadata(&path) {
        Ok(meta) => meta,
        Err(e) => return err(404, format!("File not found: {e}")),
    };
    if meta.len() > MAX_FILE_CONTENT_BYTES {
        return err(413, "File is too large to return via API");
    }
    match fs::read_to_string(&path) {
        Ok(content) => ok(json!({
            "ok": true,
            "projectId": project.id,
            "path": rel,
            "content": content,
            "revision": file_revision(&meta),
        })),
        Err(_) => err(415, "File is not valid UTF-8 text"),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FileWriteRequest {
    path: String,
    content: String,
    #[serde(default)]
    if_match: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FilePathRequest {
    path: String,
    #[serde(default)]
    if_match: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RestoreFileRequest {
    path: String,
    entry_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateMissingPageRequest {
    title: String,
    #[serde(default)]
    content: Option<String>,
}

fn editable_wiki_rel(raw: &str) -> Result<String, String> {
    let rel = normalize_path(raw).trim_start_matches('/').to_string();
    let lower = rel.to_ascii_lowercase();
    if !is_public_project_rel(&rel)
        || !lower.starts_with("wiki/")
        || !matches!(
            Path::new(&lower)
                .extension()
                .and_then(|value| value.to_str()),
            Some("md") | Some("mdx")
        )
    {
        return Err("Only Markdown pages under wiki/ can be changed from Studio".to_string());
    }
    Ok(rel)
}

fn protected_wiki_page(rel: &str) -> bool {
    matches!(
        normalize_path(rel).to_ascii_lowercase().as_str(),
        "wiki/index.md" | "wiki/log.md" | "wiki/overview.md"
    )
}

fn file_revision(metadata: &fs::Metadata) -> String {
    let modified = metadata
        .modified()
        .ok()
        .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
        .map(|value| value.as_nanos())
        .unwrap_or(0);
    format!("{modified}:{}", metadata.len())
}

fn matches_if_match(expected: Option<&str>, metadata: &fs::Metadata) -> bool {
    expected
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value == file_revision(metadata))
        .unwrap_or(true)
}

fn handle_write_file(app: &AppHandle, project_id: &str, body: &str) -> ApiResponse {
    let project = match resolve_project(app, project_id) {
        Ok(project) => project,
        Err(error) => return err(404, error),
    };
    let request: FileWriteRequest = match serde_json::from_str(body) {
        Ok(request) => request,
        Err(error) => return err(400, format!("Invalid file write request: {error}")),
    };
    let rel = match editable_wiki_rel(&request.path) {
        Ok(rel) => rel,
        Err(error) => return err(403, error),
    };
    if request.content.len() > MAX_FILE_CONTENT_BYTES as usize {
        return err(413, "Wiki page content exceeds the 2 MB limit");
    }
    let path = match safe_join(&project.path, &rel) {
        Ok(path) => path,
        Err(error) => return err(400, error),
    };
    if path.exists() {
        let metadata = match fs::metadata(&path) {
            Ok(metadata) if metadata.is_file() => metadata,
            Ok(_) => return err(409, "Wiki target is not a regular file"),
            Err(error) => return err(500, format!("Failed to inspect wiki target: {error}")),
        };
        if !matches_if_match(request.if_match.as_deref(), &metadata) {
            return err(409, "Wiki page changed elsewhere; reload before saving");
        }
        commands::file_history::record_file_version(&path, "baseline", "before.studio.api.write");
    } else if request
        .if_match
        .as_deref()
        .is_some_and(|value| !value.trim().is_empty())
    {
        return err(409, "Wiki page no longer exists; reload before saving");
    }
    if let Err(error) = write_atomic_file(&path, request.content.as_bytes()) {
        return err(500, error);
    }
    commands::file_history::record_file_version(&path, "human", "studio.api.write");
    let revision = fs::metadata(&path)
        .map(|metadata| file_revision(&metadata))
        .unwrap_or_default();
    ok(json!({ "ok": true, "projectId": project.id, "path": rel, "revision": revision }))
}

fn handle_create_missing_page(app: &AppHandle, project_id: &str, body: &str) -> ApiResponse {
    let project = match resolve_project(app, project_id) {
        Ok(project) => project,
        Err(error) => return err(404, error),
    };
    let request: CreateMissingPageRequest = match serde_json::from_str(body) {
        Ok(request) => request,
        Err(error) => return err(400, format!("Invalid missing-page request: {error}")),
    };
    let rel = match commands::fs::create_missing_wiki_page_inner(
        &project.path,
        &request.title,
        request.content.as_deref(),
    ) {
        Ok(path) => path,
        Err(error) => return err(400, error),
    };
    let path = match safe_join(&project.path, &rel) {
        Ok(path) => path,
        Err(error) => return err(500, error),
    };
    let content = fs::read_to_string(&path).unwrap_or_default();
    let revision = fs::metadata(&path)
        .map(|metadata| file_revision(&metadata))
        .unwrap_or_default();
    ok(json!({
        "ok": true,
        "projectId": project.id,
        "path": rel,
        "content": content,
        "revision": revision,
    }))
}

fn handle_file_history(app: &AppHandle, project_id: &str, query: &str) -> ApiResponse {
    let project = match resolve_project(app, project_id) {
        Ok(project) => project,
        Err(error) => return err(404, error),
    };
    let params = parse_query(query);
    let Some(raw_path) = params.get("path") else {
        return err(400, "Missing path query parameter");
    };
    if !is_public_project_rel(raw_path) || !is_text_content_rel(raw_path) {
        return err(403, "Path is not available for Studio file history");
    }
    let rel = normalize_path(raw_path).trim_start_matches('/').to_string();
    let path = match safe_join(&project.path, &rel) {
        Ok(path) => path,
        Err(error) => return err(400, error),
    };
    let entries = match commands::file_history::list_file_history_inner(
        &project.path,
        &path.to_string_lossy(),
    ) {
        Ok(entries) => entries,
        Err(error) => return err(400, error),
    };
    let entries = entries
        .into_iter()
        .map(|entry| {
            json!({
                "id": entry.id,
                "timestamp": entry.timestamp,
                "author": entry.author,
                "tool": entry.tool,
                "content": entry.content,
            })
        })
        .collect::<Vec<_>>();
    ok(json!({ "ok": true, "projectId": project.id, "path": rel, "entries": entries }))
}

fn handle_restore_file_history(app: &AppHandle, project_id: &str, body: &str) -> ApiResponse {
    let project = match resolve_project(app, project_id) {
        Ok(project) => project,
        Err(error) => return err(404, error),
    };
    let request: RestoreFileRequest = match serde_json::from_str(body) {
        Ok(request) => request,
        Err(error) => return err(400, format!("Invalid history restore request: {error}")),
    };
    let rel = match editable_wiki_rel(&request.path) {
        Ok(rel) => rel,
        Err(error) => return err(403, error),
    };
    let path = match safe_join(&project.path, &rel) {
        Ok(path) => path,
        Err(error) => return err(400, error),
    };
    let content = match commands::file_history::restore_file_history_inner(
        &project.path,
        &path.to_string_lossy(),
        &request.entry_id,
    ) {
        Ok(content) => content,
        Err(error) => return err(400, error),
    };
    let revision = fs::metadata(&path)
        .map(|metadata| file_revision(&metadata))
        .unwrap_or_default();
    ok(json!({
        "ok": true,
        "projectId": project.id,
        "path": rel,
        "content": content,
        "revision": revision,
    }))
}

fn handle_delete_file(app: &AppHandle, project_id: &str, body: &str) -> ApiResponse {
    let project = match resolve_project(app, project_id) {
        Ok(project) => project,
        Err(error) => return err(404, error),
    };
    let request: FilePathRequest = match serde_json::from_str(body) {
        Ok(request) => request,
        Err(error) => return err(400, format!("Invalid file delete request: {error}")),
    };
    let rel = match editable_wiki_rel(&request.path) {
        Ok(rel) => rel,
        Err(error) => return err(403, error),
    };
    if protected_wiki_page(&rel) {
        return err(409, "Core Wiki pages cannot be deleted from Studio");
    }
    let path = match safe_join(&project.path, &rel) {
        Ok(path) => path,
        Err(error) => return err(400, error),
    };
    let metadata = match fs::metadata(&path) {
        Ok(metadata) if metadata.is_file() => metadata,
        Ok(_) => return err(409, "Wiki target is not a regular file"),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return err(404, "Wiki page was not found")
        }
        Err(error) => return err(500, format!("Failed to inspect wiki page: {error}")),
    };
    if !matches_if_match(request.if_match.as_deref(), &metadata) {
        return err(409, "Wiki page changed elsewhere; reload before deleting");
    }
    commands::file_history::record_file_version(&path, "baseline", "before.studio.api.delete");
    if let Err(error) = fs::remove_file(&path) {
        return err(500, format!("Failed to delete wiki page: {error}"));
    }
    ok(json!({ "ok": true, "projectId": project.id, "path": rel }))
}

fn handle_page_links(app: &AppHandle, project_id: &str, query: &str) -> ApiResponse {
    let project = match resolve_project(app, project_id) {
        Ok(project) => project,
        Err(error) => return err(404, error),
    };
    let params = parse_query(query);
    let Some(raw_path) = params.get("path") else {
        return err(400, "Missing path query parameter");
    };
    let rel = match editable_wiki_rel(raw_path) {
        Ok(rel) => rel,
        Err(error) => return err(403, error),
    };
    let path = match safe_join(&project.path, &rel) {
        Ok(path) => path,
        Err(error) => return err(400, error),
    };
    match commands::search::get_page_links_inner(&project.path, &path.to_string_lossy()) {
        Ok(links) => {
            ok(json!({ "ok": true, "projectId": project.id, "path": rel, "links": links }))
        }
        Err(error) => err(400, error),
    }
}

fn write_atomic_file(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "Target path has no parent directory".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Failed to create parent directory: {error}"))?;
    let filename = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("llm-wiki-file");
    let temporary = parent.join(format!(".{filename}.{}.tmp", Uuid::new_v4()));
    let mut output = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .map_err(|error| format!("Failed to create temporary file: {error}"))?;
    if let Err(error) = output.write_all(bytes).and_then(|_| output.sync_all()) {
        drop(output);
        let _ = fs::remove_file(&temporary);
        return Err(format!("Failed to write temporary file: {error}"));
    }
    drop(output);
    fs::rename(&temporary, path).map_err(|error| {
        let _ = fs::remove_file(&temporary);
        format!("Failed to replace file atomically: {error}")
    })
}

fn safe_join(project_path: &str, rel: &str) -> Result<PathBuf, String> {
    let root = PathBuf::from(project_path);
    let rel = rel.trim_start_matches('/');
    let rel_path = Path::new(rel);
    if rel_path.is_absolute() {
        return Err("Absolute paths are not allowed".to_string());
    }
    for component in rel_path.components() {
        if matches!(
            component,
            Component::ParentDir | Component::Prefix(_) | Component::RootDir
        ) {
            return Err("Path traversal is not allowed".to_string());
        }
    }
    let joined = root.join(rel_path);
    let root_canon = root
        .canonicalize()
        .map_err(|e| format!("Failed to resolve project path: {e}"))?;
    if joined.exists() {
        let joined_canon = joined
            .canonicalize()
            .map_err(|e| format!("Failed to resolve path: {e}"))?;
        if !joined_canon.starts_with(&root_canon) {
            return Err("Resolved path escapes the project directory".to_string());
        }
        return Ok(joined_canon);
    }
    let parent = joined
        .parent()
        .ok_or_else(|| "Path has no parent directory".to_string())?;
    if parent.exists() {
        let parent_canon = parent
            .canonicalize()
            .map_err(|e| format!("Failed to resolve parent path: {e}"))?;
        if !parent_canon.starts_with(&root_canon) {
            return Err("Resolved parent escapes the project directory".to_string());
        }
    }
    Ok(joined)
}

fn is_public_project_rel(rel: &str) -> bool {
    let rel = normalize_path(rel).trim_start_matches('/').to_string();
    if rel
        .split('/')
        .any(|part| part.is_empty() || part.starts_with('.'))
    {
        return false;
    }
    let lower = rel.to_lowercase();
    lower == "purpose.md"
        || lower == "schema.md"
        || lower.starts_with("wiki/")
        || lower.starts_with("raw/sources/")
}

fn is_text_content_rel(rel: &str) -> bool {
    let rel = normalize_path(rel).to_lowercase();
    let ext = Path::new(&rel)
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("");
    matches!(
        ext,
        "md" | "mdx"
            | "txt"
            | "csv"
            | "json"
            | "yaml"
            | "yml"
            | "xml"
            | "html"
            | "htm"
            | "rtf"
            | "log"
    )
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ApiFileNode {
    name: String,
    path: String,
    is_dir: bool,
    size: Option<u64>,
    children: Option<Vec<ApiFileNode>>,
}

fn list_public_roots(
    project_path: &str,
    recursive: bool,
    max_files: usize,
) -> Result<Vec<ApiFileNode>, String> {
    let mut count = 0;
    let mut roots = Vec::new();
    for rel in ["purpose.md", "schema.md", "wiki", "raw/sources"] {
        let path = safe_join(project_path, rel)?;
        if !path.exists() {
            continue;
        }
        push_file_node(
            project_path,
            &path,
            recursive,
            max_files,
            &mut count,
            &mut roots,
        )?;
    }
    Ok(roots)
}

fn list_tree(
    project_path: &str,
    path: &Path,
    recursive: bool,
    max_files: usize,
    count: &mut usize,
) -> Result<Vec<ApiFileNode>, String> {
    let mut out = Vec::new();
    let entries = fs::read_dir(path).map_err(|e| format!("Failed to list directory: {e}"))?;
    for entry in entries {
        let entry = entry.map_err(|e| format!("Failed to read directory entry: {e}"))?;
        push_file_node(
            project_path,
            &entry.path(),
            recursive,
            max_files,
            count,
            &mut out,
        )?;
    }
    out.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then_with(|| a.name.cmp(&b.name)));
    Ok(out)
}

fn push_file_node(
    project_path: &str,
    path: &Path,
    recursive: bool,
    max_files: usize,
    count: &mut usize,
    out: &mut Vec<ApiFileNode>,
) -> Result<(), String> {
    let name = path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_string();
    if name.starts_with('.') {
        return Ok(());
    }
    let meta = fs::symlink_metadata(path).map_err(|e| format!("Failed to read metadata: {e}"))?;
    let file_type = meta.file_type();
    if file_type.is_symlink() {
        return Ok(());
    }
    *count += 1;
    if *count > max_files {
        return Err(format!("File listing exceeds maxFiles limit ({max_files})"));
    }
    let is_dir = file_type.is_dir();
    let children = if recursive && is_dir {
        Some(list_tree(project_path, path, true, max_files, count)?)
    } else {
        None
    };
    out.push(ApiFileNode {
        name,
        path: relative_to_project(project_path, path),
        is_dir,
        size: if is_dir { None } else { Some(meta.len()) },
        children,
    });
    Ok(())
}

fn relative_to_project(project_path: &str, path: &Path) -> String {
    let root = Path::new(project_path);
    if let Ok(relative) = path.strip_prefix(root) {
        return relative.to_string_lossy().replace('\\', "/");
    }

    // Windows canonicalize() returns an extended path such as \\?\C:\...,
    // while the configured project path is usually the regular C:\... form.
    // Compare against the canonical root before falling back to an absolute
    // path, otherwise the public file API leaks an unusable path to clients.
    if let Ok(canonical_root) = root.canonicalize() {
        if let Ok(relative) = path.strip_prefix(&canonical_root) {
            return relative.to_string_lossy().replace('\\', "/");
        }
    }

    path.to_string_lossy().replace('\\', "/")
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ReviewStatus {
    Unresolved,
    Resolved,
    All,
}

impl ReviewStatus {
    fn as_str(self) -> &'static str {
        match self {
            ReviewStatus::Unresolved => "unresolved",
            ReviewStatus::Resolved => "resolved",
            ReviewStatus::All => "all",
        }
    }

    fn matches(self, resolved: bool) -> bool {
        match self {
            ReviewStatus::Unresolved => !resolved,
            ReviewStatus::Resolved => resolved,
            ReviewStatus::All => true,
        }
    }
}

#[derive(Debug, Clone)]
struct ReviewQuery {
    status: ReviewStatus,
    item_type: Option<String>,
    limit: usize,
}

fn parse_review_query(query: &str) -> Result<ReviewQuery, String> {
    let params = parse_query(query);
    let status = match params
        .get("status")
        .map(|s| s.as_str())
        .unwrap_or("unresolved")
    {
        "unresolved" | "pending" => ReviewStatus::Unresolved,
        "resolved" => ReviewStatus::Resolved,
        "all" => ReviewStatus::All,
        value => {
            return Err(format!(
                "Invalid review status '{value}'. Expected unresolved, resolved, or all"
            ))
        }
    };
    let item_type = params
        .get("type")
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let limit = params
        .get("limit")
        .and_then(|s| s.parse::<usize>().ok())
        .unwrap_or(DEFAULT_MAX_REVIEWS)
        .clamp(1, HARD_MAX_REVIEWS);

    Ok(ReviewQuery {
        status,
        item_type,
        limit,
    })
}

fn normalize_review_title(title: &str) -> String {
    let trimmed = title.trim_start();
    let lower = trimmed.to_lowercase();
    let mut rest = trimmed;
    for prefix in [
        "missing page",
        "missing-page",
        "missingpage",
        "duplicate page",
        "duplicate-page",
        "duplicatepage",
        "possible duplicate",
        "possible-duplicate",
        "possibleduplicate",
        "缺失页面",
        "缺少页面",
        "重复页面",
        "疑似重复",
    ] {
        if !lower.starts_with(prefix) {
            continue;
        }
        let suffix = &trimmed[prefix.len()..];
        let Some(delimiter) = suffix.chars().next() else {
            continue;
        };
        if delimiter == ':' || delimiter == '：' {
            rest = suffix[delimiter.len_utf8()..].trim_start();
            break;
        }
    }
    rest.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

fn review_id_for_parts(item_type: &str, title: &str) -> String {
    let key = format!("{item_type}::{}", normalize_review_title(title));
    let mut h: u32 = 0x811c9dc5;
    for unit in key.encode_utf16() {
        h ^= u32::from(unit);
        h = h.wrapping_mul(0x01000193);
    }
    format!("review-{h:08x}")
}

fn stable_review_id(item: &Value) -> Option<String> {
    let item_type = item.get("type").and_then(Value::as_str)?;
    let title = item.get("title").and_then(Value::as_str)?;
    Some(review_id_for_parts(item_type, title))
}

fn review_id_matches(item: &Value, requested_id: &str) -> bool {
    item.get("id").and_then(Value::as_str) == Some(requested_id)
        || stable_review_id(item).as_deref() == Some(requested_id)
}

fn load_review_items(project_path: &str, query: &ReviewQuery) -> Result<Vec<Value>, String> {
    let path = Path::new(project_path).join(".llm-wiki/review.json");
    let raw = match fs::read_to_string(&path) {
        Ok(raw) => raw,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(err) => return Err(format!("Failed to read review state: {err}")),
    };
    let parsed: Value =
        serde_json::from_str(&raw).map_err(|err| format!("Invalid review state JSON: {err}"))?;
    let items = parsed
        .as_array()
        .ok_or_else(|| "Invalid review state JSON: expected an array".to_string())?;

    let mut normalized: Vec<Value> = Vec::new();
    let mut index_by_id: BTreeMap<String, usize> = BTreeMap::new();
    for item in items {
        let sanitized = sanitize_review_item(item);
        let id = sanitized
            .get("id")
            .and_then(Value::as_str)
            .map(str::to_string);
        if let Some(id) = id {
            if let Some(existing_idx) = index_by_id.get(&id).copied() {
                merge_sanitized_review(&mut normalized[existing_idx], &sanitized);
                continue;
            }
            index_by_id.insert(id, normalized.len());
        }
        normalized.push(sanitized);
    }

    let mut reviews: Vec<Value> = Vec::new();
    for item in normalized {
        let resolved = item
            .get("resolved")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        if !query.status.matches(resolved) {
            continue;
        }
        if let Some(item_type) = &query.item_type {
            if item.get("type").and_then(Value::as_str) != Some(item_type.as_str()) {
                continue;
            }
        }
        if reviews.len() >= query.limit {
            break;
        }
        reviews.push(item);
    }

    Ok(reviews)
}

fn sanitize_review_item(item: &Value) -> Value {
    let mut out = Map::new();
    if let Some(id) = stable_review_id(item) {
        out.insert("id".to_string(), Value::String(id));
    } else {
        copy_string_field(item, &mut out, "id");
    }
    copy_string_field(item, &mut out, "type");
    copy_string_field(item, &mut out, "title");
    copy_string_field(item, &mut out, "description");
    copy_string_field(item, &mut out, "sourcePath");
    copy_string_array_field(item, &mut out, "affectedPages");
    copy_string_array_field(item, &mut out, "searchQueries");
    copy_review_options(item, &mut out);
    copy_bool_field(item, &mut out, "resolved");
    copy_string_field(item, &mut out, "resolvedAction");
    copy_number_field(item, &mut out, "createdAt");
    Value::Object(out)
}

fn merge_sanitized_review(existing: &mut Value, incoming: &Value) {
    let Some(existing) = existing.as_object_mut() else {
        return;
    };
    let Some(incoming) = incoming.as_object() else {
        return;
    };

    let resolved = existing
        .get("resolved")
        .and_then(Value::as_bool)
        .unwrap_or(false)
        || incoming
            .get("resolved")
            .and_then(Value::as_bool)
            .unwrap_or(false);
    existing.insert("resolved".to_string(), Value::Bool(resolved));

    if resolved && !existing.contains_key("resolvedAction") {
        if let Some(action) = incoming.get("resolvedAction").and_then(Value::as_str) {
            existing.insert(
                "resolvedAction".to_string(),
                Value::String(action.to_string()),
            );
        }
    }

    for key in ["description", "sourcePath"] {
        let existing_empty = existing
            .get(key)
            .and_then(Value::as_str)
            .map(str::is_empty)
            .unwrap_or(true);
        if existing_empty {
            if let Some(value) = incoming.get(key).and_then(Value::as_str) {
                existing.insert(key.to_string(), Value::String(value.to_string()));
            }
        }
    }

    merge_string_array_field(existing, incoming, "affectedPages");
    merge_string_array_field(existing, incoming, "searchQueries");
    merge_review_options_field(existing, incoming);

    if let Some(incoming_created) = incoming.get("createdAt").and_then(Value::as_f64) {
        let existing_created = existing
            .get("createdAt")
            .and_then(Value::as_f64)
            .unwrap_or(incoming_created);
        existing.insert(
            "createdAt".to_string(),
            json!(existing_created.min(incoming_created)),
        );
    }
}

fn merge_string_array_field(
    existing: &mut Map<String, Value>,
    incoming: &Map<String, Value>,
    key: &str,
) {
    let mut values = existing
        .get(key)
        .and_then(Value::as_array)
        .map(|values| {
            values
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    for value in incoming
        .get(key)
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
    {
        if !values.iter().any(|existing| existing == value) {
            values.push(value.to_string());
        }
    }
    if !values.is_empty() {
        existing.insert(
            key.to_string(),
            Value::Array(values.into_iter().map(Value::String).collect()),
        );
    }
}

fn merge_review_options_field(existing: &mut Map<String, Value>, incoming: &Map<String, Value>) {
    let mut options = existing
        .get("options")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    for option in incoming
        .get("options")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let action = option.get("action").and_then(Value::as_str);
        let already_present = action.is_some_and(|action| {
            options
                .iter()
                .any(|existing| existing.get("action").and_then(Value::as_str) == Some(action))
        });
        if !already_present {
            options.push(option.clone());
        }
    }
    if !options.is_empty() {
        existing.insert("options".to_string(), Value::Array(options));
    }
}

fn copy_string_field(item: &Value, out: &mut Map<String, Value>, key: &str) {
    if let Some(value) = item.get(key).and_then(Value::as_str) {
        out.insert(key.to_string(), Value::String(value.to_string()));
    }
}

fn copy_bool_field(item: &Value, out: &mut Map<String, Value>, key: &str) {
    if let Some(value) = item.get(key).and_then(Value::as_bool) {
        out.insert(key.to_string(), Value::Bool(value));
    }
}

fn copy_number_field(item: &Value, out: &mut Map<String, Value>, key: &str) {
    if let Some(value) = item.get(key).and_then(Value::as_f64) {
        if value.is_finite() {
            out.insert(key.to_string(), json!(value));
        }
    }
}

fn copy_string_array_field(item: &Value, out: &mut Map<String, Value>, key: &str) {
    let Some(values) = item.get(key).and_then(Value::as_array) else {
        return;
    };
    let strings = values
        .iter()
        .filter_map(Value::as_str)
        .map(|value| Value::String(value.to_string()))
        .collect::<Vec<_>>();
    out.insert(key.to_string(), Value::Array(strings));
}

fn copy_review_options(item: &Value, out: &mut Map<String, Value>) {
    let Some(values) = item.get("options").and_then(Value::as_array) else {
        return;
    };
    let options = values
        .iter()
        .filter_map(|option| {
            let option = option.as_object()?;
            let mut sanitized = Map::new();
            if let Some(label) = option.get("label").and_then(Value::as_str) {
                sanitized.insert("label".to_string(), Value::String(label.to_string()));
            }
            if let Some(action) = option.get("action").and_then(Value::as_str) {
                sanitized.insert("action".to_string(), Value::String(action.to_string()));
            }
            if sanitized.is_empty() {
                None
            } else {
                Some(Value::Object(sanitized))
            }
        })
        .collect::<Vec<_>>();
    out.insert("options".to_string(), Value::Array(options));
}

fn handle_reviews(app: &AppHandle, project_id: &str, query: &str) -> ApiResponse {
    let project = match resolve_project(app, project_id) {
        Ok(project) => project,
        Err(e) => return err(404, e),
    };
    let query = match parse_review_query(query) {
        Ok(query) => query,
        Err(e) => return err(400, e),
    };
    match load_review_items(&project.path, &query) {
        Ok(reviews) => ok(json!({
            "ok": true,
            "projectId": project.id,
            "status": query.status.as_str(),
            "count": reviews.len(),
            "reviews": reviews,
        })),
        Err(e) => err(500, e),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PatchReviewRequest {
    /// Target resolved state. Defaults to `true` (the common case:
    /// resolve). Pass `false` to reopen a resolved item.
    resolved: Option<bool>,
    /// Optional human-readable action label stored on the item
    /// (e.g. "Skip", "Created page"). Mark-only — the API never
    /// replicates the WebView's side effects (page creation, etc).
    action: Option<String>,
}

/// `PATCH /projects/{id}/reviews/{reviewId}` — partial update of a
/// single review item's resolved state. Body `{ resolved?, action? }`;
/// an empty body resolves the item (resolved defaults to true).
fn handle_patch_review(
    app: &AppHandle,
    project_id: &str,
    review_id: &str,
    body: &str,
) -> ApiResponse {
    let project = match resolve_project(app, project_id) {
        Ok(project) => project,
        Err(e) => return err(404, e),
    };
    let req = if body.trim().is_empty() {
        PatchReviewRequest {
            resolved: None,
            action: None,
        }
    } else {
        match serde_json::from_str::<PatchReviewRequest>(body) {
            Ok(req) => req,
            Err(e) => return err(400, format!("Invalid request body: {e}")),
        }
    };
    let resolved = req.resolved.unwrap_or(true);
    match patch_review_item(&project.path, review_id, resolved, req.action.as_deref()) {
        Ok(true) => ok(json!({
            "ok": true,
            "projectId": project.id,
            "reviewId": review_id,
            "resolved": resolved,
        })),
        Ok(false) => err(404, format!("Review item '{review_id}' not found")),
        Err(e) => err(500, e),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BulkResolveRequest {
    /// Review item ids to resolve. Required, non-empty.
    ids: Vec<String>,
    /// Optional label applied to every resolved item.
    action: Option<String>,
}

/// `POST /projects/{id}/reviews/resolve` — bulk-resolve many review
/// items in one request. Body `{ ids, action? }`. Partial success is
/// normal, so this returns 200 with `{ resolved, notFound, count }`
/// rather than 404 — 404 is reserved for the single-item PATCH where
/// one unknown id is the entire request.
fn handle_bulk_resolve_reviews(app: &AppHandle, project_id: &str, body: &str) -> ApiResponse {
    let project = match resolve_project(app, project_id) {
        Ok(project) => project,
        Err(e) => return err(404, e),
    };
    let req = match serde_json::from_str::<BulkResolveRequest>(body) {
        Ok(req) => req,
        Err(e) => return err(400, format!("Invalid request body: {e}")),
    };
    if req.ids.is_empty() {
        return err(400, "ids must be a non-empty array".to_string());
    }
    match resolve_review_items(&project.path, &req.ids, req.action.as_deref()) {
        Ok((resolved, not_found)) => ok(json!({
            "ok": true,
            "projectId": project.id,
            "resolved": resolved,
            "notFound": not_found,
            "count": resolved.len(),
        })),
        Err(e) => err(500, e),
    }
}

/// Set one review item's resolved state in `.llm-wiki/review.json`.
///
/// Operates on the RAW parsed array (not `load_review_items`, which
/// sanitizes — reusing it would strip fields like `internalSecret` and
/// silently corrupt the file on write-back). Sets `resolved` and, when
/// provided, `resolvedAction`. Returns Ok(false) if no item with the
/// given id exists (caller maps to 404).
fn patch_review_item(
    project_path: &str,
    review_id: &str,
    resolved: bool,
    action: Option<&str>,
) -> Result<bool, String> {
    let path = Path::new(project_path).join(".llm-wiki/review.json");
    let mut parsed = match read_raw_review_array(&path)? {
        Some(parsed) => parsed,
        None => return Ok(false),
    };
    let items = parsed
        .as_array_mut()
        .ok_or_else(|| "Invalid review state JSON: expected an array".to_string())?;

    let mut found = false;
    for item in items.iter_mut() {
        if !review_id_matches(item, review_id) {
            continue;
        }
        apply_resolution(item, resolved, action);
        if let Some(stable_id) = stable_review_id(item) {
            if let Some(obj) = item.as_object_mut() {
                obj.insert("id".to_string(), Value::String(stable_id));
            }
        }
        found = true;
    }

    if !found {
        return Ok(false);
    }
    write_raw_review_array(&path, &parsed)?;
    Ok(true)
}

/// Bulk version of `patch_review_item`: reads `review.json` ONCE,
/// resolves every matching id in the raw array, writes ONCE. Looping
/// the single-item helper would be N read-parse-write cycles with a
/// race window per write. Returns `(resolved_ids, not_found_ids)`,
/// both in the caller's input order.
fn resolve_review_items(
    project_path: &str,
    ids: &[String],
    action: Option<&str>,
) -> Result<(Vec<String>, Vec<String>), String> {
    let path = Path::new(project_path).join(".llm-wiki/review.json");
    let mut parsed = match read_raw_review_array(&path)? {
        Some(parsed) => parsed,
        // No review file → nothing exists, so every id is "not found".
        None => return Ok((Vec::new(), ids.to_vec())),
    };
    let items = parsed
        .as_array_mut()
        .ok_or_else(|| "Invalid review state JSON: expected an array".to_string())?;

    let mut found: BTreeSet<String> = BTreeSet::new();
    for item in items.iter_mut() {
        let raw_id = item.get("id").and_then(Value::as_str);
        let stable_id = stable_review_id(item);
        let matched_request = ids
            .iter()
            .find(|id| raw_id == Some(id.as_str()) || stable_id.as_deref() == Some(id.as_str()));
        let Some(requested_id) = matched_request else {
            continue;
        };
        apply_resolution(item, true, action);
        if let Some(stable_id) = stable_id {
            if let Some(obj) = item.as_object_mut() {
                obj.insert("id".to_string(), Value::String(stable_id));
            }
        }
        found.insert(requested_id.clone());
    }

    if !found.is_empty() {
        write_raw_review_array(&path, &parsed)?;
    }

    // Preserve the caller's input order; dedupe is implicit via `found`.
    let resolved: Vec<String> = ids
        .iter()
        .filter(|id| found.contains(*id))
        .cloned()
        .collect();
    let not_found: Vec<String> = ids
        .iter()
        .filter(|id| !found.contains(*id))
        .cloned()
        .collect();
    Ok((resolved, not_found))
}

/// Set `resolved` / `resolvedAction` on a raw review item value.
fn apply_resolution(item: &mut Value, resolved: bool, action: Option<&str>) {
    if let Some(obj) = item.as_object_mut() {
        obj.insert("resolved".to_string(), Value::Bool(resolved));
        if !resolved {
            obj.remove("resolvedAction");
        } else if let Some(action) = action {
            obj.insert(
                "resolvedAction".to_string(),
                Value::String(action.to_string()),
            );
        }
    }
}

/// Read `.llm-wiki/review.json` as a raw JSON value. Returns Ok(None)
/// when the file doesn't exist (callers treat that as "no items").
fn read_raw_review_array(path: &Path) -> Result<Option<Value>, String> {
    let raw = match fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(err) => return Err(format!("Failed to read review state: {err}")),
    };
    let parsed: Value =
        serde_json::from_str(&raw).map_err(|err| format!("Invalid review state JSON: {err}"))?;
    Ok(Some(parsed))
}

fn write_raw_review_array(path: &Path, parsed: &Value) -> Result<(), String> {
    let serialized = serde_json::to_string_pretty(parsed)
        .map_err(|err| format!("Failed to serialize review state: {err}"))?;
    fs::write(path, serialized).map_err(|err| format!("Failed to write review state: {err}"))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SearchRequest {
    query: String,
    top_k: Option<usize>,
    include_content: Option<bool>,
    query_embedding: Option<Vec<f32>>,
    /// 混合检索（关键词+向量+图谱）完成后，用后台配置的大模型对候选重排。
    #[serde(default)]
    rerank: Option<bool>,
    /// 送入重排模型的候选数量上限（5-30，默认 20）。
    #[serde(default)]
    rerank_top_n: Option<usize>,
}

/// 执行可选的 LLM 重排：返回 (结果列表, 是否重排成功, 重排器信息)。
/// 任何失败都会原样返回输入列表（混合检索顺序），绝不丢结果。
fn apply_llm_rerank(
    app: &AppHandle,
    query: &str,
    results: Vec<Value>,
    top_k: usize,
    rerank_top_n: Option<usize>,
) -> (Vec<Value>, bool, Value) {
    let config = load_agent_runtime_config(app).llm;
    let Some(config) = config.filter(|config| config.is_usable_for_backend_http()) else {
        eprintln!("[Search] LLM rerank requested but no usable LLM config; keeping hybrid order");
        return (results, false, json!({ "skipped": "llm_not_configured" }));
    };
    let client = match agent::provider::LlmClient::new(config.clone()) {
        Ok(client) => client,
        Err(_) => return (results, false, json!({ "skipped": "llm_client_error" })),
    };
    let pool_size = rerank_top_n
        .unwrap_or(20)
        .clamp(5, 30)
        .min(results.len());
    let candidates = results
        .iter()
        .take(pool_size)
        .enumerate()
        .map(|(index, value)| crate::llm_enrich::RerankCandidate {
            index,
            title: value
                .get("title")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            snippet: value
                .get("snippet")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            path: value
                .get("path")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
        })
        .collect::<Vec<_>>();
    let verdicts =
        match tauri::async_runtime::block_on(crate::llm_enrich::rerank_candidates(
            &client,
            query,
            &candidates,
        )) {
            Ok(verdicts) => verdicts,
            Err(error) => {
                eprintln!("[Search] LLM rerank failed, keeping hybrid order: {error}");
                return (
                    results,
                    false,
                    json!({ "skipped": "rerank_failed", "error": error }),
                );
            }
        };
    let mut pool_slots: Vec<Option<Value>> = results.into_iter().map(Some).collect();
    let mut reordered = Vec::with_capacity(pool_slots.len());
    for verdict in &verdicts {
        if let Some(Some(mut item)) = pool_slots.get_mut(verdict.index).map(std::mem::take) {
            if let Some(object) = item.as_object_mut() {
                object.insert("rerankScore".to_string(), json!(verdict.score));
                if !verdict.reason.is_empty() {
                    object.insert("rerankReason".to_string(), json!(verdict.reason));
                }
            }
            reordered.push(item);
        }
    }
    // 池外候选保持混合检索顺序排在后面；最终截断到 top_k。
    for item in pool_slots.into_iter().flatten() {
        reordered.push(item);
    }
    reordered.truncate(top_k.max(1));
    (
        reordered,
        true,
        json!({
            "provider": config.provider,
            "model": config.model,
            "candidates": candidates.len(),
        }),
    )
}

fn handle_search(app: &AppHandle, project_id: &str, body: &str) -> ApiResponse {
    let project = match resolve_project(app, project_id) {
        Ok(project) => project,
        Err(e) => return err(404, e),
    };
    let req: SearchRequest = match serde_json::from_str(body) {
        Ok(req) => req,
        Err(e) => return err(400, format!("Invalid JSON: {e}")),
    };
    if req.query.trim().is_empty() {
        return err(400, "query is required");
    }
    let top_k = req.top_k.unwrap_or(10).clamp(1, MAX_SEARCH_RESULTS);
    let want_rerank = req.rerank.unwrap_or(false);
    // 重排需要更大的候选池：先取 3 倍候选，重排后截断回 top_k。
    let fetch_k = if want_rerank {
        top_k
            .saturating_mul(3)
            .clamp(top_k + 6, MAX_SEARCH_RESULTS)
    } else {
        top_k
    };
    let query = req.query;
    let query_embedding =
        match tauri::async_runtime::block_on(commands::search::resolve_query_embedding(
            &query,
            req.query_embedding,
            load_embedding_config(app),
        )) {
            Ok(embedding) => embedding,
            Err(e) => return err(400, e),
        };
    match tauri::async_runtime::block_on(commands::search::search_project_inner(
        project.path.clone(),
        query.clone(),
        fetch_k,
        req.include_content.unwrap_or(false),
        query_embedding,
    )) {
        Ok(search) => {
            let mut results = search
                .results
                .into_iter()
                .map(|result| {
                    let evidence = crate::ingest_gate::evidence_for_search(
                        &project.path,
                        &result.path,
                        &result.snippet,
                    );
                    let mut value = serde_json::to_value(result).unwrap_or_else(|_| json!({}));
                    if let (Some(evidence), Some(object)) = (evidence, value.as_object_mut()) {
                        object.insert("sourceId".to_string(), json!(evidence.source_id.clone()));
                        object.insert("evidenceLocator".to_string(), json!(evidence));
                    }
                    value
                })
                .collect::<Vec<_>>();
            let (reranked, reranker) = if want_rerank {
                let (reordered, ok_rerank, info) =
                    apply_llm_rerank(app, &query, results, top_k, req.rerank_top_n);
                results = reordered;
                (ok_rerank, Some(info))
            } else {
                (false, None)
            };
            ok(json!({
                "ok": true,
                "projectId": project.id,
                "mode": search.mode,
                "note": "Search uses only published Wiki pages and their LanceDB/graph indexes. Staged drafts are outside every retrieval root.",
                "tokenHits": search.token_hits,
                "vectorHits": search.vector_hits,
                "graphHits": search.graph_hits,
                "reranked": reranked,
                "reranker": reranker,
                "results": results,
            }))
        }
        Err(e) => err(500, e),
    }
}

fn handle_chat(app: &AppHandle, project_id: &str, body: &str) -> ApiResponse {
    let project = match resolve_project(app, project_id) {
        Ok(project) => project,
        Err(e) => return err(404, e),
    };
    let mut req: agent::AgentChatRequest = match serde_json::from_str(body) {
        Ok(req) => req,
        Err(e) => return err(400, format!("Invalid JSON: {e}")),
    };
    if req
        .session_id
        .as_deref()
        .map(str::trim)
        .unwrap_or("")
        .is_empty()
    {
        req.session_id = Some(format!("api_{}", Uuid::new_v4()));
    }
    if req
        .run_id
        .as_deref()
        .map(str::trim)
        .unwrap_or("")
        .is_empty()
    {
        req.run_id = Some(format!("run_{}", Uuid::new_v4()));
    }
    let requested_session_id = req.session_id.clone();
    if let Some(session_id) = requested_session_id.as_deref() {
        if req.history.is_empty() && !req.history_explicit {
            req.history = app
                .state::<agent::session::AgentSessionStore>()
                .recent_messages(&project.path, session_id, 12)
                .into_iter()
                .map(|message| agent::types::AgentConversationMessage {
                    role: message.role,
                    content: message.content,
                })
                .collect();
        }
    }
    let runtime_config = load_agent_runtime_config(app);
    let runtime = agent::AgentRuntime::new(
        project.id.clone(),
        project.path.clone(),
        runtime_config.embedding,
        runtime_config.llm,
        runtime_config.web_search,
        runtime_config.anytxt,
    );
    let user_message_for_session = req.message.clone();
    let persist_session = req.persist_session;
    let session_id = req.session_id.clone().unwrap_or_default();
    let run_id = req.run_id.clone().unwrap_or_default();
    let cancellation = app
        .state::<agent::cancel::AgentCancellationRegistry>()
        .start(&project.id, &session_id, &run_id);
    let result =
        tauri::async_runtime::block_on(runtime.run_once_with_cancel(req, Some(cancellation)));
    app.state::<agent::cancel::AgentCancellationRegistry>()
        .finish(&project.id, &session_id, &run_id);
    match result {
        Ok(mut response) => {
            if persist_session {
                app.state::<agent::session::AgentSessionStore>()
                    .append_turn(
                        &project.path,
                        &project.id,
                        &response.session_id,
                        &user_message_for_session,
                        &response.message,
                    );
            }
            for event in &mut response.events {
                event.redact_for_external_api();
            }
            ok(json!({
                "ok": true,
                "projectId": response.project_id,
                "sessionId": response.session_id,
                "mode": response.mode,
                "message": {
                    "role": "assistant",
                    "content": response.message,
                },
                "references": response.references,
                "toolEvents": response.tool_events,
                "events": response.events,
                "usage": response.usage,
            }))
        }
        Err(e) if e == "message is required" => err(400, e),
        Err(e) if e == "Agent turn cancelled" => err(499, e),
        Err(e) => err(502, e),
    }
}

fn handle_cancel_chat(app: &AppHandle, project_id: &str, session_id: &str) -> ApiResponse {
    let project = match resolve_project(app, project_id) {
        Ok(project) => project,
        Err(e) => return err(404, e),
    };
    ok(json!({
        "ok": true,
        "cancelled": app
            .state::<agent::cancel::AgentCancellationRegistry>()
            .cancel(&project.id, session_id, None),
        "sessionId": session_id,
    }))
}

fn handle_chat_sessions(app: &AppHandle, project_id: &str) -> ApiResponse {
    let project = match resolve_project(app, project_id) {
        Ok(project) => project,
        Err(error) => return err(404, error),
    };
    let sessions = app
        .state::<agent::session::AgentSessionStore>()
        .list_sessions(&project.path)
        .into_iter()
        .map(|session| {
            let title = session
                .messages
                .iter()
                .find(|message| message.role == "user")
                .map(|message| compact_session_title(&message.content))
                .unwrap_or_else(|| "New conversation".to_string());
            json!({
                "id": session.session_id,
                "title": title,
                "updatedAt": session.updated_at,
                "messageCount": session.messages.len(),
            })
        })
        .collect::<Vec<_>>();
    ok(json!({ "ok": true, "projectId": project.id, "sessions": sessions }))
}

fn handle_chat_session(app: &AppHandle, project_id: &str, raw_session_id: &str) -> ApiResponse {
    let project = match resolve_project(app, project_id) {
        Ok(project) => project,
        Err(error) => return err(404, error),
    };
    let session_id = percent_decode(raw_session_id);
    let session = app
        .state::<agent::session::AgentSessionStore>()
        .list_sessions(&project.path)
        .into_iter()
        .find(|session| session.session_id == session_id);
    let Some(session) = session else {
        return err(404, "Conversation was not found");
    };
    let messages = session
        .messages
        .into_iter()
        .map(|message| {
            json!({
                "role": message.role,
                "content": message.content,
                "timestamp": message.timestamp,
            })
        })
        .collect::<Vec<_>>();
    ok(json!({
        "ok": true,
        "projectId": project.id,
        "session": {
            "id": session.session_id,
            "updatedAt": session.updated_at,
            "messages": messages,
        },
    }))
}

fn compact_session_title(content: &str) -> String {
    let compact = content.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut title = compact.chars().take(60).collect::<String>();
    if compact.chars().count() > 60 {
        title.push_str("...");
    }
    if title.is_empty() {
        "New conversation".to_string()
    } else {
        title
    }
}

fn handle_skills(app: &AppHandle, project_id: &str) -> ApiResponse {
    let project = match resolve_project(app, project_id) {
        Ok(project) => project,
        Err(error) => return err(404, error),
    };
    let skills = agent::skills::agent_list_skills(project.path.clone());
    ok(json!({ "ok": true, "projectId": project.id, "skills": skills }))
}

fn handle_settings(app: &AppHandle, project_id: &str) -> ApiResponse {
    let project = match resolve_project(app, project_id) {
        Ok(project) => project,
        Err(error) => return err(404, error),
    };
    let source_watch = load_source_watch_config(app, &project.id)
        .and_then(|config| serde_json::to_value(config).ok())
        .unwrap_or_else(|| json!({}));
    let source_watch = json!({
        "enabled": source_watch.get("enabled").and_then(Value::as_bool).unwrap_or(false),
        "autoIngest": source_watch.get("autoIngest").and_then(Value::as_bool).unwrap_or(false),
        "maxFileSizeMb": source_watch.get("maxFileSizeMb").and_then(Value::as_u64).unwrap_or(0),
    });
    let runtime = load_agent_runtime_config(app);
    let llm_configured = runtime
        .llm
        .as_ref()
        .is_some_and(agent::provider::LlmConfig::is_usable_for_backend_http);
    ok(json!({
        "ok": true,
        "projectId": project.id,
        "retrievalMode": if commands::search::keyword_only_mode() { "keyword_graph" } else { "default" },
        "embeddingEnabled": !commands::search::keyword_only_mode(),
        "llmConfigured": llm_configured,
        "clipServerStatus": clip_server::get_daemon_status().to_string(),
        "sourceWatch": source_watch,
        "api": {
            "loopbackOnly": !api_allow_lan_access(app),
            "tokenConfigured": api_token(app).is_some(),
            "mcpEnabled": api_mcp_enabled(app),
        },
    }))
}

fn handle_lint(app: &AppHandle, project_id: &str) -> ApiResponse {
    let project = match resolve_project(app, project_id) {
        Ok(project) => project,
        Err(error) => return err(404, error),
    };
    match lint_project_wiki(&project.path) {
        Ok((pages, issues)) => ok(json!({
            "ok": true,
            "projectId": project.id,
            "pages": pages,
            "issues": issues,
        })),
        Err(error) => err(500, error),
    }
}

fn lint_project_wiki(project_path: &str) -> Result<(usize, Vec<Value>), String> {
    let wiki = safe_join(project_path, "wiki")?;
    if !wiki.is_dir() {
        return Ok((0, Vec::new()));
    }
    let mut pages = Vec::<(String, String)>::new();
    let mut ids = BTreeSet::new();
    for entry in WalkDir::new(&wiki)
        .follow_links(false)
        .into_iter()
        .filter_map(Result::ok)
    {
        if !entry.file_type().is_file()
            || entry.path().extension().and_then(|value| value.to_str()) != Some("md")
        {
            continue;
        }
        let content = match fs::read_to_string(entry.path()) {
            Ok(content) => content,
            Err(_) => continue,
        };
        let rel = relative_to_project(project_path, entry.path());
        let id = entry
            .path()
            .file_stem()
            .and_then(|value| value.to_str())
            .unwrap_or_default()
            .to_string();
        if !id.is_empty() {
            ids.insert(id);
        }
        pages.push((rel, content));
    }
    let mut issues = Vec::new();
    for (path, content) in &pages {
        let frontmatter = content
            .strip_prefix("---\n")
            .and_then(|rest| rest.split_once("\n---"));
        let Some((frontmatter, _)) = frontmatter else {
            issues.push(json!({
                "id": format!("frontmatter:{path}"),
                "path": path,
                "severity": "warning",
                "message": "Page has no YAML frontmatter",
            }));
            continue;
        };
        let has_type = frontmatter
            .lines()
            .any(|line| line.trim_start().starts_with("type:"));
        let has_title = frontmatter.lines().any(|line| {
            line.trim_start()
                .strip_prefix("title:")
                .is_some_and(|value| !value.trim().trim_matches(['\"', '\'']).is_empty())
        });
        if !has_type {
            issues.push(json!({
                "id": format!("type:{path}"),
                "path": path,
                "severity": "warning",
                "message": "Page frontmatter has no type",
            }));
        }
        if !has_title {
            issues.push(json!({
                "id": format!("title:{path}"),
                "path": path,
                "severity": "warning",
                "message": "Page frontmatter has no title",
            }));
        }
        for link in extract_wikilinks(content) {
            if resolve_link(&link, &ids).is_none() {
                issues.push(json!({
                    "id": format!("link:{path}:{link}"),
                    "path": path,
                    "severity": "info",
                    "message": format!("Missing wiki link: [[{link}]]"),
                    "missingTitle": link,
                }));
            }
        }
    }
    issues.truncate(1_000);
    Ok((pages.len(), issues))
}

fn handle_rebuild_index(app: &AppHandle, project_id: &str) -> ApiResponse {
    let project = match resolve_project(app, project_id) {
        Ok(project) => project,
        Err(error) => return err(404, error),
    };
    match commands::project_maintenance::rebuild_wiki_index_inner(project.path.clone()) {
        Ok(result) => ok(json!({ "ok": true, "projectId": project.id, "result": result })),
        Err(error) => err(500, error),
    }
}

fn load_embedding_config(app: &AppHandle) -> Option<commands::search::SearchEmbeddingConfig> {
    let parsed = load_app_state(app)?;
    let value = parsed.get("embeddingConfig")?.clone();
    serde_json::from_value::<commands::search::SearchEmbeddingConfig>(value).ok()
}

fn clean_environment_value(value: Option<String>) -> Option<String> {
    value
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn llm_config_from_environment_values<F>(mut get: F) -> Option<agent::provider::LlmConfig>
where
    F: FnMut(&str) -> Option<String>,
{
    let provider = clean_environment_value(get("LLM_WIKI_LLM_PROVIDER"))?.to_ascii_lowercase();
    Some(agent::provider::LlmConfig {
        provider,
        api_key: clean_environment_value(get("LLM_WIKI_LLM_API_KEY")).unwrap_or_default(),
        model: clean_environment_value(get("LLM_WIKI_LLM_MODEL")).unwrap_or_default(),
        ollama_url: clean_environment_value(get("LLM_WIKI_LLM_OLLAMA_URL")).unwrap_or_default(),
        custom_endpoint: clean_environment_value(get("LLM_WIKI_LLM_CUSTOM_ENDPOINT"))
            .unwrap_or_default(),
        azure_api_version: clean_environment_value(get("LLM_WIKI_LLM_AZURE_API_VERSION")),
        api_mode: clean_environment_value(get("LLM_WIKI_LLM_API_MODE")),
        reasoning: None,
        max_tokens: clean_environment_value(get("LLM_WIKI_LLM_MAX_TOKENS"))
            .and_then(|value| value.parse::<u32>().ok())
            .filter(|value| *value > 0),
        max_context_size: clean_environment_value(get("LLM_WIKI_LLM_MAX_CONTEXT_SIZE"))
            .and_then(|value| value.parse::<usize>().ok())
            .filter(|value| *value > 0),
    })
}

fn llm_config_from_environment() -> Option<agent::provider::LlmConfig> {
    llm_config_from_environment_values(|key| std::env::var(key).ok())
}

#[derive(Debug, Clone, Default)]
struct AgentRuntimeConfig {
    embedding: Option<commands::search::SearchEmbeddingConfig>,
    llm: Option<agent::provider::LlmConfig>,
    web_search: Option<agent::tools::WebSearchConfig>,
    anytxt: Option<agent::tools::AnyTxtConfig>,
}

fn load_agent_runtime_config(app: &AppHandle) -> AgentRuntimeConfig {
    let parsed = load_app_state(app);
    AgentRuntimeConfig {
        embedding: parsed
            .as_ref()
            .and_then(|value| value.get("embeddingConfig"))
            .cloned()
            .and_then(|value| serde_json::from_value(value).ok()),
        // A Studio-managed headless service cannot depend on an old Wiki
        // window for first-run setup. Environment configuration takes
        // precedence so the API key remains outside app-state and Git.
        llm: llm_config_from_environment().or_else(|| {
            parsed
                .as_ref()
                .and_then(|value| value.get("llmConfig"))
                .cloned()
                .and_then(|value| serde_json::from_value(value).ok())
        }),
        web_search: parsed
            .as_ref()
            .and_then(|value| value.get("searchApiConfig"))
            .cloned()
            .and_then(|value| serde_json::from_value(value).ok()),
        anytxt: parsed
            .as_ref()
            .and_then(|value| value.get("searchApiConfig"))
            .and_then(|value| value.get("anyTxt"))
            .cloned()
            .and_then(|value| serde_json::from_value(value).ok()),
    }
}

fn llm_config_source(app: &AppHandle) -> &'static str {
    if llm_config_from_environment().is_some() {
        "environment"
    } else if load_app_state(app)
        .and_then(|value| value.get("llmConfig").cloned())
        .and_then(|value| serde_json::from_value::<agent::provider::LlmConfig>(value).ok())
        .is_some()
    {
        "store"
    } else {
        "none"
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ApiGraphNode {
    id: String,
    label: String,
    title_zh: String,
    node_type: String,
    content_kind: String,
    path: String,
    link_count: usize,
    tags: Vec<String>,
    authors: Vec<String>,
    year: Option<u32>,
    #[serde(skip_serializing_if = "String::is_empty")]
    summary: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    topics: Vec<String>,
    #[serde(default)]
    enriched: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ApiGraphEdge {
    source: String,
    target: String,
    weight: f64,
    kind: String,
    relation: String,
    /// llm | link | inferred —— 关系标签的来源。
    #[serde(skip_serializing_if = "String::is_empty")]
    relation_source: String,
    /// LLM 给出的一句话依据（仅 llm 来源时有值）。
    #[serde(skip_serializing_if = "String::is_empty")]
    evidence: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    shared_terms: Vec<String>,
}

#[derive(Debug, Clone)]
struct GraphPage {
    title: String,
    title_zh: String,
    node_type: String,
    content_kind: String,
    path: String,
    links: Vec<GraphLink>,
    tags: Vec<String>,
    authors: Vec<String>,
    year: Option<u32>,
    summary: String,
    terms: BTreeMap<String, f64>,
    /// LLM 增强的具体研究主题（覆盖层，内容哈希校验通过才填充）。
    topics: Vec<String>,
    /// 该页面是否命中了有效的 LLM 增强结果。
    enriched: bool,
}

#[derive(Debug, Clone)]
struct GraphLink {
    target: String,
    relation: String,
}

fn handle_graph(app: &AppHandle, project_id: &str, query: &str) -> ApiResponse {
    let project = match resolve_project(app, project_id) {
        Ok(project) => project,
        Err(e) => return err(404, e),
    };
    let params = parse_query(query);
    let q = params.get("q").map(|s| s.to_lowercase());
    let node_type = params.get("nodeType").map(|s| s.to_lowercase());
    let limit = params
        .get("limit")
        .and_then(|s| s.parse::<usize>().ok())
        .unwrap_or(200)
        .clamp(1, 1000);

    match build_graph(&project.path) {
        Ok((mut nodes, edges)) => {
            if let Some(ref q) = q {
                nodes.retain(|n| {
                    n.id.to_lowercase().contains(q) || n.label.to_lowercase().contains(q)
                });
            }
            if let Some(ref node_type) = node_type {
                nodes.retain(|n| n.node_type == *node_type);
            }
            nodes.truncate(limit);
            let ids: BTreeSet<String> = nodes.iter().map(|n| n.id.clone()).collect();
            let edges: Vec<ApiGraphEdge> = edges
                .into_iter()
                .filter(|e| ids.contains(&e.source) && ids.contains(&e.target))
                .collect();
            ok(json!({ "ok": true, "projectId": project.id, "nodes": nodes, "edges": edges }))
        }
        Err(e) => err(500, e),
    }
}

fn handle_enrich_start(app: &AppHandle, project_id: &str, body: &str) -> ApiResponse {
    let project = match resolve_project(app, project_id) {
        Ok(project) => project,
        Err(error) => return err(404, error),
    };
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct EnrichRequest {
        limit: Option<usize>,
        force: Option<bool>,
        include_relations: Option<bool>,
    }
    let options: crate::llm_enrich::EnrichOptions = if body.trim().is_empty() {
        Default::default()
    } else {
        match serde_json::from_str::<EnrichRequest>(body) {
            Ok(request) => crate::llm_enrich::EnrichOptions {
                limit: request.limit,
                force: request.force,
                include_relations: request.include_relations,
            },
            Err(error) => return err(400, format!("Invalid JSON: {error}")),
        }
    };
    // 环境变量优先，其次应用内设置——与 Agent 对话使用同一套后台 API Key。
    let Some(llm) = load_agent_runtime_config(app).llm else {
        return err(
            409,
            "LLM 未配置：请先在设置中配置模型（provider/model/apiKey）或设置 LLM_WIKI_LLM_* 环境变量",
        );
    };
    match crate::llm_enrich::start_enrichment(project.id.clone(), project.path.clone(), llm, options)
    {
        Ok(status) => ok(status),
        Err(error) if error.contains("已有增强任务") || error.contains("LLM 未配置") => {
            err(409, error)
        }
        Err(error) => err(500, error),
    }
}

fn handle_enrich_cancel(app: &AppHandle, project_id: &str) -> ApiResponse {
    let project = match resolve_project(app, project_id) {
        Ok(project) => project,
        Err(error) => return err(404, error),
    };
    let running = crate::llm_enrich::request_cancel(&project.path);
    let mut status = crate::llm_enrich::job_status(&project.path);
    if let Some(object) = status.as_object_mut() {
        object.insert("ok".to_string(), json!(true));
        object.insert("projectId".to_string(), json!(project.id));
        object.insert("requested".to_string(), json!(running));
    }
    ok(status)
}

fn handle_enrich_status(app: &AppHandle, project_id: &str) -> ApiResponse {
    let project = match resolve_project(app, project_id) {
        Ok(project) => project,
        Err(error) => return err(404, error),
    };
    let mut status = crate::llm_enrich::job_status(&project.path);
    if let Some(object) = status.as_object_mut() {
        object.insert("ok".to_string(), json!(true));
        object.insert("projectId".to_string(), json!(project.id));
    }
    ok(status)
}

fn handle_enrich_info(app: &AppHandle, project_id: &str) -> ApiResponse {
    let project = match resolve_project(app, project_id) {
        Ok(project) => project,
        Err(error) => return err(404, error),
    };
    ok(json!({
        "ok": true,
        "projectId": project.id,
        "overlay": crate::llm_enrich::overlay_summary(&project.path),
    }))
}

fn build_graph(project_path: &str) -> Result<(Vec<ApiGraphNode>, Vec<ApiGraphEdge>), String> {
    let wiki_root = Path::new(project_path).join("wiki");
    // LLM 增强覆盖层（可选）：内容哈希匹配的条目才会参与标签/摘要/关系。
    let overlay = crate::llm_enrich::load_overlay(project_path);
    let mut raw: BTreeMap<String, GraphPage> = BTreeMap::new();
    for entry in WalkDir::new(&wiki_root).into_iter().filter_map(Result::ok) {
        if !entry.file_type().is_file()
            || entry.path().extension().and_then(|s| s.to_str()) != Some("md")
        {
            continue;
        }
        let content = match fs::read_to_string(entry.path()) {
            Ok(content) => content,
            Err(_) => continue,
        };
        let path = relative_to_project(project_path, entry.path());
        let id = path
            .strip_prefix("wiki/")
            .unwrap_or(&path)
            .strip_suffix(".md")
            .unwrap_or(&path)
            .to_string();
        if id.is_empty() {
            continue;
        }
        let title =
            commands::search::extract_title(&content, entry.file_name().to_string_lossy().as_ref());
        let node_type = extract_type(&content);
        let content_kind =
            extract_frontmatter_value(&content, "content_kind").unwrap_or_else(|| {
                if node_type == "paper" {
                    "paper".to_string()
                } else if node_type == "source" {
                    "technical_article".to_string()
                } else {
                    String::new()
                }
            });
        let title_zh =
            extract_frontmatter_value(&content, "title_zh").unwrap_or_else(|| title.clone());
        let mut tags = extract_frontmatter_list(&content, "domain_tags");
        // 白名单归一化：只保留固定中文体系（数据采集/存储/计算/传输/治理/质量/安全/智能）
        // 内的标签。入库归纳时模型偶尔会生造体系外的标签（例如“评测方法”“研究基础”），
        // 这里一律丢弃；过滤后为空则按 wiki 页面标题+正文关键词重新推断。
        tags.retain(|tag| DATA_DOMAIN_TAGS.contains(&tag.as_str()));
        let mut seen_tags = std::collections::BTreeSet::new();
        tags.retain(|tag| seen_tags.insert(tag.clone()));
        if tags.is_empty() {
            tags = infer_data_domain_tags(&format!("{title} {content}"));
        }
        let mut summary = extract_frontmatter_value(&content, "summary")
            .unwrap_or_else(|| extract_summary(&content));
        // LLM 增强覆盖层：内容未变时，用模型给出的更具体领域标签扩充节点标签，
        // 并优先使用语义摘要。陈旧条目（页面已编辑）自动失效。
        let enriched_page = overlay
            .as_ref()
            .and_then(|overlay| overlay.pages.get(&id))
            .filter(|entry| entry.content_hash == crate::llm_enrich::content_hash(&content));
        let mut topics = Vec::new();
        let mut enriched = false;
        if let Some(entry) = enriched_page {
            enriched = true;
            if !entry.summary.is_empty() {
                summary = entry.summary.clone();
            }
            topics = entry.topics.clone();
            for tag in &entry.tags {
                if !tags.contains(tag) && tags.len() < 8 {
                    tags.push(tag.clone());
                }
            }
        }
        let authors = extract_frontmatter_list(&content, "authors");
        let year =
            extract_frontmatter_value(&content, "year").and_then(|value| value.parse::<u32>().ok());
        let links = extract_graph_links(&content);
        let terms = if matches!(
            content_kind.as_str(),
            "paper" | "technical_article" | "article"
        ) || node_type == "paper"
        {
            graph_term_counts(&title, &content)
        } else {
            BTreeMap::new()
        };
        raw.insert(
            id,
            GraphPage {
                title,
                title_zh,
                node_type,
                content_kind,
                path,
                links,
                tags,
                authors,
                year,
                summary,
                terms,
                topics,
                enriched,
            },
        );
    }
    let ids: BTreeSet<String> = raw.keys().cloned().collect();
    let mut link_count: BTreeMap<String, usize> = raw.keys().map(|id| (id.clone(), 0)).collect();
    let mut seen = BTreeSet::new();
    let mut edges = Vec::new();
    for (source, page) in &raw {
        for link in &page.links {
            let Some(target) = resolve_link(&link.target, &ids) else {
                continue;
            };
            if &target == source {
                continue;
            }
            let key = if source < &target {
                format!("{source}::{target}")
            } else {
                format!("{target}::{source}")
            };
            if seen.insert(key) {
                *link_count.entry(source.clone()).or_default() += 1;
                *link_count.entry(target.clone()).or_default() += 1;
                let mut relation = if link.relation.is_empty() {
                    inferred_graph_relation(page, raw.get(&target), &[])
                } else {
                    link.relation.clone()
                };
                let mut relation_source = if link.relation.is_empty() {
                    "inferred".to_string()
                } else {
                    "link".to_string()
                };
                let mut evidence = String::new();
                if let Some((llm_relation, llm_evidence)) =
                    overlay_relation_label(overlay.as_ref(), &raw, source, &target)
                {
                    relation = llm_relation;
                    evidence = llm_evidence;
                    relation_source = "llm".to_string();
                }
                edges.push(ApiGraphEdge {
                    source: source.clone(),
                    relation,
                    relation_source,
                    evidence,
                    target,
                    weight: 1.0,
                    kind: "wikilink".to_string(),
                    shared_terms: Vec::new(),
                });
            }
        }
    }

    add_keyword_similarity_edges(&raw, overlay.as_ref(), &mut link_count, &mut seen, &mut edges);

    let nodes = raw
        .into_iter()
        .filter(|(_, page)| page.node_type != "query")
        .map(|(id, page)| ApiGraphNode {
            link_count: *link_count.get(&id).unwrap_or(&0),
            id,
            label: page.title,
            title_zh: page.title_zh,
            node_type: page.node_type,
            content_kind: page.content_kind,
            path: page.path,
            tags: page.tags,
            authors: page.authors,
            year: page.year,
            summary: page.summary,
            topics: page.topics,
            enriched: page.enriched,
        })
        .collect();
    Ok((nodes, edges))
}

/// 若覆盖层中存在该文章对（双向）的 LLM 关系标签且两端页面内容均未变化，
/// 返回 `(关系短语, 依据)`。
fn overlay_relation_label(
    overlay: Option<&crate::llm_enrich::EnrichmentOverlay>,
    pages: &BTreeMap<String, GraphPage>,
    source: &str,
    target: &str,
) -> Option<(String, String)> {
    let overlay = overlay?;
    let source_fresh = pages.get(source)?.enriched;
    let target_fresh = pages.get(target)?.enriched;
    if !source_fresh || !target_fresh {
        return None;
    }
    let relation = overlay.relation_for(source, target)?;
    Some((relation.relation.clone(), relation.evidence.clone()))
}

fn add_keyword_similarity_edges(
    pages: &BTreeMap<String, GraphPage>,
    overlay: Option<&crate::llm_enrich::EnrichmentOverlay>,
    link_count: &mut BTreeMap<String, usize>,
    seen: &mut BTreeSet<String>,
    edges: &mut Vec<ApiGraphEdge>,
) {
    let papers = pages
        .iter()
        .filter(|(_, page)| {
            (page.node_type == "paper"
                || matches!(
                    page.content_kind.as_str(),
                    "paper" | "technical_article" | "article"
                ))
                && !page.terms.is_empty()
        })
        .collect::<Vec<_>>();
    if papers.len() < 2 {
        return;
    }

    let mut document_frequency = BTreeMap::<String, usize>::new();
    for (_, page) in &papers {
        for term in page.terms.keys() {
            *document_frequency.entry(term.clone()).or_default() += 1;
        }
    }
    let document_count = papers.len() as f64;
    let vectors = papers
        .iter()
        .map(|(_, page)| {
            let mut vector = BTreeMap::new();
            let mut norm_squared = 0.0;
            for (term, count) in &page.terms {
                let frequency = *document_frequency.get(term).unwrap_or(&1) as f64;
                let idf = ((document_count + 1.0) / (frequency + 1.0)).ln() + 1.0;
                let weight = (1.0 + count.ln()) * idf;
                norm_squared += weight * weight;
                vector.insert(term.clone(), weight);
            }
            (vector, norm_squared.sqrt())
        })
        .collect::<Vec<_>>();

    let mut candidates = Vec::<(f64, usize, usize, Vec<String>)>::new();
    for left in 0..papers.len() {
        for right in (left + 1)..papers.len() {
            let (left_vector, left_norm) = &vectors[left];
            let (right_vector, right_norm) = &vectors[right];
            if *left_norm == 0.0 || *right_norm == 0.0 {
                continue;
            }
            let (small, large) = if left_vector.len() <= right_vector.len() {
                (left_vector, right_vector)
            } else {
                (right_vector, left_vector)
            };
            let mut dot = 0.0;
            let mut shared = Vec::<(f64, String)>::new();
            for (term, weight) in small {
                if let Some(other) = large.get(term) {
                    let contribution = weight * other;
                    dot += contribution;
                    shared.push((contribution, term.clone()));
                }
            }
            if dot == 0.0 {
                continue;
            }
            let score = dot / (left_norm * right_norm);
            if score < 0.035 {
                continue;
            }
            shared.sort_by(|a, b| b.0.total_cmp(&a.0).then_with(|| a.1.cmp(&b.1)));
            candidates.push((
                score,
                left,
                right,
                shared.into_iter().take(5).map(|(_, term)| term).collect(),
            ));
        }
    }
    candidates.sort_by(|a, b| b.0.total_cmp(&a.0));

    let mut similarity_degree = vec![0usize; papers.len()];
    for (score, left, right, shared_terms) in candidates {
        if similarity_degree[left] >= 3 || similarity_degree[right] >= 3 {
            continue;
        }
        let source = papers[left].0.clone();
        let target = papers[right].0.clone();
        let key = if source < target {
            format!("{source}::{target}")
        } else {
            format!("{target}::{source}")
        };
        if !seen.insert(key) {
            continue;
        }
        similarity_degree[left] += 1;
        similarity_degree[right] += 1;
        *link_count.entry(source.clone()).or_default() += 1;
        *link_count.entry(target.clone()).or_default() += 1;
        let mut relation =
            inferred_graph_relation(papers[left].1, Some(papers[right].1), &shared_terms);
        let mut relation_source = "inferred".to_string();
        let mut evidence = String::new();
        if let Some((llm_relation, llm_evidence)) =
            overlay_relation_label(overlay, pages, &source, &target)
        {
            relation = llm_relation;
            evidence = llm_evidence;
            relation_source = "llm".to_string();
        }
        edges.push(ApiGraphEdge {
            source,
            target,
            weight: (score * 1000.0).round() / 1000.0,
            kind: "keyword_similarity".to_string(),
            relation,
            relation_source,
            evidence,
            shared_terms,
        });
    }
}

fn graph_term_counts(title: &str, content: &str) -> BTreeMap<String, f64> {
    let mut counts = BTreeMap::<String, f64>::new();
    for term in graph_terms(title) {
        *counts.entry(term).or_default() += 6.0;
    }
    let body = content.chars().take(120_000).collect::<String>();
    for term in graph_terms(&body) {
        let value = counts.entry(term).or_default();
        *value = (*value + 1.0).min(12.0);
    }
    let mut ranked = counts.into_iter().collect::<Vec<_>>();
    ranked.sort_by(|a, b| b.1.total_cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    ranked.into_iter().take(80).collect()
}

fn graph_terms(text: &str) -> Vec<String> {
    const STOP_WORDS: &[&str] = &[
        "about", "after", "also", "among", "based", "been", "being", "between", "both", "could",
        "does", "each", "from", "have", "into", "more", "most", "other", "over", "paper",
        "results", "show", "such", "than", "that", "their", "there", "these", "they", "this",
        "through", "using", "very", "were", "which", "while", "with", "would",
    ];
    let stop_words = STOP_WORDS.iter().copied().collect::<BTreeSet<_>>();
    let mut terms = Vec::new();
    let mut ascii = String::new();
    let mut cjk = String::new();

    let flush_ascii = |buffer: &mut String, output: &mut Vec<String>| {
        if buffer.len() >= 3 && !stop_words.contains(buffer.as_str()) {
            output.push(buffer.clone());
        }
        buffer.clear();
    };
    let flush_cjk = |buffer: &mut String, output: &mut Vec<String>| {
        let chars = buffer.chars().collect::<Vec<_>>();
        if chars.len() == 1 {
            output.push(chars[0].to_string());
        } else {
            for pair in chars.windows(2) {
                output.push(pair.iter().collect());
            }
        }
        buffer.clear();
    };

    for character in text.chars() {
        if character.is_ascii_alphanumeric() {
            flush_cjk(&mut cjk, &mut terms);
            ascii.push(character.to_ascii_lowercase());
        } else if matches!(character as u32, 0x3400..=0x9fff) {
            flush_ascii(&mut ascii, &mut terms);
            cjk.push(character);
        } else {
            flush_ascii(&mut ascii, &mut terms);
            flush_cjk(&mut cjk, &mut terms);
        }
    }
    flush_ascii(&mut ascii, &mut terms);
    flush_cjk(&mut cjk, &mut terms);
    terms
}

fn extract_type(content: &str) -> String {
    for line in content.lines() {
        if let Some(value) = line.trim().strip_prefix("type:") {
            return value
                .trim()
                .trim_matches('"')
                .trim_matches('\'')
                .to_lowercase();
        }
    }
    "other".to_string()
}

fn frontmatter(content: &str) -> Option<&str> {
    let rest = content
        .strip_prefix("---\n")
        .or_else(|| content.strip_prefix("---\r\n"))?;
    let end = rest.find("\n---")?;
    Some(&rest[..end])
}

fn extract_frontmatter_value(content: &str, key: &str) -> Option<String> {
    let prefix = format!("{key}:");
    frontmatter(content)?
        .lines()
        .find_map(|line| line.trim().strip_prefix(&prefix))
        .map(|value| value.trim().trim_matches(['\'', '"']).trim().to_string())
        .filter(|value| !value.is_empty())
}

fn extract_frontmatter_list(content: &str, key: &str) -> Vec<String> {
    extract_frontmatter_value(content, key)
        .map(|value| {
            value
                .trim_matches(['[', ']'])
                .split(',')
                .map(|item| item.trim().trim_matches(['\'', '"']).to_string())
                .filter(|item| !item.is_empty())
                .take(8)
                .collect()
        })
        .unwrap_or_default()
}

fn extract_summary(content: &str) -> String {
    let body = content.splitn(3, "---").nth(2).unwrap_or(content);
    body.lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with('#') && !line.starts_with('-'))
        .next()
        .unwrap_or("")
        .chars()
        .take(180)
        .collect()
}

/// 固定中文领域标签体系（与入库归纳提示词一致；前端只展示这 8 类，不随论文增长）。
const DATA_DOMAIN_TAGS: &[&str] = &[
    "数据采集",
    "数据存储",
    "数据计算",
    "数据传输",
    "数据治理",
    "数据质量",
    "数据安全",
    "数据智能",
];

/// 推断不出任何领域标签时的兜底中文标签。
const DATA_DOMAIN_FALLBACK_TAG: &str = "数据技术";

/// 英文关键词按整词匹配（避免 "ai" 误命中 "available"、"main" 等）。
fn contains_english_word(lower: &str, word: &str) -> bool {
    let lower_bytes = lower.as_bytes();
    let needle_bytes = word.as_bytes();
    if needle_bytes.is_empty() || needle_bytes.len() > lower_bytes.len() {
        return false;
    }
    let mut pos = 0usize;
    while pos + needle_bytes.len() <= lower_bytes.len() {
        if &lower_bytes[pos..pos + needle_bytes.len()] == needle_bytes {
            let before_ok = pos == 0 || !lower_bytes[pos - 1].is_ascii_alphanumeric();
            let after = pos + needle_bytes.len();
            let after_ok = after >= lower_bytes.len() || !lower_bytes[after].is_ascii_alphanumeric();
            if before_ok && after_ok {
                return true;
            }
        }
        pos += 1;
    }
    false
}

/// 规则命中：纯英文（含空格短语）关键词整词匹配；含中文的关键词子串匹配。
fn tag_rule_hits(lower: &str, words: &[&str]) -> bool {
    words.iter().any(|word| {
        if word.chars().all(|c| c.is_ascii_alphabetic() || c == ' ') {
            contains_english_word(lower, word)
        } else {
            lower.contains(word)
        }
    })
}

fn infer_data_domain_tags(text: &str) -> Vec<String> {
    let lower = text.to_lowercase();
    let rules: &[(&str, &[&str])] = &[
        (
            "数据采集",
            &["采集", "ingestion", "采样", "sensor", "埋点", "cdc"],
        ),
        (
            "数据存储",
            &[
                "存储",
                "database",
                "storage",
                "lakehouse",
                "warehouse",
                "数据库",
                "数据湖",
            ],
        ),
        (
            "数据计算",
            &["计算", "compute", "spark", "flink", "查询", "query", "引擎"],
        ),
        (
            "数据治理",
            &[
                "治理",
                "governance",
                "metadata",
                "元数据",
                "血缘",
                "catalog",
            ],
        ),
        (
            "数据质量",
            &["质量", "quality", "清洗", "validation", "异常检测"],
        ),
        (
            "数据安全",
            &["安全", "security", "privacy", "隐私", "脱敏", "权限"],
        ),
        (
            "数据传输",
            &["传输", "stream", "流式", "消息队列", "kafka", "同步"],
        ),
        (
            "数据智能",
            &[
                "机器学习",
                "machine learning",
                "llm",
                "ai",
                "智能",
                "rag",
                "agent",
            ],
        ),
    ];
    let mut tags = rules
        .iter()
        .filter(|(_, words)| tag_rule_hits(&lower, words))
        .map(|(label, _)| (*label).to_string())
        .take(3)
        .collect::<Vec<_>>();
    if tags.is_empty() {
        tags.push(DATA_DOMAIN_FALLBACK_TAG.to_string());
    }
    tags
}

fn inferred_graph_relation(
    source: &GraphPage,
    target: Option<&GraphPage>,
    shared_terms: &[String],
) -> String {
    let Some(target) = target else {
        return "研究延伸".to_string();
    };
    let source_text = graph_relation_text(source);
    let target_text = graph_relation_text(target);
    let shared_text = shared_terms.join(" ").to_lowercase();

    // Data engineering domains are intentionally checked before generic
    // research labels so the graph answers "what kind of relationship".
    let domain_rules: &[(&str, &[&str])] = &[
        ("数据采集", &["采集", "ingestion", "ingest", "cdc", "sensor", "capture", "source"]),
        ("数据存储", &["存储", "storage", "lakehouse", "data lake", "warehouse", "database", "parquet", "delta lake", "table"]),
        ("数据计算", &["计算", "compute", "query", "spark", "flink", "stream processing", "processing", "engine", "throughput", "latency"]),
        ("数据治理", &["治理", "governance", "metadata", "元数据", "lineage", "血缘", "catalog", "policy"]),
        ("数据质量", &["质量", "quality", "validation", "cleaning", "cleansing", "completeness", "accuracy", "anomaly"]),
        ("数据安全", &["安全", "security", "privacy", "隐私", "access control", "encryption", "federated", "threat"]),
    ];
    for (label, keywords) in domain_rules {
        if keywords.iter().any(|keyword| {
            source_text.contains(keyword) && target_text.contains(keyword)
                || shared_text.contains(keyword)
        }) {
            return (*label).to_string();
        }
    }

    let source_title = source.title.to_lowercase();
    let target_title = target.title.to_lowercase();
    let is_review = |title: &str| {
        ["survey", "review", "overview", "taxonomy", "综述", "概览"]
            .iter()
            .any(|term| title.contains(term))
    };
    if is_review(&source_title) || is_review(&target_title) {
        return "研究基础".to_string();
    }
    if ["evaluation", "benchmark", "评测", "基准"]
        .iter()
        .any(|term| source_title.contains(term) || target_title.contains(term) || shared_text.contains(term))
    {
        return "评测方法".to_string();
    }
    if ["production", "deployment", "platform", "architecture", "implementation", "system", "平台", "架构", "落地"]
        .iter()
        .any(|term| source_text.contains(term) || target_text.contains(term))
    {
        return if source.content_kind == "technical_article" || target.content_kind == "technical_article" {
            "工程落地".to_string()
        } else {
            "方法改进".to_string()
        };
    }
    if !shared_terms.is_empty() {
        "方法改进".to_string()
    } else if source.content_kind == "technical_article" || target.content_kind == "technical_article" {
        "工程落地".to_string()
    } else {
        "研究延伸".to_string()
    }
}

fn graph_relation_text(page: &GraphPage) -> String {
    format!(
        "{} {} {} {} {}",
        page.title.to_lowercase(),
        page.title_zh.to_lowercase(),
        page.tags.join(" ").to_lowercase(),
        page.summary.to_lowercase(),
        page.terms.keys().cloned().collect::<Vec<_>>().join(" ").to_lowercase(),
    )
}

fn extract_graph_links(content: &str) -> Vec<GraphLink> {
    let mut out = Vec::new();
    for line in content.lines() {
        let mut rest = line;
        while let Some(start) = rest.find("[[") {
            rest = &rest[start + 2..];
            let Some(end) = rest.find("]]") else { break };
            let inner = &rest[..end];
            let mut parts = inner.splitn(2, '|');
            let target = parts.next().unwrap_or("").trim();
            let alias = parts.next().unwrap_or("").trim();
            let raw_tail = rest[end + 2..].trim_start();
            let has_relation_separator = raw_tail.starts_with([':', '：', '—', '–']);
            let tail = raw_tail.trim_start_matches(|character: char| {
                character.is_whitespace() || matches!(character, ':' | '：' | '—' | '–')
            });
            let trailing = if has_relation_separator { tail } else { "" }
                .split(['。', '；', ';', ',', '，', '|'])
                .next()
                .unwrap_or("")
                .trim()
                .chars()
                .take(18)
                .collect::<String>();
            if !target.is_empty() {
                out.push(GraphLink {
                    target: target.to_string(),
                    relation: if trailing.is_empty() {
                        alias.to_string()
                    } else {
                        trailing
                    },
                });
            }
            rest = &rest[end + 2..];
        }
    }
    out
}

fn extract_wikilinks(content: &str) -> Vec<String> {
    extract_graph_links(content)
        .into_iter()
        .map(|link| link.target)
        .collect()
}

fn resolve_link(raw: &str, ids: &BTreeSet<String>) -> Option<String> {
    let raw = raw
        .trim()
        .trim_matches('/')
        .strip_prefix("wiki/")
        .unwrap_or(raw.trim().trim_matches('/'))
        .strip_suffix(".md")
        .unwrap_or_else(|| {
            raw.trim()
                .trim_matches('/')
                .strip_prefix("wiki/")
                .unwrap_or(raw.trim().trim_matches('/'))
        });
    if let Some(id) = ids.iter().find(|id| id.eq_ignore_ascii_case(raw)) {
        return Some(id.clone());
    }

    // Wiki links may include a project-relative directory (for example
    // `papers/foo`) and an optional Markdown extension, while graph node IDs
    // are file stems. Resolve the final path component before comparing IDs.
    let path_name = raw.rsplit(['/', '\\']).next().unwrap_or(raw);
    let normalized = path_name.to_lowercase().replace(' ', "-");
    ids.iter()
        .find(|id| {
            let id_name = id.rsplit('/').next().unwrap_or(id);
            id.to_lowercase() == normalized
                || id_name.to_lowercase().replace(' ', "-") == normalized
                || id_name.eq_ignore_ascii_case(path_name)
        })
        .cloned()
}

fn handle_rescan(app: &AppHandle, project_id: &str) -> ApiResponse {
    let project = match resolve_project(app, project_id) {
        Ok(project) => project,
        Err(e) => return err(404, e),
    };
    let source_watch_config = load_source_watch_config(app, &project.id);
    match commands::file_sync::rescan_project_files(
        app.clone(),
        project.id.clone(),
        project.path.clone(),
        source_watch_config,
    ) {
        Ok(result) => ok(json!({ "ok": true, "projectId": project.id, "result": result })),
        Err(e) => err(500, e),
    }
}

fn load_source_watch_config(
    app: &AppHandle,
    project_id: &str,
) -> Option<commands::file_sync::SourceWatchConfig> {
    let parsed = load_app_state(app)?;
    let settings = parsed.get("sourceWatchConfig").and_then(Value::as_object);
    if let Some(value) = settings
        .and_then(|s| s.get(project_id).or_else(|| s.get("default")))
        .cloned()
    {
        if let Ok(config) = serde_json::from_value::<commands::file_sync::SourceWatchConfig>(value)
        {
            return Some(config);
        }
    }
    let legacy_enabled = parsed
        .get("projectFileSyncEnabled")
        .and_then(Value::as_object)
        .and_then(|settings| {
            settings
                .get(project_id)
                .or_else(|| settings.get("default"))
                .and_then(Value::as_bool)
        });
    legacy_enabled.and_then(|enabled| {
        serde_json::from_value::<commands::file_sync::SourceWatchConfig>(
            json!({ "enabled": enabled }),
        )
        .ok()
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn test_project_dir() -> PathBuf {
        // Per-process atomic sequence appended to the timestamp so two
        // tests calling this concurrently can't collide on the same dir
        // (nanos alone are not unique enough under parallel `cargo test`,
        // which would let one test's remove_dir_all delete another's files).
        use std::sync::atomic::{AtomicU64, Ordering};
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let id = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let seq = COUNTER.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!("llm-wiki-api-test-{id}-{seq}"));
        fs::create_dir_all(path.join("wiki")).unwrap();
        path
    }

    #[test]
    fn safe_join_rejects_traversal() {
        let root = test_project_dir();
        let root_str = root.to_string_lossy();
        assert!(safe_join(&root_str, "../secret.md").is_err());
        assert!(safe_join(&root_str, "wiki/../../secret.md").is_err());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn safe_join_accepts_project_relative_paths() {
        let root = test_project_dir();
        let root_str = root.to_string_lossy();
        let joined = safe_join(&root_str, "wiki/index.md").unwrap();
        assert_eq!(joined, root.join("wiki/index.md"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn relative_to_project_handles_canonical_project_paths() {
        let root = test_project_dir();
        let papers = root.join("wiki/papers");
        fs::create_dir_all(&papers).unwrap();
        let file = papers.join("paper.md");
        fs::write(&file, "# Paper").unwrap();

        let canonical_file = file.canonicalize().unwrap();
        let relative = relative_to_project(&root.to_string_lossy(), &canonical_file);
        assert_eq!(relative, "wiki/papers/paper.md");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn graph_adds_keyword_similarity_edges_between_papers() {
        let root = test_project_dir();
        let papers = root.join("wiki/papers");
        fs::create_dir_all(&papers).unwrap();
        fs::write(
            papers.join("photonic-a.md"),
            "---\ntype: paper\ntitle: Photonic matrix accelerator\n---\nPhotonic matrix multiplication accelerator using optical tensor cores.",
        )
        .unwrap();
        fs::write(
            papers.join("photonic-b.md"),
            "---\ntype: paper\ntitle: Optical photonic tensor accelerator\n---\nAn optical photonic accelerator performs matrix multiplication with tensor cores.",
        )
        .unwrap();
        fs::write(
            papers.join("biology.md"),
            "---\ntype: paper\ntitle: Cellular protein regulation\n---\nA biological study of protein expression and cellular regulation.",
        )
        .unwrap();

        let (nodes, edges) = build_graph(root.to_string_lossy().as_ref()).unwrap();
        assert!(nodes.iter().any(|node| node.id == "papers/photonic-a"));
        assert!(edges.iter().any(|edge| {
            edge.kind == "keyword_similarity"
                && ((edge.source == "papers/photonic-a" && edge.target == "papers/photonic-b")
                    || (edge.source == "papers/photonic-b" && edge.target == "papers/photonic-a"))
                && !edge.shared_terms.is_empty()
        }));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn domain_tags_are_normalized_to_the_fixed_chinese_taxonomy() {
        // 1) 入库时模型生造的体系外标签（如“评测方法/研究基础”）会被丢弃并重新推断；
        // 2) 英文关键词按整词匹配，避免 "ai" 误命中 "available"。
        let root = test_project_dir();
        let sources = root.join("wiki/sources");
        fs::create_dir_all(&sources).unwrap();
        fs::write(
            sources.join("eval-stream.md"),
            "---\ntype: paper\ntitle: Stream processing evaluation\ncontent_kind: paper\ndomain_tags: [数据计算, 评测方法]\n---\n# Stream processing evaluation\n\nFlink and Kafka based stream processing with throughput measurement and query engine benchmarks.\n",
        )
        .unwrap();
        fs::write(
            sources.join("privacy.md"),
            "---\ntype: paper\ntitle: ML privacy attack survey\ncontent_kind: paper\ndomain_tags: [研究基础, ML]\n---\n# ML privacy attack survey\n\nPrivacy attacks and defense mechanisms with security guarantees for available datasets.\n",
        )
        .unwrap();

        let (nodes, _) = build_graph(root.to_string_lossy().as_ref()).unwrap();
        let eval_node = nodes.iter().find(|node| node.id == "sources/eval-stream").unwrap();
        // 体系外的“评测方法”被丢弃；保留的“数据计算”仍在体系内。
        assert_eq!(eval_node.tags, vec!["数据计算"]);

        let privacy_node = nodes.iter().find(|node| node.id == "sources/privacy").unwrap();
        // “研究基础”与英文 “ML” 都被丢弃后，按正文推断出体系内标签；
        // “available” 不能因包含 “ai” 而被误标为 数据智能。
        assert!(privacy_node.tags.iter().any(|tag| tag == "数据安全"));
        assert!(!privacy_node.tags.iter().any(|tag| tag == "数据智能"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn graph_exposes_library_metadata_and_semantic_relations() {
        let root = test_project_dir();
        let sources = root.join("wiki/sources");
        fs::create_dir_all(&sources).unwrap();
        fs::write(
            sources.join("streaming.md"),
            "---\ntype: source\ntitle: Streaming architecture\ntitle_zh: 流式数据架构实践\ncontent_kind: technical_article\ndomain_tags: [数据采集, 数据传输]\nauthors: [数据平台团队]\nyear: 2026\nsummary: 介绍生产环境中的流式数据链路。\n---\n# 流式数据架构实践\n\n## 关联关系\n- [[storage]]：工程依赖\n",
        ).unwrap();
        fs::write(
            sources.join("storage.md"),
            "---\ntype: paper\ntitle: Distributed storage\ncontent_kind: paper\n---\n# Distributed storage\n",
        ).unwrap();

        let (nodes, edges) = build_graph(root.to_string_lossy().as_ref()).unwrap();
        let article = nodes
            .iter()
            .find(|node| node.id == "sources/streaming")
            .unwrap();
        assert_eq!(article.title_zh, "流式数据架构实践");
        assert_eq!(article.content_kind, "technical_article");
        assert_eq!(article.tags, vec!["数据采集", "数据传输"]);
        assert_eq!(article.year, Some(2026));
        assert!(edges.iter().any(|edge| edge.source == "sources/streaming"
            && edge.target == "sources/storage"
            && edge.relation == "工程依赖"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn query_parser_decodes_percent_and_plus() {
        let parsed = parse_query("path=wiki%2Fhello+world.md&token=a%2Bb");
        assert_eq!(parsed.get("path").unwrap(), "wiki/hello world.md");
        assert_eq!(parsed.get("token").unwrap(), "a+b");
    }

    #[test]
    fn snippet_handles_unicode_boundaries() {
        let content = "前言。这里是关于知识图谱过滤的中文内容。后续说明。";
        let snippet = commands::search::build_snippet(content, "知识图谱");
        assert!(snippet.contains("知识图谱"));
    }

    #[test]
    fn public_api_paths_exclude_internal_state() {
        assert!(is_public_project_rel("wiki/index.md"));
        assert!(is_public_project_rel("Wiki/index.md"));
        assert!(is_public_project_rel("raw/sources/source.md"));
        assert!(is_public_project_rel("Raw/Sources/source.md"));
        assert!(!is_public_project_rel(".llm-wiki/file-change-queue.json"));
        assert!(!is_public_project_rel("wiki/.draft.md"));
    }

    #[test]
    fn review_query_defaults_to_unresolved_items() {
        let root = test_project_dir();
        let state_dir = root.join(".llm-wiki");
        fs::create_dir_all(&state_dir).unwrap();
        fs::write(
            state_dir.join("review.json"),
            json!([
                {
                    "id": "r1",
                    "type": "missing-page",
                    "title": "Missing page: Attention",
                    "description": "Add Attention",
                    "options": [],
                    "resolved": false,
                    "createdAt": 1,
                    "internalSecret": "do-not-expose"
                },
                {
                    "id": "r2",
                    "type": "duplicate",
                    "title": "Duplicate: LLM",
                    "description": "Merge pages",
                    "options": [],
                    "resolved": true,
                    "createdAt": 2
                }
            ])
            .to_string(),
        )
        .unwrap();

        let query = parse_review_query("").unwrap();
        let reviews = load_review_items(root.to_str().unwrap(), &query).unwrap();

        assert_eq!(query.status.as_str(), "unresolved");
        assert_eq!(reviews.len(), 1);
        assert_eq!(
            reviews[0].get("id").and_then(Value::as_str),
            Some(review_id_for_parts("missing-page", "Missing page: Attention").as_str())
        );
        assert!(reviews[0].get("internalSecret").is_none());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn review_title_normalization_requires_a_prefix_delimiter() {
        assert_eq!(
            normalize_review_title("Missing page: Attention"),
            "attention"
        );
        assert_eq!(
            normalize_review_title(" Missing page: Attention"),
            "attention"
        );
        assert_eq!(
            normalize_review_title("Missing page Attention"),
            "missing page attention"
        );
        assert_eq!(normalize_review_title("疑似重复 注意力"), "疑似重复 注意力");
        assert_ne!(
            review_id_for_parts("missing-page", "Missing page: Attention"),
            review_id_for_parts("missing-page", "Missing page Attention")
        );
        assert_eq!(
            review_id_for_parts("missing-page", "Missing page: Attention"),
            "review-dbdcf949"
        );
        assert_eq!(
            review_id_for_parts("missing-page", " Missing page: Attention"),
            "review-dbdcf949"
        );
        assert_eq!(
            review_id_for_parts("missing-page", "Missing page Attention"),
            "review-fa5d9960"
        );
        assert_eq!(
            review_id_for_parts("missing-page", "疑似重复 注意力"),
            "review-d2dacda0"
        );
    }

    #[test]
    fn review_query_filters_by_type_status_and_limit() {
        let root = test_project_dir();
        let state_dir = root.join(".llm-wiki");
        fs::create_dir_all(&state_dir).unwrap();
        fs::write(
            state_dir.join("review.json"),
            json!([
                { "id": "r1", "type": "missing-page", "title": "r1", "resolved": false, "createdAt": 1 },
                { "id": "r2", "type": "missing-page", "title": "r2", "resolved": false, "createdAt": 2 },
                { "id": "r3", "type": "duplicate", "resolved": false, "createdAt": 3 },
                { "id": "r4", "type": "missing-page", "resolved": true, "createdAt": 4 }
            ])
            .to_string(),
        )
        .unwrap();

        let query = parse_review_query("status=all&type=missing-page&limit=2").unwrap();
        let reviews = load_review_items(root.to_str().unwrap(), &query).unwrap();

        assert_eq!(query.status.as_str(), "all");
        assert_eq!(
            reviews
                .iter()
                .filter_map(|r| r.get("id").and_then(Value::as_str))
                .map(str::to_string)
                .collect::<Vec<_>>(),
            vec![
                review_id_for_parts("missing-page", "r1"),
                review_id_for_parts("missing-page", "r2"),
            ]
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn review_query_collapses_legacy_duplicate_ids_to_stable_id() {
        let root = test_project_dir();
        let state_dir = root.join(".llm-wiki");
        fs::create_dir_all(&state_dir).unwrap();
        fs::write(
            state_dir.join("review.json"),
            json!([
                {
                    "id": "review-1",
                    "type": "missing-page",
                    "title": "Attention",
                    "description": "",
                    "affectedPages": ["a.md"],
                    "resolved": false,
                    "createdAt": 5
                },
                {
                    "id": "review-2",
                    "type": "missing-page",
                    "title": "Missing page: Attention",
                    "description": "resolved copy",
                    "affectedPages": ["b.md"],
                    "resolved": true,
                    "resolvedAction": "user-resolved",
                    "createdAt": 2
                }
            ])
            .to_string(),
        )
        .unwrap();

        let query = parse_review_query("status=all").unwrap();
        let reviews = load_review_items(root.to_str().unwrap(), &query).unwrap();

        assert_eq!(reviews.len(), 1);
        assert_eq!(
            reviews[0].get("id").and_then(Value::as_str),
            Some(review_id_for_parts("missing-page", "Attention").as_str())
        );
        assert_eq!(
            reviews[0].get("resolved").and_then(Value::as_bool),
            Some(true)
        );
        assert_eq!(
            reviews[0].get("resolvedAction").and_then(Value::as_str),
            Some("user-resolved")
        );
        assert_eq!(
            reviews[0]
                .get("affectedPages")
                .and_then(Value::as_array)
                .map(|pages| pages.iter().filter_map(Value::as_str).collect::<Vec<_>>()),
            Some(vec!["a.md", "b.md"])
        );
        assert_eq!(
            reviews[0].get("createdAt").and_then(Value::as_f64),
            Some(2.0)
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn review_query_filters_status_after_stable_id_merge() {
        let root = test_project_dir();
        let state_dir = root.join(".llm-wiki");
        fs::create_dir_all(&state_dir).unwrap();
        fs::write(
            state_dir.join("review.json"),
            json!([
                {
                    "id": "review-old-unresolved",
                    "type": "missing-page",
                    "title": "Attention",
                    "resolved": false,
                    "createdAt": 5
                },
                {
                    "id": "review-old-resolved",
                    "type": "missing-page",
                    "title": "Missing page: Attention",
                    "resolved": true,
                    "resolvedAction": "Done",
                    "createdAt": 6
                }
            ])
            .to_string(),
        )
        .unwrap();

        let unresolved = parse_review_query("status=unresolved").unwrap();
        let unresolved_reviews = load_review_items(root.to_str().unwrap(), &unresolved).unwrap();
        assert!(unresolved_reviews.is_empty());

        let all = parse_review_query("status=all").unwrap();
        let all_reviews = load_review_items(root.to_str().unwrap(), &all).unwrap();
        assert_eq!(all_reviews.len(), 1);
        assert_eq!(
            all_reviews[0].get("resolved").and_then(Value::as_bool),
            Some(true)
        );
        let _ = fs::remove_dir_all(root);
    }

    fn write_reviews(root: &Path, value: Value) {
        let state_dir = root.join(".llm-wiki");
        fs::create_dir_all(&state_dir).unwrap();
        fs::write(state_dir.join("review.json"), value.to_string()).unwrap();
    }

    fn read_reviews(root: &Path) -> Value {
        let raw = fs::read_to_string(root.join(".llm-wiki/review.json")).unwrap();
        serde_json::from_str(&raw).unwrap()
    }

    #[test]
    fn patch_review_item_marks_resolved_and_preserves_unsanitized_fields() {
        let root = test_project_dir();
        write_reviews(
            &root,
            json!([
                {
                    "id": "r1",
                    "type": "missing-page",
                    "resolved": false,
                    "createdAt": 1,
                    "internalSecret": "keep-me"
                },
                { "id": "r2", "type": "duplicate", "resolved": false, "createdAt": 2 }
            ]),
        );

        let found = patch_review_item(root.to_str().unwrap(), "r1", true, Some("Skip")).unwrap();
        assert!(found);

        // Re-read the RAW file: r1 must be resolved with the action label,
        // its non-sanitized `internalSecret` preserved (the write path must
        // not go through the sanitizing reader), and r2 left untouched.
        let parsed = read_reviews(&root);
        let items = parsed.as_array().unwrap();
        let r1 = items
            .iter()
            .find(|i| i.get("id").and_then(Value::as_str) == Some("r1"))
            .unwrap();
        assert_eq!(r1.get("resolved").and_then(Value::as_bool), Some(true));
        assert_eq!(
            r1.get("resolvedAction").and_then(Value::as_str),
            Some("Skip")
        );
        assert_eq!(
            r1.get("internalSecret").and_then(Value::as_str),
            Some("keep-me")
        );
        let r2 = items
            .iter()
            .find(|i| i.get("id").and_then(Value::as_str) == Some("r2"))
            .unwrap();
        assert_eq!(r2.get("resolved").and_then(Value::as_bool), Some(false));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn patch_review_item_accepts_stable_id_for_legacy_counter_item() {
        let root = test_project_dir();
        write_reviews(
            &root,
            json!([
                {
                    "id": "review-1",
                    "type": "missing-page",
                    "title": "Missing page: Attention",
                    "resolved": false
                }
            ]),
        );

        let stable_id = review_id_for_parts("missing-page", "Attention");
        let found =
            patch_review_item(root.to_str().unwrap(), &stable_id, true, Some("API")).unwrap();
        assert!(found);

        let parsed = read_reviews(&root);
        let item = &parsed.as_array().unwrap()[0];
        assert_eq!(
            item.get("id").and_then(Value::as_str),
            Some(stable_id.as_str())
        );
        assert_eq!(item.get("resolved").and_then(Value::as_bool), Some(true));
        assert_eq!(
            item.get("resolvedAction").and_then(Value::as_str),
            Some("API")
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn patch_review_item_can_reopen_with_resolved_false() {
        let root = test_project_dir();
        write_reviews(
            &root,
            json!([{ "id": "r1", "resolved": true, "resolvedAction": "Skip" }]),
        );

        let found = patch_review_item(root.to_str().unwrap(), "r1", false, None).unwrap();
        assert!(found);

        let parsed = read_reviews(&root);
        let r1 = &parsed.as_array().unwrap()[0];
        assert_eq!(r1.get("resolved").and_then(Value::as_bool), Some(false));
        assert!(r1.get("resolvedAction").is_none());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn patch_review_item_returns_false_for_unknown_id() {
        let root = test_project_dir();
        write_reviews(&root, json!([{ "id": "r1", "resolved": false }]));

        let found = patch_review_item(root.to_str().unwrap(), "nope", true, None).unwrap();
        assert!(!found);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn patch_review_item_missing_file_returns_false() {
        let root = test_project_dir();
        let found = patch_review_item(root.to_str().unwrap(), "r1", true, None).unwrap();
        assert!(!found);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn resolve_review_items_bulk_resolves_matching_and_reports_not_found() {
        let root = test_project_dir();
        write_reviews(
            &root,
            json!([
                { "id": "r1", "resolved": false, "internalSecret": "a" },
                { "id": "r2", "resolved": false },
                { "id": "r3", "resolved": false }
            ]),
        );

        let ids = vec!["r1".to_string(), "r3".to_string(), "missing".to_string()];
        let (resolved, not_found) =
            resolve_review_items(root.to_str().unwrap(), &ids, Some("Bulk")).unwrap();

        // Input order preserved; missing id reported, not 404'd.
        assert_eq!(resolved, vec!["r1".to_string(), "r3".to_string()]);
        assert_eq!(not_found, vec!["missing".to_string()]);

        let parsed = read_reviews(&root);
        let items = parsed.as_array().unwrap();
        let by_id = |id: &str| {
            items
                .iter()
                .find(|i| i.get("id").and_then(Value::as_str) == Some(id))
                .unwrap()
        };
        assert_eq!(
            by_id("r1").get("resolved").and_then(Value::as_bool),
            Some(true)
        );
        assert_eq!(
            by_id("r1").get("resolvedAction").and_then(Value::as_str),
            Some("Bulk")
        );
        // Unsanitized field survives the bulk write-back too.
        assert_eq!(
            by_id("r1").get("internalSecret").and_then(Value::as_str),
            Some("a")
        );
        assert_eq!(
            by_id("r3").get("resolved").and_then(Value::as_bool),
            Some(true)
        );
        // r2 was not in the request — untouched.
        assert_eq!(
            by_id("r2").get("resolved").and_then(Value::as_bool),
            Some(false)
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn resolve_review_items_accepts_stable_ids_for_legacy_counter_items() {
        let root = test_project_dir();
        write_reviews(
            &root,
            json!([
                {
                    "id": "review-1",
                    "type": "missing-page",
                    "title": "Missing page: Attention",
                    "resolved": false
                },
                {
                    "id": "review-2",
                    "type": "duplicate",
                    "title": "Duplicate page: Transformer",
                    "resolved": false
                }
            ]),
        );

        let ids = vec![
            review_id_for_parts("missing-page", "Attention"),
            "missing".to_string(),
        ];
        let (resolved, not_found) =
            resolve_review_items(root.to_str().unwrap(), &ids, Some("Bulk")).unwrap();

        assert_eq!(resolved, vec![ids[0].clone()]);
        assert_eq!(not_found, vec!["missing".to_string()]);
        let parsed = read_reviews(&root);
        let items = parsed.as_array().unwrap();
        assert_eq!(
            items[0].get("id").and_then(Value::as_str),
            Some(ids[0].as_str())
        );
        assert_eq!(
            items[0].get("resolved").and_then(Value::as_bool),
            Some(true)
        );
        assert_eq!(items[1].get("id").and_then(Value::as_str), Some("review-2"));
        assert_eq!(
            items[1].get("resolved").and_then(Value::as_bool),
            Some(false)
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn resolve_review_items_missing_file_reports_all_not_found() {
        let root = test_project_dir();
        let ids = vec!["r1".to_string(), "r2".to_string()];
        let (resolved, not_found) =
            resolve_review_items(root.to_str().unwrap(), &ids, None).unwrap();
        assert!(resolved.is_empty());
        assert_eq!(not_found, ids);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn project_path_match_normalizes_separators() {
        assert!(project_path_matches(
            "C:/Users/me/wiki",
            "C:\\Users\\me\\wiki"
        ));
        if cfg!(windows) {
            assert!(project_path_matches("C:/Users/me/wiki", "c:/users/me/wiki"));
        } else {
            assert!(!project_path_matches(
                "C:/Users/me/wiki",
                "c:/users/me/wiki"
            ));
        }
    }

    #[test]
    fn tokenize_keeps_single_cjk_character() {
        assert_eq!(
            crate::commands::search::tokenize_query("图"),
            Vec::<String>::new()
        );
        let tokens = crate::commands::search::tokenize_query("知识图谱");
        assert!(tokens.contains(&"知识".to_string()));
    }

    #[test]
    fn text_content_filter_rejects_binary_extensions() {
        assert!(is_text_content_rel("wiki/index.md"));
        assert!(!is_text_content_rel("wiki/media/image.png"));
        assert!(!is_text_content_rel("raw/sources/book.pdf"));
    }

    #[test]
    fn constant_time_eq_matches_equal_bytes_only() {
        assert!(constant_time_eq(b"token", b"token"));
        assert!(constant_time_eq(b"", b""));
        assert!(!constant_time_eq(b"token", b"tokeN"));
        assert!(!constant_time_eq(b"token", b"token-longer"));
    }

    #[test]
    fn rate_limit_skips_health_and_options_only() {
        assert!(!should_rate_limit(&Method::Get, "/api/v1/health"));
        assert!(!should_rate_limit(&Method::Options, "/api/v1/projects"));
        assert!(should_rate_limit(&Method::Get, "/wp-login"));
        assert!(should_rate_limit(
            &Method::Post,
            "/api/v1/projects/current/search"
        ));
    }

    #[test]
    fn chat_endpoint_allows_larger_multimodal_bodies() {
        assert_eq!(
            body_limit_for_request(&Method::Post, "/api/v1/projects/current/chat"),
            MAX_CHAT_BODY_BYTES
        );
        assert_eq!(
            body_limit_for_request(&Method::Post, "/api/v1/projects/current/search"),
            MAX_BODY_BYTES
        );
    }

    #[test]
    fn chat_routes_are_recognized_as_agent_requests() {
        assert!(is_agent_chat_request(
            &Method::Post,
            "/api/v1/projects/current/chat"
        ));
        assert!(is_agent_chat_request(
            &Method::Post,
            "/api/v1/projects/current/chat/session-1/cancel"
        ));
        assert!(!is_agent_chat_request(
            &Method::Post,
            "/api/v1/projects/current/search"
        ));
        assert!(!is_agent_chat_request(
            &Method::Get,
            "/api/v1/projects/current/chat"
        ));
    }

    #[test]
    fn environment_llm_configuration_supports_headless_custom_providers() {
        let values = BTreeMap::from([
            ("LLM_WIKI_LLM_PROVIDER", " custom ".to_string()),
            ("LLM_WIKI_LLM_API_KEY", "secret".to_string()),
            ("LLM_WIKI_LLM_MODEL", "deepseek-chat".to_string()),
            (
                "LLM_WIKI_LLM_CUSTOM_ENDPOINT",
                "https://api.deepseek.com/v1".to_string(),
            ),
            ("LLM_WIKI_LLM_MAX_TOKENS", "2048".to_string()),
        ]);
        let config = llm_config_from_environment_values(|key| values.get(key).cloned()).unwrap();

        assert_eq!(config.provider, "custom");
        assert_eq!(config.model, "deepseek-chat");
        assert_eq!(config.max_tokens, Some(2048));
        assert!(config.is_usable_for_backend_http());
    }

    #[test]
    fn api_config_shape_parses_enabled_and_unauthenticated_access() {
        // Standalone pure-function check to mirror what `api_enabled`
        // reads off `load_app_state`. Mirrors the JS-side shape
        // emitted by `saveApiConfig` so any rename on either side
        // surfaces here before users hit it as a 503 in production.
        let payload = json!({
            "apiConfig": {
                "enabled": false,
                "allowUnauthenticated": true,
                "allowLanAccess": true,
                "mcpEnabled": true,
                "token": "abc"
            }
        });
        let enabled = payload
            .get("apiConfig")
            .and_then(|v| v.get("enabled"))
            .and_then(Value::as_bool)
            .unwrap_or(true);
        assert!(!enabled);
        let allow_unauthenticated = payload
            .get("apiConfig")
            .and_then(|v| v.get("allowUnauthenticated"))
            .and_then(Value::as_bool)
            .unwrap_or(false);
        assert!(allow_unauthenticated);
        let allow_lan_access = payload
            .get("apiConfig")
            .and_then(|v| v.get("allowLanAccess"))
            .and_then(Value::as_bool)
            .unwrap_or(false);
        assert!(allow_lan_access);
        let mcp_enabled = payload
            .get("apiConfig")
            .and_then(|v| v.get("mcpEnabled"))
            .and_then(Value::as_bool)
            .unwrap_or(false);
        assert!(mcp_enabled);
        let token_source = payload
            .get("apiConfig")
            .and_then(|v| v.get("token"))
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(|_| "store")
            .unwrap_or("none");
        assert_eq!(token_source, "store");

        let missing = json!({});
        let enabled_missing = missing
            .get("apiConfig")
            .and_then(|v| v.get("enabled"))
            .and_then(Value::as_bool)
            .unwrap_or(true);
        // Fail-open by design — see `api_enabled` doc comment.
        assert!(enabled_missing);
        let mcp_enabled_missing = missing
            .get("apiConfig")
            .and_then(|v| v.get("mcpEnabled"))
            .and_then(Value::as_bool)
            .unwrap_or(false);
        assert!(!mcp_enabled_missing);
        let allow_lan_access_missing = missing
            .get("apiConfig")
            .and_then(|v| v.get("allowLanAccess"))
            .and_then(Value::as_bool)
            .unwrap_or(false);
        assert!(!allow_lan_access_missing);
    }
}
