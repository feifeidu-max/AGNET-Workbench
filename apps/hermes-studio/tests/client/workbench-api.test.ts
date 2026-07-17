// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

vi.mock('@/router', () => ({
  default: {
    currentRoute: { value: { name: 'hermes.knowledge' } },
    replace: vi.fn(),
  },
}))

import {
  askTrustedKnowledge,
  fetchKnowledgeDraftDetail,
  listKnowledgeDrafts,
  searchReadingCandidates,
  searchTrustedKnowledge,
} from '../../packages/client/src/api/workbench'
import { setApiKey } from '../../packages/client/src/api/client'

function response(body: unknown) {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  }
}

describe('workbench knowledge API normalization', () => {
  beforeEach(() => {
    localStorage.clear()
    setApiKey('test-token')
    mockFetch.mockReset()
  })

  it('maps LLM Wiki paper metadata and draft change counts', async () => {
    mockFetch.mockResolvedValueOnce(response({
      drafts: [{
        id: 'draft-1',
        filename: 'paper.pdf',
        paperTitle: 'A Local-First Agent',
        paperAuthors: ['Alice Zhang', 'Bo Li'],
        publicationYear: 2026,
        proposedChangeCount: 2,
        status: 'awaiting_review',
      }],
    }))

    const drafts = await listKnowledgeDrafts()

    expect(drafts[0]).toEqual(expect.objectContaining({
      title: 'A Local-First Agent',
      authors: ['Alice Zhang', 'Bo Li'],
      year: 2026,
      changeCount: 2,
    }))
  })

  it('maps current/proposed page content and structured evidence locators', async () => {
    mockFetch.mockResolvedValueOnce(response({
      draft: { id: 'draft-1', filename: 'paper.pdf', status: 'awaiting_review' },
      proposal: {
        changes: [{
          path: 'wiki/papers/paper.md',
          operation: 'update',
          title: 'Paper',
          previousContent: '# Old',
          content: '# New',
          evidenceLocators: [{ sourceId: 'paper:123', revision: 2, page: 7, section: 'Results' }],
        }],
      },
      extractedTextPreview: '## Page 7\nResult text',
    }))

    const detail = await fetchKnowledgeDraftDetail('draft-1')

    expect(detail.changes[0].previousContent).toBe('# Old')
    expect(detail.changes[0].content).toBe('# New')
    expect(detail.changes[0].evidenceLocators[0]).toEqual(expect.objectContaining({
      sourceId: 'paper:123',
      revision: '2',
      page: 7,
    }))
  })

  it('uses locator metadata when trusted-search metadata is nested', async () => {
    mockFetch.mockResolvedValueOnce(response({
      results: [{
        id: 'result-1',
        title: 'Evidence page',
        snippet: 'Local evidence',
        sourceUrl: '/api/knowledge/sources/paper%3A123/pdf?page=4',
        evidenceLocator: { sourceId: 'paper:123', revision: 1, page: 4, authors: ['Chen'], year: 2025 },
      }],
    }))

    const results = await searchTrustedKnowledge('evidence')

    expect(results[0]).toEqual(expect.objectContaining({ authors: ['Chen'], year: 2025 }))
    expect(results[0].locator?.page).toBe(4)
    expect(results[0].sourceUrl).toBe('/api/knowledge/sources/paper%3A123/pdf?page=4&token=test-token#page=4')
  })

  it('maps external recommendation reasons without treating candidates as trusted', async () => {
    mockFetch.mockResolvedValueOnce(response({
      candidates: [{
        id: 'candidate-1',
        title: 'External paper',
        authors: ['Dana'],
        year: 2024,
        provider: 'openalex',
        recommendedReason: 'Fills a local evidence gap',
        status: 'candidate',
      }],
    }))

    const candidates = await searchReadingCandidates('local first')

    expect(candidates[0]).toEqual(expect.objectContaining({
      provider: 'openalex',
      reason: 'Fills a local evidence gap',
      status: 'candidate',
    }))
  })

  it('normalizes local-first Wiki answers and references', async () => {
    mockFetch.mockResolvedValueOnce(response({
      message: 'Approved local answer.',
      references: [{ title: 'Paper page', path: 'wiki/papers/paper.md', kind: 'wiki', score: 0.88 }],
    }))

    const answer = await askTrustedKnowledge('What did I read?')

    expect(answer.content).toBe('Approved local answer.')
    expect(answer.references).toEqual([
      expect.objectContaining({ title: 'Paper page', path: 'wiki/papers/paper.md', kind: 'wiki', score: 0.88 }),
    ])
    expect(JSON.parse(String(mockFetch.mock.calls[0][1]?.body))).toEqual({ question: 'What did I read?' })
  })

  it('keeps compatibility with object-shaped Wiki messages', async () => {
    mockFetch.mockResolvedValueOnce(response({
      message: { role: 'assistant', content: 'Legacy response shape.' },
      references: [],
    }))

    await expect(askTrustedKnowledge('legacy')).resolves.toEqual({
      content: 'Legacy response shape.',
      references: [],
    })
  })
})
