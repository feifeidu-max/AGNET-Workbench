//! Strict, review-first ingestion for the local API.
//!
//! Nothing in this module writes to `raw/sources`, `wiki`, or LanceDB until
//! `approve_draft()` commits the complete proposal. The desktop's historical
//! review feature is post-write; this gate is intentionally separate from it.

use std::collections::BTreeSet;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use chrono::Utc;
use futures::future::join_all;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::commands;

pub const MAX_PDF_BYTES: usize = 100 * 1024 * 1024;

const STAGING_ROOT: &str = ".llm-wiki/staging";
const DRAFT_FILE: &str = "draft.json";
const SOURCE_FILE: &str = "source.pdf";
const EXTRACTED_FILE: &str = "extracted.md";
const PROPOSAL_FILE: &str = "proposal.json";
const TRUSTED_FILE: &str = ".llm-wiki/trusted-sources.json";
const CANDIDATES_FILE: &str = ".llm-wiki/reading-candidates.json";
const MAX_EXTRACTED_CHARS: usize = 2_000_000;
const MAX_CANDIDATE_ABSTRACT_CHARS: usize = 8_000;
const MAX_GENERATED_PAGE_BYTES: usize = 4 * 1024 * 1024;

static PROJECT_GATE: OnceLock<Mutex<()>> = OnceLock::new();

#[derive(Debug, Clone)]
pub struct GateError {
    pub status: u16,
    pub message: String,
}

impl GateError {
    fn new(status: u16, message: impl Into<String>) -> Self {
        Self {
            status,
            message: message.into(),
        }
    }

    fn internal(message: impl Into<String>) -> Self {
        Self::new(500, message)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DraftStatus {
    Uploaded,
    Parsing,
    Drafting,
    AwaitingReview,
    Publishing,
    Trusted,
    RevisionRequested,
    Rejected,
    Failed,
}

impl DraftStatus {
    fn blocks_queue(&self) -> bool {
        matches!(
            self,
            Self::Parsing | Self::Drafting | Self::AwaitingReview | Self::Publishing
        )
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IngestDraft {
    pub id: String,
    pub filename: String,
    pub source_id: String,
    pub sha256: String,
    pub size_bytes: u64,
    pub status: DraftStatus,
    pub revision: u32,
    pub created_at: String,
    pub updated_at: String,
    pub draft_mode: String,
    #[serde(default = "default_source_kind")]
    pub source_kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub staged_source_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub paper_title: Option<String>,
    #[serde(default)]
    pub paper_authors: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub publication_year: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metadata_source: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub page_count: Option<usize>,
    #[serde(default)]
    pub proposed_change_count: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub feedback: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rejection_reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_path: Option<String>,
    #[serde(default)]
    pub published_pages: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub embedding_status: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EvidenceLocator {
    pub source_id: String,
    pub revision: u32,
    pub page: usize,
    pub section: String,
    pub snippet_hash: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub authors: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub year: Option<i32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProposedChange {
    pub path: String,
    pub operation: String,
    pub title: String,
    pub content: String,
    #[serde(default)]
    pub evidence_locators: Vec<EvidenceLocator>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IngestCompilationClaim {
    pub draft: IngestDraft,
    pub source_path: String,
    pub feedback: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DraftProposal {
    generated_at: String,
    generator: String,
    changes: Vec<ProposedChange>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TrustedSource {
    source_id: String,
    sha256: String,
    filename: String,
    source_path: String,
    page_paths: Vec<String>,
    revision: u32,
    trusted_at: String,
    #[serde(default = "default_source_kind")]
    source_kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    title: Option<String>,
    #[serde(default)]
    authors: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    year: Option<i32>,
}

#[derive(Debug, Clone)]
struct PaperMetadata {
    title: String,
    authors: Vec<String>,
    year: Option<i32>,
    source: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadingCandidate {
    pub id: String,
    pub provider: String,
    pub external_id: String,
    pub title: String,
    pub authors: Vec<String>,
    pub year: Option<i32>,
    #[serde(rename = "abstract")]
    pub abstract_text: String,
    pub doi: Option<String>,
    pub url: String,
    pub query: String,
    pub recommended_reason: String,
    pub status: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CandidateSearchResult {
    pub candidates: Vec<ReadingCandidate>,
    pub provider_errors: Vec<String>,
}

fn default_source_kind() -> String {
    "pdf".to_string()
}

fn native_compile_enabled() -> bool {
    std::env::var("LLM_WIKI_NATIVE_COMPILE").as_deref() == Ok("1")
}

fn gate_lock() -> Result<std::sync::MutexGuard<'static, ()>, GateError> {
    PROJECT_GATE
        .get_or_init(|| Mutex::new(()))
        .lock()
        .map_err(|_| GateError::internal("Ingest project lock is poisoned"))
}

fn now() -> String {
    Utc::now().to_rfc3339()
}

fn state_path(project_path: &str, rel: &str) -> Result<PathBuf, GateError> {
    let relative = Path::new(rel);
    if relative.is_absolute()
        || relative.components().any(|part| {
            matches!(
                part,
                Component::ParentDir | Component::Prefix(_) | Component::RootDir
            )
        })
    {
        return Err(GateError::new(400, "Unsafe project-relative path"));
    }
    Ok(Path::new(project_path).join(relative))
}

fn draft_dir(project_path: &str, draft_id: &str) -> Result<PathBuf, GateError> {
    if draft_id.is_empty()
        || !draft_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    {
        return Err(GateError::new(400, "Invalid draft id"));
    }
    state_path(project_path, &format!("{STAGING_ROOT}/{draft_id}"))
}

fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), GateError> {
    let parent = path
        .parent()
        .ok_or_else(|| GateError::internal("State file has no parent directory"))?;
    fs::create_dir_all(parent)
        .map_err(|e| GateError::internal(format!("Failed to create state directory: {e}")))?;
    let temp = parent.join(format!(".tmp-{}", Uuid::new_v4()));
    fs::write(&temp, bytes)
        .map_err(|e| GateError::internal(format!("Failed to write state file: {e}")))?;
    if path.exists() {
        fs::remove_file(path)
            .map_err(|e| GateError::internal(format!("Failed to replace state file: {e}")))?;
    }
    fs::rename(&temp, path)
        .map_err(|e| GateError::internal(format!("Failed to commit state file: {e}")))
}

fn write_json<T: Serialize>(path: &Path, value: &T) -> Result<(), GateError> {
    let bytes = serde_json::to_vec_pretty(value)
        .map_err(|e| GateError::internal(format!("Failed to serialize state: {e}")))?;
    write_atomic(path, &bytes)
}

fn read_json_or_default<T>(path: &Path) -> Result<T, GateError>
where
    T: for<'de> Deserialize<'de> + Default,
{
    if !path.exists() {
        return Ok(T::default());
    }
    let raw =
        fs::read(path).map_err(|e| GateError::internal(format!("Failed to read state: {e}")))?;
    serde_json::from_slice(&raw)
        .map_err(|e| GateError::internal(format!("Invalid state file '{}': {e}", path.display())))
}

fn read_draft(project_path: &str, draft_id: &str) -> Result<IngestDraft, GateError> {
    let path = draft_dir(project_path, draft_id)?.join(DRAFT_FILE);
    let raw = fs::read(&path).map_err(|e| {
        GateError::new(
            if e.kind() == std::io::ErrorKind::NotFound {
                404
            } else {
                500
            },
            format!("Draft '{draft_id}' was not found: {e}"),
        )
    })?;
    serde_json::from_slice(&raw)
        .map_err(|e| GateError::internal(format!("Draft metadata is invalid: {e}")))
}

fn write_draft(project_path: &str, draft: &IngestDraft) -> Result<(), GateError> {
    write_json(&draft_dir(project_path, &draft.id)?.join(DRAFT_FILE), draft)
}

fn list_drafts_unlocked(project_path: &str) -> Result<Vec<IngestDraft>, GateError> {
    let root = state_path(project_path, STAGING_ROOT)?;
    if !root.exists() {
        return Ok(Vec::new());
    }
    let mut drafts = Vec::new();
    for entry in fs::read_dir(&root)
        .map_err(|e| GateError::internal(format!("Failed to list draft staging: {e}")))?
    {
        let entry = entry.map_err(|e| GateError::internal(format!("Failed to list draft: {e}")))?;
        if !entry.path().is_dir() {
            continue;
        }
        let path = entry.path().join(DRAFT_FILE);
        if !path.exists() {
            continue;
        }
        let raw = fs::read(&path)
            .map_err(|e| GateError::internal(format!("Failed to read draft metadata: {e}")))?;
        let draft: IngestDraft = serde_json::from_slice(&raw).map_err(|e| {
            GateError::internal(format!("Invalid draft metadata '{}': {e}", path.display()))
        })?;
        drafts.push(draft);
    }
    drafts.sort_by(|left, right| right.created_at.cmp(&left.created_at));
    Ok(drafts)
}

pub fn create_draft(
    project_path: &str,
    filename: &str,
    bytes: &[u8],
) -> Result<IngestDraft, GateError> {
    if bytes.is_empty() {
        return Err(GateError::new(400, "Uploaded PDF is empty"));
    }
    let filename = safe_source_filename(filename)?;
    if !filename.to_ascii_lowercase().ends_with(".pdf") {
        return Err(GateError::new(415, "Only PDF uploads are accepted"));
    }
    let header_end = bytes.len().min(1024);
    if !bytes[..header_end]
        .windows(5)
        .any(|window| window == b"%PDF-")
    {
        return Err(GateError::new(415, "Uploaded content is not a PDF"));
    }

    create_source_draft(project_path, &filename, bytes, "pdf")
}

/// Desktop import, directory-watch, and scheduled-import entry point. The
/// original file stays outside the trusted project tree until approval.
#[tauri::command]
pub fn stage_ingest_source(
    project_path: String,
    source_path: String,
) -> Result<IngestDraft, String> {
    let path = PathBuf::from(&source_path);
    let filename = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "Source path has no valid filename".to_string())?;
    let bytes =
        fs::read(&path).map_err(|error| format!("Failed to read source for review: {error}"))?;
    let source_kind = path
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_ascii_lowercase())
        .unwrap_or_else(|| "document".to_string());
    if !supported_source_extension(&source_kind) {
        return Err(format!("Unsupported source extension '.{source_kind}'"));
    }
    create_source_draft(&project_path, filename, &bytes, &source_kind)
        .map_err(|error| error.message)
}

/// Deep Research and Web Clipper submit proposed Wiki pages through the same
/// single-review queue without first writing into `wiki/` or `raw/sources/`.
#[tauri::command]
pub fn stage_generated_wiki_page(
    project_path: String,
    title: String,
    target_path: String,
    content: String,
    origin: String,
) -> Result<IngestDraft, String> {
    create_generated_page_draft(&project_path, &title, &target_path, &content, &origin)
        .map_err(|error| error.message)
}

fn create_source_draft(
    project_path: &str,
    filename: &str,
    bytes: &[u8],
    source_kind: &str,
) -> Result<IngestDraft, GateError> {
    if bytes.is_empty() {
        return Err(GateError::new(400, "Imported source is empty"));
    }
    if bytes.len() > MAX_PDF_BYTES {
        return Err(GateError::new(
            413,
            "Source exceeds the 100 MB ingest limit",
        ));
    }
    let filename = safe_source_filename(filename)?;
    let source_kind = normalize_source_kind(source_kind, &filename);
    let staged_source_name = staged_source_name(&filename);

    let sha256 = hex_sha256(bytes);
    let _guard = gate_lock()?;
    if let Some(existing) = list_drafts_unlocked(project_path)?
        .into_iter()
        .find(|draft| draft.sha256 == sha256 && draft.status != DraftStatus::Rejected)
    {
        return Err(GateError::new(
            409,
            format!(
                "Duplicate PDF; draft '{}' already has status {:?}",
                existing.id, existing.status
            ),
        ));
    }
    let trusted: Vec<TrustedSource> =
        read_json_or_default(&state_path(project_path, TRUSTED_FILE)?)?;
    if trusted.iter().any(|source| source.sha256 == sha256) {
        return Err(GateError::new(409, "Duplicate PDF is already trusted"));
    }

    let timestamp = now();
    let draft = IngestDraft {
        id: Uuid::new_v4().to_string(),
        filename,
        source_id: format!(
            "{}:{}",
            if source_kind == "pdf" {
                "paper"
            } else {
                "source"
            },
            &sha256[..16]
        ),
        sha256,
        size_bytes: bytes.len() as u64,
        status: DraftStatus::Uploaded,
        revision: 1,
        created_at: timestamp.clone(),
        updated_at: timestamp,
        draft_mode: "deterministic_extraction".to_string(),
        source_kind,
        staged_source_name: Some(staged_source_name.clone()),
        paper_title: None,
        paper_authors: Vec::new(),
        publication_year: None,
        metadata_source: None,
        page_count: None,
        proposed_change_count: 0,
        feedback: None,
        rejection_reason: None,
        error: None,
        source_path: None,
        published_pages: Vec::new(),
        embedding_status: None,
    };
    let directory = draft_dir(project_path, &draft.id)?;
    fs::create_dir_all(&directory)
        .map_err(|e| GateError::internal(format!("Failed to create draft staging: {e}")))?;
    write_atomic(&directory.join(staged_source_name), bytes)?;
    write_draft(project_path, &draft)?;
    drop(_guard);

    if !native_compile_enabled() {
        kick_queue(project_path.to_string());
    }
    Ok(draft)
}

pub(crate) fn create_generated_page_draft(
    project_path: &str,
    title: &str,
    target_path: &str,
    content: &str,
    origin: &str,
) -> Result<IngestDraft, GateError> {
    let title = collapse_whitespace(title);
    if title.is_empty() || title.chars().count() > 300 {
        return Err(GateError::new(400, "Generated page title is invalid"));
    }
    let target_path = target_path.replace('\\', "/");
    // Reuse the same path validator used for compiler proposals so generated
    // Agent pages cannot create a weaker path variant that bypasses review.
    validate_wiki_page_path(&target_path)?;
    if content.trim().is_empty() || content.len() > MAX_GENERATED_PAGE_BYTES {
        return Err(GateError::new(
            400,
            "Generated page content is empty or too large",
        ));
    }
    let origin = collapse_whitespace(origin);
    let bytes = content.as_bytes();
    let sha256 = hex_sha256(bytes);
    let _guard = gate_lock()?;
    if let Some(existing) = list_drafts_unlocked(project_path)?
        .into_iter()
        .find(|draft| draft.sha256 == sha256 && draft.status != DraftStatus::Rejected)
    {
        return Err(GateError::new(
            409,
            format!(
                "Duplicate generated content; draft '{}' already exists",
                existing.id
            ),
        ));
    }

    let timestamp = now();
    let target = state_path(project_path, &target_path)?;
    let operation = match fs::metadata(&target) {
        Ok(metadata) if metadata.is_file() => "update",
        Ok(_) => {
            return Err(GateError::new(
                409,
                "Generated page target exists but is not a regular file",
            ))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => "create",
        Err(error) => {
            return Err(GateError::internal(format!(
                "Failed to inspect generated page target: {error}"
            )))
        }
    };
    let draft = IngestDraft {
        id: Uuid::new_v4().to_string(),
        filename: format!("{}.md", slugify(&title)),
        source_id: format!("generated:{}", &sha256[..16]),
        sha256,
        size_bytes: bytes.len() as u64,
        status: DraftStatus::Uploaded,
        revision: 1,
        created_at: timestamp.clone(),
        updated_at: timestamp,
        draft_mode: format!(
            "generated_proposal:{}",
            if origin.is_empty() {
                "unknown"
            } else {
                &origin
            }
        ),
        source_kind: "generated".to_string(),
        staged_source_name: None,
        paper_title: Some(title.clone()),
        paper_authors: Vec::new(),
        publication_year: None,
        metadata_source: Some(if origin.is_empty() {
            "generated".to_string()
        } else {
            origin
        }),
        page_count: None,
        proposed_change_count: 1,
        feedback: None,
        rejection_reason: None,
        error: None,
        source_path: None,
        published_pages: Vec::new(),
        embedding_status: None,
    };
    let directory = draft_dir(project_path, &draft.id)?;
    fs::create_dir_all(&directory)
        .map_err(|error| GateError::internal(format!("Failed to create draft staging: {error}")))?;
    let proposal = DraftProposal {
        generated_at: now(),
        generator: draft.draft_mode.clone(),
        changes: vec![ProposedChange {
            path: target_path,
            operation: operation.to_string(),
            title,
            content: content.to_string(),
            evidence_locators: Vec::new(),
        }],
    };
    write_json(&directory.join(PROPOSAL_FILE), &proposal)?;
    write_draft(project_path, &draft)?;
    drop(_guard);
    kick_queue(project_path.to_string());
    Ok(draft)
}

pub fn list_drafts(project_path: &str) -> Result<Vec<IngestDraft>, GateError> {
    let _guard = gate_lock()?;
    list_drafts_unlocked(project_path)
}

#[tauri::command]
pub fn pending_ingest_publications(project_path: String) -> Result<Vec<IngestDraft>, String> {
    list_drafts(&project_path)
        .map(|drafts| {
            drafts
                .into_iter()
                .filter(|draft| {
                    draft.status == DraftStatus::Trusted
                        && matches!(
                            draft.embedding_status.as_deref(),
                            Some("queued") | Some("indexing") | Some("failed")
                        )
                })
                .collect()
        })
        .map_err(|error| error.message)
}

#[tauri::command]
pub fn set_ingest_embedding_status(
    project_path: String,
    draft_id: String,
    status: String,
    error: Option<String>,
) -> Result<IngestDraft, String> {
    let allowed = ["queued", "indexing", "indexed", "disabled", "failed"];
    if !allowed.contains(&status.as_str()) {
        return Err("Invalid embedding status".to_string());
    }
    let _guard = gate_lock().map_err(|gate_error| gate_error.message)?;
    let mut draft =
        read_draft(&project_path, &draft_id).map_err(|gate_error| gate_error.message)?;
    if draft.status != DraftStatus::Trusted {
        return Err("Only trusted drafts have an embedding status".to_string());
    }
    draft.embedding_status = Some(status);
    draft.error = error.filter(|value| !value.trim().is_empty());
    draft.updated_at = now();
    write_draft(&project_path, &draft).map_err(|gate_error| gate_error.message)?;
    Ok(draft)
}

/// Claims the oldest source draft for the native knowledge compiler. A draft
/// left in `drafting` by a previous process is returned first so compilation
/// can resume after a restart. Generated Wiki pages have no staged source and
/// continue through the deterministic queue.
#[tauri::command]
pub fn claim_ingest_compilation(
    project_path: String,
) -> Result<Option<IngestCompilationClaim>, String> {
    let _guard = gate_lock().map_err(|error| error.message)?;
    let drafts = list_drafts_unlocked(&project_path).map_err(|error| error.message)?;
    if drafts.iter().any(|draft| {
        matches!(
            draft.status,
            DraftStatus::AwaitingReview | DraftStatus::Publishing
        )
    }) {
        return Ok(None);
    }

    let mut candidates = drafts
        .into_iter()
        .filter(|draft| {
            draft.source_kind != "generated"
                && draft.staged_source_name.is_some()
                && matches!(
                    draft.status,
                    DraftStatus::Uploaded | DraftStatus::RevisionRequested | DraftStatus::Drafting
                )
        })
        .collect::<Vec<_>>();
    candidates.sort_by(|left, right| {
        let left_recovery = usize::from(left.status != DraftStatus::Drafting);
        let right_recovery = usize::from(right.status != DraftStatus::Drafting);
        left_recovery
            .cmp(&right_recovery)
            .then_with(|| left.created_at.cmp(&right.created_at))
    });
    let Some(mut draft) = candidates.into_iter().next() else {
        return Ok(None);
    };

    let source = staged_source_path(&project_path, &draft).map_err(|error| error.message)?;
    let source = fs::canonicalize(&source)
        .map_err(|error| format!("Staged source is missing or inaccessible: {error}"))?;
    if !source.is_file() {
        return Err("Staged source is not a file".to_string());
    }

    draft.status = DraftStatus::Drafting;
    draft.draft_mode = "native_compilation".to_string();
    draft.error = None;
    draft.updated_at = now();
    write_draft(&project_path, &draft).map_err(|error| error.message)?;
    Ok(Some(IngestCompilationClaim {
        feedback: draft.feedback.clone(),
        draft,
        source_path: source.to_string_lossy().into_owned(),
    }))
}

/// Commits a native compiler result to staging. The status/revision check is
/// a compare-and-swap: a late result from an earlier revision cannot replace
/// the proposal currently being reviewed or recompiled.
#[tauri::command]
pub fn submit_ingest_compilation(
    project_path: String,
    draft_id: String,
    revision: u32,
    extracted_text: String,
    changes: Vec<ProposedChange>,
    generator: String,
) -> Result<IngestDraft, String> {
    let extracted_chars = extracted_text.chars().count();
    if extracted_text.trim().is_empty() {
        return Err("Extracted text is empty".to_string());
    }
    if extracted_chars > MAX_EXTRACTED_CHARS {
        return Err(format!(
            "Extracted text exceeds the {MAX_EXTRACTED_CHARS} character limit"
        ));
    }
    let generator = collapse_whitespace(&generator);
    if generator.is_empty() || generator.chars().count() > 200 {
        return Err("Compilation generator is empty or too long".to_string());
    }
    if changes.is_empty() {
        return Err("Compilation must propose at least one Wiki change".to_string());
    }

    let _guard = gate_lock().map_err(|error| error.message)?;
    let mut draft = read_draft(&project_path, &draft_id).map_err(|error| error.message)?;
    ensure_compilation_cas(&draft, revision).map_err(|error| error.message)?;
    let source = staged_source_path(&project_path, &draft).map_err(|error| error.message)?;
    if !source.is_file() {
        return Err("Staged source is missing".to_string());
    }

    let metadata = derive_paper_metadata(&draft, &extracted_text, &source);
    let locators = evidence_locators(
        &extracted_text,
        &draft.source_id,
        revision,
        &metadata.authors,
        metadata.year,
    );
    let changes =
        validate_compilation_changes(changes, &locators).map_err(|error| error.message)?;
    let proposal = DraftProposal {
        generated_at: now(),
        generator: generator.clone(),
        changes,
    };

    let directory = draft_dir(&project_path, &draft_id).map_err(|error| error.message)?;
    write_atomic(&directory.join(EXTRACTED_FILE), extracted_text.as_bytes())
        .map_err(|error| error.message)?;
    // Keep immutable per-revision evidence so a later revision request cannot
    // make citations in an already-published page resolve against new text.
    write_atomic(
        &directory.join(format!("extracted-r{revision}.md")),
        extracted_text.as_bytes(),
    )
    .map_err(|error| error.message)?;
    write_json(&directory.join(PROPOSAL_FILE), &proposal).map_err(|error| error.message)?;

    draft.paper_title = Some(metadata.title);
    draft.paper_authors = metadata.authors;
    draft.publication_year = metadata.year;
    draft.metadata_source = Some(metadata.source);
    draft.page_count = Some(count_pages(&extracted_text));
    draft.proposed_change_count = proposal.changes.len();
    draft.draft_mode = format!("native_compilation:{generator}");
    draft.status = DraftStatus::AwaitingReview;
    draft.error = None;
    draft.updated_at = now();
    write_draft(&project_path, &draft).map_err(|error| error.message)?;
    Ok(draft)
}

/// Records a compiler failure only while the claimed revision is still
/// current. This deliberately leaves the staged source intact for revision or
/// retry.
#[tauri::command]
pub fn fail_ingest_compilation(
    project_path: String,
    draft_id: String,
    revision: u32,
    error: String,
) -> Result<IngestDraft, String> {
    let _guard = gate_lock().map_err(|gate_error| gate_error.message)?;
    let mut draft = read_draft(&project_path, &draft_id).map_err(|error| error.message)?;
    ensure_compilation_cas(&draft, revision).map_err(|error| error.message)?;
    let error = collapse_whitespace(&error);
    draft.status = DraftStatus::Failed;
    draft.error = Some(if error.is_empty() {
        "Native compilation failed".to_string()
    } else {
        truncate_chars(&error, 8_000)
    });
    draft.updated_at = now();
    write_draft(&project_path, &draft).map_err(|error| error.message)?;
    drop(_guard);
    kick_queue(project_path);
    Ok(draft)
}

fn ensure_compilation_cas(draft: &IngestDraft, revision: u32) -> Result<(), GateError> {
    if draft.status != DraftStatus::Drafting || draft.revision != revision {
        return Err(GateError::new(
            409,
            format!(
                "Compilation claim is stale; expected drafting revision {}, found {:?} revision {}",
                revision, draft.status, draft.revision
            ),
        ));
    }
    Ok(())
}

fn validate_compilation_changes(
    changes: Vec<ProposedChange>,
    locators: &[EvidenceLocator],
) -> Result<Vec<ProposedChange>, GateError> {
    let locators_json = serde_json::to_string(locators)
        .map_err(|error| GateError::internal(format!("Failed to serialize evidence: {error}")))?;
    let mut seen = BTreeSet::new();
    let mut validated = Vec::with_capacity(changes.len());
    for mut change in changes {
        validate_wiki_page_path(&change.path)?;
        let path_key = change.path.to_ascii_lowercase();
        if !seen.insert(path_key) {
            return Err(GateError::new(
                400,
                "Compilation contains duplicate Wiki paths",
            ));
        }

        change.operation = collapse_whitespace(&change.operation).to_ascii_lowercase();
        if !matches!(change.operation.as_str(), "create" | "update") {
            return Err(GateError::new(
                400,
                "Wiki change operation must be 'create' or 'update'",
            ));
        }
        change.title = collapse_whitespace(&change.title);
        if change.title.is_empty() || change.title.chars().count() > 300 {
            return Err(GateError::new(
                400,
                "Wiki change title is empty or too long",
            ));
        }
        if change.content.trim().is_empty() {
            return Err(GateError::new(400, "Wiki change content is empty"));
        }
        if change.content.contains("<!-- evidence-locators:") {
            return Err(GateError::new(
                400,
                "Wiki change content contains a reserved evidence marker",
            ));
        }
        if change.content.len() > MAX_GENERATED_PAGE_BYTES {
            return Err(GateError::new(413, "Wiki change content is too large"));
        }

        change.evidence_locators = locators.to_vec();
        change.content = format!(
            "{}\n\n<!-- evidence-locators: {} -->\n",
            change.content.trim_end(),
            locators_json
        );
        if change.content.len() > MAX_GENERATED_PAGE_BYTES {
            return Err(GateError::new(
                413,
                "Wiki change content and evidence metadata are too large",
            ));
        }
        validated.push(change);
    }
    Ok(validated)
}

fn validate_wiki_page_path(path: &str) -> Result<(), GateError> {
    if path != path.trim()
        || path.len() > 512
        || path.contains('\\')
        || !path.starts_with("wiki/")
        || !path.ends_with(".md")
    {
        return Err(GateError::new(
            400,
            "Wiki change path must be a safe wiki/*.md path",
        ));
    }
    let parts = path.split('/').collect::<Vec<_>>();
    if parts.len() < 2
        || parts.iter().any(|part| {
            part.is_empty()
                || matches!(*part, "." | "..")
                || part.chars().any(|character| {
                    character.is_control()
                        || matches!(character, ':' | '*' | '?' | '"' | '<' | '>' | '|')
                })
        })
        || parts.last().is_some_and(|part| *part == ".md")
    {
        return Err(GateError::new(
            400,
            "Wiki change path must be a safe wiki/*.md path",
        ));
    }
    Ok(())
}

pub fn publication_sync_paths(draft: &IngestDraft) -> Vec<String> {
    let mut paths = draft.published_pages.clone();
    if let Some(source_path) = &draft.source_path {
        paths.push(source_path.clone());
    }
    paths.extend([
        "wiki/index.md".to_string(),
        "wiki/log.md".to_string(),
        "wiki/overview.md".to_string(),
    ]);
    paths.sort();
    paths.dedup();
    paths
}

pub fn draft_detail(project_path: &str, draft_id: &str) -> Result<Value, GateError> {
    let _guard = gate_lock()?;
    let draft = read_draft(project_path, draft_id)?;
    let proposal_path = draft_dir(project_path, draft_id)?.join(PROPOSAL_FILE);
    let proposal = if proposal_path.exists() {
        let raw = fs::read(&proposal_path)
            .map_err(|e| GateError::internal(format!("Failed to read draft proposal: {e}")))?;
        Some(
            serde_json::from_slice::<DraftProposal>(&raw)
                .map_err(|e| GateError::internal(format!("Invalid draft proposal: {e}")))?,
        )
    } else {
        None
    };
    let extracted_path = draft_dir(project_path, draft_id)?.join(EXTRACTED_FILE);
    let extracted_preview = fs::read_to_string(extracted_path)
        .ok()
        .map(|text| truncate_chars(&text, 12_000));
    Ok(json!({
        "ok": true,
        "draft": draft,
        "proposal": proposal,
        "extractedTextPreview": extracted_preview,
    }))
}

pub fn request_revision(
    project_path: &str,
    draft_id: &str,
    feedback: Option<String>,
) -> Result<IngestDraft, GateError> {
    let _guard = gate_lock()?;
    let mut draft = read_draft(project_path, draft_id)?;
    if !matches!(
        draft.status,
        DraftStatus::AwaitingReview | DraftStatus::Failed
    ) {
        return Err(GateError::new(
            409,
            "Only awaiting-review or failed drafts can be revised",
        ));
    }
    draft.status = DraftStatus::RevisionRequested;
    draft.revision = draft.revision.saturating_add(1);
    draft.feedback = feedback.filter(|value| !value.trim().is_empty());
    draft.error = None;
    draft.updated_at = now();
    write_draft(project_path, &draft)?;
    drop(_guard);
    kick_queue(project_path.to_string());
    Ok(draft)
}

pub fn reject_draft(
    project_path: &str,
    draft_id: &str,
    reason: Option<String>,
) -> Result<IngestDraft, GateError> {
    let _guard = gate_lock()?;
    let mut draft = read_draft(project_path, draft_id)?;
    if matches!(draft.status, DraftStatus::Trusted | DraftStatus::Publishing) {
        return Err(GateError::new(409, "Published drafts cannot be rejected"));
    }
    draft.status = DraftStatus::Rejected;
    draft.rejection_reason = reason.filter(|value| !value.trim().is_empty());
    draft.updated_at = now();
    write_draft(project_path, &draft)?;
    drop(_guard);
    kick_queue(project_path.to_string());
    Ok(draft)
}

pub fn approve_draft(project_path: &str, draft_id: &str) -> Result<IngestDraft, GateError> {
    let _guard = gate_lock()?;
    let mut draft = read_draft(project_path, draft_id)?;
    if draft.status != DraftStatus::AwaitingReview {
        return Err(GateError::new(409, "Draft is not awaiting review"));
    }
    let proposal_path = draft_dir(project_path, draft_id)?.join(PROPOSAL_FILE);
    let proposal_raw = fs::read(&proposal_path)
        .map_err(|e| GateError::internal(format!("Draft proposal is missing: {e}")))?;
    let proposal: DraftProposal = serde_json::from_slice(&proposal_raw)
        .map_err(|e| GateError::internal(format!("Draft proposal is invalid: {e}")))?;
    if proposal.changes.is_empty() {
        return Err(GateError::new(409, "Draft has no proposed Wiki changes"));
    }

    draft.status = DraftStatus::Publishing;
    draft.updated_at = now();
    write_draft(project_path, &draft)?;

    match publish_transaction(project_path, &mut draft, &proposal) {
        Ok(()) => {
            drop(_guard);
            kick_queue(project_path.to_string());
            Ok(draft)
        }
        Err(error) => {
            draft.status = DraftStatus::AwaitingReview;
            draft.error = Some(error.message.clone());
            draft.updated_at = now();
            let _ = write_draft(project_path, &draft);
            drop(_guard);
            Err(error)
        }
    }
}

fn kick_queue(project_path: String) {
    let selected = (|| -> Result<Option<String>, GateError> {
        let _guard = gate_lock()?;
        let drafts = list_drafts_unlocked(&project_path)?;
        if drafts.iter().any(|draft| draft.status.blocks_queue()) {
            return Ok(None);
        }
        let native_compile = native_compile_enabled();
        let mut queued = drafts
            .into_iter()
            .filter(|draft| {
                matches!(
                    draft.status,
                    DraftStatus::Uploaded | DraftStatus::RevisionRequested
                ) && (!native_compile || draft.source_kind == "generated")
            })
            .collect::<Vec<_>>();
        queued.sort_by(|left, right| left.created_at.cmp(&right.created_at));
        let Some(mut draft) = queued.into_iter().next() else {
            return Ok(None);
        };
        draft.status = DraftStatus::Parsing;
        draft.updated_at = now();
        write_draft(&project_path, &draft)?;
        Ok(Some(draft.id))
    })();

    match selected {
        Ok(Some(draft_id)) => {
            std::thread::spawn(move || process_draft(project_path, draft_id));
        }
        Ok(None) => {}
        Err(error) => eprintln!(
            "[ingest-gate] failed to start queued draft: {}",
            error.message
        ),
    }
}

fn process_draft(project_path: String, draft_id: String) {
    let result = (|| -> Result<(), GateError> {
        let initial_draft = {
            let _guard = gate_lock()?;
            read_draft(&project_path, &draft_id)?
        };
        if initial_draft.source_kind == "generated" {
            let proposal_path = draft_dir(&project_path, &draft_id)?.join(PROPOSAL_FILE);
            let proposal_raw = fs::read(&proposal_path).map_err(|error| {
                GateError::internal(format!("Generated proposal is missing: {error}"))
            })?;
            let proposal: DraftProposal =
                serde_json::from_slice(&proposal_raw).map_err(|error| {
                    GateError::internal(format!("Generated proposal is invalid: {error}"))
                })?;
            let _guard = gate_lock()?;
            let mut draft = read_draft(&project_path, &draft_id)?;
            if draft.status == DraftStatus::Rejected {
                return Ok(());
            }
            draft.status = DraftStatus::AwaitingReview;
            draft.proposed_change_count = proposal.changes.len();
            draft.error = None;
            draft.updated_at = now();
            return write_draft(&project_path, &draft);
        }

        let source = staged_source_path(&project_path, &initial_draft)?;
        let source_string = source.to_string_lossy().to_string();
        let extracted =
            tauri::async_runtime::block_on(commands::fs::read_file(source_string, Some(false)))
                .map_err(|e| GateError::new(422, format!("PDF parsing failed: {e}")))?;
        let extracted = truncate_chars(&extracted, MAX_EXTRACTED_CHARS);
        write_atomic(
            &draft_dir(&project_path, &draft_id)?.join(EXTRACTED_FILE),
            extracted.as_bytes(),
        )?;
        write_atomic(
            &draft_dir(&project_path, &draft_id)?
                .join(format!("extracted-r{}.md", initial_draft.revision)),
            extracted.as_bytes(),
        )?;

        let mut draft = {
            let _guard = gate_lock()?;
            let mut draft = read_draft(&project_path, &draft_id)?;
            if draft.status == DraftStatus::Rejected {
                return Ok(());
            }
            let metadata = derive_paper_metadata(&draft, &extracted, &source);
            draft.paper_title = Some(metadata.title);
            draft.paper_authors = metadata.authors;
            draft.publication_year = metadata.year;
            draft.metadata_source = Some(metadata.source);
            draft.status = DraftStatus::Drafting;
            draft.updated_at = now();
            write_draft(&project_path, &draft)?;
            draft
        };

        let proposal = build_proposal(&draft, &extracted);
        write_json(
            &draft_dir(&project_path, &draft_id)?.join(PROPOSAL_FILE),
            &proposal,
        )?;

        let _guard = gate_lock()?;
        draft = read_draft(&project_path, &draft_id)?;
        if draft.status == DraftStatus::Rejected {
            return Ok(());
        }
        draft.status = DraftStatus::AwaitingReview;
        draft.page_count = Some(count_pages(&extracted));
        draft.proposed_change_count = proposal.changes.len();
        draft.error = None;
        draft.updated_at = now();
        write_draft(&project_path, &draft)
    })();

    if let Err(error) = result {
        if let Ok(_guard) = gate_lock() {
            if let Ok(mut draft) = read_draft(&project_path, &draft_id) {
                if draft.status != DraftStatus::Rejected {
                    draft.status = DraftStatus::Failed;
                    draft.error = Some(error.message.clone());
                    draft.updated_at = now();
                    let _ = write_draft(&project_path, &draft);
                }
            }
        }
        eprintln!("[ingest-gate] draft {draft_id} failed: {}", error.message);
        kick_queue(project_path);
    }
}

fn build_proposal(draft: &IngestDraft, extracted: &str) -> DraftProposal {
    let title = draft
        .paper_title
        .clone()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| title_from_filename(&draft.filename));
    let slug = format!("{}-{}", slugify(&title), &draft.sha256[..8]);
    let path = format!("wiki/papers/{slug}.md");
    let evidence_locators = evidence_locators(
        extracted,
        &draft.source_id,
        draft.revision,
        &draft.paper_authors,
        draft.publication_year,
    );
    let locators_json = serde_json::to_string(&evidence_locators).unwrap_or_else(|_| "[]".into());
    let authors_json = serde_json::to_string(&draft.paper_authors).unwrap_or_else(|_| "[]".into());
    let year_yaml = draft
        .publication_year
        .map(|year| year.to_string())
        .unwrap_or_else(|| "null".to_string());
    let citation = citation_label(
        &draft.paper_authors,
        draft.publication_year,
        1,
        &draft.source_id,
    );
    let feedback = draft
        .feedback
        .as_ref()
        .map(|value| format!("\n> Revision request: {}\n", value.trim()))
        .unwrap_or_default();
    let content = format!(
        "---\ntype: paper\ntitle: {title_json}\nauthors: {authors_json}\nyear: {year_yaml}\nsourceId: {source_id_json}\nsourceRevision: {revision}\nmetadataSource: {metadata_source_json}\n---\n\n# {title}\n\n<!-- evidence-locators: {locators_json} -->\n\n## Source\n\n- Citation: {citation}\n- Source ID: `{source_id}`\n- Original file: `{filename}`\n- SHA-256: `{sha256}`\n- Revision: {revision}\n- Metadata source: `{metadata_source}`\n{feedback}\n## Extracted paper text\n\n{extracted}\n",
        title_json = serde_json::to_string(&title).unwrap_or_else(|_| "\"Paper\"".into()),
        source_id_json = serde_json::to_string(&draft.source_id).unwrap_or_else(|_| "\"\"".into()),
        metadata_source_json = serde_json::to_string(draft.metadata_source.as_deref().unwrap_or("filename_fallback")).unwrap_or_else(|_| "\"filename_fallback\"".into()),
        source_id = draft.source_id,
        filename = draft.filename,
        sha256 = draft.sha256,
        revision = draft.revision,
        metadata_source = draft.metadata_source.as_deref().unwrap_or("filename_fallback"),
    );
    DraftProposal {
        generated_at: now(),
        generator: "strict-gate/deterministic-extraction".to_string(),
        changes: vec![ProposedChange {
            path,
            operation: "create".to_string(),
            title,
            content,
            evidence_locators,
        }],
    }
}

fn publish_transaction(
    project_path: &str,
    draft: &mut IngestDraft,
    proposal: &DraftProposal,
) -> Result<(), GateError> {
    let source_rel = if draft.source_kind == "generated" {
        None
    } else {
        let source_name = format!(
            "{}-{}",
            &draft.sha256[..8],
            safe_source_filename(&draft.filename)?
        );
        Some(format!("raw/sources/{source_name}"))
    };
    let trusted_at = now();
    let page_paths = proposal
        .changes
        .iter()
        .map(|change| change.path.clone())
        .collect::<Vec<_>>();

    draft.status = DraftStatus::Trusted;
    draft.source_path = source_rel.clone();
    draft.published_pages = page_paths.clone();
    draft.embedding_status = Some("queued".to_string());
    draft.error = None;
    draft.updated_at = trusted_at.clone();

    let trusted_path = state_path(project_path, TRUSTED_FILE)?;
    let mut trusted: Vec<TrustedSource> = read_json_or_default(&trusted_path)?;
    if let Some(source_rel) = &source_rel {
        trusted.retain(|source| source.source_id != draft.source_id);
        trusted.push(TrustedSource {
            source_id: draft.source_id.clone(),
            sha256: draft.sha256.clone(),
            filename: draft.filename.clone(),
            source_path: source_rel.clone(),
            page_paths: page_paths.clone(),
            revision: draft.revision,
            trusted_at: trusted_at.clone(),
            source_kind: draft.source_kind.clone(),
            title: draft.paper_title.clone(),
            authors: draft.paper_authors.clone(),
            year: draft.publication_year,
        });
    }

    let mut operations = Vec::<(PathBuf, Vec<u8>)>::new();
    if let Some(source_rel) = &source_rel {
        let source_bytes = fs::read(staged_source_path(project_path, draft)?)
            .map_err(|e| GateError::internal(format!("Staged source is missing: {e}")))?;
        operations.push((state_path(project_path, source_rel)?, source_bytes));
    }
    for change in &proposal.changes {
        if !change.path.starts_with("wiki/") || !change.path.ends_with(".md") {
            return Err(GateError::new(400, "Proposal contains an unsafe Wiki path"));
        }
        operations.push((
            state_path(project_path, &change.path)?,
            change.content.as_bytes().to_vec(),
        ));
    }

    let index_path = state_path(project_path, "wiki/index.md")?;
    let mut index =
        fs::read_to_string(&index_path).unwrap_or_else(|_| "# Knowledge Index\n".into());
    for change in &proposal.changes {
        let wiki_link = change
            .path
            .trim_start_matches("wiki/")
            .trim_end_matches(".md");
        let line = format!(
            "- [[{wiki_link}|{}]] (`{}`)\n",
            change.title, draft.source_id
        );
        if !index.contains(&line) {
            index.push_str(&line);
        }
    }
    operations.push((index_path, index.into_bytes()));

    let log_path = state_path(project_path, "wiki/log.md")?;
    let mut log = fs::read_to_string(&log_path).unwrap_or_else(|_| "# Activity Log\n\n".into());
    log.push_str(&format!(
        "- {trusted_at}: approved `{}` as `{}` (revision {}).\n",
        draft.filename, draft.source_id, draft.revision
    ));
    operations.push((log_path, log.into_bytes()));

    let overview_path = state_path(project_path, "wiki/overview.md")?;
    let overview = format!(
        "# Knowledge Base Overview\n\nTrusted sources: {}\n\nLast publication: {trusted_at}\n",
        trusted.len()
    );
    operations.push((overview_path, overview.into_bytes()));
    operations.push((
        trusted_path,
        serde_json::to_vec_pretty(&trusted).map_err(|e| {
            GateError::internal(format!("Failed to serialize trusted sources: {e}"))
        })?,
    ));
    operations.push((
        draft_dir(project_path, &draft.id)?.join(DRAFT_FILE),
        serde_json::to_vec_pretty(&draft)
            .map_err(|e| GateError::internal(format!("Failed to serialize draft: {e}")))?,
    ));

    // Ignore these writes in the legacy watcher. Publication has its own
    // explicit indexing event and must never loop back into source ingest.
    for (target, _) in &operations {
        commands::file_sync::mark_app_write_path(target);
    }
    commit_with_rollback(project_path, operations)?;
    if draft.source_kind != "generated" {
        let _ = fs::remove_file(staged_source_path(project_path, draft)?);
    }
    Ok(())
}

fn commit_with_rollback(
    project_path: &str,
    operations: Vec<(PathBuf, Vec<u8>)>,
) -> Result<(), GateError> {
    let transaction_root = state_path(
        project_path,
        &format!(".llm-wiki/transactions/{}", Uuid::new_v4()),
    )?;
    let staged_root = transaction_root.join("new");
    let backup_root = transaction_root.join("backup");
    fs::create_dir_all(&staged_root)
        .and_then(|_| fs::create_dir_all(&backup_root))
        .map_err(|e| GateError::internal(format!("Failed to prepare publication: {e}")))?;

    let mut prepared = Vec::new();
    let mut target_keys = BTreeSet::new();
    for (index, (target, bytes)) in operations.into_iter().enumerate() {
        let target_key = target
            .to_string_lossy()
            .replace('\\', "/")
            .to_ascii_lowercase();
        if !target_keys.insert(target_key) {
            let _ = fs::remove_dir_all(&transaction_root);
            return Err(GateError::new(
                409,
                "Publication contains duplicate target paths",
            ));
        }
        let staged = staged_root.join(index.to_string());
        if let Err(error) = fs::write(&staged, bytes) {
            rollback_prepared(&prepared);
            let _ = fs::remove_dir_all(&transaction_root);
            return Err(GateError::internal(format!(
                "Failed to stage publication: {error}"
            )));
        }
        let backup = backup_root.join(index.to_string());
        if target.exists() {
            if let Err(error) = fs::copy(&target, &backup) {
                rollback_prepared(&prepared);
                let _ = fs::remove_dir_all(&transaction_root);
                return Err(GateError::internal(format!(
                    "Failed to back up publication target: {error}"
                )));
            }
        }
        prepared.push((target, staged, backup));
    }

    let commit_result = (|| -> Result<(), GateError> {
        for (target, staged, _) in &prepared {
            let parent = target
                .parent()
                .ok_or_else(|| GateError::internal("Publication target has no parent"))?;
            fs::create_dir_all(parent).map_err(|e| {
                GateError::internal(format!("Failed to create publication directory: {e}"))
            })?;
            if target.exists() {
                fs::remove_file(target).map_err(|e| {
                    GateError::internal(format!("Failed to replace publication target: {e}"))
                })?;
            }
            fs::rename(staged, target).map_err(|e| {
                GateError::internal(format!("Failed to commit publication target: {e}"))
            })?;
        }
        Ok(())
    })();

    if let Err(error) = commit_result {
        rollback_prepared(&prepared);
        let _ = fs::remove_dir_all(&transaction_root);
        return Err(error);
    }
    let _ = fs::remove_dir_all(&transaction_root);
    Ok(())
}

fn rollback_prepared(prepared: &[(PathBuf, PathBuf, PathBuf)]) {
    for (target, _, backup) in prepared.iter().rev() {
        let _ = fs::remove_file(target);
        if backup.exists() {
            if let Some(parent) = target.parent() {
                let _ = fs::create_dir_all(parent);
            }
            let _ = fs::copy(backup, target);
        }
    }
}

pub fn list_candidates(
    project_path: &str,
    include_dismissed: bool,
) -> Result<Vec<ReadingCandidate>, GateError> {
    let _guard = gate_lock()?;
    let mut candidates: Vec<ReadingCandidate> =
        read_json_or_default(&state_path(project_path, CANDIDATES_FILE)?)?;
    if !include_dismissed {
        candidates.retain(|candidate| candidate.status != "dismissed");
    }
    candidates.sort_by(|left, right| right.created_at.cmp(&left.created_at));
    Ok(candidates)
}

pub fn dismiss_candidate(
    project_path: &str,
    candidate_id: &str,
) -> Result<ReadingCandidate, GateError> {
    let _guard = gate_lock()?;
    let path = state_path(project_path, CANDIDATES_FILE)?;
    let mut candidates: Vec<ReadingCandidate> = read_json_or_default(&path)?;
    let Some(candidate) = candidates
        .iter_mut()
        .find(|candidate| candidate.id == candidate_id)
    else {
        return Err(GateError::new(404, "Reading candidate was not found"));
    };
    candidate.status = "dismissed".to_string();
    candidate.updated_at = now();
    let result = candidate.clone();
    write_json(&path, &candidates)?;
    Ok(result)
}

pub async fn search_candidates(
    project_path: &str,
    query: &str,
    providers: &[String],
) -> Result<CandidateSearchResult, GateError> {
    let query = query.trim();
    if query.is_empty() {
        return Err(GateError::new(400, "Search query is required"));
    }
    let requested = providers
        .iter()
        .map(|provider| provider.to_ascii_lowercase())
        .collect::<BTreeSet<_>>();
    let use_all = requested.is_empty();
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(12))
        .user_agent("LLM-Wiki/0.6.4 local-reading-candidates")
        .build()
        .map_err(|e| GateError::internal(format!("Failed to create metadata client: {e}")))?;

    let mut calls = Vec::new();
    if use_all || requested.contains("openalex") {
        calls.push(fetch_openalex(client.clone(), query.to_string()));
    }
    if use_all || requested.contains("crossref") {
        calls.push(fetch_crossref(client.clone(), query.to_string()));
    }
    if use_all || requested.contains("arxiv") {
        calls.push(fetch_arxiv(client, query.to_string()));
    }

    let mut fetched = Vec::new();
    let mut provider_errors = Vec::new();
    for result in join_all(calls).await {
        match result {
            Ok(mut candidates) => fetched.append(&mut candidates),
            Err(error) => provider_errors.push(error),
        }
    }

    let _guard = gate_lock()?;
    let path = state_path(project_path, CANDIDATES_FILE)?;
    let mut stored: Vec<ReadingCandidate> = read_json_or_default(&path)?;
    let mut returned = Vec::new();
    for mut candidate in fetched {
        candidate.query = query.to_string();
        candidate.recommended_reason = format!(
            "题录与检索词“{}”相关；请先阅读原文，再手动上传 PDF 进入审核。",
            query
        );
        let key = candidate_key(&candidate);
        if let Some(existing) = stored.iter_mut().find(|item| candidate_key(item) == key) {
            if existing.status == "dismissed" {
                continue;
            }
            existing.updated_at = now();
            returned.push(existing.clone());
        } else {
            returned.push(candidate.clone());
            stored.push(candidate);
        }
    }
    write_json(&path, &stored)?;
    Ok(CandidateSearchResult {
        candidates: returned,
        provider_errors,
    })
}

type CandidateFetch = std::pin::Pin<
    Box<dyn std::future::Future<Output = Result<Vec<ReadingCandidate>, String>> + Send>,
>;

fn fetch_openalex(client: reqwest::Client, query: String) -> CandidateFetch {
    Box::pin(async move {
        let payload: Value = client
            .get("https://api.openalex.org/works")
            .query(&[("search", query.as_str()), ("per-page", "5")])
            .send()
            .await
            .map_err(|e| format!("OpenAlex request failed: {e}"))?
            .error_for_status()
            .map_err(|e| format!("OpenAlex returned an error: {e}"))?
            .json()
            .await
            .map_err(|e| format!("OpenAlex response was invalid: {e}"))?;
        let timestamp = now();
        Ok(payload
            .get("results")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|work| {
                let title = work.get("title")?.as_str()?.trim().to_string();
                if title.is_empty() {
                    return None;
                }
                let id = work
                    .get("id")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                let doi = work
                    .get("doi")
                    .and_then(Value::as_str)
                    .map(|value| value.trim_start_matches("https://doi.org/").to_string());
                let url = work
                    .pointer("/primary_location/landing_page_url")
                    .and_then(Value::as_str)
                    .or_else(|| work.get("id").and_then(Value::as_str))
                    .unwrap_or("")
                    .to_string();
                let authors = work
                    .get("authorships")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter_map(|entry| {
                        entry
                            .pointer("/author/display_name")
                            .and_then(Value::as_str)
                    })
                    .take(20)
                    .map(ToOwned::to_owned)
                    .collect();
                Some(ReadingCandidate {
                    id: Uuid::new_v4().to_string(),
                    provider: "openalex".to_string(),
                    external_id: id,
                    title,
                    authors,
                    year: work
                        .get("publication_year")
                        .and_then(Value::as_i64)
                        .map(|v| v as i32),
                    abstract_text: openalex_abstract(work.get("abstract_inverted_index")),
                    doi,
                    url,
                    query: String::new(),
                    recommended_reason: String::new(),
                    status: "unread".to_string(),
                    created_at: timestamp.clone(),
                    updated_at: timestamp.clone(),
                })
            })
            .collect())
    })
}

fn fetch_crossref(client: reqwest::Client, query: String) -> CandidateFetch {
    Box::pin(async move {
        let payload: Value = client
            .get("https://api.crossref.org/works")
            .query(&[("query", query.as_str()), ("rows", "5")])
            .send()
            .await
            .map_err(|e| format!("Crossref request failed: {e}"))?
            .error_for_status()
            .map_err(|e| format!("Crossref returned an error: {e}"))?
            .json()
            .await
            .map_err(|e| format!("Crossref response was invalid: {e}"))?;
        let timestamp = now();
        Ok(payload
            .pointer("/message/items")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|work| {
                let title = work
                    .get("title")
                    .and_then(Value::as_array)
                    .and_then(|values| values.first())
                    .and_then(Value::as_str)?
                    .trim()
                    .to_string();
                if title.is_empty() {
                    return None;
                }
                let doi = work
                    .get("DOI")
                    .and_then(Value::as_str)
                    .map(ToOwned::to_owned);
                let url = work
                    .get("URL")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                let authors = work
                    .get("author")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .map(|author| {
                        format!(
                            "{} {}",
                            author.get("given").and_then(Value::as_str).unwrap_or(""),
                            author.get("family").and_then(Value::as_str).unwrap_or("")
                        )
                        .trim()
                        .to_string()
                    })
                    .filter(|author| !author.is_empty())
                    .take(20)
                    .collect();
                let year = work
                    .pointer("/published/date-parts/0/0")
                    .and_then(Value::as_i64)
                    .map(|value| value as i32);
                Some(ReadingCandidate {
                    id: Uuid::new_v4().to_string(),
                    provider: "crossref".to_string(),
                    external_id: doi.clone().unwrap_or_else(|| url.clone()),
                    title,
                    authors,
                    year,
                    abstract_text: truncate_chars(
                        work.get("abstract").and_then(Value::as_str).unwrap_or(""),
                        MAX_CANDIDATE_ABSTRACT_CHARS,
                    ),
                    doi,
                    url,
                    query: String::new(),
                    recommended_reason: String::new(),
                    status: "unread".to_string(),
                    created_at: timestamp.clone(),
                    updated_at: timestamp.clone(),
                })
            })
            .collect())
    })
}

#[derive(Debug, Deserialize)]
struct ArxivFeed {
    #[serde(rename = "entry", default)]
    entries: Vec<ArxivEntry>,
}

#[derive(Debug, Deserialize)]
struct ArxivEntry {
    id: String,
    title: String,
    summary: String,
    published: String,
    #[serde(rename = "author", default)]
    authors: Vec<ArxivAuthor>,
}

#[derive(Debug, Deserialize)]
struct ArxivAuthor {
    name: String,
}

fn fetch_arxiv(client: reqwest::Client, query: String) -> CandidateFetch {
    Box::pin(async move {
        let body = client
            .get("https://export.arxiv.org/api/query")
            .query(&[
                ("search_query", format!("all:{query}")),
                ("start", "0".to_string()),
                ("max_results", "5".to_string()),
            ])
            .send()
            .await
            .map_err(|e| format!("arXiv request failed: {e}"))?
            .error_for_status()
            .map_err(|e| format!("arXiv returned an error: {e}"))?
            .text()
            .await
            .map_err(|e| format!("arXiv response could not be read: {e}"))?;
        let feed: ArxivFeed = quick_xml::de::from_str(&body)
            .map_err(|e| format!("arXiv response was invalid: {e}"))?;
        let timestamp = now();
        Ok(feed
            .entries
            .into_iter()
            .map(|entry| {
                let external_id = entry.id.rsplit('/').next().unwrap_or(&entry.id).to_string();
                ReadingCandidate {
                    id: Uuid::new_v4().to_string(),
                    provider: "arxiv".to_string(),
                    external_id,
                    title: collapse_whitespace(&entry.title),
                    authors: entry
                        .authors
                        .into_iter()
                        .map(|author| author.name)
                        .collect(),
                    year: entry
                        .published
                        .get(0..4)
                        .and_then(|value| value.parse().ok()),
                    abstract_text: truncate_chars(
                        &collapse_whitespace(&entry.summary),
                        MAX_CANDIDATE_ABSTRACT_CHARS,
                    ),
                    doi: None,
                    url: entry.id,
                    query: String::new(),
                    recommended_reason: String::new(),
                    status: "unread".to_string(),
                    created_at: timestamp.clone(),
                    updated_at: timestamp.clone(),
                }
            })
            .collect())
    })
}

pub fn trusted_source_pdf(
    project_path: &str,
    source_id: &str,
) -> Result<(PathBuf, String), GateError> {
    let _guard = gate_lock()?;
    let trusted: Vec<TrustedSource> =
        read_json_or_default(&state_path(project_path, TRUSTED_FILE)?)?;
    let source = trusted
        .into_iter()
        .find(|source| source.source_id == source_id && source.source_kind == "pdf")
        .ok_or_else(|| GateError::new(404, "Trusted source was not found"))?;
    let path = state_path(project_path, &source.source_path)?;
    if !path.exists() {
        return Err(GateError::new(404, "Trusted PDF file is missing"));
    }
    Ok((path, source.filename))
}

pub fn evidence_for_search(
    project_path: &str,
    page_path: &str,
    snippet: &str,
) -> Option<EvidenceLocator> {
    if !page_path.starts_with("wiki/") || !page_path.ends_with(".md") {
        return None;
    }
    let path = state_path(project_path, page_path).ok()?;
    let content = fs::read_to_string(path).ok()?;
    let marker = "<!-- evidence-locators: ";
    let start = content.find(marker)? + marker.len();
    let end = content[start..].find(" -->")? + start;
    let locators: Vec<EvidenceLocator> = serde_json::from_str(&content[start..end]).ok()?;
    if locators.is_empty() {
        return None;
    }
    let source_id = locators.first()?.source_id.clone();
    let revision = locators.first()?.revision;
    // The generated Wiki page can contain headings and metadata that are not
    // present in the source PDF. Match against the immutable extracted source
    // for this exact revision whenever it is available, then fall back to the
    // page itself for older projects that predate revision snapshots.
    let evidence_text = extracted_text_for_source(project_path, &source_id, revision)
        .unwrap_or_else(|| content.clone());
    let best_page = best_matching_page(&evidence_text, snippet)?;
    locators
        .iter()
        .find(|locator| locator.page == best_page)
        .cloned()
}

fn extracted_text_for_source(project_path: &str, source_id: &str, revision: u32) -> Option<String> {
    let root = state_path(project_path, STAGING_ROOT).ok()?;
    let entries = fs::read_dir(root).ok()?;
    let revision_file = format!("extracted-r{revision}.md");
    for entry in entries.flatten() {
        let directory = entry.path();
        if !directory.is_dir() {
            continue;
        }
        let draft_path = directory.join(DRAFT_FILE);
        let Some(draft) = fs::read(&draft_path)
            .ok()
            .and_then(|raw| serde_json::from_slice::<IngestDraft>(&raw).ok())
        else {
            continue;
        };
        if draft.source_id != source_id {
            continue;
        }
        let revision_path = directory.join(&revision_file);
        if let Ok(text) = fs::read_to_string(revision_path) {
            return Some(text);
        }
        // Compatibility for drafts created before immutable revision files
        // were introduced. Only use the mutable file when its revision still
        // agrees with the locator.
        if draft.revision == revision {
            if let Ok(text) = fs::read_to_string(directory.join(EXTRACTED_FILE)) {
                return Some(text);
            }
        }
    }
    None
}

fn safe_source_filename(input: &str) -> Result<String, GateError> {
    let decoded = input.trim();
    let mut result = String::with_capacity(decoded.len());
    for character in decoded.chars().take(180) {
        if character.is_control()
            || matches!(
                character,
                '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|'
            )
        {
            result.push('_');
        } else {
            result.push(character);
        }
    }
    let result = result
        .trim_matches(|character| character == ' ' || character == '.')
        .trim()
        .to_string();
    if result.is_empty() || Path::new(&result).extension().is_none() {
        return Err(GateError::new(
            415,
            "Imported source must have a file extension",
        ));
    }
    Ok(result)
}

fn normalize_source_kind(requested: &str, filename: &str) -> String {
    let extension = Path::new(filename)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or(requested)
        .trim()
        .to_ascii_lowercase();
    if extension.is_empty() {
        "document".to_string()
    } else {
        extension
    }
}

fn supported_source_extension(extension: &str) -> bool {
    matches!(
        extension,
        "md" | "mdx"
            | "txt"
            | "rtf"
            | "pdf"
            | "html"
            | "htm"
            | "xml"
            | "doc"
            | "docx"
            | "xls"
            | "xlsx"
            | "ppt"
            | "pptx"
            | "odt"
            | "ods"
            | "odp"
            | "epub"
            | "mobi"
            | "json"
            | "jsonl"
            | "csv"
            | "tsv"
            | "yaml"
            | "yml"
            | "ndjson"
    )
}

fn staged_source_name(filename: &str) -> String {
    let extension = Path::new(filename)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("bin")
        .to_ascii_lowercase();
    format!("source.{extension}")
}

fn staged_source_path(project_path: &str, draft: &IngestDraft) -> Result<PathBuf, GateError> {
    let name = draft.staged_source_name.as_deref().unwrap_or(SOURCE_FILE);
    if name.contains('/') || name.contains('\\') || name == "." || name == ".." {
        return Err(GateError::internal("Draft staged source name is invalid"));
    }
    Ok(draft_dir(project_path, &draft.id)?.join(name))
}

fn derive_paper_metadata(draft: &IngestDraft, extracted: &str, source: &Path) -> PaperMetadata {
    let filename_title = title_from_filename(&draft.filename);
    let mut title = filename_title.clone();
    let mut authors = Vec::new();
    let mut sources = Vec::<&str>::new();
    let mut pdf_creation_date = None;

    if draft.source_kind == "pdf" {
        if let Ok((pdf_title, pdf_author, creation_date)) =
            commands::fs::read_pdf_metadata_fields(&source.to_string_lossy())
        {
            if let Some(value) = pdf_title.filter(|value| usable_paper_title(value)) {
                title = collapse_whitespace(&value);
                sources.push("pdf_title");
            }
            if let Some(value) = pdf_author {
                authors = split_authors(&value);
                if !authors.is_empty() {
                    sources.push("pdf_author");
                }
            }
            pdf_creation_date = creation_date;
        }
    }

    let first_page = first_page_text(extracted);
    if title == filename_title {
        if let Some(value) = first_page_title(&first_page) {
            title = value;
            sources.push("first_page_title");
        }
    }
    if authors.is_empty() {
        if let Some(value) = first_page_author_line(&first_page, &title) {
            authors = split_authors(&value);
            if !authors.is_empty() {
                sources.push("first_page_authors_heuristic");
            }
        }
    }

    let mut year =
        extract_plausible_year(&first_page).or_else(|| extract_plausible_year(&draft.filename));
    if year.is_some() {
        sources.push("first_page_or_filename_year");
    } else if let Some(value) = pdf_creation_date
        .as_deref()
        .and_then(extract_plausible_year)
    {
        // PDF creation date is explicitly a fallback; it may be the export
        // year rather than the publication year, so surface that provenance.
        year = Some(value);
        sources.push("pdf_creation_year_fallback");
    }

    if sources.is_empty() {
        sources.push("filename_fallback");
    }
    PaperMetadata {
        title,
        authors,
        year,
        source: sources.join("+"),
    }
}

fn usable_paper_title(value: &str) -> bool {
    let value = collapse_whitespace(value);
    let lower = value.to_ascii_lowercase();
    let count = value.chars().count();
    (3..=300).contains(&count)
        && value.chars().any(char::is_alphabetic)
        && !matches!(lower.as_str(), "untitled" | "document" | "microsoft word")
        && !value.contains('/')
        && !value.contains('\\')
}

fn first_page_text(extracted: &str) -> String {
    let mut in_first_page = false;
    let mut output = String::new();
    for line in extracted.lines() {
        if let Some(page) = page_marker(line) {
            if page == 1 {
                in_first_page = true;
                continue;
            }
            if in_first_page {
                break;
            }
        }
        if in_first_page
            || !extracted
                .lines()
                .any(|candidate| page_marker(candidate).is_some())
        {
            output.push_str(line);
            output.push('\n');
        }
    }
    truncate_chars(&output, 20_000)
}

fn first_page_title(first_page: &str) -> Option<String> {
    first_page
        .lines()
        .map(collapse_whitespace)
        .filter(|line| usable_paper_title(line))
        .find(|line| {
            let lower = line.to_ascii_lowercase();
            !lower.starts_with("abstract")
                && !lower.starts_with("arxiv:")
                && !lower.starts_with("doi:")
                && !lower.starts_with("http")
                && !lower.contains("all rights reserved")
        })
}

fn first_page_author_line(first_page: &str, title: &str) -> Option<String> {
    let normalized_title = collapse_whitespace(title).to_ascii_lowercase();
    first_page
        .lines()
        .map(collapse_whitespace)
        .skip_while(|line| line.to_ascii_lowercase() != normalized_title)
        .skip(1)
        .take(8)
        .find(|line| {
            let lower = line.to_ascii_lowercase();
            line.chars().count() <= 300
                && line.chars().any(char::is_alphabetic)
                && (line.contains(',') || line.contains(';') || lower.contains(" and "))
                && !lower.contains("university")
                && !lower.contains("institute")
                && !lower.starts_with("abstract")
                && !lower.contains('@')
        })
}

fn split_authors(value: &str) -> Vec<String> {
    let normalized = value
        .replace(" and ", ";")
        .replace(" AND ", ";")
        .replace('&', ";");
    let delimiter = if normalized.contains(';') { ';' } else { ',' };
    let mut authors = normalized
        .split(delimiter)
        .map(|author| {
            collapse_whitespace(author.trim_matches(|character: char| {
                character.is_ascii_digit()
                    || matches!(character, '*' | '†' | '‡' | ',' | ';')
                    || character.is_whitespace()
            }))
        })
        .filter(|author| {
            let count = author.chars().count();
            (2..=100).contains(&count) && author.chars().any(char::is_alphabetic)
        })
        .collect::<Vec<_>>();
    let mut seen = BTreeSet::new();
    authors.retain(|author| seen.insert(author.to_ascii_lowercase()));
    authors.truncate(50);
    authors
}

fn extract_plausible_year(value: &str) -> Option<i32> {
    let current_year = Utc::now().format("%Y").to_string().parse::<i32>().ok()?;
    let chars = value.chars().collect::<Vec<_>>();
    for window in chars.windows(4) {
        if !window.iter().all(char::is_ascii_digit) {
            continue;
        }
        let parsed = window.iter().collect::<String>().parse::<i32>().ok()?;
        if (1900..=current_year + 1).contains(&parsed) {
            return Some(parsed);
        }
    }
    None
}

fn citation_label(authors: &[String], year: Option<i32>, page: usize, source_id: &str) -> String {
    let author = authors
        .first()
        .map(|value| {
            if authors.len() > 1 {
                format!("{value} et al.")
            } else {
                value.clone()
            }
        })
        .unwrap_or_else(|| source_id.to_string());
    let year = year
        .map(|value| value.to_string())
        .unwrap_or_else(|| "n.d.".to_string());
    format!("【{author}, {year}, p.{page}】")
}

fn title_from_filename(filename: &str) -> String {
    Path::new(filename)
        .file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or("Paper")
        .replace('_', " ")
        .replace('-', " ")
        .trim()
        .to_string()
}

fn slugify(title: &str) -> String {
    let mut slug = String::new();
    let mut separator = false;
    for character in title.chars() {
        if character.is_ascii_alphanumeric() {
            slug.push(character.to_ascii_lowercase());
            separator = false;
        } else if !separator && !slug.is_empty() {
            slug.push('-');
            separator = true;
        }
    }
    let slug = slug.trim_matches('-');
    if slug.is_empty() {
        "paper".to_string()
    } else {
        slug.to_string()
    }
}

fn count_pages(text: &str) -> usize {
    let pages = text
        .lines()
        .filter_map(page_marker)
        .collect::<BTreeSet<_>>()
        .len();
    pages.max(1)
}

fn evidence_locators(
    text: &str,
    source_id: &str,
    revision: u32,
    authors: &[String],
    year: Option<i32>,
) -> Vec<EvidenceLocator> {
    let mut chunks = Vec::<(usize, String)>::new();
    let mut current_page = 1usize;
    let mut current = String::new();
    for line in text.lines() {
        if let Some(page) = page_marker(line) {
            if !current.trim().is_empty() {
                chunks.push((current_page, std::mem::take(&mut current)));
            }
            current_page = page;
            continue;
        }
        current.push_str(line);
        current.push('\n');
    }
    if !current.trim().is_empty() || chunks.is_empty() {
        chunks.push((current_page, current));
    }
    chunks
        .into_iter()
        .map(|(page, content)| {
            let section = content
                .lines()
                .find_map(|line| line.trim().strip_prefix('#').map(str::trim))
                .filter(|value| !value.is_empty())
                .unwrap_or("Page text")
                .to_string();
            let snippet = collapse_whitespace(&content);
            let snippet = truncate_chars(&snippet, 240);
            EvidenceLocator {
                source_id: source_id.to_string(),
                revision,
                page,
                section,
                snippet_hash: hex_sha256(snippet.as_bytes()),
                authors: authors.to_vec(),
                year,
            }
        })
        .collect()
}

fn page_marker(line: &str) -> Option<usize> {
    line.trim()
        .strip_prefix("## Page ")
        .and_then(|value| value.trim().parse::<usize>().ok())
}

fn best_matching_page(content: &str, snippet: &str) -> Option<usize> {
    let query_tokens = collapse_whitespace(snippet)
        .to_ascii_lowercase()
        .split(|character: char| !character.is_alphanumeric())
        .filter(|token| token.chars().count() >= 3)
        .map(ToOwned::to_owned)
        .collect::<BTreeSet<_>>();
    let mut current_page = 1usize;
    let mut current_text = String::new();
    let mut pages = Vec::new();
    for line in content.lines() {
        if let Some(page) = page_marker(line) {
            if !current_text.is_empty() {
                pages.push((current_page, std::mem::take(&mut current_text)));
            }
            current_page = page;
        } else {
            current_text.push_str(line);
            current_text.push(' ');
        }
    }
    pages.push((current_page, current_text));
    let (page, score) = pages
        .into_iter()
        .map(|(page, page_text)| {
            let lower = page_text.to_ascii_lowercase();
            let score = query_tokens
                .iter()
                .filter(|token| lower.contains(token.as_str()))
                .count();
            (page, score)
        })
        .max_by_key(|(_, score)| *score)?;
    (score > 0).then_some(page)
}

fn openalex_abstract(value: Option<&Value>) -> String {
    let Some(map) = value.and_then(Value::as_object) else {
        return String::new();
    };
    let mut words = Vec::<(usize, String)>::new();
    for (word, positions) in map {
        for position in positions.as_array().into_iter().flatten() {
            if let Some(position) = position.as_u64() {
                words.push((position as usize, word.clone()));
            }
        }
    }
    words.sort_by_key(|(position, _)| *position);
    truncate_chars(
        &words
            .into_iter()
            .map(|(_, word)| word)
            .collect::<Vec<_>>()
            .join(" "),
        MAX_CANDIDATE_ABSTRACT_CHARS,
    )
}

fn candidate_key(candidate: &ReadingCandidate) -> String {
    if let Some(doi) = &candidate.doi {
        return format!("doi:{}", doi.to_ascii_lowercase());
    }
    if !candidate.external_id.is_empty() {
        return format!(
            "{}:{}",
            candidate.provider.to_ascii_lowercase(),
            candidate.external_id.to_ascii_lowercase()
        );
    }
    format!(
        "title:{}",
        collapse_whitespace(&candidate.title).to_ascii_lowercase()
    )
}

fn collapse_whitespace(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn truncate_chars(value: &str, max_chars: usize) -> String {
    if value.chars().count() <= max_chars {
        value.to_string()
    } else {
        let mut truncated = value.chars().take(max_chars).collect::<String>();
        truncated.push_str("\n\n[truncated by strict ingest gate]");
        truncated
    }
}

fn hex_sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stage_test_source(project_path: &str, status: DraftStatus, revision: u32) -> IngestDraft {
        let bytes = b"Native compiler test source";
        let timestamp = now();
        let sha256 = hex_sha256(bytes);
        let draft = IngestDraft {
            id: Uuid::new_v4().to_string(),
            filename: "native-compiler-test.txt".to_string(),
            source_id: format!("source:{}", &sha256[..16]),
            sha256,
            size_bytes: bytes.len() as u64,
            status,
            revision,
            created_at: timestamp.clone(),
            updated_at: timestamp,
            draft_mode: "native_compilation".to_string(),
            source_kind: "txt".to_string(),
            staged_source_name: Some("source.txt".to_string()),
            paper_title: None,
            paper_authors: Vec::new(),
            publication_year: None,
            metadata_source: None,
            page_count: None,
            proposed_change_count: 0,
            feedback: Some("Include the revised method discussion".to_string()),
            rejection_reason: None,
            error: None,
            source_path: None,
            published_pages: Vec::new(),
            embedding_status: None,
        };
        let directory = draft_dir(project_path, &draft.id).expect("draft directory");
        fs::create_dir_all(&directory).expect("create staging directory");
        fs::write(directory.join("source.txt"), bytes).expect("write staged source");
        write_draft(project_path, &draft).expect("write draft metadata");
        draft
    }

    #[test]
    fn page_boundaries_create_stable_evidence_locators() {
        let text = "## Page 1\n# Intro\nAlpha beta\n## Page 2\n## Method\nGamma";
        let locators = evidence_locators(
            text,
            "paper:abc",
            2,
            &["Ada Lovelace".to_string(), "Alan Turing".to_string()],
            Some(2025),
        );
        assert_eq!(locators.len(), 2);
        assert_eq!(locators[0].page, 1);
        assert_eq!(locators[1].page, 2);
        assert_eq!(locators[0].source_id, "paper:abc");
        assert_eq!(locators[0].revision, 2);
        assert_eq!(locators[0].snippet_hash.len(), 64);
        assert_eq!(locators[0].authors[0], "Ada Lovelace");
        assert_eq!(locators[0].year, Some(2025));
    }

    #[test]
    fn filename_never_escapes_staging() {
        assert_eq!(
            safe_source_filename("../bad:name.pdf").unwrap(),
            "_bad_name.pdf"
        );
        assert_eq!(safe_source_filename("notes.txt").unwrap(), "notes.txt");
        assert!(safe_source_filename("no-extension").is_err());
    }

    #[test]
    fn metadata_fallbacks_are_explicit_and_preserve_author_order() {
        assert_eq!(
            split_authors("Ada Lovelace; Alan Turing; Ada Lovelace"),
            vec!["Ada Lovelace", "Alan Turing"]
        );
        assert_eq!(extract_plausible_year("Published online 2024"), Some(2024));
        assert_eq!(
            citation_label(
                &["Ada Lovelace".to_string(), "Alan Turing".to_string()],
                Some(2024),
                9,
                "paper:abc"
            ),
            "【Ada Lovelace et al., 2024, p.9】"
        );
        assert_eq!(
            citation_label(&[], None, 1, "paper:abc"),
            "【paper:abc, n.d., p.1】"
        );
    }

    #[test]
    fn openalex_inverted_abstract_is_reassembled() {
        let value = json!({ "world": [1], "hello": [0] });
        assert_eq!(openalex_abstract(Some(&value)), "hello world");
    }

    #[test]
    fn native_compilation_claim_and_submit_are_cas_guarded() {
        let project = std::env::temp_dir().join(format!("llm-wiki-native-{}", Uuid::new_v4()));
        let project_path = project.to_string_lossy().to_string();
        let original = stage_test_source(&project_path, DraftStatus::Uploaded, 3);

        let claim = claim_ingest_compilation(project_path.clone())
            .expect("claim should succeed")
            .expect("source draft should be available");
        assert_eq!(claim.draft.id, original.id);
        assert_eq!(claim.draft.status, DraftStatus::Drafting);
        assert_eq!(claim.draft.revision, 3);
        assert!(Path::new(&claim.source_path).is_absolute());
        assert_eq!(
            claim.feedback.as_deref(),
            Some("Include the revised method discussion")
        );

        let recovered = claim_ingest_compilation(project_path.clone())
            .expect("recovery claim should succeed")
            .expect("drafting source should be recoverable");
        assert_eq!(recovered.draft.id, original.id);
        assert_eq!(recovered.draft.revision, 3);

        let extracted = "## Page 1\nNative Compiler Test\nAda Lovelace; Alan Turing\nPublished 2024\nAlpha evidence.\n## Page 2\n# Method\nBeta evidence.";
        let change = ProposedChange {
            path: "wiki/papers/native-compiler-test.md".to_string(),
            operation: "create".to_string(),
            title: "Native Compiler Test".to_string(),
            content: "# Native Compiler Test\n\nCompiled synthesis.".to_string(),
            evidence_locators: vec![EvidenceLocator {
                source_id: "untrusted".to_string(),
                revision: 999,
                page: 999,
                section: "untrusted".to_string(),
                snippet_hash: "untrusted".to_string(),
                authors: Vec::new(),
                year: None,
            }],
        };
        let submitted = submit_ingest_compilation(
            project_path.clone(),
            original.id.clone(),
            3,
            extracted.to_string(),
            vec![change.clone()],
            "test/native-compiler".to_string(),
        )
        .expect("current compilation should submit");
        assert_eq!(submitted.status, DraftStatus::AwaitingReview);
        assert_eq!(submitted.page_count, Some(2));
        assert_eq!(submitted.proposed_change_count, 1);
        assert_eq!(submitted.publication_year, Some(2024));

        let proposal_raw = fs::read(
            draft_dir(&project_path, &original.id)
                .expect("draft directory")
                .join(PROPOSAL_FILE),
        )
        .expect("proposal should exist");
        let proposal: DraftProposal =
            serde_json::from_slice(&proposal_raw).expect("proposal should be valid");
        let locators = &proposal.changes[0].evidence_locators;
        assert_eq!(locators.len(), 2);
        assert_eq!(locators[0].page, 1);
        assert_eq!(locators[1].page, 2);
        assert!(locators.iter().all(|locator| {
            locator.source_id == original.source_id
                && locator.revision == 3
                && locator.snippet_hash.len() == 64
        }));
        assert!(proposal.changes[0]
            .content
            .contains("<!-- evidence-locators:"));

        let stale = submit_ingest_compilation(
            project_path.clone(),
            original.id.clone(),
            3,
            extracted.to_string(),
            vec![change],
            "test/native-compiler".to_string(),
        )
        .expect_err("an already-submitted claim must be stale");
        assert!(stale.contains("stale"));

        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn native_compilation_waits_for_pending_review() {
        let project = std::env::temp_dir().join(format!("llm-wiki-native-{}", Uuid::new_v4()));
        let project_path = project.to_string_lossy().to_string();
        stage_test_source(&project_path, DraftStatus::AwaitingReview, 1);
        stage_test_source(&project_path, DraftStatus::Uploaded, 1);

        assert!(claim_ingest_compilation(project_path.clone())
            .expect("claim check should succeed")
            .is_none());

        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn native_compilation_rejects_unsafe_and_duplicate_paths() {
        let locator = EvidenceLocator {
            source_id: "paper:test".to_string(),
            revision: 1,
            page: 1,
            section: "Intro".to_string(),
            snippet_hash: "0".repeat(64),
            authors: Vec::new(),
            year: None,
        };
        let change = |path: &str| ProposedChange {
            path: path.to_string(),
            operation: "create".to_string(),
            title: "Test".to_string(),
            content: "# Test".to_string(),
            evidence_locators: Vec::new(),
        };

        assert!(validate_compilation_changes(
            vec![change("wiki/../outside.md")],
            std::slice::from_ref(&locator),
        )
        .is_err());
        assert!(validate_compilation_changes(
            vec![change("wiki/Test.md"), change("wiki/test.md")],
            &[locator],
        )
        .is_err());
    }

    #[test]
    fn native_compilation_failure_uses_revision_cas() {
        let project = std::env::temp_dir().join(format!("llm-wiki-native-{}", Uuid::new_v4()));
        let project_path = project.to_string_lossy().to_string();
        let draft = stage_test_source(&project_path, DraftStatus::Drafting, 2);

        assert!(fail_ingest_compilation(
            project_path.clone(),
            draft.id.clone(),
            1,
            "old result".to_string(),
        )
        .is_err());
        let failed = fail_ingest_compilation(
            project_path.clone(),
            draft.id,
            2,
            "compiler unavailable".to_string(),
        )
        .expect("current revision failure should be recorded");
        assert_eq!(failed.status, DraftStatus::Failed);
        assert_eq!(failed.error.as_deref(), Some("compiler unavailable"));

        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn evidence_matching_never_falls_back_to_page_one() {
        let project = std::env::temp_dir().join(format!("llm-wiki-evidence-{}", Uuid::new_v4()));
        let project_path = project.to_string_lossy().to_string();
        let draft = stage_test_source(&project_path, DraftStatus::Trusted, 1);
        let staging = draft_dir(&project_path, &draft.id).expect("draft directory");
        fs::write(
            staging.join("extracted-r1.md"),
            "## Page 1\nFirst page evidence\n## Page 2\nSecond page evidence",
        )
        .expect("write extracted evidence");
        let page_path = state_path(&project_path, "wiki/papers/test.md").expect("page path");
        fs::create_dir_all(page_path.parent().expect("page parent")).expect("create wiki");
        let locators = vec![
            EvidenceLocator {
                source_id: draft.source_id.clone(),
                revision: 1,
                page: 1,
                section: "Page 1".to_string(),
                snippet_hash: "a".repeat(64),
                authors: Vec::new(),
                year: None,
            },
            EvidenceLocator {
                source_id: draft.source_id.clone(),
                revision: 1,
                page: 2,
                section: "Page 2".to_string(),
                snippet_hash: "b".repeat(64),
                authors: Vec::new(),
                year: None,
            },
        ];
        let marker = serde_json::to_string(&locators).expect("serialize locators");
        fs::write(
            &page_path,
            format!("# Test\n\n<!-- evidence-locators: {marker} -->\n"),
        )
        .expect("write page");

        assert_eq!(
            evidence_for_search(&project_path, "wiki/papers/test.md", "Second page evidence")
                .expect("matching evidence")
                .page,
            2
        );
        assert!(evidence_for_search(
            &project_path,
            "wiki/papers/test.md",
            "unrelated query with no overlap",
        )
        .is_none());
        assert!(best_matching_page("## Page 1\nalpha", "completely unrelated").is_none());

        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn publication_duplicate_target_rolls_back_without_touching_original() {
        let project = std::env::temp_dir().join(format!("llm-wiki-rollback-{}", Uuid::new_v4()));
        let project_path = project.to_string_lossy().to_string();
        let target = state_path(&project_path, "wiki/duplicate.md").expect("target path");
        fs::create_dir_all(target.parent().expect("target parent")).expect("create parent");
        fs::write(&target, b"original").expect("write original");

        let result = commit_with_rollback(
            &project_path,
            vec![
                (target.clone(), b"first".to_vec()),
                (target.clone(), b"second".to_vec()),
            ],
        );
        assert!(result.is_err());
        assert_eq!(
            fs::read_to_string(target).expect("read original"),
            "original"
        );
        assert!(
            !state_path(&project_path, ".llm-wiki/transactions")
                .expect("transaction path")
                .exists()
                || fs::read_dir(state_path(&project_path, ".llm-wiki/transactions").unwrap())
                    .map(|mut entries| entries.next().is_none())
                    .unwrap_or(true)
        );

        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn generated_page_stays_staged_until_approval() {
        let project = std::env::temp_dir().join(format!("llm-wiki-gate-{}", Uuid::new_v4()));
        let project_path = project.to_string_lossy().to_string();
        let target = "wiki/papers/generated-review-test.md";
        let content = "# Generated review page\n\nThis must remain a draft until approval.";

        let draft = create_generated_page_draft(
            &project_path,
            "Generated review page",
            target,
            content,
            "test",
        )
        .expect("generated draft should be staged");
        let published_page = project.join(target.replace('/', std::path::MAIN_SEPARATOR_STR));

        // Queue processing may happen on a worker thread, but it must never
        // publish the generated page before the explicit approval call.
        assert!(!published_page.exists());
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        let awaiting = loop {
            let current = read_draft(&project_path, &draft.id).expect("draft should exist");
            if matches!(
                current.status,
                DraftStatus::AwaitingReview | DraftStatus::Failed
            ) {
                break current;
            }
            if std::time::Instant::now() >= deadline {
                panic!("generated draft did not reach review: {:?}", current.status);
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        };
        assert_eq!(awaiting.status, DraftStatus::AwaitingReview);
        assert!(!published_page.exists());

        let trusted = approve_draft(&project_path, &draft.id).expect("approval should publish");
        assert_eq!(trusted.status, DraftStatus::Trusted);
        assert_eq!(trusted.embedding_status.as_deref(), Some("queued"));
        assert_eq!(trusted.published_pages, vec![target.to_string()]);
        assert_eq!(
            fs::read_to_string(&published_page).expect("published page should exist"),
            content
        );

        let _ = fs::remove_dir_all(project);
    }
}
