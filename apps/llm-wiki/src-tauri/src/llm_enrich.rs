//! LLM 驱动的知识库语义增强管线。
//!
//! 设计边界（保持“审核后才入库”的数据约束）：
//! * 本模块**绝不修改**已发布的 `wiki/*.md` 页面；
//! * 所有增强结果（语义摘要、主题分类、领域标签、实体抽取、文章间关系标签）
//!   写入项目状态目录下的覆盖层文件 `<project>/.llm-wiki/llm-enrichment.json`；
//! * 知识图谱构建（`api_server::build_graph`）把覆盖层当作咨询层读取：
//!   页面内容哈希不匹配的陈旧条目会被自动忽略；删除该文件即可完全恢复纯关键词行为。
//! * 检索重排（[`rerank_candidates`]）在混合检索（关键词+向量+图谱）之后执行，
//!   仅调整候选顺序，不改变候选集合。

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use walkdir::WalkDir;

use crate::agent::provider::{LlmClient, LlmConfig};

/// 覆盖层文件版本。
pub const OVERLAY_VERSION: u32 = 1;
/// 单页送入模型的正文上限（字符），超出截断。
const MAX_PAGE_CHARS: usize = 6_000;
/// 单次任务最多处理的页面数，防止失控的 API 账单。
pub const MAX_PAGES_PER_JOB: usize = 120;
/// 关系标注阶段最多处理的候选文章对数量。
const MAX_RELATION_PAIRS: usize = 160;
/// 关系标注阶段每次批量送入模型的文章对数量。
const RELATION_BATCH: usize = 8;
/// 重排阶段送入模型的候选摘要长度上限（字符）。
const RERANK_SNIPPET_CHARS: usize = 320;

// ---------------------------------------------------------------------------
// 数据结构
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct EnrichedEntity {
    pub name: String,
    #[serde(rename = "type")]
    pub entity_type: String,
    #[serde(default)]
    pub description: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct EnrichedPage {
    /// 中文语义摘要（80–160 字）。
    pub summary: String,
    /// 具体研究主题（1–4 个，开放词表）。
    pub topics: Vec<String>,
    /// 领域标签（1–5 个）：优先具体标签，通用体系标签仅在贴切时使用。
    pub tags: Vec<String>,
    /// 中英文学术关键词。
    pub keywords: Vec<String>,
    /// 实体抽取结果。
    pub entities: Vec<EnrichedEntity>,
    /// 增强时的页面内容 SHA-256 前缀，用于陈旧检测。
    pub content_hash: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct EnrichedRelation {
    pub source: String,
    pub target: String,
    /// 具体关系短语，例如“在其框架上改进”“提供评测基准”。
    pub relation: String,
    /// 一句话依据（可选，供界面悬浮提示）。
    pub evidence: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnrichmentOverlay {
    pub version: u32,
    #[serde(default)]
    pub provider: String,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub updated_at: u64,
    #[serde(default)]
    pub pages: BTreeMap<String, EnrichedPage>,
    #[serde(default)]
    pub relations: Vec<EnrichedRelation>,
}

impl Default for EnrichmentOverlay {
    fn default() -> Self {
        Self {
            version: OVERLAY_VERSION,
            provider: String::new(),
            model: String::new(),
            updated_at: 0,
            pages: BTreeMap::new(),
            relations: Vec::new(),
        }
    }
}

impl EnrichmentOverlay {
    /// 双向查找某对页面的关系标签。
    pub fn relation_for(&self, left: &str, right: &str) -> Option<&EnrichedRelation> {
        self.relations
            .iter()
            .find(|relation| {
                (relation.source == left && relation.target == right)
                    || (relation.source == right && relation.target == left)
            })
    }
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct EnrichOptions {
    /// 本次最多重新增强多少页（默认 40，上限 [`MAX_PAGES_PER_JOB`]）。
    #[serde(default)]
    pub limit: Option<usize>,
    /// 为 true 时忽略已有结果强制重跑全部页面。
    #[serde(default)]
    pub force: Option<bool>,
    /// 为 false 时跳过文章间关系标注阶段（默认开启）。
    #[serde(default)]
    pub include_relations: Option<bool>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnrichJobStatus {
    pub running: bool,
    /// idle | pages | relations | done | failed
    pub phase: String,
    pub total: usize,
    pub done: usize,
    pub failed: usize,
    pub current: String,
    pub provider: String,
    pub model: String,
    pub started_at: Option<u64>,
    pub finished_at: Option<u64>,
    pub last_error: Option<String>,
}

impl EnrichJobStatus {
    fn new(provider: &str, model: &str) -> Self {
        Self {
            running: true,
            phase: "idle".to_string(),
            total: 0,
            done: 0,
            failed: 0,
            current: String::new(),
            provider: provider.to_string(),
            model: model.to_string(),
            started_at: Some(now_millis()),
            finished_at: None,
            last_error: None,
        }
    }

    fn idle() -> Self {
        Self::new("", "")
    }
}

/// 收集到的待增强页面（内存中间结构）。
struct CollectedPage {
    id: String,
    title: String,
    node_type: String,
    content_kind: String,
    content: String,
    links: Vec<String>,
    hash: String,
}

// ---------------------------------------------------------------------------
// 覆盖层持久化
// ---------------------------------------------------------------------------

pub fn overlay_path(project_path: &str) -> PathBuf {
    Path::new(project_path)
        .join(".llm-wiki")
        .join("llm-enrichment.json")
}

/// 页面内容的稳定哈希（SHA-256 十六进制前 16 位足够区分内容变更）。
pub fn content_hash(content: &str) -> String {
    let digest = Sha256::digest(content.as_bytes());
    digest[..8].iter().map(|byte| format!("{byte:02x}")).collect()
}

pub fn load_overlay(project_path: &str) -> Option<EnrichmentOverlay> {
    let raw = fs::read_to_string(overlay_path(project_path)).ok()?;
    let overlay: EnrichmentOverlay = serde_json::from_str(&raw).ok()?;
    if overlay.version > OVERLAY_VERSION {
        return None;
    }
    Some(overlay)
}

pub fn save_overlay(project_path: &str, overlay: &EnrichmentOverlay) -> Result<(), String> {
    let path = overlay_path(project_path);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            format!("无法创建目录 {}: {error}", parent.display())
        })?;
    }
    let serialized =
        serde_json::to_string_pretty(overlay).map_err(|error| format!("序列化失败: {error}"))?;
    fs::write(&path, serialized).map_err(|error| format!("写入 {} 失败: {error}", path.display()))
}

/// 给状态接口用的覆盖层概要。
pub fn overlay_summary(project_path: &str) -> Value {
    match load_overlay(project_path) {
        Some(overlay) => json!({
            "available": true,
            "version": overlay.version,
            "provider": overlay.provider,
            "model": overlay.model,
            "updatedAt": overlay.updated_at,
            "pages": overlay.pages.len(),
            "relations": overlay.relations.len(),
        }),
        None => json!({ "available": false }),
    }
}

// ---------------------------------------------------------------------------
// 任务注册表
// ---------------------------------------------------------------------------

fn jobs() -> &'static Mutex<BTreeMap<String, EnrichJobStatus>> {
    static JOBS: OnceLock<Mutex<BTreeMap<String, EnrichJobStatus>>> = OnceLock::new();
    JOBS.get_or_init(|| Mutex::new(BTreeMap::new()))
}

/// 取消请求标记：按项目路径记录；任务循环在每个页面/批次之间检查。
fn cancel_flags() -> &'static Mutex<BTreeSet<String>> {
    static FLAGS: OnceLock<Mutex<BTreeSet<String>>> = OnceLock::new();
    FLAGS.get_or_init(|| Mutex::new(BTreeSet::new()))
}

/// 请求取消当前项目的增强任务。返回 true 表示确有任务在跑。
pub fn request_cancel(project_path: &str) -> bool {
    if let Ok(mut flags) = cancel_flags().lock() {
        flags.insert(job_key(project_path));
    }
    jobs()
        .lock()
        .ok()
        .and_then(|jobs| jobs.get(&job_key(project_path)).cloned())
        .map(|status| matches!(status.phase.as_str(), "pages" | "relations"))
        .unwrap_or(false)
}

fn cancelled(project_path: &str) -> bool {
    cancel_flags()
        .lock()
        .map(|flags| flags.contains(&job_key(project_path)))
        .unwrap_or(false)
}

fn clear_cancel(project_path: &str) {
    if let Ok(mut flags) = cancel_flags().lock() {
        flags.remove(&job_key(project_path));
    }
}

fn job_key(project_path: &str) -> String {
    normalize_path(project_path)
}

fn normalize_path(path: &str) -> String {
    path.replace('\\', "/").trim_end_matches('/').to_lowercase()
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn update_job<F: FnOnce(&mut EnrichJobStatus)>(project_path: &str, update: F) {
    if let Ok(mut jobs) = jobs().lock() {
        update(
            jobs.entry(job_key(project_path))
                .or_insert_with(EnrichJobStatus::idle),
        );
    }
}

/// 当前项目的任务状态；没有任务记录时返回 idle 占位并附带覆盖层概要。
pub fn job_status(project_path: &str) -> Value {
    let mut status = jobs()
        .lock()
        .ok()
        .and_then(|jobs| jobs.get(&job_key(project_path)).cloned())
        .unwrap_or_else(EnrichJobStatus::idle);
    status.running = matches!(status.phase.as_str(), "pages" | "relations");
    let mut value = serde_json::to_value(&status).unwrap_or_else(|_| json!({}));
    if let Some(object) = value.as_object_mut() {
        object.insert("overlay".to_string(), overlay_summary(project_path));
    }
    value
}

// ---------------------------------------------------------------------------
// 启动入口
// ---------------------------------------------------------------------------

/// 启动一个后台增强任务。同一项目同时只允许一个任务。
pub fn start_enrichment(
    project_id: String,
    project_path: String,
    llm: LlmConfig,
    options: EnrichOptions,
) -> Result<Value, String> {
    if !llm.is_usable_for_backend_http() {
        return Err(
            "LLM 未配置或不可用：需要配置 provider/model/apiKey（或环境变量 LLM_WIKI_LLM_*）"
                .to_string(),
        );
    }
    let key = job_key(&project_path);
    {
        let jobs = jobs().lock().map_err(|_| "任务状态锁不可用".to_string())?;
        if let Some(existing) = jobs.get(&key) {
            if matches!(existing.phase.as_str(), "pages" | "relations") {
                return Err("该项目已有增强任务正在运行，请稍后再试".to_string());
            }
        }
    }
    let mut initial = EnrichJobStatus::new(&llm.provider, &llm.model);
    initial.phase = "pages".to_string();
    clear_cancel(&project_path);
    if let Ok(mut jobs) = jobs().lock() {
        jobs.insert(key, initial);
    }
    tauri::async_runtime::spawn(run_enrichment_job(
        project_id,
        project_path.clone(),
        llm,
        options,
    ));
    Ok(job_status(&project_path))
}

async fn run_enrichment_job(
    _project_id: String,
    project_path: String,
    llm: LlmConfig,
    options: EnrichOptions,
) {
    let result = run_enrichment_inner(&project_path, &llm, &options).await;
    let was_cancelled = cancelled(&project_path);
    clear_cancel(&project_path);
    match result {
        Ok(()) => {
            update_job(&project_path, |job| {
                job.phase = if was_cancelled { "cancelled".to_string() } else { "done".to_string() };
                job.current.clear();
                job.finished_at = Some(now_millis());
            });
        }
        Err(error) => {
            eprintln!("[Enrich] job failed for {}: {error}", project_path);
            update_job(&project_path, |job| {
                job.phase = "failed".to_string();
                job.current.clear();
                job.finished_at = Some(now_millis());
                job.last_error = Some(truncate_str(&error, 300));
            });
        }
    }
}

async fn run_enrichment_inner(
    project_path: &str,
    llm: &LlmConfig,
    options: &EnrichOptions,
) -> Result<(), String> {
    let client = LlmClient::new(llm.clone())?;
    let include_relations = options.include_relations.unwrap_or(true);
    let limit = options.limit.unwrap_or(40).clamp(1, MAX_PAGES_PER_JOB);
    let force = options.force.unwrap_or(false);

    update_job(project_path, |job| {
        job.phase = "pages".to_string();
        job.done = 0;
        job.failed = 0;
    });

    let pages = collect_pages(project_path)?;
    if pages.is_empty() {
        return Err("知识库 wiki 目录中没有可增强的页面".to_string());
    }

    let mut overlay = load_overlay(project_path).unwrap_or_default();
    overlay.provider = llm.provider.clone();
    overlay.model = llm.model.clone();

    // 阶段 A：逐页语义摘要 / 主题分类 / 实体抽取。
    let todo: Vec<&CollectedPage> = pages
        .iter()
        .filter(|page| {
            force
                || overlay
                    .pages
                    .get(&page.id)
                    .map(|entry| entry.content_hash != page.hash)
                    .unwrap_or(true)
        })
        .take(limit)
        .collect();

    update_job(project_path, |job| {
        job.total = todo.len();
    });

    let mut enriched_ids = BTreeSet::new();
    let mut was_cancelled = false;
    for page in &todo {
        if cancelled(project_path) {
            was_cancelled = true;
            break;
        }
        update_job(project_path, |job| {
            job.current = page.id.clone();
        });
        match enrich_single_page(&client, page).await {
            Ok(mut enriched) => {
                enriched.content_hash = page.hash.clone();
                overlay.pages.insert(page.id.clone(), enriched);
                enriched_ids.insert(page.id.clone());
                update_job(project_path, |job| {
                    job.done += 1;
                });
            }
            Err(error) => {
                eprintln!("[Enrich] page '{}' failed: {error}", page.id);
                update_job(project_path, |job| {
                    job.failed += 1;
                    job.last_error = Some(truncate_str(&error, 300));
                });
            }
        }
        // 每页落盘一次：中途失败/退出也保留已完成的部分。
        overlay.updated_at = now_millis();
        save_overlay(project_path, &overlay)?;
    }

    // 阶段 B：文章间关系标签。
    if include_relations && !was_cancelled && !cancelled(project_path) {
        update_job(project_path, |job| {
            job.phase = "relations".to_string();
            job.current.clear();
        });
        label_relations(project_path, &client, &pages, &mut overlay, &enriched_ids).await?;
    }

    if was_cancelled || cancelled(project_path) {
        overlay.updated_at = now_millis();
        save_overlay(project_path, &overlay)?;
        return Ok(());
    }

    overlay.updated_at = now_millis();
    save_overlay(project_path, &overlay)
}

// ---------------------------------------------------------------------------
// 页面收集
// ---------------------------------------------------------------------------

fn collect_pages(project_path: &str) -> Result<Vec<CollectedPage>, String> {
    let wiki_root = Path::new(project_path).join("wiki");
    if !wiki_root.is_dir() {
        return Ok(Vec::new());
    }
    let project_root = Path::new(project_path);
    let mut pages = Vec::new();
    for entry in WalkDir::new(&wiki_root).into_iter().filter_map(Result::ok) {
        if !entry.file_type().is_file()
            || entry.path().extension().and_then(|value| value.to_str()) != Some("md")
        {
            continue;
        }
        let Ok(content) = fs::read_to_string(entry.path()) else {
            continue;
        };
        let relative = entry
            .path()
            .strip_prefix(project_root)
            .map(|path| path.to_string_lossy().replace('\\', "/"))
            .unwrap_or_default();
        let id = relative
            .strip_prefix("wiki/")
            .unwrap_or(relative.as_str())
            .strip_suffix(".md")
            .unwrap_or(relative.as_str())
            .to_string();
        if id.is_empty() || is_aggregate_page(&id) {
            continue;
        }
        let node_type = extract_frontmatter_value(&content, "type")
            .unwrap_or_else(|| "other".to_string())
            .to_lowercase();
        if node_type == "query" {
            continue;
        }
        let title = extract_frontmatter_value(&content, "title")
            .or_else(|| first_heading(&content))
            .unwrap_or_else(|| id.rsplit('/').next().unwrap_or(id.as_str()).to_string());
        let content_kind =
            extract_frontmatter_value(&content, "content_kind").unwrap_or_default();
        let links = extract_wikilink_targets(&content);
        let hash = content_hash(&content);
        pages.push(CollectedPage {
            id,
            title,
            node_type,
            content_kind,
            content,
            links,
            hash,
        });
    }
    pages.sort_by(|left, right| left.id.cmp(&right.id));
    Ok(pages)
}

/// 聚合导航页不参与增强。
fn is_aggregate_page(id: &str) -> bool {
    let lowered = id.to_lowercase();
    lowered == "index"
        || lowered == "overview"
        || lowered == "log"
        || lowered.ends_with("/index")
        || lowered.ends_with("/overview")
}

fn first_heading(content: &str) -> Option<String> {
    content
        .lines()
        .find_map(|line| line.trim().strip_prefix("# "))
        .map(|title| title.trim().to_string())
}

fn extract_frontmatter_value(content: &str, key: &str) -> Option<String> {
    let rest = content
        .strip_prefix("---\n")
        .or_else(|| content.strip_prefix("---\r\n"))?;
    let end = rest.find("\n---")?;
    let prefix = format!("{key}:");
    rest[..end]
        .lines()
        .find_map(|line| line.trim().strip_prefix(&prefix))
        .map(|value| value.trim().trim_matches(['\'', '"']).to_string())
        .filter(|value| !value.is_empty())
}

fn extract_wikilink_targets(content: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut rest = content;
    while let Some(start) = rest.find("[[") {
        rest = &rest[start + 2..];
        let Some(end) = rest.find("]]") else { break };
        let inner = &rest[..end];
        let target = inner.split('|').next().unwrap_or("").trim();
        if !target.is_empty() {
            out.push(target.to_string());
        }
        rest = &rest[end + 2..];
    }
    out
}

// ---------------------------------------------------------------------------
// 阶段 A：单页语义增强
// ---------------------------------------------------------------------------

const ENRICH_SYSTEM_PROMPT: &str = "你是学术知识库的语义分析引擎。仔细阅读文章后只输出一个严格的 JSON 对象，不要输出任何解释文字、Markdown 代码块标记或其他内容。所有中文文本使用简体中文。";

async fn enrich_single_page(
    client: &LlmClient,
    page: &CollectedPage,
) -> Result<EnrichedPage, String> {
    let body = truncate_str(&page.content, MAX_PAGE_CHARS);
    let user = format!(
        "请阅读下面这篇知识库文章并输出严格 JSON 对象，字段固定为：\n\
         {{\n\
         \"summary\": \"80-160字的中文语义摘要，概括研究问题、方法与主要结论\",\n\
         \"topics\": [\"主题\"],\n\
         \"tags\": [\"标签\"],\n\
         \"keywords\": [\"关键词\"],\n\
         \"entities\": [{{\"name\": \"实体名\", \"type\": \"方法|模型|数据集|系统|指标|组织|任务\", \"description\": \"一句话说明\"}}]\n\
         }}\n\
         字段说明：\n\
         - topics：1-4 个具体研究主题（中文，可跨领域，如“电力负荷预测”“湖仓一体架构”）\n\
         - tags：1-5 个中文领域标签，优先给出准确、具体的标签（如“元数据管理”“流处理”“图神经网络”）；通用体系标签（数据采集/存储/计算/传输/治理/质量/安全/智能）只在确实最贴切时使用\n\
         - keywords：3-8 个中英文学术关键词\n\
         - entities：最多 8 个关键实体\n\n\
         文章标题：{}\n类型：{} ({})\n\n正文：\n{}",
        page.title, page.node_type, page.content_kind, body
    );
    let value = llm_json_object(client, ENRICH_SYSTEM_PROMPT, &user).await?;
    Ok(EnrichedPage {
        summary: truncate_str(&clean_text(value.get("summary")), 240),
        topics: string_list(value.get("topics"), 4),
        tags: string_list(value.get("tags"), 5),
        keywords: string_list(value.get("keywords"), 8),
        entities: entity_list(value.get("entities"), 8),
        content_hash: String::new(),
    })
}

// ---------------------------------------------------------------------------
// 阶段 B：文章间关系标签
// ---------------------------------------------------------------------------

const RELATION_SYSTEM_PROMPT: &str = "你是知识图谱的关系标注引擎。对给定的文章对逐一判断两篇文章之间的具体关系，只输出一个严格的 JSON 数组，不要输出任何解释文字或代码块标记。";

type PairRef<'a> = (&'a str, &'a str);

async fn label_relations(
    project_path: &str,
    client: &LlmClient,
    pages: &[CollectedPage],
    overlay: &mut EnrichmentOverlay,
    fresh_ids: &BTreeSet<String>,
) -> Result<(), String> {
    // 只给“有可用摘要”的页面对做关系标注：本次新增强的页面优先，
    // 内容未变且已有摘要的页面也可参与。
    let usable: Vec<&CollectedPage> = pages
        .iter()
        .filter(|page| {
            fresh_ids.contains(&page.id)
                || overlay
                    .pages
                    .get(&page.id)
                    .map(|entry| entry.content_hash == page.hash && !entry.summary.is_empty())
                    .unwrap_or(false)
        })
        .collect();
    if usable.len() < 2 {
        return Ok(());
    }

    let pairs = candidate_pairs(&usable, pages);
    if pairs.is_empty() {
        return Ok(());
    }
    update_relation_progress(project_path, pairs.len(), 0);

    let mut relations = Vec::new();
    let mut processed = 0usize;
    for batch in pairs.chunks(RELATION_BATCH) {
        if cancelled(project_path) {
            return Ok(());
        }
        let user = build_relation_prompt(batch, &overlay.pages);
        match llm_json_array(client, RELATION_SYSTEM_PROMPT, &user).await {
            Ok(items) => {
                for item in items {
                    if let Some(relation) = parse_relation_verdict(item, batch) {
                        relations.push(relation);
                    }
                }
            }
            Err(error) => {
                eprintln!("[Enrich] relation batch failed: {error}");
                update_job(project_path, |job| {
                    job.failed += 1;
                    job.last_error = Some(truncate_str(&error, 300));
                });
            }
        }
        processed += batch.len();
        update_relation_progress(project_path, pairs.len(), processed);
    }

    overlay.relations = relations;
    Ok(())
}

fn update_relation_progress(project_path: &str, total: usize, done: usize) {
    update_job(project_path, |job| {
        job.total = total;
        job.done = done.min(total);
    });
}

/// 组装一批文章对的提示词。pair-N 的编号在每批内从 1 重新计数，
/// 与 [`parse_relation_verdict`] 的批次下标约定一致。
fn build_relation_prompt(batch: &[PairRef<'_>], pages: &BTreeMap<String, EnrichedPage>) -> String {
    let describe = |id: &str| -> String {
        match pages.get(id) {
            Some(page) => {
                let summary = truncate_str(page.summary.trim(), 140);
                let tags = page.tags.join("/");
                if tags.is_empty() {
                    summary
                } else {
                    format!("{summary}［{tags}］")
                }
            }
            None => String::new(),
        }
    };
    let mut listing = String::new();
    for (position, (left_id, right_id)) in batch.iter().enumerate() {
        listing.push_str(&format!(
            "\n[pair-{}] {}\n  A: {}\n  B: {}\n",
            position + 1,
            left_id,
            describe(left_id),
            describe(right_id)
        ));
    }
    format!(
        "下面是若干知识库文章对（编号 pair-N）。为每一对判断两篇文章之间的具体关系，\n\
         输出严格 JSON 数组：\n\
         [{{\"pair\": \"pair-1\", \"relation\": \"关系短语\", \"evidence\": \"一句话依据\"}}]\n\
         要求：\n\
         - relation 用 4-12 字的中文动词短语回答“是什么关系”，例如：“提出X改进”“提供评测基准”“数据来源”“同期开源实现”“方法对比”“理论支撑”“工程落地案例”“引用其损失函数”\n\
         - 禁止使用宽泛的领域词（如“数据治理”“数据采集”）作为关系——那不是关系\n\
         - 若两篇确实无实质关联，relation 填 “无关”\n\
         - 必须覆盖每一个 pair-N\n{listing}"
    )
}

/// 解析单个关系判定结果；“无关”或越界编号返回 None。
fn parse_relation_verdict(item: Value, batch: &[PairRef<'_>]) -> Option<EnrichedRelation> {
    let pair_label = clean_text(item.get("pair"));
    let index_part = pair_label
        .split(['-', ' '])
        .last()
        .and_then(|part| part.parse::<usize>().ok())?;
    let &(left, right) = batch.get(index_part.checked_sub(1)?)?;
    let relation = clean_text(item.get("relation"));
    if relation.is_empty() || is_irrelevant_relation(&relation) {
        return None;
    }
    Some(EnrichedRelation {
        source: left.to_string(),
        target: right.to_string(),
        relation: truncate_str(&relation, 24),
        evidence: truncate_str(&clean_text(item.get("evidence")), 120),
    })
}

fn is_irrelevant_relation(relation: &str) -> bool {
    let cleaned: String = relation.replace(char::is_whitespace, "");
    matches!(
        cleaned.as_str(),
        "无关" | "无关系" | "无直接关系" | "不相关" | "none" | "N/A"
    ) || cleaned.eq_ignore_ascii_case("none")
}

// ---------------------------------------------------------------------------
// 候选文章对生成：显式 wikilink + 本地 TF-IDF 相似度
// ---------------------------------------------------------------------------

fn candidate_pairs<'a>(usable: &[&'a CollectedPage], all: &'a [CollectedPage]) -> Vec<PairRef<'a>> {
    let mut ordered: Vec<PairRef<'a>> = Vec::new();
    let mut seen = BTreeSet::new();

    // 1) 显式 wikilink（解析到本库页面 ID）。
    let id_set: BTreeSet<&str> = all.iter().map(|page| page.id.as_str()).collect();
    for page in usable {
        for raw in &page.links {
            if let Some(target) = resolve_link_target(raw, &id_set) {
                push_pair(&mut ordered, &mut seen, page.id.as_str(), target);
            }
        }
    }

    // 2) 内容 TF-IDF 余弦相似度最高的近邻对。
    for (left, right, _score) in similar_pairs(all, 3, MAX_RELATION_PAIRS) {
        push_pair(
            &mut ordered,
            &mut seen,
            all[left].id.as_str(),
            all[right].id.as_str(),
        );
    }

    ordered.truncate(MAX_RELATION_PAIRS);
    ordered
}

fn push_pair<'a>(
    ordered: &mut Vec<PairRef<'a>>,
    seen: &mut BTreeSet<String>,
    left: &'a str,
    right: &'a str,
) {
    if left == right {
        return;
    }
    let key = if left < right {
        format!("{left}::{right}")
    } else {
        format!("{right}::{left}")
    };
    if seen.insert(key) {
        ordered.push((left, right));
    }
}

fn resolve_link_target<'a, 'ids>(raw: &str, ids: &'ids BTreeSet<&'a str>) -> Option<&'a str> {
    let cleaned = raw.trim().trim_matches('/').replace('\\', "/");
    let cleaned = cleaned.strip_prefix("wiki/").unwrap_or(cleaned.as_str());
    let cleaned = cleaned.strip_suffix(".md").unwrap_or(cleaned);
    let lowered = cleaned.to_lowercase();
    if let Some(found) = ids.iter().find(|id| id.to_lowercase() == lowered) {
        return Some(found);
    }
    let stem = lowered.rsplit('/').next().unwrap_or(lowered.as_str());
    ids.iter()
        .find(|id| {
            let id_stem = id.rsplit('/').next().unwrap_or(id).to_lowercase();
            id_stem == stem || id_stem.replace(' ', "-") == stem
        })
        .copied()
}

/// 返回按相似度降序排列的文档索引对（每篇最多 top_per_doc 个邻居，全局上限 cap）。
fn similar_pairs(pages: &[CollectedPage], top_per_doc: usize, cap: usize) -> Vec<(usize, usize, f64)> {
    let counts: Vec<BTreeMap<String, f64>> = pages
        .iter()
        .map(|page| term_counts(&format!("{} {}", page.title, page.content)))
        .collect();
    let document_count = pages.len() as f64;
    let mut document_frequency: BTreeMap<String, usize> = BTreeMap::new();
    for terms in &counts {
        for term in terms.keys() {
            *document_frequency.entry(term.clone()).or_default() += 1;
        }
    }
    let vectors: Vec<(BTreeMap<String, f64>, f64)> = counts
        .into_iter()
        .map(|terms| {
            let mut vector = BTreeMap::new();
            let mut norm_squared = 0.0;
            for (term, count) in terms {
                let frequency = document_frequency.get(&term).copied().unwrap_or(1) as f64;
                let idf = ((document_count + 1.0) / (frequency + 1.0)).ln() + 1.0;
                let weight = (1.0 + count.ln()) * idf;
                norm_squared += weight * weight;
                vector.insert(term, weight);
            }
            (vector, norm_squared.sqrt())
        })
        .collect();

    let mut scored: Vec<(f64, usize, usize)> = Vec::new();
    for left in 0..pages.len() {
        let mut row: Vec<(f64, usize)> = Vec::new();
        for right in (left + 1)..pages.len() {
            let score = cosine_similarity(&vectors[left], &vectors[right]);
            if score >= 0.06 {
                row.push((score, right));
            }
        }
        row.sort_by(|a, b| b.0.total_cmp(&a.0).then_with(|| a.1.cmp(&b.1)));
        for (score, right) in row.into_iter().take(top_per_doc) {
            scored.push((score, left, right));
        }
    }
    scored.sort_by(|a, b| b.0.total_cmp(&a.0).then_with(|| a.1.cmp(&b.1)));
    scored.truncate(cap);
    scored
        .into_iter()
        .map(|(score, left, right)| (left, right, score))
        .collect()
}

fn cosine_similarity(left: &(BTreeMap<String, f64>, f64), right: &(BTreeMap<String, f64>, f64)) -> f64 {
    let (left_vector, left_norm) = left;
    let (right_vector, right_norm) = right;
    if *left_norm == 0.0 || *right_norm == 0.0 {
        return 0.0;
    }
    let (small, large) = if left_vector.len() <= right_vector.len() {
        (left_vector, right_vector)
    } else {
        (right_vector, left_vector)
    };
    let mut dot = 0.0;
    for (term, weight) in small {
        if let Some(other) = large.get(term) {
            dot += weight * other;
        }
    }
    dot / (left_norm * right_norm)
}

/// 极简分词：ASCII 词（≥3 字符，小写，剔除停用词）+ CJK 相邻双字组合。
fn term_counts(text: &str) -> BTreeMap<String, f64> {
    const STOP_WORDS: &[&str] = &[
        "about", "after", "also", "based", "been", "between", "both", "from", "have", "into",
        "more", "most", "other", "over", "paper", "results", "such", "than", "that", "their",
        "there", "these", "they", "this", "through", "using", "were", "which", "while", "with",
        "the", "and", "for",
    ];
    let mut counts: BTreeMap<String, f64> = BTreeMap::new();
    let mut ascii = String::new();
    let mut cjk: Vec<char> = Vec::new();

    fn bump_ascii(buffer: &mut String, counts: &mut BTreeMap<String, f64>) {
        let word = buffer.to_lowercase();
        if word.chars().count() >= 3 && !STOP_WORDS.contains(&word.as_str()) {
            *counts.entry(word).or_default() += 1.0;
        }
        buffer.clear();
    }
    fn flush_cjk(buffer: &mut Vec<char>, counts: &mut BTreeMap<String, f64>) {
        if buffer.len() == 1 {
            *counts.entry(buffer[0].to_string()).or_default() += 1.0;
        } else {
            for pair in buffer.windows(2) {
                *counts.entry(pair.iter().collect::<String>()).or_default() += 1.0;
            }
        }
        buffer.clear();
    }

    for character in text.chars() {
        if character.is_ascii_alphanumeric() {
            if !cjk.is_empty() {
                flush_cjk(&mut cjk, &mut counts);
            }
            ascii.push(character);
        } else if matches!(character as u32, 0x3400..=0x9fff) {
            if !ascii.is_empty() {
                bump_ascii(&mut ascii, &mut counts);
            }
            cjk.push(character);
        } else {
            if !ascii.is_empty() {
                bump_ascii(&mut ascii, &mut counts);
            }
            if !cjk.is_empty() {
                flush_cjk(&mut cjk, &mut counts);
            }
        }
    }
    if !ascii.is_empty() {
        bump_ascii(&mut ascii, &mut counts);
    }
    if !cjk.is_empty() {
        flush_cjk(&mut cjk, &mut counts);
    }
    counts
}

// ---------------------------------------------------------------------------
// 检索重排
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct RerankCandidate {
    /// 候选在原结果列表中的下标。
    pub index: usize,
    pub title: String,
    pub snippet: String,
    pub path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RerankVerdict {
    pub index: usize,
    pub score: f64,
    pub reason: String,
}

/// 用大模型对混合检索候选做相关性重排。
///
/// 只调整顺序：返回的 verdict 列表按相关性降序排列，调用方据此重排并截断。
/// 模型未覆盖到的候选会以 score 0 追加在末尾，保证不丢结果。
pub async fn rerank_candidates(
    client: &LlmClient,
    query: &str,
    candidates: &[RerankCandidate],
) -> Result<Vec<RerankVerdict>, String> {
    if candidates.is_empty() {
        return Ok(Vec::new());
    }
    let system = "你是检索结果重排引擎。根据查询与候选文档的相关性打分并排序，只输出一个严格的 JSON 数组，不要输出任何解释文字或代码块标记。";
    let mut listing = String::new();
    for candidate in candidates {
        let snippet = truncate_str(candidate.snippet.trim(), RERANK_SNIPPET_CHARS);
        listing.push_str(&format!(
            "[{}] {}\n路径: {}\n摘要: {}\n\n",
            candidate.index, candidate.title, candidate.path, snippet
        ));
    }
    let user = format!(
        "查询：{query}\n\n请对下列候选文档按与查询的相关性输出严格 JSON 数组（必须覆盖每个编号）：\n\
         [{{\"index\": 0, \"score\": 0-10 的数字, \"reason\": \"一句话理由\"}}]\n\
         score 表示相关性（10 最相关）。不相关的文档可以给低分，但不要遗漏编号。\n\n候选：\n{listing}"
    );
    let value = llm_json_array(client, system, &user).await?;
    let mut verdicts = Vec::new();
    for item in value.iter().take(candidates.len() * 2) {
        let index = item
            .get("index")
            .and_then(Value::as_u64)
            .unwrap_or(u64::MAX) as usize;
        if index >= candidates.len() {
            continue;
        }
        let score = item
            .get("score")
            .and_then(Value::as_f64)
            .unwrap_or(0.0)
            .clamp(0.0, 10.0);
        verdicts.push(RerankVerdict {
            index,
            score,
            reason: truncate_str(&clean_text(item.get("reason")), 160),
        });
    }
    // 未被模型覆盖的候选补零分，保证调用方可以完整重排而不丢结果。
    let covered: BTreeSet<usize> = verdicts.iter().map(|verdict| verdict.index).collect();
    for candidate in candidates {
        if !covered.contains(&candidate.index) {
            verdicts.push(RerankVerdict {
                index: candidate.index,
                score: 0.0,
                reason: String::new(),
            });
        }
    }
    verdicts.sort_by(|a, b| b.score.total_cmp(&a.score).then_with(|| a.index.cmp(&b.index)));
    Ok(verdicts)
}

// ---------------------------------------------------------------------------
// LLM 调用与宽松 JSON 解析
// ---------------------------------------------------------------------------

async fn llm_json_object(client: &LlmClient, system: &str, user: &str) -> Result<Value, String> {
    let text = client.generate_text(system, user, &[]).await?;
    parse_loose_json(&text, '{', '}')
        .ok_or_else(|| format!("模型输出不是有效 JSON 对象: {}", truncate_str(&text, 160)))
}

async fn llm_json_array(
    client: &LlmClient,
    system: &str,
    user: &str,
) -> Result<Vec<Value>, String> {
    let text = client.generate_text(system, user, &[]).await?;
    match parse_loose_json(&text, '[', ']') {
        Some(Value::Array(items)) => Ok(items),
        Some(Value::Object(map)) => {
            // 部分模型无视指令，把数组包进对象（如 {"relations": [...]}）。
            for key in ["data", "items", "results", "list", "relations", "pairs", "verdicts", "output"] {
                if let Some(Value::Array(items)) = map.get(key) {
                    return Ok(items.clone());
                }
            }
            for value in map.values() {
                if let Value::Array(items) = value {
                    return Ok(items.clone());
                }
            }
            Err(format!(
                "模型输出是对象但没有可用的数组字段: {}",
                truncate_str(&text, 160)
            ))
        }
        Some(_) => Err(format!(
            "模型输出不是有效 JSON 数组: {}",
            truncate_str(&text, 160)
        )),
        None => Err(format!(
            "模型输出不是有效 JSON 数组: {}",
            truncate_str(&text, 160)
        )),
    }
}

/// 宽松解析：容忍 Markdown 代码块围栏和前后杂文，截取首个平衡的 {...} / [...]。
fn parse_loose_json(text: &str, open: char, close: char) -> Option<Value> {
    let trimmed = text.trim();
    if let Ok(value) = serde_json::from_str::<Value>(trimmed) {
        return Some(value);
    }
    let mut depth = 0usize;
    let mut start: Option<usize> = None;
    let mut in_string = false;
    let mut escaped = false;
    for (byte_index, character) in trimmed.char_indices() {
        if in_string {
            if escaped {
                escaped = false;
            } else if character == '\\' {
                escaped = true;
            } else if character == '"' {
                in_string = false;
            }
            continue;
        }
        if character == '"' {
            in_string = true;
        } else if character == open {
            if depth == 0 {
                start = Some(byte_index);
            }
            depth += 1;
        } else if character == close && depth > 0 {
            depth -= 1;
            if depth == 0 {
                if let Some(begin) = start {
                    if let Ok(value) = serde_json::from_str::<Value>(&trimmed[begin..=byte_index]) {
                        return Some(value);
                    }
                }
            }
        }
    }
    None
}

fn clean_text(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(text)) => text.trim().to_string(),
        Some(Value::Number(number)) => number.to_string(),
        _ => String::new(),
    }
}

fn string_list(value: Option<&Value>, cap: usize) -> Vec<String> {
    let mut out = Vec::new();
    if let Some(Value::Array(items)) = value {
        for item in items {
            let text = clean_text(Some(item));
            if !text.is_empty() && !out.contains(&text) {
                out.push(text);
            }
            if out.len() >= cap {
                break;
            }
        }
    }
    out
}

fn entity_list(value: Option<&Value>, cap: usize) -> Vec<EnrichedEntity> {
    let mut out: Vec<EnrichedEntity> = Vec::new();
    if let Some(Value::Array(items)) = value {
        for item in items {
            let name = clean_text(item.get("name"));
            if name.is_empty() {
                continue;
            }
            if out.iter().any(|entity| entity.name == name) {
                continue;
            }
            out.push(EnrichedEntity {
                name: truncate_str(&name, 80),
                entity_type: truncate_str(&clean_text(item.get("type")), 24),
                description: truncate_str(&clean_text(item.get("description")), 160),
            });
            if out.len() >= cap {
                break;
            }
        }
    }
    out
}

fn truncate_str(text: &str, cap_chars: usize) -> String {
    text.chars().take(cap_chars).collect()
}

// ---------------------------------------------------------------------------
// 测试
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn page(id: &str, title: &str, content: &str) -> CollectedPage {
        CollectedPage {
            id: id.to_string(),
            title: title.to_string(),
            node_type: "paper".to_string(),
            content_kind: "paper".to_string(),
            content: content.to_string(),
            links: Vec::new(),
            hash: content_hash(content),
        }
    }

    #[test]
    fn content_hash_changes_with_content_and_is_stable() {
        let first = content_hash("hello 世界");
        assert_eq!(first, content_hash("hello 世界"));
        assert_ne!(first, content_hash("hello 世界!"));
        assert_eq!(first.len(), 16);
    }

    #[test]
    fn parses_plain_and_fenced_json_objects() {
        let plain = r#"{"summary": "测试摘要"}"#;
        assert!(parse_loose_json(plain, '{', '}').is_some());

        let fenced = "```json\n{\"topics\": [\"流处理\"]}\n```";
        let value = parse_loose_json(fenced, '{', '}').expect("fenced object should parse");
        assert_eq!(value["topics"][0], "流处理");

        let noisy = "好的，以下是结果：{\"a\": {\"b\": 1}} 请查收";
        let value = parse_loose_json(noisy, '{', '}').expect("noisy object should parse");
        assert_eq!(value["a"]["b"], 1);
    }

    #[test]
    fn parses_arrays_with_nested_objects_without_confusion() {
        let text = r#"[{"pair": "pair-1", "relation": "提供评测基准"}, {"pair": "pair-2", "relation": "无关"}]"#;
        let value = parse_loose_json(text, '[', ']').expect("array should parse");
        let items = value.as_array().expect("should be array");
        assert_eq!(items.len(), 2);
        assert!(parse_loose_json("not json at all", '{', '}').is_none());
    }

    #[test]
    fn string_list_dedupes_and_caps() {
        let value = serde_json::json!(["a", "b", "a", "", "c"]);
        assert_eq!(string_list(Some(&value), 2), vec!["a", "b"]);
        assert!(string_list(None, 3).is_empty());
    }

    #[test]
    fn entity_list_parses_and_dedupes() {
        let value = serde_json::json!([
            {"name": "Flink", "type": "系统", "description": "流处理引擎"},
            {"name": "Flink", "type": "系统"},
            {"name": "", "type": "x"}
        ]);
        let entities = entity_list(Some(&value), 5);
        assert_eq!(entities.len(), 1);
        assert_eq!(entities[0].name, "Flink");
        assert_eq!(entities[0].description, "流处理引擎");
    }

    #[test]
    fn irrelevant_relations_are_filtered() {
        assert!(is_irrelevant_relation("无关"));
        assert!(is_irrelevant_relation("无 直接 关系"));
        assert!(is_irrelevant_relation("None"));
        assert!(!is_irrelevant_relation("提供评测基准"));
    }

    #[test]
    fn relation_verdict_maps_pair_labels_to_batch_entries() {
        let batch: Vec<PairRef> = vec![("alpha", "beta"), ("gamma", "delta")];
        let verdict = parse_relation_verdict(
            serde_json::json!({"pair": "pair-2", "relation": "方法对比", "evidence": "两者比较了吞吐"}),
            &batch,
        )
        .expect("verdict should map");
        assert_eq!(verdict.source, "gamma");
        assert_eq!(verdict.target, "delta");
        assert_eq!(verdict.evidence, "两者比较了吞吐");
        assert!(
            parse_relation_verdict(serde_json::json!({"pair": "pair-9", "relation": "x"}), &batch)
                .is_none()
        );
        assert!(
            parse_relation_verdict(serde_json::json!({"pair": "pair-1", "relation": "无关"}), &batch)
                .is_none()
        );
    }

    #[test]
    fn relation_for_finds_both_directions() {
        let mut overlay = EnrichmentOverlay::default();
        overlay.relations.push(EnrichedRelation {
            source: "alpha".to_string(),
            target: "beta".to_string(),
            relation: "提供评测基准".to_string(),
            evidence: String::new(),
        });
        assert!(overlay.relation_for("beta", "alpha").is_some());
        assert!(overlay.relation_for("alpha", "beta").is_some());
        assert!(overlay.relation_for("alpha", "gamma").is_none());
    }

    #[test]
    fn candidate_pairs_include_wikilinks_and_similarity_and_dedupe() {
        let mut linked = page("alpha", "Alpha Paper", "stream processing kafka flink latency throughput");
        linked.links.push("beta".to_string());
        let beta = page("beta", "Beta Paper", "kafka streaming latency benchmark flink throughput");
        let gamma = page("gamma", "Gamma Paper", "graph neural network citation network embedding");
        let all = vec![linked, beta, gamma];
        let refs: Vec<&CollectedPage> = all.iter().collect();
        let pairs = candidate_pairs(&refs, &all);
        assert!(
            pairs.contains(&("alpha", "beta")),
            "wikilink pair should be present: {pairs:?}"
        );
        // alpha/beta 同时也是相似文档对，但不应重复出现。
        let count = pairs
            .iter()
            .filter(|pair| **pair == ("alpha", "beta") || **pair == ("beta", "alpha"))
            .count();
        assert_eq!(count, 1);
        // gamma 与其他两篇主题不同，不应成对。
        assert!(pairs.iter().all(|pair| pair.0 != "gamma" && pair.1 != "gamma"));
    }

    #[test]
    fn aggregate_pages_are_excluded() {
        assert!(is_aggregate_page("index"));
        assert!(is_aggregate_page("sources/index"));
        assert!(!is_aggregate_page("papers/my-paper"));
    }

    #[test]
    fn overlay_roundtrips_through_disk() {
        let dir = std::env::temp_dir().join(format!("llm-enrich-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(dir.join(".llm-wiki")).unwrap();
        let project = dir.to_string_lossy().to_string();
        let mut overlay = EnrichmentOverlay::default();
        overlay.provider = "custom".to_string();
        overlay.model = "test-model".to_string();
        overlay.pages.insert(
            "demo-page".to_string(),
            EnrichedPage {
                summary: "测试摘要".to_string(),
                topics: vec!["测试主题".to_string()],
                tags: vec!["元数据管理".to_string()],
                keywords: vec!["metadata".to_string()],
                entities: Vec::new(),
                content_hash: content_hash("body"),
            },
        );
        overlay.relations.push(EnrichedRelation {
            source: "a".to_string(),
            target: "b".to_string(),
            relation: "提供评测基准".to_string(),
            evidence: "两者共用基准".to_string(),
        });
        save_overlay(&project, &overlay).expect("save should succeed");
        let loaded = load_overlay(&project).expect("load should succeed");
        assert_eq!(loaded.pages.len(), 1);
        assert_eq!(loaded.relations[0].relation, "提供评测基准");
        assert_eq!(loaded.model, "test-model");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn stale_overlay_version_is_rejected() {
        let dir = std::env::temp_dir().join(format!("llm-enrich-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(dir.join(".llm-wiki")).unwrap();
        let path = dir.join(".llm-wiki").join("llm-enrichment.json");
        fs::write(path, "{\"version\": 99}").unwrap();
        assert!(load_overlay(dir.to_string_lossy().as_ref()).is_none());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn term_counts_tokenizes_ascii_words_and_cjk_bigrams() {
        let counts = term_counts("Stream Processing 流处理引擎 stream");
        assert!(*counts.get("stream").unwrap_or(&0.0) >= 2.0);
        assert!(counts.contains_key("processing"));
        assert!(counts.contains_key("流处"));
        assert!(counts.contains_key("处理"));
        // 停用词应被剔除。
        assert!(!counts.contains_key("the"));
    }
}
