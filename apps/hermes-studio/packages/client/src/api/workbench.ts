import { getApiKey, request } from './client'

export type ServiceStatus = 'ok' | 'degraded' | 'down' | 'unavailable' | 'unknown'

export interface ServiceHealth {
  name: string
  status: ServiceStatus
  detail?: string
  checkedAt?: string | null
}

export interface WorkbenchSummary {
  knowledge: {
    drafts: number
    awaitingReview?: number
    trusted: number
    candidates: number
    serviceOk: boolean
    todayPapers?: number
  }
  paperRecommendations?: PaperRecommendationsPayload
  services: ServiceHealth[]
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
}

export interface PaperRecommendationsPayload {
  status: 'pending' | 'success' | 'partial' | 'failed'
  generatedAt: string | null
  focus: string | null
  nextRunAt: string | null
  count: number
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
