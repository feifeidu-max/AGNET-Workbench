import { describe, expect, it } from 'vitest'
import { publicErrorMessage } from '../../packages/server/src/routes/knowledge'
import {
  countTodayDrafts,
  LlmWikiApiError,
  publicKnowledgeErrorMessage,
} from '../../packages/server/src/services/knowledge/llm-wiki-client'

describe('knowledge BFF error boundary', () => {
  it('redacts local paths from client-visible validation errors', () => {
    const windows = publicErrorMessage(new LlmWikiApiError(
      'Could not read C:\\Users\\alice\\wiki\\paper.pdf',
      422,
    ))
    const unix = publicErrorMessage(new LlmWikiApiError(
      'Could not read /home/alice/wiki/paper.pdf',
      422,
    ))

    expect(windows).toContain('[local path omitted]')
    expect(windows).not.toContain('alice')
    expect(unix).toContain('[local path omitted]')
    expect(unix).not.toContain('/home/alice')
  })

  it('uses a fixed message for upstream server failures', () => {
    expect(publicErrorMessage(new LlmWikiApiError(
      'Failed in D:\\private\\staging with upstream diagnostics',
      500,
      { internalPath: 'D:\\private\\staging' },
    ))).toBe('LLM Wiki service request failed')
  })

  it('redacts paths from summary-level upstream errors too', () => {
    const message = publicKnowledgeErrorMessage(new Error('Failed to read C:\\Users\\alice\\wiki\\draft.json'))
    expect(message).toContain('[local path omitted]')
    expect(message).not.toContain('alice')
  })

  it('counts drafts by the Shanghai calendar day', () => {
    const now = new Date('2026-07-16T01:00:00.000Z')
    expect(countTodayDrafts([
      { createdAt: '2026-07-15T16:30:00.000Z' },
      { created_at: '2026-07-16T15:59:59.000Z' },
      { createdAt: '2026-07-16T16:00:00.000Z' },
      { createdAt: 'not-a-date' },
    ], now)).toBe(2)
  })
})
