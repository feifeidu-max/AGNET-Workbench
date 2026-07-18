export const knowledgeTabs = ['management', 'drafts', 'trusted', 'qa', 'candidates'] as const

export type KnowledgeTab = (typeof knowledgeTabs)[number]

/**
 * Keep the Studio's single LLM Wiki route stable while allowing direct links
 * to an individual management surface. Opening the route without a tab lands
 * on the management overview rather than hiding the service behind drafts.
 */
export function resolveKnowledgeTab(value: unknown): KnowledgeTab {
  const candidate = Array.isArray(value) ? value[0] : value
  if (typeof candidate === 'string' && knowledgeTabs.includes(candidate as KnowledgeTab)) {
    return candidate as KnowledgeTab
  }
  return 'management'
}
