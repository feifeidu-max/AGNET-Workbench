import { getApiKey, request } from './client'

export type ServiceStatus = 'ok' | 'degraded' | 'down' | 'unavailable' | 'unknown'

export interface ServiceHealth {
  id?: string
  name: string
  status: ServiceStatus
  detail?: string
  checkedAt?: string | null
}

export interface ModelProbe {
  status: 'ok' | 'failed' | 'skipped' | 'unknown'
  error: string | null
  checkedAt: string | null
}

export interface ModelHealth {
  profile: string
  provider: string | null
  providerName: string | null
  model: string | null
  baseUrl: string | null
  keyEnv: string | null
  keyConfigured: boolean
  keyMasked: string | null
  apiMode: string | null
  probe: ModelProbe
}

export interface HermesGatewayHealth {
  running: boolean
  pid: number | null
  profile: string
}

export interface WorkbenchSummary {
  knowledge: {
    drafts: number
    awaitingReview?: number
    trusted: number
    /** 已批准发布的公众号文章/技术文章数量（wiki/sources） */
    sources?: number
    candidates: number
    serviceOk: boolean
    todayPapers?: number
  }
  paperRecommendations?: PaperRecommendationsPayload
  hermes?: HermesGatewayHealth
  model?: ModelHealth
  services: ServiceHealth[]
}

export interface WechatSource {
  id: string
  name: string
  url: string
  enabled: boolean
  createdAt: string
  updatedAt: string
  lastSyncAt: string | null
  lastSyncStatus: 'never' | 'success' | 'partial' | 'failed'
  lastSyncError: string | null
  importedCount: number
  discoveredCount: number
}

export interface WechatSyncReport {
  startedAt: string
  finishedAt: string
  discovered: number
  imported: number
  skipped: number
  rejected: number
  errors: string[]
  sources: Array<{
    sourceId: string
    sourceName: string
    discovered: number
    imported: number
    skipped: number
    rejected: number
    errors: string[]
  }>
}

export type KnowledgeDraftStatus =
  | 'uploaded'
  | 'parsing'
  | 'drafting'
  | 'awaiting_review'
  | 'publishing'
  | 'trusted'
  | 'revision_requested'
  | 'rejected'
  | 'failed'

export interface EvidenceLocator {
  sourceId: string
  revision: string
  page: number
  section?: string | null
  snippetHash?: string | null
}

export interface KnowledgeDraft {
  id: string
  title: string
  fileName: string
  status: KnowledgeDraftStatus
  createdAt: string | null
  updatedAt: string | null
  authors: string[]
  year: number | null
  summary?: string | null
  error?: string | null
  additions?: number
  modifications?: number
  changeCount?: number
  /** 已发布（trusted）时对应的 Wiki 页面路径，如 wiki/papers/xxx.md */
  publishedPages?: string[]
}

export interface KnowledgeDraftChange {
  path: string
  operation: string
  title: string
  content: string
  previousContent: string | null
  evidenceLocators: EvidenceLocator[]
}

export interface KnowledgeDraftDetail {
  draft: KnowledgeDraft
  changes: KnowledgeDraftChange[]
  extractedTextPreview: string | null
}

export interface KnowledgeSearchResult {
  id: string
  title: string
  excerpt: string
  score?: number | null
  authors: string[]
  year: number | null
  locator?: EvidenceLocator | null
  sourceUrl?: string | null
}

export interface KnowledgeAnswerReference {
  title: string
  path: string
  kind: string
  snippet?: string | null
  score?: number | null
}

export interface KnowledgeAnswer {
  content: string
  references: KnowledgeAnswerReference[]
}

export interface ReadingCandidate {
  id: string
  title: string
  authors: string[]
  year: number | null
  abstract?: string | null
  url?: string | null
  provider?: string | null
  reason?: string | null
  status?: 'candidate' | 'dismissed' | 'uploaded' | string
}

export interface KnowledgeGraph {
  nodes: Array<Record<string, unknown>>
  edges: Array<Record<string, unknown>>
}

export interface KnowledgeProject {
  id: string
  name: string
  path: string
  current: boolean
}

export interface PaperRecommendation {
  id: string
  title: string
  authors: string[]
  year: number | null
  abstract?: string | null
  url?: string | null
  provider?: string | null
  reason?: string | null
  venue?: string | null
  doi?: string | null
  /** 中文标签：LLM-Wiki 同款关键词提取，固定数据方向域标签 */
  tags?: string[]
  /** 本次刷新新检索到的论文（服务端对比上一轮结果标记） */
  newlyFound?: boolean
  /** 该论文被搜出来的时间（ISO），旧论文保留首次搜出时间 */
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
  error?: string | null
}

export interface KnowledgeWorkspace {
  projects: KnowledgeProject[]
  currentProject: KnowledgeProject | null
  service: {
    status: string
    version: string | null
    retrievalMode: string | null
    studioManaged: boolean
    llmConfigured: boolean
    llmConfigSource: 'environment' | 'store' | 'none' | string
  }
}

type UnknownRecord = Record<string, unknown>

function asRecord(value: unknown): UnknownRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as UnknownRecord : {}
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function asNullableString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function asNullableNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string')
}

function normalizeEvidenceLocator(value: unknown): EvidenceLocator | null {
  const locator = asRecord(value)
  if (Object.keys(locator).length === 0) return null
  const rawRevision = locator.revision
  return {
    sourceId: asString(locator.sourceId ?? locator.source_id),
    revision: typeof rawRevision === 'number' ? String(rawRevision) : asString(rawRevision),
    page: asNumber(locator.page, 1),
    section: asNullableString(locator.section),
    snippetHash: asNullableString(locator.snippetHash ?? locator.snippet_hash),
  }
}

function arrayFromResponse(value: unknown, key: string): unknown[] {
  if (Array.isArray(value)) return value
  const record = asRecord(value)
  return Array.isArray(record[key]) ? record[key] : []
}

function normalizeDraft(value: unknown): KnowledgeDraft {
  const item = asRecord(value)
  const status = asString(item.status, 'failed') as KnowledgeDraftStatus
  return {
    id: asString(item.id ?? item.draftId ?? item.draft_id),
    title: asString(item.title ?? item.paperTitle ?? item.paper_title ?? item.fileName ?? item.file_name ?? item.filename, '未命名论文'),
    fileName: asString(item.fileName ?? item.file_name ?? item.filename, 'unknown.pdf'),
    status,
    createdAt: asNullableString(item.createdAt ?? item.created_at),
    updatedAt: asNullableString(item.updatedAt ?? item.updated_at),
    authors: asStringArray(item.authors ?? item.paperAuthors ?? item.paper_authors),
    year: asNullableNumber(item.year ?? item.publicationYear ?? item.publication_year),
    summary: asNullableString(item.summary),
    error: asNullableString(item.error),
    additions: asNumber(item.additions ?? item.addedPages, 0),
    modifications: asNumber(item.modifications ?? item.modifiedPages, 0),
    changeCount: asNumber(item.changeCount ?? item.proposedChangeCount ?? item.proposed_change_count, 0),
    publishedPages: asStringArray(item.publishedPages ?? item.published_pages),
  }
}

function normalizeSearchResult(value: unknown): KnowledgeSearchResult {
  const item = asRecord(value)
  const locatorRecord = asRecord(item.locator ?? item.evidenceLocator ?? item.evidence_locator)
  const locator = normalizeEvidenceLocator(locatorRecord)
  const rawSourceUrl = asNullableString(item.sourceUrl ?? item.source_url ?? item.url)
  let sourceUrl = rawSourceUrl
  if (rawSourceUrl?.startsWith('/api/knowledge/')) {
    const target = new URL(rawSourceUrl, window.location.origin)
    const token = getApiKey()
    if (token) target.searchParams.set('token', token)
    const page = Math.max(1, locator?.page || Number(target.searchParams.get('page')) || 1)
    target.hash = `page=${page}`
    sourceUrl = `${target.pathname}${target.search}${target.hash}`
  }
  return {
    id: asString(item.id ?? item.sourceId ?? item.source_id ?? item.path),
    title: asString(item.title ?? item.name ?? item.path, '未命名条目'),
    excerpt: asString(item.excerpt ?? item.snippet ?? item.summary ?? item.content),
    score: asNullableNumber(item.score),
    authors: asStringArray(item.authors ?? locatorRecord.authors),
    year: asNullableNumber(item.year ?? locatorRecord.year),
    locator,
    sourceUrl,
  }
}

function normalizeCandidate(value: unknown): ReadingCandidate {
  const item = asRecord(value)
  return {
    id: asString(item.id ?? item.doi ?? item.url),
    title: asString(item.title, '未命名论文'),
    authors: asStringArray(item.authors),
    year: asNullableNumber(item.year),
    abstract: asNullableString(item.abstract ?? item.summary),
    url: asNullableString(item.url),
    provider: asNullableString(item.provider ?? item.source),
    reason: asNullableString(item.reason ?? item.recommendedReason ?? item.recommended_reason),
    status: asString(item.status, 'candidate'),
  }
}

function normalizeKnowledgeProject(value: unknown): KnowledgeProject {
  const item = asRecord(value)
  return {
    id: asString(item.id ?? item.path),
    name: asString(item.name, '未命名知识库'),
    path: asString(item.path),
    current: item.current === true,
  }
}

function normalizeWechatSource(value: unknown): WechatSource {
  const item = asRecord(value)
  const status = asString(item.lastSyncStatus, 'never') as WechatSource['lastSyncStatus']
  return {
    id: asString(item.id),
    name: asString(item.name, '微信公众号来源'),
    url: asString(item.url),
    enabled: item.enabled !== false,
    createdAt: asString(item.createdAt ?? item.created_at),
    updatedAt: asString(item.updatedAt ?? item.updated_at),
    lastSyncAt: asNullableString(item.lastSyncAt ?? item.last_sync_at),
    lastSyncStatus: ['never', 'success', 'partial', 'failed'].includes(status) ? status : 'never',
    lastSyncError: asNullableString(item.lastSyncError ?? item.last_sync_error),
    importedCount: asNumber(item.importedCount ?? item.imported_count),
    discoveredCount: asNumber(item.discoveredCount ?? item.discovered_count),
  }
}

export async function fetchWorkbenchSummary(): Promise<WorkbenchSummary> {
  return request<WorkbenchSummary>('/api/workbench/summary')
}

export async function fetchPaperRecommendations(): Promise<PaperRecommendationsPayload> {
  return request<PaperRecommendationsPayload>('/api/workbench/paper-recommendations')
}

export async function refreshPaperRecommendations(): Promise<PaperRecommendationsPayload> {
  return request<PaperRecommendationsPayload>('/api/workbench/paper-recommendations/refresh', {
    method: 'POST',
  })
}

/**
 * 手动触发“论文推荐（本地知识库 · 顶会优先）”任务并等待结果：
 * POST 触发（后台跑 Hermes agent 任务 + 本地引擎兜底，立即返回 pending），
 * 然后轮询 GET 直到状态离开 pending，按钮始终能等到新结果。
 */
export async function refreshPaperRecommendationsAndWait(
  timeoutMs = 180_000,
  pollMs = 3000,
): Promise<PaperRecommendationsPayload> {
  await request<PaperRecommendationsPayload>('/api/workbench/paper-recommendations/refresh', {
    method: 'POST',
  })
  const deadline = Date.now() + timeoutMs
  let last: PaperRecommendationsPayload | null = null
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, pollMs))
    last = await fetchPaperRecommendations()
    if (last.status !== 'pending') return last
  }
  return last ?? (await fetchPaperRecommendations())
}

export async function fetchWechatSources(): Promise<WechatSource[]> {
  const result = await request<unknown>('/api/workbench/wechat-sources')
  return arrayFromResponse(result, 'sources').map(normalizeWechatSource)
}

export async function addWechatSource(name: string, url: string): Promise<WechatSource> {
  const result = asRecord(await request<unknown>('/api/workbench/wechat-sources', {
    method: 'POST',
    body: JSON.stringify({ name, url }),
  }))
  return normalizeWechatSource(result.source ?? result)
}

export async function removeWechatSource(id: string): Promise<void> {
  await request<unknown>(`/api/workbench/wechat-sources/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

export async function syncWechatSources(sourceId?: string): Promise<WechatSyncReport> {
  return request<WechatSyncReport>('/api/workbench/wechat-sources/sync', {
    method: 'POST',
    body: JSON.stringify(sourceId ? { sourceId } : {}),
  })
}

export async function listKnowledgeDrafts(): Promise<KnowledgeDraft[]> {
  const result = await request<unknown>('/api/knowledge/drafts')
  return arrayFromResponse(result, 'drafts').map(normalizeDraft)
}

export async function fetchKnowledgeDraftDetail(id: string): Promise<KnowledgeDraftDetail> {
  const result = asRecord(await request<unknown>(`/api/knowledge/drafts/${encodeURIComponent(id)}`))
  const proposal = asRecord(result.proposal)
  const changes = arrayFromResponse(proposal, 'changes').map((value): KnowledgeDraftChange => {
    const change = asRecord(value)
    return {
      path: asString(change.path),
      operation: asString(change.operation, 'update'),
      title: asString(change.title ?? change.path, '未命名页面'),
      content: asString(change.content),
      previousContent: change.previousContent === null || change.previous_content === null
        ? null
        : asString(change.previousContent ?? change.previous_content),
      evidenceLocators: (Array.isArray(change.evidenceLocators)
        ? change.evidenceLocators
        : arrayFromResponse(change, 'evidence_locators'))
        .map(normalizeEvidenceLocator)
        .filter((locator): locator is EvidenceLocator => locator !== null),
    }
  })
  return {
    draft: normalizeDraft(result.draft ?? result),
    changes,
    extractedTextPreview: asNullableString(result.extractedTextPreview ?? result.extracted_text_preview),
  }
}

export async function uploadKnowledgePdf(file: File): Promise<KnowledgeDraft> {
  const result = await request<unknown>('/api/knowledge/drafts', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/pdf',
      'X-Filename': encodeURIComponent(file.name),
    },
    body: file,
  })
  const record = asRecord(result)
  return normalizeDraft(record.draft ?? result)
}

export async function approveKnowledgeDraft(id: string): Promise<KnowledgeDraft> {
  return mutateKnowledgeDraft(id, 'approve')
}

export async function reviseKnowledgeDraft(id: string, reason?: string): Promise<KnowledgeDraft> {
  return mutateKnowledgeDraft(id, 'revise', reason ? { guidance: reason } : undefined)
}

export async function rejectKnowledgeDraft(id: string, reason?: string): Promise<KnowledgeDraft> {
  return mutateKnowledgeDraft(id, 'reject', reason ? { reason } : undefined)
}

async function mutateKnowledgeDraft(
  id: string,
  action: 'approve' | 'revise' | 'reject',
  payload?: { reason: string } | { guidance: string },
): Promise<KnowledgeDraft> {
  const result = await request<unknown>(`/api/knowledge/drafts/${encodeURIComponent(id)}/${action}`, {
    method: 'POST',
    body: JSON.stringify(payload ?? {}),
  })
  const record = asRecord(result)
  return normalizeDraft(record.draft ?? result)
}

export async function searchTrustedKnowledge(query: string): Promise<KnowledgeSearchResult[]> {
  const result = await request<unknown>(`/api/knowledge/search?q=${encodeURIComponent(query.trim())}`)
  return arrayFromResponse(result, 'results').map(normalizeSearchResult)
}

export async function askTrustedKnowledge(question: string): Promise<KnowledgeAnswer> {
  const result = asRecord(await request<unknown>('/api/knowledge/chat', {
    method: 'POST',
    body: JSON.stringify({ question: question.trim() }),
  }))
  const message = asRecord(result.message)
  return {
    // LLM Wiki's current AgentChatResponse uses a string `message`; retain
    // object support for older builds that returned `{ content }`.
    content: asString(message.content ?? result.message ?? result.content ?? result.answer),
    references: arrayFromResponse(result, 'references').map((value) => {
      const item = asRecord(value)
      return {
        title: asString(item.title ?? item.path, '未命名来源'),
        path: asString(item.path),
        kind: asString(item.kind, 'wiki'),
        snippet: asNullableString(item.snippet),
        score: asNullableNumber(item.score),
      }
    }),
  }
}

export async function searchReadingCandidates(query = ''): Promise<ReadingCandidate[]> {
  const result = await request<unknown>('/api/knowledge/candidates', {
    method: 'POST',
    body: JSON.stringify({ query: query.trim() }),
  })
  return arrayFromResponse(result, 'candidates').map(normalizeCandidate)
}

export async function dismissReadingCandidate(id: string): Promise<void> {
  await request<unknown>(`/api/knowledge/candidates/${encodeURIComponent(id)}/dismiss`, { method: 'POST' })
}

export async function fetchKnowledgeGraph(): Promise<KnowledgeGraph> {
  const raw = await request<unknown>('/api/knowledge/graph')
  const result = asRecord(raw)
  const rawNodes = Array.isArray(raw) ? raw : result.nodes
  const rawEdges = result.edges ?? result.links
  return {
    nodes: Array.isArray(rawNodes) ? rawNodes.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object') : [],
    edges: Array.isArray(rawEdges) ? rawEdges.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object') : [],
  }
}

export async function fetchKnowledgeWorkspace(): Promise<KnowledgeWorkspace> {
  const result = asRecord(await request<unknown>('/api/knowledge/workspace'))
  const projects = arrayFromResponse(result, 'projects').map(normalizeKnowledgeProject)
  const currentRaw = asRecord(result.currentProject ?? result.current_project)
  const currentProject = Object.keys(currentRaw).length
    ? normalizeKnowledgeProject(currentRaw)
    : projects.find((project) => project.current) ?? null
  const service = asRecord(result.service)
  return {
    projects,
    currentProject,
    service: {
      status: asString(service.status, 'unknown'),
      version: asNullableString(service.version),
      retrievalMode: asNullableString(service.retrievalMode ?? service.retrieval_mode),
      studioManaged: service.studioManaged !== false,
      llmConfigured: service.llmConfigured === true,
      llmConfigSource: asString(service.llmConfigSource ?? service.llm_config_source, 'none'),
    },
  }
}

export async function selectKnowledgeProject(projectId: string): Promise<void> {
  await request<unknown>('/api/knowledge/workspace/select', {
    method: 'POST',
    body: JSON.stringify({ projectId }),
  })
}
