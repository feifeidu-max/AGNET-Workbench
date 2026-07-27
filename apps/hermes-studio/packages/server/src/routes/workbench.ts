import Router from '@koa/router'
import type { Context } from 'koa'
import { knowledgeSummary } from '../services/knowledge/llm-wiki-client'
import { loadRecommendations, refreshRecommendations } from '../services/paper-recommender'

export const workbenchRoutes = new Router()

workbenchRoutes.get('/api/workbench/summary', async (ctx: Context) => {
  const knowledge = await knowledgeSummary()
  ctx.body = {
    generatedAt: new Date().toISOString(),
    knowledge,
    paperRecommendations: loadRecommendations(),
    services: [
      { id: 'studio', name: 'Hermes Studio', status: 'ok' },
      { id: 'llm-wiki', name: 'LLM Wiki', status: knowledge.serviceOk ? 'ok' : 'unavailable' },
    ],
    dataBoundaries: {
      knowledge: 'public-papers-may-use-external-llm',
    },
  }
})

workbenchRoutes.get('/api/workbench/paper-recommendations', async (ctx: Context) => {
  ctx.body = loadRecommendations()
})

workbenchRoutes.post('/api/workbench/paper-recommendations/refresh', async (ctx: Context) => {
  ctx.body = await refreshRecommendations()
})
