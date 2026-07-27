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

export interface PaperRecommendation {
  id: string
  title: string
  authors: string[]
  year: number | null
  abstract: string | null
  url: string | null
  provider: string | null
  reason: string | null
}

export interface PaperRecommendationsPayload {
  status: 'pending' | 'success' | 'partial' | 'failed'
  generatedAt: string | null
  focus: string | null
  paperCount: number
  nextRunAt: string | null
  count: number
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
  }
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
  if (focus) {
    try {
      const payload = await llmWikiJson<Record<string, unknown>>('/projects/current/reading-candidates/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: focus, providers: CANDIDATE_PROVIDERS }),
      }, 90_000)
      const items = arrayFromResponse(payload, 'candidates')
        .map(normalizeCandidate)
        .filter((item): item is PaperRecommendation => item !== null)
        .slice(0, MAX_ITEMS)
      if (items.length > 0) return { items, viaSearch: true }
    } catch (error) {
      if (!(error instanceof LlmWikiApiError)) throw error
      // 搜索失败（如 llm-wiki 未配置外部 LLM）→ 兜底读预计算候选。
    }
  }
  const payload = await llmWikiJson<Record<string, unknown>>('/projects/current/reading-candidates')
  const items = arrayFromResponse(payload, 'candidates')
    .map(normalizeCandidate)
    .filter((item): item is PaperRecommendation => item !== null)
    .slice(0, MAX_ITEMS)
  return { items, viaSearch: false }
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
      focus: paperCount > 0 ? `本地知识库 · ${paperCount} 篇论文` : null,
      paperCount,
      nextRunAt,
      count: items.length,
      items,
      error: items.length === 0 ? '暂无可推荐的外部论文候选' : null,
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
