import { beforeEach, describe, expect, it, vi } from 'vitest'

const { requestMock } = vi.hoisted(() => ({
  requestMock: vi.fn(),
}))

vi.mock('../src/api/client', () => ({
  request: requestMock,
}))

import {
  listCompanyReports,
  listKnowledgeDrafts,
  reviseKnowledgeDraft,
  searchReadingCandidates,
  uploadKnowledgePdf,
} from '../src/api/workbench'

describe('workbench API contract', () => {
  beforeEach(() => {
    requestMock.mockReset()
  })

  it('normalizes snake_case knowledge drafts for the UI', async () => {
    requestMock.mockResolvedValue({
      drafts: [{
        draft_id: 'draft-1',
        file_name: 'paper.pdf',
        title: 'Grid Resilience',
        status: 'awaiting_review',
        created_at: '2026-07-16T01:00:00Z',
        updated_at: '2026-07-16T02:00:00Z',
        authors: ['A. Chen'],
        year: 2026,
        addedPages: 2,
        modifiedPages: 1,
      }],
    })

    const drafts = await listKnowledgeDrafts()

    expect(requestMock).toHaveBeenCalledWith('/api/knowledge/drafts')
    expect(drafts).toEqual([expect.objectContaining({
      id: 'draft-1',
      fileName: 'paper.pdf',
      status: 'awaiting_review',
      additions: 2,
      modifications: 1,
    })])
  })

  it('uploads the raw PDF body with the filename header', async () => {
    requestMock.mockResolvedValue({
      draft: { id: 'draft-2', title: 'Paper', fileName: 'daily paper.pdf', status: 'uploaded' },
    })
    const file = new File(['%PDF-1.7'], 'daily paper.pdf', { type: 'application/pdf' })

    await uploadKnowledgePdf(file)

    expect(requestMock).toHaveBeenCalledWith('/api/knowledge/drafts', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/pdf',
        'X-Filename': 'daily%20paper.pdf',
      },
      body: file,
    })
  })

  it('uses guidance for revision and POST for candidate discovery', async () => {
    requestMock
      .mockResolvedValueOnce({ draft: { id: 'draft-3', title: 'Paper', status: 'revision_requested' } })
      .mockResolvedValueOnce({ candidates: [{ doi: '10.1/example', title: 'Candidate', source: 'Crossref' }] })

    await reviseKnowledgeDraft('draft/3', '核对第 7 页')
    const candidates = await searchReadingCandidates('新型电力系统')

    expect(requestMock).toHaveBeenNthCalledWith(1, '/api/knowledge/drafts/draft%2F3/revise', {
      method: 'POST',
      body: JSON.stringify({ guidance: '核对第 7 页' }),
    })
    expect(requestMock).toHaveBeenNthCalledWith(2, '/api/knowledge/candidates', {
      method: 'POST',
      body: JSON.stringify({ query: '新型电力系统' }),
    })
    expect(candidates[0]).toEqual(expect.objectContaining({
      id: '10.1/example',
      provider: 'Crossref',
    }))
  })

  it('normalizes report history response fields', async () => {
    requestMock.mockResolvedValue({
      reports: [{
        id: '2026-07-16',
        report_date: '2026-07-16',
        generated_at: '2026-07-16T01:00:00Z',
        status: 'success',
        metric_count: 5,
        abnormal_count: 1,
      }],
    })

    const reports = await listCompanyReports()

    expect(reports[0]).toEqual(expect.objectContaining({
      reportDate: '2026-07-16',
      metricCount: 5,
      abnormalCount: 1,
    }))
  })
})
