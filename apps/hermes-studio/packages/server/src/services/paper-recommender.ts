/**
 * 论文推荐服务（定时）
 *
 * 依据：本地知识库（llm-wiki）自身已收录的论文作为“相似推荐”的锚点。
 * 流程：列出 wiki/papers/*.md（文件名即论文标题 slug）→ 反解标题 →
 * 提取领域关键词（point cloud / neural network / accelerator …）作为检索 query
 * → 调用 llm-wiki 的 reading-candidates/search（OpenAlex/Crossref/arXiv 纯 HTTP，
 * 无需 LLM）返回与知识库主题相似的外部论文。
 *
 * 推荐来源 = 尚未收录的外部论文（reading-candidates）；相关性依据 = 本地知识库论文。
 * 不再使用聊天记录作为焦点（避免推荐出与知识库无关的论文）。
 *
 * 调度：服务启动时延迟 30s 首跑（等 llm-wiki 起来），之后每 6 小时刷新一次。
 * 同时暴露手动 refresh（HTTP 端点），便于即时触发与排错。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { config } from '../config'
import { llmWikiJson, LlmWikiApiError, publicKnowledgeErrorMessage } from './knowledge/llm-wiki-client'

const RECOMMEND_INTERVAL_MS = 6 * 60 * 60 * 1000
const FIRST_RUN_DELAY_MS = 30 * 1000
const MAX_ITEMS = 6
const MAX_FOCUS_LENGTH = 400
const CANDIDATE_PROVIDERS = ['openalex', 'crossref', 'arxiv']
// 一次检索多拉一些候选，再做“顶会”过滤，保证最终能凑满 MAX_ITEMS。
const CANDIDATE_FETCH_LIMIT = 30
// 候选本身不含 venue 字段，需要根据 DOI 向 Crossref/OpenAlex 反查会议名称，
// 再按顶会白名单过滤。这里覆盖与本项目（点云/神经网络加速器）相关的计算机顶会，
// 也包含 ML/视觉/机器人/系统/安全/网络等通用 CS 顶会。
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
  // 数据库 / 数据挖掘 / 软件工程
  'sigmod', 'vldb', 'icde', 'kdd', 'www', 'icse', 'ase', 'fse', 'issta',
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
}

export interface PaperRecommendationsPayload {
  status: 'pending' | 'success' | 'partial' | 'failed'
  generatedAt: string | null
  focus: string | null
  paperCount: number
  nextRunAt: string | null
  count: number
  topVenueOnly: boolean
  items: PaperRecommendation[]
  error: string | null
}

function recommendationsPath(): string {
  return join(config.appHome, 'paper-recommendations.json')
}

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
  return {
    id,
    title: asString(item.title, '未命名论文'),
    authors: asStringArray(item.authors),
    year: asNullableNumber(item.year),
    abstract: asNullableString(item.abstract ?? item.summary),
    url: asNullableString(item.url),
    provider: asNullableString(item.provider ?? item.source),
    reason: asNullableString(item.reason ?? item.recommendedReason ?? item.recommended_reason),
    venue: null,
    doi: asNullableString(item.doi),
  }
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
 * 以本地知识库自身论文为锚点，构建“相似推荐”的检索 query。
 * 列出 wiki/papers/*.md → 反解标题 → 提取领域高频关键词。
 * 知识库不可用或为空时返回 null（调用方会回退到预计算候选）。
 */
async function buildFocusFromKnowledgeBase(): Promise<{ query: string; paperCount: number } | null> {
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
    const query = extractDomainKeywords(titles)
    if (!query) return null
    return { query, paperCount: titles.length }
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

async function fetchCandidates(focus: string | null): Promise<{ items: PaperRecommendation[]; viaSearch: boolean }> {
  let raw: unknown[] = []
  let viaSearch = false
  if (focus) {
    try {
      const payload = await llmWikiJson<Record<string, unknown>>('/projects/current/reading-candidates/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: focus, providers: CANDIDATE_PROVIDERS }),
      }, 90_000)
      raw = arrayFromResponse(payload, 'candidates')
      viaSearch = raw.length > 0
    } catch (error) {
      if (!(error instanceof LlmWikiApiError)) throw error
      // 搜索失败（如 llm-wiki 未配置外部 LLM）→ 兜底读预计算候选。
    }
  }
  if (raw.length === 0) {
    const payload = await llmWikiJson<Record<string, unknown>>('/projects/current/reading-candidates')
    raw = arrayFromResponse(payload, 'candidates')
    viaSearch = false
  }

  const normalized = raw
    .map(normalizeCandidate)
    .filter((item): item is PaperRecommendation => item !== null)
    .slice(0, CANDIDATE_FETCH_LIMIT)

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
  const allEnrichFailed = enriched.length > 0 && enriched.every((item) => !item.enrichResolved)
  const pool: Array<PaperRecommendation & { enrichResolved: boolean }> =
    topVenue.length > 0 ? topVenue : allEnrichFailed ? enriched : []
  const chosen = pool
    .slice(0, MAX_ITEMS)
    .map(({ enrichResolved, ...rest }) => rest)
  return { items: chosen, viaSearch }
}

export async function generateRecommendations(): Promise<PaperRecommendationsPayload> {
  const generatedAt = new Date().toISOString()
  const nextRunAt = new Date(Date.now() + RECOMMEND_INTERVAL_MS).toISOString()
  try {
    const kb = await buildFocusFromKnowledgeBase()
    const { items } = await fetchCandidates(kb?.query ?? null)
    const paperCount = kb?.paperCount ?? 0
    const payload: PaperRecommendationsPayload = {
      status: items.length > 0 ? 'success' : 'partial',
      generatedAt,
      focus: paperCount > 0 ? `本地知识库 · ${paperCount} 篇论文 · 顶会优先` : null,
      paperCount,
      nextRunAt,
      count: items.length,
      topVenueOnly: true,
      items,
      error: items.length === 0 ? '暂无可推荐的外部顶会论文候选' : null,
    }
    persist(payload)
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
    return payload
  }
}

function persist(payload: PaperRecommendationsPayload): void {
  try {
    mkdirSync(config.appHome, { recursive: true })
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

export async function refreshRecommendations(): Promise<PaperRecommendationsPayload> {
  return generateRecommendations()
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
