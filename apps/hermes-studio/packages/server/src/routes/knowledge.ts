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
  const question = typeof body.question === 'string' ? body.question.trim() : ''
  if (!question) {
    ctx.status = 400
    ctx.body = { error: 'question_required' }
    return
  }
  if (question.length > 8_000) {
    ctx.status = 413
    ctx.body = { error: 'question_too_long' }
    return
  }
  try {
    ctx.body = await llmWikiJson(
      '/projects/current/chat',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: question,
          mode: 'local_first',
          retrievalMode: 'smart',
          tools: { wiki: true, web: false, anytxt: false },
          topK: 8,
          includeContent: false,
          history: [],
          historyExplicit: true,
          skills: [],
          persistSession: false,
          // Studio knowledge Q&A is a retrieval surface. The browser cannot
          // override this boundary or enable any LLM Wiki mutation tools.
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
