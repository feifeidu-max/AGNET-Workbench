import { request } from './client'

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function array(value: unknown, key: string): unknown[] {
  if (Array.isArray(value)) return value
  const result = record(value)[key]
  return Array.isArray(result) ? result : []
}

function string(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' && value.length ? value : null
}

function number(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

export interface KnowledgeFileNode {
  name: string
  path: string
  isDir: boolean
  size: number | null
  children: KnowledgeFileNode[]
}

export interface KnowledgeFileContent {
  path: string
  content: string
  revision: string
}

export interface KnowledgeFileHistoryEntry {
  id: string
  timestamp: number
  author: string
  tool: string
  content: string
}

export interface KnowledgePageLink {
  title: string
  path: string | null
  snippet: string | null
}

export interface KnowledgePageLinks {
  outgoing: KnowledgePageLink[]
  backlinks: KnowledgePageLink[]
  missing: KnowledgePageLink[]
}

export interface KnowledgeReview {
  id: string
  title: string
  type: string
  resolved: boolean
  description: string | null
  createdAt: string | null
  options: unknown[]
  raw: Record<string, unknown>
}

export interface KnowledgeSkill {
  id: string
  name: string
  description: string
  source: string
}

export interface TrustedKnowledgeSource {
  sourceId: string
  filename: string
  sourceKind: string
  pagePaths: string[]
  revision: number
  trustedAt: string | null
  title: string | null
  authors: string[]
  year: number | null
}

export interface KnowledgeChatMessage {
  role: 'user' | 'assistant' | string
  content: string
  timestamp?: number
}

export interface KnowledgeChatSession {
  id: string
  title: string
  updatedAt: number
  messageCount: number
}

export interface KnowledgeChatResponse {
  sessionId: string
  content: string
  references: Array<{
    title: string
    path: string
    kind: string
    snippet: string | null
    score: number | null
  }>
  toolEvents: Array<{ tool: string; status: string; detail: string | null }>
}

export interface KnowledgeLintIssue {
  id: string
  path: string
  severity: 'error' | 'warning' | 'info' | string
  message: string
  missingTitle: string | null
}

export interface KnowledgeSettings {
  retrievalMode: string
  embeddingEnabled: boolean
  llmConfigured: boolean
  clipServerStatus: string
  sourceWatch: {
    enabled: boolean
    autoIngest: boolean
    maxFileSizeMb: number
  }
  api: {
    loopbackOnly: boolean
    tokenConfigured: boolean
    mcpEnabled: boolean
  }
}

export interface ManagedKnowledgeProject {
  id: string
  name: string
  current: boolean
}

export async function createManagedKnowledgeProject(name: string): Promise<ManagedKnowledgeProject> {
  const result = record(await request<unknown>('/api/knowledge/workspace', {
    method: 'POST',
    body: JSON.stringify({ name: name.trim() }),
  }))
  const project = record(result.project)
  return {
    id: string(project.id),
    name: string(project.name),
    current: project.current === true,
  }
}

function normalizeNode(value: unknown): KnowledgeFileNode {
  const item = record(value)
  return {
    name: string(item.name, 'Untitled'),
    path: string(item.path).replace(/\\/g, '/'),
    isDir: item.isDir === true || item.is_dir === true,
    size: item.size === null || item.size === undefined ? null : number(item.size),
    children: array(item, 'children').map(normalizeNode),
  }
}

function normalizeLink(value: unknown): KnowledgePageLink {
  const item = record(value)
  return {
    title: string(item.title, 'Untitled'),
    path: nullableString(item.path),
    snippet: nullableString(item.snippet),
  }
}

function normalizeReview(value: unknown): KnowledgeReview {
  const item = record(value)
  return {
    id: string(item.id),
    title: string(item.title, 'Review item'),
    type: string(item.type, 'review'),
    resolved: item.resolved === true,
    description: nullableString(item.description ?? item.message ?? item.detail),
    createdAt: nullableString(item.createdAt ?? item.created_at),
    options: Array.isArray(item.options) ? item.options : [],
    raw: item,
  }
}

export async function listKnowledgeFiles(root: 'wiki' | 'sources' = 'wiki'): Promise<KnowledgeFileNode[]> {
  const result = await request<unknown>(`/api/knowledge/files?root=${root}`)
  return array(result, 'files').map(normalizeNode)
}

export async function fetchKnowledgeFile(path: string): Promise<KnowledgeFileContent> {
  const result = record(await request<unknown>(`/api/knowledge/files/content?path=${encodeURIComponent(path)}`))
  return {
    path: string(result.path, path),
    content: string(result.content),
    revision: string(result.revision),
  }
}

export async function saveKnowledgeFile(path: string, content: string, ifMatch?: string): Promise<string> {
  const result = record(await request<unknown>('/api/knowledge/files/write', {
    method: 'POST',
    body: JSON.stringify({ path, content, ifMatch }),
  }))
  return string(result.revision)
}

export async function deleteKnowledgeFile(path: string, ifMatch?: string): Promise<void> {
  await request<unknown>('/api/knowledge/files/delete', {
    method: 'POST',
    body: JSON.stringify({ path, ifMatch }),
  })
}

export async function createMissingKnowledgePage(title: string, content?: string): Promise<KnowledgeFileContent> {
  const result = record(await request<unknown>('/api/knowledge/files/create-missing', {
    method: 'POST',
    body: JSON.stringify({ title, content }),
  }))
  return {
    path: string(result.path),
    content: string(result.content),
    revision: string(result.revision),
  }
}

export async function listKnowledgeFileHistory(path: string): Promise<KnowledgeFileHistoryEntry[]> {
  const result = await request<unknown>(`/api/knowledge/files/history?path=${encodeURIComponent(path)}`)
  return array(result, 'entries').map((value) => {
    const item = record(value)
    return {
      id: string(item.id),
      timestamp: number(item.timestamp),
      author: string(item.author, 'unknown'),
      tool: string(item.tool, 'unknown'),
      content: string(item.content),
    }
  })
}

export async function restoreKnowledgeFileHistory(path: string, entryId: string): Promise<KnowledgeFileContent> {
  const result = record(await request<unknown>('/api/knowledge/files/restore', {
    method: 'POST',
    body: JSON.stringify({ path, entryId }),
  }))
  return {
    path: string(result.path, path),
    content: string(result.content),
    revision: string(result.revision),
  }
}

export async function fetchKnowledgePageLinks(path: string): Promise<KnowledgePageLinks> {
  const result = record(await request<unknown>(`/api/knowledge/files/links?path=${encodeURIComponent(path)}`))
  const links = record(result.links)
  return {
    outgoing: array(links, 'outgoing').map(normalizeLink),
    backlinks: array(links, 'backlinks').map(normalizeLink),
    missing: array(links, 'missing').map(normalizeLink),
  }
}

export async function listKnowledgeReviews(status: 'unresolved' | 'resolved' | 'all' = 'unresolved'): Promise<KnowledgeReview[]> {
  const result = await request<unknown>(`/api/knowledge/reviews?status=${status}`)
  return array(result, 'reviews').map(normalizeReview)
}

export async function updateKnowledgeReview(id: string, resolved: boolean, action?: string): Promise<void> {
  await request<unknown>(`/api/knowledge/reviews/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify({ resolved, action }),
  })
}

export async function resolveKnowledgeReviews(ids: string[]): Promise<void> {
  await request<unknown>('/api/knowledge/reviews/resolve', {
    method: 'POST',
    body: JSON.stringify({ ids }),
  })
}

export async function rescanKnowledgeSources(): Promise<void> {
  await request<unknown>('/api/knowledge/sources/rescan', { method: 'POST' })
}

export async function listTrustedKnowledgeSources(): Promise<TrustedKnowledgeSource[]> {
  const result = await request<unknown>('/api/knowledge/sources')
  return array(result, 'sources').map((value) => {
    const item = record(value)
    return {
      sourceId: string(item.sourceId ?? item.source_id),
      filename: string(item.filename),
      sourceKind: string(item.sourceKind ?? item.source_kind, 'source'),
      pagePaths: array(item, 'pagePaths').map(value => string(value)).filter(Boolean),
      revision: number(item.revision),
      trustedAt: nullableString(item.trustedAt ?? item.trusted_at),
      title: nullableString(item.title),
      authors: array(item, 'authors').map(value => string(value)).filter(Boolean),
      year: item.year === null || item.year === undefined ? null : number(item.year),
    }
  })
}

export async function listKnowledgeSkills(): Promise<KnowledgeSkill[]> {
  const result = await request<unknown>('/api/knowledge/skills')
  return array(result, 'skills').map((value) => {
    const item = record(value)
    return {
      id: string(item.id),
      name: string(item.name, string(item.id)),
      description: string(item.description),
      source: string(item.source, 'project'),
    }
  })
}

export async function listKnowledgeChatSessions(): Promise<KnowledgeChatSession[]> {
  const result = await request<unknown>('/api/knowledge/chat/sessions')
  return array(result, 'sessions').map((value) => {
    const item = record(value)
    return {
      id: string(item.id),
      title: string(item.title, 'New conversation'),
      updatedAt: number(item.updatedAt ?? item.updated_at),
      messageCount: number(item.messageCount ?? item.message_count),
    }
  })
}

export async function fetchKnowledgeChatSession(id: string): Promise<KnowledgeChatMessage[]> {
  const result = record(await request<unknown>(`/api/knowledge/chat/sessions/${encodeURIComponent(id)}`))
  const session = record(result.session)
  return array(session, 'messages').map((value) => {
    const item = record(value)
    return {
      role: string(item.role, 'assistant'),
      content: string(item.content),
      timestamp: item.timestamp === undefined ? undefined : number(item.timestamp),
    }
  })
}

export async function sendKnowledgeChat(input: {
  message: string
  sessionId?: string
  mode?: 'fast' | 'standard' | 'deep' | 'local_first'
  webSearch?: boolean
  skills?: string[]
}): Promise<KnowledgeChatResponse> {
  const result = record(await request<unknown>('/api/knowledge/chat', {
    method: 'POST',
    body: JSON.stringify({ ...input, persistSession: true }),
  }))
  const assistant = record(result.message)
  return {
    sessionId: string(result.sessionId ?? result.session_id),
    content: string(assistant.content ?? result.message ?? result.content),
    references: array(result, 'references').map((value) => {
      const item = record(value)
      return {
        title: string(item.title, 'Reference'),
        path: string(item.path),
        kind: string(item.kind, 'wiki'),
        snippet: nullableString(item.snippet),
        score: item.score === undefined || item.score === null ? null : number(item.score),
      }
    }),
    toolEvents: array(result, 'toolEvents').map((value) => {
      const item = record(value)
      return {
        tool: string(item.tool),
        status: string(item.status),
        detail: nullableString(item.detail),
      }
    }),
  }
}

export async function stageGeneratedKnowledgeDraft(title: string, targetPath: string, content: string): Promise<void> {
  await request<unknown>('/api/knowledge/generated-drafts', {
    method: 'POST',
    body: JSON.stringify({ title, targetPath, content }),
  })
}

export async function fetchKnowledgeLint(): Promise<{ pages: number; issues: KnowledgeLintIssue[] }> {
  const result = record(await request<unknown>('/api/knowledge/lint'))
  return {
    pages: number(result.pages),
    issues: array(result, 'issues').map((value) => {
      const item = record(value)
      return {
        id: string(item.id),
        path: string(item.path),
        severity: string(item.severity, 'info'),
        message: string(item.message),
        missingTitle: nullableString(item.missingTitle ?? item.missing_title),
      }
    }),
  }
}

export async function fetchKnowledgeSettings(): Promise<KnowledgeSettings> {
  const result = record(await request<unknown>('/api/knowledge/settings'))
  const sourceWatch = record(result.sourceWatch ?? result.source_watch)
  const api = record(result.api)
  return {
    retrievalMode: string(result.retrievalMode ?? result.retrieval_mode, 'keyword_graph'),
    embeddingEnabled: result.embeddingEnabled === true || result.embedding_enabled === true,
    llmConfigured: result.llmConfigured === true || result.llm_configured === true,
    clipServerStatus: string(result.clipServerStatus ?? result.clip_server_status, 'unknown'),
    sourceWatch: {
      enabled: sourceWatch.enabled === true,
      autoIngest: sourceWatch.autoIngest === true || sourceWatch.auto_ingest === true,
      maxFileSizeMb: number(sourceWatch.maxFileSizeMb ?? sourceWatch.max_file_size_mb),
    },
    api: {
      loopbackOnly: api.loopbackOnly === true || api.loopback_only === true,
      tokenConfigured: api.tokenConfigured === true || api.token_configured === true,
      mcpEnabled: api.mcpEnabled === true || api.mcp_enabled === true,
    },
  }
}

export async function rebuildKnowledgeIndex(): Promise<{ pages: number; groups: number }> {
  const result = record(await request<unknown>('/api/knowledge/maintenance/rebuild-index', { method: 'POST' }))
  const summary = record(result.result)
  return { pages: number(summary.pages), groups: number(summary.groups) }
}
