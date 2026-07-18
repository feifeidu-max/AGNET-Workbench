import type { Readable } from 'stream'

const DEFAULT_BASE_URL = 'http://127.0.0.1:19828/api/v1'
const DEFAULT_TIMEOUT_MS = 10_000
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024

export class LlmWikiApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly payload?: unknown,
  ) {
    super(message)
  }
}

function redactLocalPaths(message: string): string {
  return message
    .replace(/\b[A-Za-z]:[\\/][^\r\n]*/g, '[local path omitted]')
    .replace(/(^|[\s("'])\/(?:Users|home|var|tmp|private|opt|root|mnt|Volumes)\/[^\s"')]+/g, '$1[local path omitted]')
}

/** Keep upstream diagnostics useful without exposing local filesystem paths. */
export function publicKnowledgeErrorMessage(error: unknown): string {
  if (error instanceof LlmWikiApiError) {
    if (error.status >= 500) return 'LLM Wiki service request failed'
    return redactLocalPaths(error.message)
  }
  return redactLocalPaths(error instanceof Error ? error.message : String(error))
}

function configuredBaseUrl(): string {
  const raw = process.env.LLM_WIKI_BASE_URL?.trim() || DEFAULT_BASE_URL
  const url = new URL(raw)
  const allowedHosts = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])
  if (url.protocol !== 'http:' || !allowedHosts.has(url.hostname)) {
    throw new Error('LLM_WIKI_BASE_URL must use loopback HTTP')
  }
  return url.toString().replace(/\/$/, '')
}

function headers(extra?: HeadersInit): Headers {
  const result = new Headers(extra)
  const token = process.env.LLM_WIKI_API_TOKEN?.trim()
  if (token) result.set('Authorization', `Bearer ${token}`)
  result.set('Accept', 'application/json')
  return result
}

function errorMessage(payload: unknown, fallback: string): string {
  if (payload && typeof payload === 'object') {
    const value = payload as Record<string, unknown>
    if (typeof value.error === 'string') return value.error
    if (typeof value.message === 'string') return value.message
  }
  return fallback
}

export async function llmWikiJson<T = any>(
  path: string,
  init: RequestInit = {},
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<T> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  timeout.unref?.()
  try {
    const response = await fetch(`${configuredBaseUrl()}${path.startsWith('/') ? path : `/${path}`}`, {
      ...init,
      headers: headers(init.headers),
      signal: controller.signal,
    })
    const text = await response.text()
    let payload: unknown = null
    if (text) {
      try { payload = JSON.parse(text) } catch { payload = { message: text.slice(0, 500) } }
    }
    if (!response.ok) {
      throw new LlmWikiApiError(errorMessage(payload, `LLM Wiki returned ${response.status}`), response.status, payload)
    }
    return payload as T
  } catch (error) {
    if (error instanceof LlmWikiApiError) throw error
    if (error instanceof Error && error.name === 'AbortError') {
      throw new LlmWikiApiError('LLM Wiki request timed out', 504)
    }
    throw new LlmWikiApiError(error instanceof Error ? error.message : String(error), 503)
  } finally {
    clearTimeout(timeout)
  }
}

export async function llmWikiRaw(path: string, init: RequestInit = {}): Promise<Response> {
  let response: Response
  try {
    response = await fetch(`${configuredBaseUrl()}${path.startsWith('/') ? path : `/${path}`}`, {
      ...init,
      headers: headers(init.headers),
    })
  } catch (error) {
    throw new LlmWikiApiError(error instanceof Error ? error.message : String(error), 503)
  }
  if (!response.ok) {
    const text = await response.text()
    let payload: unknown = null
    try { payload = text ? JSON.parse(text) : null } catch { payload = { message: text.slice(0, 500) } }
    throw new LlmWikiApiError(
      errorMessage(payload, `LLM Wiki returned ${response.status}`),
      response.status,
      payload,
    )
  }
  return response
}

export async function uploadDraft(stream: Readable, filename: string, contentLength?: number): Promise<any> {
  if (contentLength !== undefined && contentLength > MAX_UPLOAD_BYTES) {
    throw new LlmWikiApiError('PDF exceeds the 100 MB upload limit', 413)
  }
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 120_000)
  timeout.unref?.()
  const uploadHeaders = headers({
    'Content-Type': 'application/octet-stream',
    'X-Filename': encodeURIComponent(filename),
  })
  if (contentLength !== undefined) uploadHeaders.set('Content-Length', String(contentLength))
  try {
    const request: RequestInit & { duplex: 'half' } = {
      method: 'POST',
      headers: uploadHeaders,
      body: stream as any,
      signal: controller.signal,
      duplex: 'half',
    }
    const response = await fetch(`${configuredBaseUrl()}/projects/current/ingest-drafts`, request)
    const text = await response.text()
    const payload = text ? JSON.parse(text) : null
    if (!response.ok) {
      throw new LlmWikiApiError(errorMessage(payload, `LLM Wiki returned ${response.status}`), response.status, payload)
    }
    return payload
  } catch (error) {
    if (error instanceof LlmWikiApiError) throw error
    throw new LlmWikiApiError(error instanceof Error ? error.message : String(error), 503)
  } finally {
    clearTimeout(timeout)
  }
}

function countWikiPages(nodes: unknown): number {
  if (!Array.isArray(nodes)) return 0
  let count = 0
  for (const item of nodes) {
    if (!item || typeof item !== 'object') continue
    const node = item as Record<string, unknown>
    if (node.isDir === true) count += countWikiPages(node.children)
    else if (typeof node.path === 'string') {
      const path = node.path.replace(/\\/g, '/').toLowerCase()
      // The root wiki also contains index/log/overview system pages. The
      // workbench metric is the number of trusted paper pages only.
      if (path.endsWith('.md') && (path.includes('/wiki/papers/') || path.includes('/papers/'))) count += 1
    }
  }
  return count
}

function listCount(payload: unknown, keys: string[]): number {
  if (!payload || typeof payload !== 'object') return 0
  const value = payload as Record<string, unknown>
  if (typeof value.count === 'number') return value.count
  for (const key of keys) {
    if (Array.isArray(value[key])) return value[key].length
  }
  return 0
}

function shanghaiDayKey(value: unknown): string | null {
  const date = value instanceof Date ? value : new Date(String(value ?? ''))
  if (Number.isNaN(date.getTime())) return null
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date)
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]))
  if (!values.year || !values.month || !values.day) return null
  return `${values.year}-${values.month}-${values.day}`
}

/** Count papers entering the draft queue on the current Shanghai calendar day. */
export function countTodayDrafts(drafts: unknown[], now: Date = new Date()): number {
  const today = shanghaiDayKey(now)
  if (!today) return 0
  return drafts.filter((draft) => {
    if (!draft || typeof draft !== 'object') return false
    const value = draft as Record<string, unknown>
    return shanghaiDayKey(value.createdAt ?? value.created_at) === today
  }).length
}

export async function knowledgeSummary() {
  try {
    const health = await llmWikiJson<Record<string, any>>('/health')
    const [projectsResult, filesResult, draftsResult, candidatesResult] = await Promise.allSettled([
      llmWikiJson<Record<string, any>>('/projects'),
      llmWikiJson<Record<string, any>>('/projects/current/files?root=wiki&recursive=true&maxFiles=2000'),
      llmWikiJson<Record<string, any>>('/projects/current/ingest-drafts'),
      llmWikiJson<Record<string, any>>('/projects/current/reading-candidates'),
    ])
    const projects = projectsResult.status === 'fulfilled' ? projectsResult.value.projects || [] : []
    const currentProject = projects.find((project: any) => project.current) || projects[0] || null
    const files = filesResult.status === 'fulfilled' ? filesResult.value.files || [] : []
    const draftsPayload = draftsResult.status === 'fulfilled' ? draftsResult.value : null
    const candidatesPayload = candidatesResult.status === 'fulfilled' ? candidatesResult.value : null
    const drafts = draftsPayload && Array.isArray((draftsPayload as any).drafts) ? (draftsPayload as any).drafts : []
    return {
      serviceOk: health.ok !== false && health.status !== 'disabled',
      version: health.version || null,
      project: currentProject
        ? { id: currentProject.id, name: currentProject.name, current: currentProject.current === true }
        : null,
      trusted: countWikiPages(files),
      todayPapers: countTodayDrafts(drafts),
      drafts: listCount(draftsPayload, ['drafts']),
      awaitingReview: drafts.filter((draft: any) => draft.status === 'awaiting_review').length,
      candidates: listCount(candidatesPayload, ['candidates']),
      authConfigured: health.authConfigured !== false,
      errors: [draftsResult, candidatesResult]
        .filter(result => result.status === 'rejected')
        .map(result => result.status === 'rejected' ? publicKnowledgeErrorMessage(result.reason) : ''),
    }
  } catch (error) {
    return {
      serviceOk: false,
      version: null,
      project: null,
      trusted: 0,
      todayPapers: 0,
      drafts: 0,
      awaitingReview: 0,
      candidates: 0,
      authConfigured: false,
      errors: [publicKnowledgeErrorMessage(error)],
    }
  }
}
