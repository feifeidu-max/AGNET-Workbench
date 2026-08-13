/**
 * 论文推荐服务（定时）
 *
 * 依据：本地知识库（llm-wiki）的 wiki 内容作为“相似推荐”的锚点。
 * 流程（基于 wiki 的相似性检索）：
 *   1) 列出 wiki 中已收录的论文（wiki/papers/*.md）→ 每篇标题截短成一个 query，
 *      即“找出与该篇 KB 论文相似的外部论文”（真正的基于 wiki 的相似性，而非仅拼题录）。
 *   2) 用领域关键词在 wiki 内做语义检索（含正文），从返回的相关页面正文里
 *      提炼研究概念，作为额外的“基于 wiki 内容”的检索词。
 *   3) 以上 query 并行调用 llm-wiki 的 reading-candidates/search
 *      （OpenAlex/Crossref/arXiv 纯 HTTP，无需 LLM）返回与知识库相似的外部论文。
 *   4) 反查每篇候选的发表会议/期刊，按顶会白名单过滤（arXiv 预印本/期刊/非顶会排除）；
 *      在顶会候选池内按发表年份倒序，最近发表的顶会论文排最前。
 *
 * 推荐来源 = 尚未收录的外部论文（reading-candidates）；相关性依据 = 本地知识库 wiki。
 *
 * 调度：服务启动时延迟 30s 首跑（等 llm-wiki 起来），之后每 6 小时刷新一次；
 * 同时 Hermes 的 cron 任务（/#/hermes/jobs，agent 模式）也可触发/接管，由 Hermes
 * 基于 wiki 联网检索并回写推荐。两者写入同一份 paper-recommendations.json。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { createHash } from 'crypto'
import { config } from '../config'
import { logger } from './logger'
import { llmWikiJson, LlmWikiApiError, publicKnowledgeErrorMessage } from './knowledge/llm-wiki-client'
import { getActiveProfileName } from './hermes/hermes-profile'
import { ensurePaperRecommenderJob, nextScheduledRunAt, recordPaperRecommenderRun, runPaperRecommenderAgentJob } from './paper-recommender-job'

const RECOMMEND_INTERVAL_MS = 6 * 60 * 60 * 1000
const FIRST_RUN_DELAY_MS = 30 * 1000
const MAX_ITEMS = 6
const MAX_FOCUS_LENGTH = 400
// Keep the automatic feed useful for current research. Older top-venue
// records can still appear in provider search results, but must not displace
// recent papers on the home page.
const RECENT_YEAR_WINDOW = 7
const CANDIDATE_PROVIDERS = ['openalex', 'crossref', 'arxiv']
// 一次检索多拉一些候选，再做“顶会”过滤，保证最终能凑满 MAX_ITEMS。
const CANDIDATE_FETCH_LIMIT = 30
const DATA_FOCUS_QUERIES = [
  // Explicit venue probes keep recency from depending on a provider's
  // relevance ranking (which otherwise tends to return older survey papers).
  'VLDB data lake systems',
  'SIGMOD data lake management',
  'TKDE data lake data management',
  'ICDE data engineering data systems',
  'KDD data mining data systems',
  'data engineering data platform data management',
  'data lakehouse storage table format data warehouse',
  'stream processing data pipeline real-time analytics',
  'data governance metadata lineage data quality',
  'data security privacy access control',
]
const DATA_DOMAIN_TERMS = [
  'data', 'database', 'storage', 'lakehouse', 'warehouse', 'stream', 'pipeline',
  'governance', 'metadata', 'lineage', 'quality', 'privacy', 'security', 'delta lake',
  'spark', 'flink', 'kafka', 'ingestion', 'catalog',
]
const EXCLUDED_DOMAIN_TERMS = ['point cloud', 'voxel', 'near-memory accelerator', 'neural accelerator']
/**
 * 论文中文标签：与 LLM-Wiki 的 infer_data_domain_tags 完全一致的关键词规则。
 * 标签集合固定（8 个数据方向域 + 兜底），只输出中文，不随论文数量增长。
 */
export const DOMAIN_TAG_RULES: Array<[string, string[]]> = [
  ['数据采集', ['采集', 'ingestion', '采样', 'sensor', '埋点', 'cdc']],
  ['数据存储', ['存储', 'database', 'storage', 'lakehouse', 'warehouse', '数据库', '数据湖']],
  ['数据计算', ['计算', 'compute', 'spark', 'flink', '查询', 'query', '引擎']],
  ['数据治理', ['治理', 'governance', 'metadata', '元数据', '血缘', 'catalog']],
  ['数据质量', ['质量', 'quality', '清洗', 'validation', '异常检测']],
  ['数据安全', ['安全', 'security', 'privacy', '隐私', '脱敏', '权限']],
  ['数据传输', ['传输', 'stream', '流式', '消息队列', 'kafka', '同步']],
  ['数据智能', ['机器学习', 'machine learning', 'llm', 'ai', '智能', 'rag', 'agent']],
]

export const KNOWN_DOMAIN_TAGS = ['数据采集', '数据存储', '数据计算', '数据治理', '数据质量', '数据安全', '数据传输', '数据智能']
export const FALLBACK_DOMAIN_TAG = '数据技术'

/** 与 LLM-Wiki（src-tauri api_server.rs infer_data_domain_tags）同款的关键词提取，最多 3 个标签。 */
export function inferDomainTags(text: string): string[] {
  const lower = String(text || '').toLowerCase()
  const tags = DOMAIN_TAG_RULES
    .filter(([, words]) => words.some((word) => lower.includes(word)))
    .map(([label]) => label)
    .slice(0, 3)
  return tags.length > 0 ? tags : [FALLBACK_DOMAIN_TAG]
}

function normalizeTags(value: unknown, fallbackText: string): string[] {
  const known = new Set(KNOWN_DOMAIN_TAGS)
  const fromValue = Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && known.has(item.trim()))
      .map((item) => item.trim())
    : []
  const seen = new Set<string>()
  const merged: string[] = []
  for (const tag of [...fromValue, ...inferDomainTags(fallbackText)]) {
    if (!seen.has(tag)) {
      seen.add(tag)
      merged.push(tag)
    }
  }
  return merged.slice(0, 3)
}

// 候选本身不含 venue 字段，需要根据 DOI 向 Crossref/OpenAlex 反查会议/期刊名称，
// 再按数据系统及通用 CS 顶级 venue 白名单过滤。白名单使用完整刊名和常见缩写，
// 避免把普通的“大数据”期刊误标成顶级论文。
const TOP_CONFERENCE_KEYWORDS = [
  // 体系结构 / EDA / 硬件加速
  'isca', 'micro', 'hpca', 'asplos', 'dac', 'iccad', 'fpga', 'fpl', 'fpt', 'fccm',
  'date', 'case', 'iscas', 'nocs', 'pact', 'cgo', 'esweek', 'rtas', 'rtss', 'ispass',
  'iiswc', 'asap', 'codes', 'isss', 'samos', 'heap', 'sc', 'supercomputing', 'hotchips',
  // 机器学习 / AI
  'neurips', 'nips', 'icml', 'iclr', 'aaai', 'ijcai', 'uai', 'aistats', 'colt',
  // 计算机视觉 / 3D
  'cvpr', 'iccv', 'eccv', 'wacv', 'bmvc', '3dv',
  // 机器人
  'icra', 'iros', 'rss', 'corl', 'humanoids',
  // NLP
  'acl', 'emnlp', 'naacl', 'coling', 'tacl',
  // 图形学
  'siggraph',
  // 系统
  'osdi', 'sosp', 'nsdi', 'atc', 'eurosys', 'fast', 'socc', 'middleware',
  // 安全
  'usenix', 'ccs', 'oakland', 'ndss', 'acsac', 'raid',
  // 网络
  'sigcomm', 'mobicom', 'infocom', 'conext', 'imc', 'mobicom',
  // 数据库 / 数据挖掘 / 数据系统（会议与顶级期刊）
  'sigmod', 'acm sigmod record', 'vldb', 'the vldb journal', 'vldb journal', 'icde', 'edbt', 'pods', 'cidr', 'icdt',
  'dasfaa', 'ssdbm', 'kdd', 'www', 'tpds', 'ieee transactions on parallel and distributed systems',
  'tkde', 'ieee transactions on knowledge and data engineering', 'tods', 'acm transactions on database systems',
  'data mining and knowledge discovery',
  'icse', 'ase', 'fse', 'issta',
  // 语音 / 信号
  'icassp', 'interspeech',
]
// 反查到的 venue -> 是否顶会 的进程内缓存，避免同一次/跨次刷新重复打外部 API。
const VENUE_CACHE = new Map<string, { venue: string | null; resolved: boolean }>()

export interface PaperRecommendation {
  id: string
  title: string
  authors: string[]
  year: number | null
  abstract: string | null
  url: string | null
  provider: string | null
  reason: string | null
  venue: string | null
  doi: string | null
  /** 中文标签：由 LLM-Wiki 同款关键词规则提取，固定为数据方向域标签。 */
  tags?: string[]
  /** 本次刷新新检索到的论文（与上一轮结果对比，供前端差异化标注）。 */
  newlyFound?: boolean
  /** 该论文被搜出来的时间（ISO）。新搜出的=本次 generatedAt；旧论文保留首次搜出时间。 */
  foundAt?: string | null
}

export interface PaperRecommendationsPayload {
  status: 'pending' | 'success' | 'partial' | 'failed'
  generatedAt: string | null
  focus: string | null
  paperCount: number
  nextRunAt: string | null
  count: number
  topVenueOnly: boolean
  recentPriority: boolean
  items: PaperRecommendation[]
  error: string | null
}

function recommendationsPath(): string {
  return join(config.appHome, 'paper-recommendations.json')
}

function itemKey(item: PaperRecommendation): string {
  return String(item.doi ?? item.url ?? item.id ?? item.title ?? '').toLowerCase()
}

/**
 * 手动刷新时记录上一轮结果（论文 + 生成时间），作为“新发现/搜出时间”对比基线。
 * 覆盖 pending 前快照，避免 pending（items 为空）冲掉对比依据。
 */
let manualRefreshBaseline: { items: PaperRecommendation[]; generatedAt: string | null } | null = null

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function asNullableString(value: unknown): string | null {
  const text = typeof value === 'string' ? value.trim() : ''
  return text.length > 0 ? text : null
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string')
}

function asNullableNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function normalizeCandidate(value: unknown): PaperRecommendation | null {
  if (!value || typeof value !== 'object') return null
  const item = value as Record<string, unknown>
  const id = asString(item.id ?? item.doi ?? item.url)
  if (!id) return null
  const title = asString(item.title, '未命名论文')
  const abstract = asNullableString(item.abstract ?? item.summary)
  return {
    id,
    title,
    authors: asStringArray(item.authors),
    year: asNullableNumber(item.year),
    abstract,
    url: asNullableString(item.url),
    provider: asNullableString(item.provider ?? item.source),
    reason: asNullableString(item.reason ?? item.recommendedReason ?? item.recommended_reason),
    venue: asNullableString(item.venue ?? item.journal ?? item.containerTitle ?? item.container_title),
    doi: asNullableString(item.doi),
    tags: normalizeTags(item.tags ?? item.domain_tags, `${title} ${abstract ?? ''}`),
  }
}

const METADATA_TITLE_PATTERNS = [
  /^proceedings\b/i,
  /\bconference proceedings\b/i,
  /\binformation for authors\b/i,
  /\btable of contents\b/i,
  /\b(?:^|\s)(?:toc|index|commentary)\b/i,
  /\borganizing committee\b/i,
]

function isMetadataCandidate(item: PaperRecommendation): boolean {
  return METADATA_TITLE_PATTERNS.some((pattern) => pattern.test(item.title))
}

/**
 * 判断一段会议/期刊名称是否属于“顶会”。采用词边界匹配顶会缩写白名单，
 * 避免 "scalability" 误命中 "sc" 之类。
 */
function isTopVenue(venue: string | null): boolean {
  if (!venue) return false
  const text = venue.toLowerCase()
  return TOP_CONFERENCE_KEYWORDS.some((keyword) => {
    const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'i').test(text)
  })
}

/**
 * 根据 DOI 反查论文发表的会议/期刊名称。
 * 优先 Crossref（container-title / event），失败再试 OpenAlex（primary_location.source.display_name）。
 * 结果进程内缓存，避免一次刷新内重复请求。无 DOI 或查询失败返回 null。
 */
async function enrichVenue(doi: string | undefined | null): Promise<{ venue: string | null; resolved: boolean }> {
  if (!doi || !/^10\./.test(doi)) return { venue: null, resolved: true }
  const cached = VENUE_CACHE.get(doi)
  if (cached !== undefined) return cached
  const lookup = async (url: string): Promise<{ venue: string | null; resolved: boolean }> => {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 4000)
    timeout.unref?.()
    try {
      const response = await fetch(url, {
        headers: { 'User-Agent': 'AGNET-PaperRecommender/1.0 (mailto:agent@agnet.local)' },
        signal: controller.signal,
      })
      if (!response.ok) return { venue: null, resolved: true }
      const data = (await response.json()) as Record<string, unknown>
      const message = (data.message ?? data) as Record<string, unknown>
      return { venue: extractVenueName(message), resolved: true }
    } catch {
      return { venue: null, resolved: false }
    } finally {
      clearTimeout(timeout)
    }
  }
  const crossref = await lookup(`https://api.crossref.org/works/${encodeURIComponent(doi)}`)
  if (crossref.resolved && crossref.venue) {
    VENUE_CACHE.set(doi, crossref)
    return crossref
  }
  const openalex = await lookup(`https://api.openalex.org/works/doi:${encodeURIComponent(doi)}`)
  VENUE_CACHE.set(doi, openalex)
  return openalex
}

/**
 * 从 Crossref/OpenAlex 的 work 元数据里挑一个最能代表“会议/期刊”的名称：
 * Crossref 优先 container-title，其次 event.name；OpenAlex 取 primary_location.source.display_name。
 */
function extractVenueName(message: Record<string, unknown>): string | null {
  const container = message['container-title']
  if (Array.isArray(container) && typeof container[0] === 'string' && container[0].trim()) {
    return container[0].trim()
  }
  const event = message.event as Record<string, unknown> | undefined
  if (event && typeof event.name === 'string' && (event.name as string).trim()) {
    return (event.name as string).trim()
  }
  const primary = message['primary_location'] as Record<string, unknown> | undefined
  const source = primary?.source as Record<string, unknown> | undefined
  if (source && typeof source.display_name === 'string' && (source.display_name as string).trim()) {
    return (source.display_name as string).trim()
  }
  return null
}

/**
 * 从本地知识库（llm-wiki）的 wiki/papers/*.md 反解论文标题。
 * 文件名即论文标题的 slug（如 "flna-an-energy-efficient-point-cloud-...-1b797bdc.md"），
 * 去掉末尾 hash 后按 "-" 拆词即可还原标题。
 */
interface WikiFileNode {
  name?: string
  path?: string
  isDir?: boolean
  children?: WikiFileNode[] | null
}

const PAPER_SLUG_STOP = new Set([
  'the', 'a', 'an', 'for', 'with', 'of', 'and', 'based', 'via', 'using', 'from',
  'into', 'on', 'to', 'in', 'its', 'as', 'at', 'by', 'that', 'this', 'these',
  'approach', 'method', 'new', 'novel', 'towards', 'exploring', 'potential',
  'architecture', 'design', 'hardware', 'system', 'study', 'analysis', 'using',
])

function deslugify(slug: string): string {
  return slug.replace(/-/g, ' ').replace(/\s+/g, ' ').trim()
}

function collectPaperTitles(node: unknown, out: string[]): void {
  if (!node || typeof node !== 'object') return
  const n = node as Record<string, unknown>
  const path = asString(n.path ?? n.name)
  const isDir = n.isDir === true
  if (isDir && Array.isArray(n.children)) {
    for (const child of n.children as unknown[]) collectPaperTitles(child, out)
  } else if (!isDir && /\.md$/i.test(path) && /(^|\/)papers\//i.test(path)) {
    const name = (path.split('/').pop() || '').replace(/\.md$/i, '')
    const slug = name.replace(/-[0-9a-f]{6,}$/i, '')
    const title = deslugify(slug)
    if (title) out.push(title)
  }
}

/** 把一篇论文标题截短为检索友好的 query（保留前若干词，去掉年份/副标题噪声）。 */
function shortenQuery(title: string, maxWords = 12): string {
  const words = title.split(/\s+/).filter((w) => w.length > 0)
  return words.slice(0, maxWords).join(' ').trim()
}

function extractDomainKeywords(titles: string[]): string {
  const freq = new Map<string, number>()
  for (const title of titles) {
    const words = title
      .toLowerCase()
      .split(/[^a-z0-9]+/i)
      .filter((w) => w.length >= 3 && !PAPER_SLUG_STOP.has(w))
    for (const w of words) freq.set(w, (freq.get(w) || 0) + 1)
  }
  const top = [...freq.entries()]
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
    .slice(0, 10)
    .map((e) => e[0])
  const query = top.join(' ')
  return query.length > MAX_FOCUS_LENGTH ? query.slice(0, MAX_FOCUS_LENGTH) : query
}

/**
 * 从若干 wiki 页面正文里提炼“概念 query”：
 * 取标题行（#）、加粗术语，以及高频技术词（长度>=4、非停用词、
 * 含数字/大写驼峰/连字符，如 3d、point-cloud、fpga），拼接成检索词。
 * 目的是让检索“基于 wiki 内容”而不仅是论文题录。
 */
function extractConceptQuery(contents: string[]): string | null {
  const freq = new Map<string, number>()
  const headings: string[] = []
  for (const content of contents) {
    for (const line of content.split('\n')) {
      const h = line.match(/^#{1,3}\s+(.+)$/)
      if (h) headings.push(h[1].trim())
      const bold = line.match(/\*\*([^*]{3,40})\*\*/g)
      if (bold) for (const b of bold) headings.push(b.replace(/\*\*/g, '').trim())
    }
    for (const word of content.toLowerCase().split(/[^a-z0-9]+/i)) {
      if (word.length < 4 || PAPER_SLUG_STOP.has(word)) continue
      // 偏好“技术词”：含数字/大写驼峰/连字符的权重更高。
      if (/[0-9]/.test(word) || /[a-z][A-Z]/.test(word) || word.includes('-')) {
        freq.set(word, (freq.get(word) || 0) + 2)
      } else {
        freq.set(word, (freq.get(word) || 0) + 1)
      }
    }
  }
  const topTerms = [...freq.entries()]
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
    .slice(0, 10)
    .map((e) => e[0])
  const seed = [...headings, ...topTerms].map((s) => s.toLowerCase()).filter((s) => s.length > 0)
  const seen = new Set<string>()
  const parts: string[] = []
  for (const part of seed) {
    if (seen.has(part)) continue
    seen.add(part)
    parts.push(part)
  }
  const query = parts.join(' ')
  return query.length > 0 ? (query.length > MAX_FOCUS_LENGTH ? query.slice(0, MAX_FOCUS_LENGTH) : query) : null
}

export interface RecommendationFocus {
  baseQuery: string
  pageQueries: string[]
  conceptQuery: string | null
  paperCount: number
}

/**
 * 以本地知识库（llm-wiki）的 wiki 为锚点，构建“相似推荐”的检索焦点：
 *  1) baseQuery：从已收录论文标题提炼的领域高频关键词（兜底检索词）。
 *  2) pageQueries：每篇论文标题截短成一个 query —— “找出与该篇 KB 论文相似的论文”，
 *     即真正的“基于 wiki 相似性”检索，不再把所有标题拼成一句题录。
 *  3) conceptQuery：用 baseQuery 在 wiki 内做语义检索（含正文），从返回的相关
 *     页面正文里提炼研究概念，作为额外的“基于 wiki 内容”的检索词。
 * 知识库不可用或为空时返回 null（调用方会回退到预计算候选）。
 */
async function buildFocusFromKnowledgeBase(): Promise<RecommendationFocus | null> {
  try {
    const payload = await llmWikiJson<Record<string, unknown>>(
      '/projects/current/files?root=wiki&recursive=true&maxFiles=300',
      {},
      15_000,
    )
    const filesArr = Array.isArray(payload.files) ? (payload.files as unknown[]) : []
    const titles: string[] = []
    for (const node of filesArr) collectPaperTitles(node, titles)
    if (titles.length === 0) return null

    const extractedQuery = extractDomainKeywords(titles)
    const baseQuery = [...DATA_FOCUS_QUERIES.slice(0, 3), extractedQuery]
      .filter((part) => part.length > 0)
      .join(' ')
      .slice(0, MAX_FOCUS_LENGTH)
    // 每篇 KB 论文 → 一个相似性检索 query（最多 6 篇，避免外网请求过多）。
    const pageQueries = titles
      .map((t) => shortenQuery(t))
      .filter((q) => !EXCLUDED_DOMAIN_TERMS.some((term) => q.toLowerCase().includes(term)))
      .filter((q) => q.length > 0)
      .slice(0, 6)

    // 基于 wiki 内容的概念检索词：在 wiki 内语义检索相关页面正文后提炼。
    let conceptQuery: string | null = null
    if (baseQuery) {
      try {
        const search = await llmWikiJson<Record<string, unknown>>(
          '/projects/current/search',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query: baseQuery, topK: 5, includeContent: true }),
          },
          15_000,
        )
        const results = Array.isArray(search.results) ? (search.results as Record<string, unknown>[]) : []
        const contents = results
          .map((r) => asNullableString(r.content) ?? asNullableString(r.snippet) ?? '')
          .filter((c) => c.length > 0)
        conceptQuery = extractConceptQuery(contents)
      } catch {
        conceptQuery = null
      }
    }

    if (!baseQuery && pageQueries.length === 0 && !conceptQuery) return null
    return { baseQuery, pageQueries, conceptQuery, paperCount: titles.length }
  } catch {
    return null
  }
}

function emptyPayload(status: PaperRecommendationsPayload['status'] = 'pending'): PaperRecommendationsPayload {
  return {
    status,
    generatedAt: null,
    focus: null,
    paperCount: 0,
    nextRunAt: null,
    count: 0,
    topVenueOnly: false,
    recentPriority: false,
    items: [],
    error: null,
  }
}

function arrayFromResponse(value: unknown, key: string): unknown[] {
  if (Array.isArray(value)) return value
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    if (Array.isArray(record[key])) return record[key] as unknown[]
  }
  return []
}

async function searchReadingCandidates(query: string): Promise<unknown[]> {
  try {
    const payload = await llmWikiJson<Record<string, unknown>>(
      '/projects/current/reading-candidates/search',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, providers: CANDIDATE_PROVIDERS }),
      },
      90_000,
    )
    return arrayFromResponse(payload, 'candidates')
  } catch (error) {
    if (!(error instanceof LlmWikiApiError)) throw error
    return []
  }
}

function isDataDomainCandidate(item: PaperRecommendation): boolean {
  const text = `${item.title} ${item.abstract ?? ''}`.toLowerCase()
  if (EXCLUDED_DOMAIN_TERMS.some((term) => text.includes(term))) return false
  return DATA_DOMAIN_TERMS.some((term) => text.includes(term))
}

function isRecentCandidate(item: PaperRecommendation): boolean {
  if (item.year === null) return false
  const cutoff = new Date().getUTCFullYear() - RECENT_YEAR_WINDOW
  return item.year >= cutoff && item.year <= new Date().getUTCFullYear() + 1
}

/**
 * 根据焦点做多路“相似性检索”并筛选顶会、按发表时间倒序（最新优先）。
 * - baseQuery + 每篇 KB 论文标题（pageQueries）+ wiki 概念检索词（conceptQuery）
 *   并行调用 reading-candidates/search，外网检索与知识库相似的论文。
 * - 反查每篇候选的发表会议/期刊，按顶会白名单过滤
 *   （arXiv 预印本 / 期刊 / 非顶会排除）。
 * - 在顶会候选池内按年份倒序排序：最近发表的顶会论文排最前。
 * - 反查整体失败（网络/限流）时退化为不过滤，避免长期空白。
 */
async function fetchCandidates(
  focus: RecommendationFocus | null,
): Promise<{ items: PaperRecommendation[]; viaSearch: boolean; topVenueOnly: boolean }> {
  const queries: string[] = [...DATA_FOCUS_QUERIES]
  if (focus) {
    if (focus.baseQuery) queries.push(focus.baseQuery)
    for (const q of focus.pageQueries) if (q) queries.push(q)
    if (focus.conceptQuery) queries.push(focus.conceptQuery)
  }
  // 去重并限流（避免一次性过多外网请求）。
  const uniqueQueries = [...new Set(queries.map((q) => q.trim()).filter((q) => q.length > 0))].slice(0, 12)

  let raw: unknown[] = []
  let viaSearch = false
  if (uniqueQueries.length > 0) {
    const batches = await Promise.all(uniqueQueries.map((q) => searchReadingCandidates(q)))
    raw = batches.flat()
    viaSearch = raw.length > 0
  }
  if (raw.length === 0) {
    const payload = await llmWikiJson<Record<string, unknown>>('/projects/current/reading-candidates')
    raw = arrayFromResponse(payload, 'candidates')
    viaSearch = false
  }

  const allCandidates = raw
    .map(normalizeCandidate)
    .filter((item): item is PaperRecommendation => item !== null)
    .filter((item) => !isMetadataCandidate(item))
  // The search query is already data-focused. If a provider omits abstracts or
  // uses non-English metadata, keep those candidates instead of turning a
  // successful search into an empty recommendation panel.
  const domainCandidates = allCandidates.filter(isDataDomainCandidate)
  const normalizedCandidates = domainCandidates.length > 0 ? domainCandidates : allCandidates
  const deduplicated = new Map<string, PaperRecommendation>()
  for (const item of normalizedCandidates) {
    const key = (item.doi ?? item.url ?? item.id).toLowerCase()
    if (!deduplicated.has(key)) deduplicated.set(key, item)
  }
  const normalized = [...deduplicated.values()].slice(0, CANDIDATE_FETCH_LIMIT * 2)

  // 反查每篇候选的发表会议/期刊，并标记是否为顶会。
  const enriched = await Promise.all(
    normalized.map(async (item) => {
      const { venue, resolved } = await enrichVenue(item.doi ?? undefined)
      return { ...item, venue, enrichResolved: resolved }
    }),
  )
  const topVenue = enriched.filter((item) => isTopVenue(item.venue))
  // venue 反查整体失败（网络/限流）时退化为不过滤，避免长期空白；
  // 若已成功解析但无顶会命中，则严格只返回顶会（可能为空）。
  // A venue lookup can succeed without matching the conservative top-venue
  // allowlist (for example, a strong data-engineering journal). Show those
  // data-focused candidates as a useful fallback rather than returning zero.
  const pool: Array<PaperRecommendation & { enrichResolved: boolean }> =
    topVenue.length > 0 ? topVenue : enriched

  // Providers sometimes return very old proceedings for broad venue queries.
  // Prefer dated papers from the recent window and never let stale records
  // fill the feed. Undated records remain a last-resort fallback because a
  // provider may omit publication metadata for an otherwise valid result.
  const recent = pool.filter(isRecentCandidate)
  const undated = pool.filter((item) => item.year === null)
  const eligible = recent.length > 0 ? recent : undated
  // 按发表年份倒序：最近发表的顶会论文优先级最高。
  const sorted = eligible.slice().sort((a, b) => (b.year ?? 0) - (a.year ?? 0))
  const chosen = sorted
    .slice(0, MAX_ITEMS)
    .map(({ enrichResolved, ...rest }) => rest)
    .map((item) => ({ ...item, tags: normalizeTags(item.tags, `${item.title} ${item.abstract ?? ''}`) }))
  return { items: chosen, viaSearch, topVenueOnly: topVenue.length > 0 }
}

const RECOMMENDED_DRAFTS_STATE_FILE = 'recommended-drafts.json'

function normalizePaperTitle(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/gi, ' ').trim()
}

function slugifyPaperTitle(title: string): string {
  const ascii = title.toLowerCase().replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 60)
  const hash = createHash('sha256').update(title).digest('hex').slice(0, 8)
  return `${ascii || 'paper'}-${hash}`
}

function quoteFrontmatter(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ')}"`
}

/**
 * 推荐论文默认转入审核队列：为每篇新推荐的论文生成审核草稿（题录 + 摘要 + 推荐理由 + 原文链接），
 * 批准后发布为 wiki/papers/<slug>.md 论文页。去重：本地转换记录 + 现有草稿标题。
 */
async function syncRecommendedDrafts(items: PaperRecommendation[]): Promise<void> {
  if (!Array.isArray(items) || items.length === 0) return
  const statePath = join(config.appHome, RECOMMENDED_DRAFTS_STATE_FILE)
  let converted: Record<string, string> = {}
  try {
    if (existsSync(statePath)) {
      const parsed = JSON.parse(readFileSync(statePath, 'utf-8'))
      if (parsed && typeof parsed === 'object') converted = parsed as Record<string, string>
    }
  } catch {
    converted = {}
  }

  // 现有草稿标题集合（含已入库/已拒绝，避免重复生成）
  const existingTitles = new Set<string>()
  try {
    const drafts = await llmWikiJson<Record<string, unknown>>('/projects/current/ingest-drafts')
    const list = Array.isArray(drafts.drafts) ? (drafts.drafts as Record<string, unknown>[]) : []
    for (const d of list) {
      const t = typeof d?.paperTitle === 'string' ? d.paperTitle : (typeof d?.title === 'string' ? d.title : '')
      if (t.trim()) existingTitles.add(normalizePaperTitle(t))
    }
  } catch (err) {
    logger.warn(err, '[paper-recommender] failed to list drafts for dedup')
  }

  for (const item of items) {
    const title = asString(item.title, '').trim()
    if (!title) continue
    const key = normalizePaperTitle(title)
    if (converted[key] || existingTitles.has(key)) continue
    try {
      const targetPath = `wiki/papers/${slugifyPaperTitle(title)}.md`
      const authors = Array.isArray(item.authors) ? item.authors.filter((a) => typeof a === 'string' && a.trim()) : []
      const content = [
        '---',
        'type: paper',
        `title: ${quoteFrontmatter(title)}`,
        'content_kind: paper',
        `domain_tags: [${(item.tags ?? []).map((t) => quoteFrontmatter(t)).join(', ')}]`,
        `authors: [${authors.map((a) => quoteFrontmatter(a)).join(', ')}]`,
        ...(item.year ? [`year: ${item.year}`] : []),
        ...(item.venue ? [`venue: ${quoteFrontmatter(item.venue)}`] : []),
        ...(item.doi ? [`doi: ${quoteFrontmatter(item.doi)}`] : []),
        ...(item.url ? [`source_url: ${quoteFrontmatter(item.url)}`] : []),
        'summary: "由论文推荐任务自动生成的审核草稿，含题录、摘要与推荐理由；批准前请核对原文。"',
        '---',
        '',
        `# ${title}`,
        '',
        ...(authors.length ? [`**作者**：${authors.join('、')}`, ''] : []),
        ...(item.venue ? [`**会议/期刊**：${item.venue}`, ''] : []),
        ...(item.year ? [`**年份**：${item.year}`, ''] : []),
        ...(item.doi ? [`**DOI**：${item.doi}`, ''] : []),
        ...(item.abstract ? ['## 摘要', '', item.abstract, ''] : []),
        ...(item.reason ? ['## 推荐理由', '', item.reason, ''] : []),
        '## 原文链接',
        '',
        item.url ? `[${item.url}](${item.url})` : '（无链接，请自行查找原文）',
        '',
        '> 本页由“论文推荐（本地知识库 · 顶会优先）”任务自动生成，仅包含题录与摘要，请阅读原文后核实内容再批准。',
      ].join('\n')
      await llmWikiJson(
        '/projects/current/generated-drafts',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title, targetPath, content }),
        },
        30_000,
      )
      converted[key] = targetPath
      logger.info('[paper-recommender] recommended paper staged as review draft: %s', title)
    } catch (err) {
      if (err instanceof LlmWikiApiError && err.status === 409) {
        // 内容重复（llm-wiki 侧已存在同内容草稿）
        converted[key] = 'existing'
      } else {
        logger.warn(err, '[paper-recommender] failed to stage recommended draft: %s', title)
      }
    }
  }

  try {
    mkdirSync(config.appHome, { recursive: true })
    writeFileSync(statePath, `${JSON.stringify(converted, null, 2)}\n`, 'utf-8')
  } catch {
    // 记录失败不影响主流程
  }
}

export async function generateRecommendations(): Promise<PaperRecommendationsPayload> {
  const generatedAt = new Date().toISOString()
  const nextRunAt = nextScheduledRunAt()
  try {
    const kb = await buildFocusFromKnowledgeBase()
    const { items, topVenueOnly } = await fetchCandidates(kb)
    const paperCount = kb?.paperCount ?? 0
    const onDisk = loadRecommendations()
    const previous = onDisk.status === 'pending' && lastGoodItems.length > 0
      ? { ...onDisk, status: 'partial', items: lastGoodItems, generatedAt: lastGoodGeneratedAt ?? onDisk.generatedAt }
      : onDisk
    if (items.length === 0 && previous.items.length > 0) {
      const preserved: PaperRecommendationsPayload = {
        ...previous,
        status: 'partial',
        generatedAt,
        nextRunAt,
        paperCount: paperCount || previous.paperCount,
        error: '本轮外部检索暂无新结果，保留上一轮推荐论文',
      }
      persist(preserved)
      recordPaperRecommenderRun(preserved.status, preserved.error)
      void syncRecommendedDrafts(preserved.items).catch((err) => {
        logger.warn(err, '[paper-recommender] sync recommended drafts failed (preserved)')
      })
      return preserved
    }
    const payload: PaperRecommendationsPayload = {
      status: items.length > 0 ? 'success' : 'partial',
      generatedAt,
      focus: paperCount > 0 ? `本地知识库 · ${paperCount} 篇数据方向论文 · 数据工程主题 · 按发表时间排序（最新优先）` : null,
      paperCount,
      nextRunAt,
      count: items.length,
      topVenueOnly,
      recentPriority: true,
      items,
      error: items.length === 0
        ? '暂无可推荐的数据方向论文候选'
        : topVenueOnly
          ? null
          : '本轮未命中顶会白名单，已展示数据方向候选',
    }
    persist(payload)
    recordPaperRecommenderRun(payload.status, payload.error)
    // 推荐论文默认转入审核队列：新推荐（此前未出现过的）自动生成审核草稿
    void syncRecommendedDrafts(payload.items).catch((err) => {
      logger.warn(err, '[paper-recommender] sync recommended drafts failed')
    })
    return payload
  } catch (error) {
    const message = error instanceof LlmWikiApiError
      ? publicKnowledgeErrorMessage(error)
      : error instanceof Error
        ? error.message
        : '生成论文推荐失败'
    const payload: PaperRecommendationsPayload = {
      ...emptyPayload('failed'),
      generatedAt,
      nextRunAt,
      error: message,
    }
    persist(payload)
    recordPaperRecommenderRun(payload.status, payload.error)
    return payload
  }
}

/** 内存中最近一轮非 pending 的有效推荐结果（供“保留上一轮”逻辑在 pending 覆盖后仍可用）。 */
let lastGoodItems: PaperRecommendation[] = []
let lastGoodGeneratedAt: string | null = null

function persist(payload: PaperRecommendationsPayload): void {
  try {
    mkdirSync(config.appHome, { recursive: true })
    if (Array.isArray(payload.items) && payload.items.length > 0) {
      // 对比依据：手动刷新用按钮前的快照；定时/agent 回写用磁盘上一轮结果。
      let prevItems: PaperRecommendation[] = []
      let prevGeneratedAt: string | null = null
      if (manualRefreshBaseline) {
        prevItems = manualRefreshBaseline.items
        prevGeneratedAt = manualRefreshBaseline.generatedAt
        manualRefreshBaseline = null
      } else {
        const previous = loadRecommendations()
        if (previous.status !== 'pending') {
          prevItems = previous.items
          prevGeneratedAt = previous.generatedAt
        }
      }
      const prevByKey = new Map(prevItems.map((it) => [itemKey(it), it]))
      // 旧论文无 foundAt 时，用上一轮的生成时间兜底（至少知道“不晚于该时间已存在”）。
      const backfillAt = prevGeneratedAt ?? new Date().toISOString()
      for (const item of payload.items) {
        const old = prevByKey.get(itemKey(item))
        if (old) {
          item.newlyFound = false
          item.foundAt = old.foundAt ?? backfillAt
        } else {
          item.newlyFound = true
          item.foundAt = payload.generatedAt
        }
      }
    }
        if (Array.isArray(payload.items) && payload.items.length > 0 && payload.status !== 'pending') {
      lastGoodItems = payload.items
      lastGoodGeneratedAt = payload.generatedAt
    }
writeFileSync(recommendationsPath(), `${JSON.stringify(payload, null, 2)}\n`, 'utf-8')
  } catch {
    // 持久化失败不应中断调度；内存中的 payload 仍会被返回给调用方。
  }
}

export function loadRecommendations(): PaperRecommendationsPayload {
  const path = recommendationsPath()
  if (!existsSync(path)) return emptyPayload('pending')
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8'))
    if (parsed && typeof parsed === 'object' && Array.isArray((parsed as any).items)) {
      return parsed as PaperRecommendationsPayload
    }
  } catch {
    // 损坏的缓存视为待生成。
  }
  return emptyPayload('pending')
}

let refreshInFlight: Promise<PaperRecommendationsPayload> | null = null

export async function refreshRecommendations(): Promise<PaperRecommendationsPayload> {
  if (refreshInFlight) return refreshInFlight
  refreshInFlight = generateRecommendations().finally(() => {
    refreshInFlight = null
  })
  return refreshInFlight
}

/**
 * 由 Hermes cron 任务（agent 模式）回写的推荐结果。
 * agent 基于知识库 wiki 联网检索后，把筛选好的顶会论文列表 POST 到这里。
 * 仅做字段校验与数量上限，不依赖外部 LLM；写入同一份 paper-recommendations.json。
 */
export function saveAgentRecommendations(rawItems: unknown[]): PaperRecommendationsPayload {
  const generatedAt = new Date().toISOString()
  const nextRunAt = nextScheduledRunAt()
  const items: PaperRecommendation[] = (Array.isArray(rawItems) ? rawItems : [])
    .filter((x): x is Record<string, unknown> => !!x && typeof x === 'object' && typeof (x as any).title === 'string')
    .slice(0, MAX_ITEMS)
    .map((r): PaperRecommendation => {
      const title = asString(r.title, '未命名论文')
      const abstract = asNullableString(r.abstract ?? r.summary)
      return {
        id: asString(r.id ?? r.doi ?? r.url ?? r.title),
        title,
        authors: asStringArray(r.authors),
        year: asNullableNumber(r.year),
        abstract,
        url: asNullableString(r.url),
        provider: asNullableString(r.provider ?? r.source) ?? 'agent',
        reason: asNullableString(r.reason ?? r.recommendedReason ?? r.recommended_reason),
        venue: asNullableString(r.venue),
        doi: asNullableString(r.doi),
        tags: normalizeTags(r.tags ?? r.domain_tags, `${title} ${abstract ?? ''}`),
      }
    })
  const payload: PaperRecommendationsPayload = {
    status: items.length > 0 ? 'success' : 'partial',
    generatedAt,
    focus: '由 Hermes 基于知识库 wiki 检索 · 数据工程主题 · 最新优先',
    paperCount: 0,
    nextRunAt,
    count: items.length,
    topVenueOnly: true,
    recentPriority: true,
    items,
    error: items.length === 0 ? '未收到有效论文' : null,
  }
  persist(payload)
  recordPaperRecommenderRun(payload.status, payload.error)
  // 推荐论文默认转入审核队列：新推荐自动生成审核草稿
  void syncRecommendedDrafts(payload.items).catch((err) => {
    logger.warn(err, '[paper-recommender] sync recommended drafts failed (agent)')
  })
  return payload
}

/**
 * 手动刷新：按下按钮后执行“论文推荐（本地知识库 · 顶会优先）”任务。
 * 1) 先持久化 pending 状态，让前端立即看到“任务已启动”。
 * 2) 后台触发 Hermes cron 任务（agent 模式，网关 ticker 会真正执行联网检索）。
 * 3) 同时后台兜底运行本地引擎，保证按钮一定有结果（与定时刷新同源）。
 * 返回 pending 载荷；前端轮询 GET 直到状态离开 pending。
 */
export async function triggerPaperRecommendationRefresh(): Promise<PaperRecommendationsPayload> {
  const pending: PaperRecommendationsPayload = {
    ...emptyPayload('pending'),
    generatedAt: new Date().toISOString(),
    nextRunAt: nextScheduledRunAt(),
    error: '论文推荐任务已启动：Hermes 正在基于本地知识库检索顶会论文…',
  }
  // 先快照“按下按钮前的上一轮结果”作为新发现/搜出时间基线，再覆盖 pending，
  // 否则 loadRecommendations 会读到刚写入的 pending（items 为空）导致基线丢失。
  const before = loadRecommendations()
  if (before.status !== 'pending' && before.items.length > 0) {
    manualRefreshBaseline = { items: before.items, generatedAt: before.generatedAt }
  }
  persist(pending)

  // 手动执行“论文推荐（本地知识库 · 顶会优先）”Hermes cron 任务（agent 模式）。
  try {
    ensurePaperRecommenderJob()
    const agent = runPaperRecommenderAgentJob(getActiveProfileName())
    if (agent.started) {
      logger.info('[paper-recommender] Hermes agent job triggered pid=%s', agent.pid ?? 'unknown')
    } else {
      logger.warn('[paper-recommender] Hermes agent job trigger failed: %s', agent.error || 'unknown')
    }
  } catch (err) {
    logger.warn(err, '[paper-recommender] failed to trigger Hermes agent job')
  }

  // 本地引擎兜底：即使 agent 任务失败/未配置模型，按钮也能产出结果。
  void refreshRecommendations().catch((err) => {
    logger.warn(err, '[paper-recommender] background engine refresh failed')
  })
  return pending
}

let timer: ReturnType<typeof setInterval> | null = null

/** 启动定时推荐：延迟首跑 + 定期刷新。幂等，重复调用只生效一次。 */
export function schedulePaperRecommendations(): void {
  if (timer) return
  timer = setInterval(() => {
    void refreshRecommendations().catch(() => {})
  }, RECOMMEND_INTERVAL_MS)
  timer.unref?.()
  // 延迟首跑，给 llm-wiki（与 studio 同批启动）留出就绪时间。
  const kickoff = setTimeout(() => {
    void refreshRecommendations().catch(() => {})
  }, FIRST_RUN_DELAY_MS)
  kickoff.unref?.()
}
