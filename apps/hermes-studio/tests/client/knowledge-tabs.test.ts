import { describe, expect, it } from 'vitest'
import { resolveKnowledgeTab } from '@/views/hermes/knowledge-tabs'

describe('resolveKnowledgeTab', () => {
  it('opens the unified LLM Wiki management surface by default', () => {
    expect(resolveKnowledgeTab(undefined)).toBe('management')
    expect(resolveKnowledgeTab('unknown')).toBe('management')
  })

  it('keeps valid deep links within the one Studio knowledge route', () => {
    expect(resolveKnowledgeTab('drafts')).toBe('drafts')
    expect(resolveKnowledgeTab(['trusted', 'management'])).toBe('trusted')
  })
})
