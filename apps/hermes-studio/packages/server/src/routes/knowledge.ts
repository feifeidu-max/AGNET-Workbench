import Router from '@koa/router'
import type { Context } from 'koa'
import { Readable } from 'node:stream'
import { join, resolve, sep } from 'path'
import { rm } from 'fs/promises'
import {
  LlmWikiApiError,
  knowledgeSummary,
  llmWikiJson,
  llmWikiRaw,
  publicKnowledgeErrorMessage,
  uploadDraft,
} from '../services/knowledge/llm-wiki-client'
import {
  bindMember,
  fetchQrcode,
  listMembers,
  pollQrcodeStatus,
  unbindMember,
} from '../services/wechat-members'

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

/**
 * 一键删除已入库的论文/文章：
 * 1) 通过 LLM-Wiki 文件删除接口移除其发布的 Wiki 页面（删除前自动留文件历史快照，可恢复）；
 * 2) 清理暂存目录中的草稿记录，使该草稿从审核队列移除。
 */
knowledgeRoutes.post('/api/knowledge/drafts/:id/remove', async (ctx: Context) => {
  const draftId = String(ctx.params.id || '').trim()
  if (!/^[0-9a-fA-F-]{8,64}$/.test(draftId)) {
    ctx.status = 400
    ctx.body = { error: 'invalid_draft_id' }
    return
  }
  try {
    const projects = await llmWikiJson<Record<string, unknown>>('/projects')
    const current = (projects.currentProject ?? (Array.isArray(projects.projects) ? projects.projects[0] : null)) as Record<string, unknown> | null
    const projectPath = typeof current?.path === 'string' ? current.path : ''
    if (!projectPath) {
      ctx.status = 409
      ctx.body = { error: '未找到当前知识库项目' }
      return
    }

    // 从草稿列表读取 publishedPages（不依赖 proposal.json，列表即含该字段）
    const list = await llmWikiJson<Record<string, unknown>>('/projects/current/ingest-drafts')
    const drafts = Array.isArray(list.drafts) ? (list.drafts as Record<string, unknown>[]) : []
    const draft = drafts.find((d) => String(d?.id ?? '') === draftId) as Record<string, unknown> | undefined
    if (!draft) {
      ctx.status = 404
      ctx.body = { error: 'draft_not_found' }
      return
    }
    const publishedPages = Array.isArray(draft.publishedPages)
      ? draft.publishedPages.filter((p): p is string => typeof p === 'string' && p.startsWith('wiki/') && p.endsWith('.md'))
      : []

    // 1) 删除已发布的 Wiki 页面
    const removedPages: string[] = []
    const failedPages: string[] = []
    for (const page of publishedPages) {
      try {
        await llmWikiJson('/projects/current/files/delete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: page }),
        })
        removedPages.push(page)
      } catch {
        failedPages.push(page)
      }
    }

    // 2) 清理暂存目录中的草稿记录（staging/<draftId>），使草稿从审核队列移除
    let stagingRemoved = false
    try {
      const stagingRoot = resolve(join(projectPath, '.llm-wiki', 'staging'))
      const target = resolve(join(stagingRoot, draftId))
      if (target.startsWith(stagingRoot + sep)) {
        await rm(target, { recursive: true, force: true })
        stagingRemoved = true
      }
    } catch {
      // 暂存清理失败不阻塞主流程
    }

    ctx.body = { ok: true, draftId, removedPages, failedPages, stagingRemoved }
  } catch (error) {
    setProxyError(ctx, error)
  }
})

knowledgeRoutes.get('/api/knowledge/search', async (ctx: Context) => {
  const query = String(ctx.query.q || '').trim()
  if (!query) {
    ctx.status = 400
    ctx.body = { error: 'query_required' }
    return
  }
  const rerank = String(ctx.query.rerank ?? '').toLowerCase() === 'true'
  try {
    const payload = await llmWikiJson<Record<string, any>>('/projects/current/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, topK: 10, includeContent: false, trustedOnly: true, rerank, rerankTopN: rerank ? 20 : undefined }),
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

// ---------------------------------------------------------------------------
// LLM 语义增强（知识库整理）：后台大模型对已入库文章做语义摘要、主题分类、
// 实体关系抽取，并为知识图谱生成更丰富的文章间关系标签。
// 启动接口立即返回（202），进度通过 /status 轮询；结果写入 LLM Wiki 项目的
// .llm-wiki/llm-enrichment.json 覆盖层，不改动任何已发布的 wiki 页面。
// ---------------------------------------------------------------------------

knowledgeRoutes.post('/api/knowledge/enrich', async (ctx: Context) => {
  const body = (ctx.request as any).body || {}
  const limit = Number.isFinite(Number(body.limit)) ? Number(body.limit) : undefined
  try {
    ctx.status = 202
    ctx.body = await llmWikiJson('/projects/current/enrich', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        limit,
        force: body.force === true,
        includeRelations: body.includeRelations !== false,
      }),
    }, 30_000)
  } catch (error) {
    setProxyError(ctx, error)
  }
})

knowledgeRoutes.get('/api/knowledge/enrich/status', async (ctx: Context) => {
  try { ctx.body = await llmWikiJson('/projects/current/enrich/status') } catch (error) { setProxyError(ctx, error) }
})

knowledgeRoutes.get('/api/knowledge/enrich', async (ctx: Context) => {
  try { ctx.body = await llmWikiJson('/projects/current/enrich') } catch (error) { setProxyError(ctx, error) }
})

// ---------------------------------------------------------------------------
// 微信多成员接入：每人扫码绑定专属 iLink bot，Studio 为其创建独立 hermes home
// 与专属网关进程；成员之间会话完全隔离，共享同一个本地知识库。
// ---------------------------------------------------------------------------

knowledgeRoutes.get('/api/knowledge/wechat/members', async (ctx: Context) => {
  try { ctx.body = await listMembers() } catch (error) { setProxyError(ctx, error) }
})

knowledgeRoutes.get('/api/knowledge/wechat/members/qr', async (ctx: Context) => {
  try { ctx.body = await fetchQrcode() } catch (error) { setProxyError(ctx, error) }
})

knowledgeRoutes.post('/api/knowledge/wechat/members/qr', async (ctx: Context) => {
  try { ctx.body = await fetchQrcode() } catch (error) { setProxyError(ctx, error) }
})

knowledgeRoutes.get('/api/knowledge/wechat/members/qr/status', async (ctx: Context) => {
  const qrcode = String(ctx.query.qrcode || '')
  if (!qrcode) { ctx.status = 400; ctx.body = { error: 'Missing qrcode parameter' }; return }
  try { ctx.body = await pollQrcodeStatus(qrcode) } catch (error) { setProxyError(ctx, error) }
})

knowledgeRoutes.post('/api/knowledge/wechat/members', async (ctx: Context) => {
  const body = (ctx.request as any).body || {}
  try {
    const member = await bindMember({
      displayName: typeof body.displayName === 'string' ? body.displayName : undefined,
      accountId: body.account_id || body.accountId,
      token: body.token,
      baseUrl: body.base_url || body.baseUrl,
    })
    ctx.status = 201
    // 延迟数秒让网关进程起来，前端稍后轮询列表即可看到 running 状态。
    ctx.body = { success: true, member }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    ctx.status = /上限/.test(message) ? 409 : 500
    ctx.body = { error: message }
  }
})

knowledgeRoutes.delete('/api/knowledge/wechat/members/:id', async (ctx: Context) => {
  const purge = String(ctx.query.purge || '') === '1'
  try {
    const removed = await unbindMember(ctx.params.id, { purge })
    if (!removed) { ctx.status = 404; ctx.body = { error: 'member_not_found' }; return }
    ctx.body = { success: true, purged: purge }
  } catch (error) { setProxyError(ctx, error) }
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

/**
 * Single-link WeChat article import via the same strict gate as PDF.
 * The link is fetched server-side, scored, de-duplicated and written as a
 * generated draft behind the review workflow — never directly as a trusted
 * wiki page. Exposed under /api/knowledge so the KnowledgeStudio BFF can
 * share auth/timeouts/error shapes with the rest of the wiki plane.
 */
const WECHAT_KNOWLEDGE_RATE = new Map<string, number[]>()
function allowWechatKnowledgeLink(ip: string): boolean {
  const now = Date.now()
  const windowMs = 60_000
  const maxInWindow = 6
  let hits = WECHAT_KNOWLEDGE_RATE.get(ip) ?? []
  hits = hits.filter((t) => now - t < windowMs)
  if (hits.length >= maxInWindow) return false
  hits.push(now)
  WECHAT_KNOWLEDGE_RATE.set(ip, hits)
  return true
}
knowledgeRoutes.post('/api/knowledge/wechat-import', async (ctx: Context) => {
  const ip = (ctx.ip || (ctx.request as { ip?: string }).ip || 'unknown').toString()
  if (!allowWechatKnowledgeLink(ip)) {
    ctx.status = 429
    ctx.body = { error: '操作过于频繁，请稍后再试' }
    return
  }
  try {
    const body = (ctx.request as any).body || {}
    const rawUrl = typeof body.url === 'string' ? body.url : typeof body.link === 'string' ? body.link : ''
    const sourceName = typeof body.sourceName === 'string' ? body.sourceName : undefined
    // Lazy import to avoid a static cycle between routes/knowledge and
    // services/wechat-article-sync (which also imports from knowledge/client).
    const { importWechatArticleLink } = await import('../services/wechat-article-sync')
    const result = await importWechatArticleLink(rawUrl, sourceName)
    ctx.status = 201
    ctx.body = { draftId: result.draftId, title: result.title, url: result.url }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const isBadRequest = /仅支持|请输入合法|未提取到|相关度不足|已导入过|验证页/.test(message)
    ctx.status = isBadRequest ? 400 : 502
    ctx.body = { error: message }
  }
})
