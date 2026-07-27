/**
 * 论文推荐服务（定时）
 *
 * 依据：用户最近的 Hermes 对话/研究话题（焦点信号）作为检索 query，
 * 调用 llm-wiki 的 reading-candidates 接口（LLM 已按 query 排序的外部论文候选），
 * 归一化后持久化到 HERMES_WEB_UI_HOME/paper-recommendations.json。
 *
 * 推荐来源 = 尚未收录的外部论文（reading-candidates），与用户决策一致。
 * 相关性依据 = 最近对话/研究话题（焦点信号），与用户决策一致。
 *
 * 调度：服务启动时延迟 30s 首跑（等 llm-wiki 起来），之后每 6 小时刷新一次。
 * 同时暴露手动 refresh（HTTP 端点），便于即时触发与排错。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { config } from '../config'
import { llmWikiJson, LlmWikiApiError, publicKnowledgeErrorMessage } from './knowledge/llm-wiki-client'
import { listSessionSummaries } from '../db/hermes/sessions-db'

const RECOMMEND_INTERVAL_MS = 6 * 60 * 60 * 1000
const FIRST_RUN_DELAY_MS = 30 * 1000
const FOCUS_SESSION_LIMIT = 12
const MAX_ITEMS = 6
const MAX_FOCUS_LENGTH = 2000
const CANDIDATE_PROVIDERS = ['openalex', 'crossref', 'arxiv']
const RESEARCH_PROFILES = ['default', 'research']

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
 * 从最近 Hermes 会话（default + research profile）提取研究话题作为焦点信号。
 * 任一 profile 的会话库不可用（sqlite 未就绪/文件缺失）时静默跳过，不影响其它 profile。
 */
async function buildFocusSignal(): Promise<string | null> {
  const titles: string[] = []
  for (const profile of RESEARCH_PROFILES) {
    try {
      const sessions = await listSessionSummaries('hermes', FOCUS_SESSION_LIMIT, profile)
      for (const session of sessions) {
        const title = session?.title
        if (typeof title === 'string' && title.trim()) titles.push(title.trim())
      }
    } catch {
      // 该 profile 的会话库暂不可用，跳过。
    }
  }
  const unique = Array.from(new Set(titles)).slice(0, 10)
  if (unique.length === 0) return null
  const focus = unique.join('；')
  return focus.length > MAX_FOCUS_LENGTH ? focus.slice(0, MAX_FOCUS_LENGTH) : focus
}

function emptyPayload(status: PaperRecommendationsPayload['status'] = 'pending'): PaperRecommendationsPayload {
  return {
    status,
    generatedAt: null,
    focus: null,
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
    const focus = await buildFocusSignal()
    const { items } = await fetchCandidates(focus)
    const payload: PaperRecommendationsPayload = {
      status: items.length > 0 ? 'success' : 'partial',
      generatedAt,
      focus,
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
