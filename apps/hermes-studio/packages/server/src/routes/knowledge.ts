import Router from '@koa/router'
import type { Context } from 'koa'
import { Readable } from 'node:stream'
import {
  LlmWikiApiError,
  knowledgeSummary,
  llmWikiJson,
  llmWikiRaw,
  publicKnowledgeErrorMessage,
  uploadDraft,
} from '../services/knowledge/llm-wiki-client'

export const knowledgeRoutes = new Router()

export function publicErrorMessage(error: LlmWikiApiError): string {
  return publicKnowledgeErrorMessage(error)
}

function setProxyError(ctx: Context, error: unknown): void {
  if (error instanceof LlmWikiApiError) {
    ctx.status = error.status
    ctx.body = { error: publicErrorMessage(error) }
    return
  }
  ctx.status = 500
  ctx.body = { error: 'Knowledge service request failed' }
}

function cleanFilename(ctx: Context): string {
  const raw = ctx.get('x-filename')
  let decoded = raw
  try { decoded = decodeURIComponent(raw) } catch { /* keep raw */ }
  const name = decoded.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim()
  if (!name || !name.toLowerCase().endsWith('.pdf')) throw new LlmWikiApiError('Only PDF uploads are accepted', 415)
  return name.slice(0, 180)
}

function cleanProjectRelativePath(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const path = value.replace(/\\/g, '/').replace(/^\/+/, '').trim()
  if (!path || path.length > 600 || path.split('/').some(part => !part || part === '.' || part === '..')) return null
  return path
}

function publicProject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object') return null
  const project = value as Record<string, unknown>
  const id = typeof project.id === 'string' ? project.id : ''
  const name = typeof project.name === 'string' ? project.name : ''
  if (!id || !name) return null
  return { id, name, current: project.current === true }
}

function compactSkillIds(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((item): item is string => typeof item === 'string')
    .map(item => item.trim())
    .filter(item => /^[A-Za-z0-9._-]{1,96}$/.test(item))
    .slice(0, 20)
}

async function withCurrentWikiContent(payload: any): Promise<any> {
  const proposal = payload?.proposal
  const changes = Array.isArray(proposal?.changes) ? proposal.changes : null
  if (!changes) return payload

  const enriched = await Promise.all(changes.map(async (change: any) => {
    const operation = String(change?.operation || '').toLowerCase()
    const path = typeof change?.path === 'string' ? change.path.replace(/\\/g, '/') : ''
    if (operation === 'create' || !path.startsWith('wiki/') || path.split('/').includes('..')) {
      return change
    }
    try {
      const current = await llmWikiJson<Record<string, unknown>>(
        `/projects/current/files/content?path=${encodeURIComponent(path)}`,
      )
      return {
        ...change,
        previousContent: typeof current.content === 'string' ? current.content : '',
      }
    } catch {
      // A missing current page is represented as an empty comparison pane.
      return { ...change, previousContent: '' }
    }
  }))

  return { ...payload, proposal: { ...proposal, changes: enriched } }
}

knowledgeRoutes.get('/api/knowledge/summary', async (ctx: Context) => {
  ctx.body = await knowledgeSummary()
})

knowledgeRoutes.get('/api/knowledge/workspace', async (ctx: Context) => {
  try {
    const [projects, health] = await Promise.all([
      llmWikiJson<Record<string, unknown>>('/projects'),
      llmWikiJson<Record<string, unknown>>('/health'),
    ])
    const projectItems = Array.isArray(projects.projects)
      ? projects.projects.map(publicProject).filter((project): project is Record<string, unknown> => project !== null)
      : []
    const currentProject = publicProject(projects.currentProject)
      || projectItems.find(project => project.current === true)
      || null
    ctx.body = {
      ok: projects.ok !== false,
      projects: projectItems,
      currentProject,
      service: {
        status: health.status || 'unknown',
        version: health.version || null,
        retrievalMode: health.retrievalMode || health.retrieval_mode || null,
        studioManaged: health.studioManaged === true,
        llmConfigured: health.llmConfigured === true,
        llmConfigSource: health.llmConfigSource || health.llm_config_source || 'none',
        clipServerStatus: health.clipServerStatus || health.clip_server_status || 'unknown',
      },
    }
  } catch (error) {
    setProxyError(ctx, error)
  }
})

knowledgeRoutes.post('/api/knowledge/workspace', async (ctx: Context) => {
  const body = (ctx.request as any).body || {}
  const name = typeof body.name === 'string' ? body.name.trim() : ''
  if (!name || name.length > 160) {
    ctx.status = 400
    ctx.body = { error: 'project_name_required' }
    return
  }
  try {
    const payload = await llmWikiJson<Record<string, unknown>>('/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    })
    ctx.body = {
      ok: payload.ok !== false,
      project: publicProject(payload.project),
    }
  } catch (error) {
    setProxyError(ctx, error)
  }
})

knowledgeRoutes.post('/api/knowledge/workspace/select', async (ctx: Context) => {
  const body = (ctx.request as any).body || {}
  const projectId = typeof body.projectId === 'string' ? body.projectId.trim() : ''
  if (!projectId) {
    ctx.status = 400
    ctx.body = { error: 'project_id_required' }
    return
  }
  try {
    ctx.body = await llmWikiJson('/projects/current/select', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId }),
    })
  } catch (error) {
    setProxyError(ctx, error)
  }
})

knowledgeRoutes.get('/api/knowledge/drafts', async (ctx: Context) => {
  try { ctx.body = await llmWikiJson('/projects/current/ingest-drafts') } catch (error) { setProxyError(ctx, error) }
})

knowledgeRoutes.post('/api/knowledge/drafts', async (ctx: Context) => {
  try {
    const contentType = ctx.get('content-type').toLowerCase()
    if (contentType !== 'application/pdf' && contentType !== 'application/octet-stream') {
      throw new LlmWikiApiError('Upload the PDF as the raw request body', 415)
    }
    const lengthHeader = ctx.get('content-length')
    const length = lengthHeader ? Number(lengthHeader) : undefined
    ctx.body = await uploadDraft(ctx.req, cleanFilename(ctx), Number.isFinite(length) ? length : undefined)
    ctx.status = 202
  } catch (error) {
    setProxyError(ctx, error)
  }
})

knowledgeRoutes.get('/api/knowledge/drafts/:id', async (ctx: Context) => {
  try {
    const payload = await llmWikiJson(`/projects/current/ingest-drafts/${encodeURIComponent(ctx.params.id)}`)
    ctx.body = await withCurrentWikiContent(payload)
  } catch (error) {
    setProxyError(ctx, error)
  }
})

for (const action of ['approve', 'revise', 'reject'] as const) {
  knowledgeRoutes.post(`/api/knowledge/drafts/:id/${action}`, async (ctx: Context) => {
    try {
      ctx.body = await llmWikiJson(
        `/projects/current/ingest-drafts/${encodeURIComponent(ctx.params.id)}/${action}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify((ctx.request as any).body || {}),
        },
      )
    } catch (error) {
      setProxyError(ctx, error)
    }
  })
}

knowledgeRoutes.get('/api/knowledge/search', async (ctx: Context) => {
  const query = String(ctx.query.q || '').trim()
  if (!query) {
    ctx.status = 400
    ctx.body = { error: 'query_required' }
    return
  }
  try {
    const payload = await llmWikiJson<Record<string, any>>('/projects/current/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, topK: 10, includeContent: false, trustedOnly: true }),
    })
    const results = Array.isArray(payload.results) ? payload.results : []
    for (const result of results) {
      if (!result || typeof result !== 'object') continue
      const locator = result.evidenceLocator || result.evidence_locator
      const sourceId = result.sourceId || result.source_id || locator?.sourceId || locator?.source_id
      const page = Number(locator?.page) || 1
      if (typeof sourceId === 'string' && sourceId) {
        result.sourceUrl = `/api/knowledge/sources/${encodeURIComponent(sourceId)}/pdf?page=${page}`
      }
    }
    ctx.body = payload
  } catch (error) {
    setProxyError(ctx, error)
  }
})

knowledgeRoutes.post('/api/knowledge/chat', async (ctx: Context) => {
  const body = (ctx.request as any).body || {}
  const message = typeof body.message === 'string'
    ? body.message.trim()
    : typeof body.question === 'string' ? body.question.trim() : ''
  if (!message) {
    ctx.status = 400
    ctx.body = { error: 'message_required' }
    return
  }
  if (message.length > 8_000) {
    ctx.status = 413
    ctx.body = { error: 'message_too_long' }
    return
  }
  const requestedMode = body.mode === 'fast' || body.mode === 'standard' || body.mode === 'deep' || body.mode === 'local_first'
    ? body.mode
    : 'local_first'
  const sessionId = typeof body.sessionId === 'string' && /^[A-Za-z0-9._-]{1,128}$/.test(body.sessionId)
    ? body.sessionId
    : undefined
  const persistSession = body.persistSession === true
  // Web search is available only for an explicit Deep Research turn. Wiki
  // chat remains local-first by default and never receives company data.
  const webSearch = requestedMode === 'deep' && body.webSearch === true
  try {
    ctx.body = await llmWikiJson(
      '/projects/current/chat',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message,
          sessionId,
          mode: requestedMode,
          retrievalMode: 'smart',
          tools: { wiki: true, web: webSearch, anytxt: false },
          topK: requestedMode === 'deep' ? 8 : 5,
          includeContent: requestedMode === 'deep',
          skills: compactSkillIds(body.skills),
          persistSession,
          // The Studio workbench is a retrieval and review surface. Generated
          // content must be explicitly staged into the strict draft gate;
          // browser chat may never write pages or execute processes.
          readOnly: true,
        }),
      },
      120_000,
    )
  } catch (error) {
    setProxyError(ctx, error)
  }
})

knowledgeRoutes.get('/api/knowledge/graph', async (ctx: Context) => {
  try { ctx.body = await llmWikiJson('/projects/current/graph?limit=500') } catch (error) { setProxyError(ctx, error) }
})

knowledgeRoutes.get('/api/knowledge/sources/:sourceId/pdf', async (ctx: Context) => {
  try {
    const page = Math.max(1, Number(ctx.query.page) || 1)
    const range = ctx.get('range')
    const response = await llmWikiRaw(
      `/projects/current/sources/${encodeURIComponent(ctx.params.sourceId)}/pdf?page=${page}`,
      { headers: range ? { Range: range } : undefined },
    )
    ctx.status = response.status
    for (const header of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'content-disposition']) {
      const value = response.headers.get(header)
      if (value) ctx.set(header, value)
    }
    ctx.set('Cache-Control', 'private, no-store')
    if (!response.body) {
      ctx.status = 502
      ctx.body = { error: 'LLM Wiki returned an empty PDF response' }
      return
    }
    ctx.body = Readable.fromWeb(response.body as any)
  } catch (error) {
    setProxyError(ctx, error)
  }
})

knowledgeRoutes.get('/api/knowledge/candidates', async (ctx: Context) => {
  try { ctx.body = await llmWikiJson('/projects/current/reading-candidates') } catch (error) { setProxyError(ctx, error) }
})

knowledgeRoutes.post('/api/knowledge/candidates', async (ctx: Context) => {
  const body = (ctx.request as any).body || {}
  const query = typeof body.query === 'string' ? body.query.trim() : ''
  if (!query) {
    ctx.status = 400
    ctx.body = { error: 'query_required' }
    return
  }
  try {
    ctx.body = await llmWikiJson('/projects/current/reading-candidates/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, providers: ['openalex', 'crossref', 'arxiv'] }),
    })
  } catch (error) {
    setProxyError(ctx, error)
  }
})

knowledgeRoutes.post('/api/knowledge/candidates/:id/dismiss', async (ctx: Context) => {
  try {
    ctx.body = await llmWikiJson(
      `/projects/current/reading-candidates/${encodeURIComponent(ctx.params.id)}/dismiss`,
      { method: 'POST' },
    )
  } catch (error) {
    setProxyError(ctx, error)
  }
})

knowledgeRoutes.get('/api/knowledge/files', async (ctx: Context) => {
  const root = ctx.query.root === 'sources' ? 'sources' : 'wiki'
  try {
    ctx.body = await llmWikiJson(`/projects/current/files?root=${root}&recursive=true&maxFiles=4000`)
  } catch (error) {
    setProxyError(ctx, error)
  }
})

knowledgeRoutes.get('/api/knowledge/files/content', async (ctx: Context) => {
  const path = cleanProjectRelativePath(ctx.query.path)
  if (!path) {
    ctx.status = 400
    ctx.body = { error: 'path_required' }
    return
  }
  try {
    ctx.body = await llmWikiJson(`/projects/current/files/content?path=${encodeURIComponent(path)}`)
  } catch (error) {
    setProxyError(ctx, error)
  }
})

knowledgeRoutes.post('/api/knowledge/files/write', async (ctx: Context) => {
  const body = (ctx.request as any).body || {}
  const path = cleanProjectRelativePath(body.path)
  const content = typeof body.content === 'string' ? body.content : null
  const ifMatch = typeof body.ifMatch === 'string' ? body.ifMatch.slice(0, 160) : undefined
  if (!path || content === null) {
    ctx.status = 400
    ctx.body = { error: 'path_and_content_required' }
    return
  }
  if (content.length > 2 * 1024 * 1024) {
    ctx.status = 413
    ctx.body = { error: 'content_too_large' }
    return
  }
  try {
    ctx.body = await llmWikiJson('/projects/current/files/write', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, content, ifMatch }),
    })
  } catch (error) {
    setProxyError(ctx, error)
  }
})

knowledgeRoutes.post('/api/knowledge/files/create-missing', async (ctx: Context) => {
  const body = (ctx.request as any).body || {}
  const title = typeof body.title === 'string' ? body.title.trim() : ''
  const content = typeof body.content === 'string' ? body.content : undefined
  if (!title || title.length > 800) {
    ctx.status = 400
    ctx.body = { error: 'title_required' }
    return
  }
  if (content && content.length > 2 * 1024 * 1024) {
    ctx.status = 413
    ctx.body = { error: 'content_too_large' }
    return
  }
  try {
    ctx.body = await llmWikiJson('/projects/current/files/create-missing', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, content }),
    })
  } catch (error) {
    setProxyError(ctx, error)
  }
})

knowledgeRoutes.get('/api/knowledge/files/history', async (ctx: Context) => {
  const path = cleanProjectRelativePath(ctx.query.path)
  if (!path) {
    ctx.status = 400
    ctx.body = { error: 'path_required' }
    return
  }
  try {
    ctx.body = await llmWikiJson(`/projects/current/files/history?path=${encodeURIComponent(path)}`)
  } catch (error) {
    setProxyError(ctx, error)
  }
})

knowledgeRoutes.post('/api/knowledge/files/restore', async (ctx: Context) => {
  const body = (ctx.request as any).body || {}
  const path = cleanProjectRelativePath(body.path)
  const entryId = typeof body.entryId === 'string' ? body.entryId.trim() : ''
  if (!path || !entryId || entryId.length > 160) {
    ctx.status = 400
    ctx.body = { error: 'path_and_entry_id_required' }
    return
  }
  try {
    ctx.body = await llmWikiJson('/projects/current/files/restore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, entryId }),
    })
  } catch (error) {
    setProxyError(ctx, error)
  }
})

knowledgeRoutes.post('/api/knowledge/files/delete', async (ctx: Context) => {
  const body = (ctx.request as any).body || {}
  const path = cleanProjectRelativePath(body.path)
  const ifMatch = typeof body.ifMatch === 'string' ? body.ifMatch.slice(0, 160) : undefined
  if (!path) {
    ctx.status = 400
    ctx.body = { error: 'path_required' }
    return
  }
  try {
    ctx.body = await llmWikiJson('/projects/current/files/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, ifMatch }),
    })
  } catch (error) {
    setProxyError(ctx, error)
  }
})

knowledgeRoutes.get('/api/knowledge/files/links', async (ctx: Context) => {
  const path = cleanProjectRelativePath(ctx.query.path)
  if (!path) {
    ctx.status = 400
    ctx.body = { error: 'path_required' }
    return
  }
  try {
    ctx.body = await llmWikiJson(`/projects/current/files/links?path=${encodeURIComponent(path)}`)
  } catch (error) {
    setProxyError(ctx, error)
  }
})

knowledgeRoutes.get('/api/knowledge/reviews', async (ctx: Context) => {
  const status = ['unresolved', 'resolved', 'all'].includes(String(ctx.query.status))
    ? String(ctx.query.status)
    : 'unresolved'
  const type = typeof ctx.query.type === 'string' ? ctx.query.type.slice(0, 80) : ''
  const limit = Math.min(500, Math.max(1, Number(ctx.query.limit) || 200))
  const query = new URLSearchParams({ status, limit: String(limit) })
  if (type) query.set('type', type)
  try {
    ctx.body = await llmWikiJson(`/projects/current/reviews?${query.toString()}`)
  } catch (error) {
    setProxyError(ctx, error)
  }
})

knowledgeRoutes.patch('/api/knowledge/reviews/:id', async (ctx: Context) => {
  const body = (ctx.request as any).body || {}
  const resolved = body.resolved === true || body.resolved === false ? body.resolved : undefined
  const action = typeof body.action === 'string' ? body.action.slice(0, 300) : undefined
  if (resolved === undefined) {
    ctx.status = 400
    ctx.body = { error: 'resolved_required' }
    return
  }
  try {
    ctx.body = await llmWikiJson(`/projects/current/reviews/${encodeURIComponent(ctx.params.id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resolved, action }),
    })
  } catch (error) {
    setProxyError(ctx, error)
  }
})

knowledgeRoutes.post('/api/knowledge/reviews/resolve', async (ctx: Context) => {
  const body = (ctx.request as any).body || {}
  const ids = Array.isArray(body.ids)
    ? body.ids.filter((id: unknown): id is string => typeof id === 'string' && id.length <= 160).slice(0, 500)
    : []
  if (!ids.length) {
    ctx.status = 400
    ctx.body = { error: 'review_ids_required' }
    return
  }
  try {
    ctx.body = await llmWikiJson('/projects/current/reviews/resolve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids, action: 'Resolved in Studio' }),
    })
  } catch (error) {
    setProxyError(ctx, error)
  }
})

knowledgeRoutes.get('/api/knowledge/sources', async (ctx: Context) => {
  try {
    ctx.body = await llmWikiJson('/projects/current/sources')
  } catch (error) {
    setProxyError(ctx, error)
  }
})

knowledgeRoutes.post('/api/knowledge/sources/rescan', async (ctx: Context) => {
  try {
    ctx.body = await llmWikiJson('/projects/current/sources/rescan', { method: 'POST' }, 120_000)
  } catch (error) {
    setProxyError(ctx, error)
  }
})

knowledgeRoutes.get('/api/knowledge/skills', async (ctx: Context) => {
  try {
    ctx.body = await llmWikiJson('/projects/current/skills')
  } catch (error) {
    setProxyError(ctx, error)
  }
})

knowledgeRoutes.get('/api/knowledge/settings', async (ctx: Context) => {
  try {
    ctx.body = await llmWikiJson('/projects/current/settings')
  } catch (error) {
    setProxyError(ctx, error)
  }
})

knowledgeRoutes.get('/api/knowledge/lint', async (ctx: Context) => {
  try {
    ctx.body = await llmWikiJson('/projects/current/lint', {}, 60_000)
  } catch (error) {
    setProxyError(ctx, error)
  }
})

knowledgeRoutes.post('/api/knowledge/maintenance/rebuild-index', async (ctx: Context) => {
  try {
    ctx.body = await llmWikiJson('/projects/current/maintenance/rebuild-index', { method: 'POST' }, 60_000)
  } catch (error) {
    setProxyError(ctx, error)
  }
})

knowledgeRoutes.get('/api/knowledge/chat/sessions', async (ctx: Context) => {
  try {
    ctx.body = await llmWikiJson('/projects/current/chat/sessions')
  } catch (error) {
    setProxyError(ctx, error)
  }
})

knowledgeRoutes.get('/api/knowledge/chat/sessions/:id', async (ctx: Context) => {
  try {
    ctx.body = await llmWikiJson(`/projects/current/chat/sessions/${encodeURIComponent(ctx.params.id)}`)
  } catch (error) {
    setProxyError(ctx, error)
  }
})

knowledgeRoutes.post('/api/knowledge/generated-drafts', async (ctx: Context) => {
  const body = (ctx.request as any).body || {}
  const title = typeof body.title === 'string' ? body.title.trim() : ''
  const targetPath = cleanProjectRelativePath(body.targetPath)
  const content = typeof body.content === 'string' ? body.content : ''
  if (!title || !targetPath || !content) {
    ctx.status = 400
    ctx.body = { error: 'title_target_path_and_content_required' }
    return
  }
  if (content.length > 2 * 1024 * 1024) {
    ctx.status = 413
    ctx.body = { error: 'content_too_large' }
    return
  }
  try {
    ctx.body = await llmWikiJson('/projects/current/generated-drafts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, targetPath, content }),
    })
  } catch (error) {
    setProxyError(ctx, error)
  }
})
