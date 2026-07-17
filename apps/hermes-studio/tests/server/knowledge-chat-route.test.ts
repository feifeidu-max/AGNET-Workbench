import Koa from 'koa'
import bodyParser from '@koa/bodyparser'
import { createServer, request as httpRequest, type Server as HttpServer } from 'node:http'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { knowledgeRoutes } from '../../packages/server/src/routes/knowledge'

function listen(server: HttpServer): Promise<string> {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('missing address')
    resolve(`http://127.0.0.1:${address.port}`)
  }))
}

function postJson(url: string, body: unknown): Promise<{ status: number, body: any }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body)
    const request = httpRequest(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    }, (response) => {
      const chunks: Buffer[] = []
      response.on('data', chunk => chunks.push(Buffer.from(chunk)))
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        resolve({ status: response.statusCode || 0, body: text ? JSON.parse(text) : null })
      })
    })
    request.on('error', reject)
    request.end(payload)
  })
}

describe('knowledge Wiki chat BFF', () => {
  let server: HttpServer
  let baseUrl: string
  let upstreamFetch: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    upstreamFetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ok: true,
      message: 'Local answer',
      references: [],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
    vi.stubGlobal('fetch', upstreamFetch)

    const app = new Koa()
    app.use(bodyParser())
    app.use(knowledgeRoutes.routes())
    server = createServer(app.callback())
    baseUrl = await listen(server)
  })

  afterEach(async () => {
    vi.unstubAllGlobals()
    await new Promise<void>(resolve => server.close(() => resolve()))
  })

  it('forces a stateless, local-only, read-only upstream request', async () => {
    const response = await postJson(`${baseUrl}/api/knowledge/chat`, {
      question: '  What does the approved Wiki say?  ',
      readOnly: false,
      tools: { web: true },
    })

    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({ message: 'Local answer' })
    expect(upstreamFetch).toHaveBeenCalledTimes(1)

    const [url, init] = upstreamFetch.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('http://127.0.0.1:19828/api/v1/projects/current/chat')
    expect(init.method).toBe('POST')
    expect(JSON.parse(String(init.body))).toEqual({
      message: 'What does the approved Wiki say?',
      mode: 'local_first',
      retrievalMode: 'smart',
      tools: { wiki: true, web: false, anytxt: false },
      topK: 8,
      includeContent: false,
      history: [],
      historyExplicit: true,
      skills: [],
      persistSession: false,
      readOnly: true,
    })
  })

  it('rejects empty and oversized questions before calling LLM Wiki', async () => {
    const empty = await postJson(`${baseUrl}/api/knowledge/chat`, { question: '   ' })
    const oversized = await postJson(`${baseUrl}/api/knowledge/chat`, { question: 'x'.repeat(8_001) })

    expect(empty).toEqual({ status: 400, body: { error: 'question_required' } })
    expect(oversized).toEqual({ status: 413, body: { error: 'question_too_long' } })
    expect(upstreamFetch).not.toHaveBeenCalled()
  })
})
