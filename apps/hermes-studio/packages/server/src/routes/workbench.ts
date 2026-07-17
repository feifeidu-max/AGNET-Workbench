import Router from '@koa/router'
import type { Context } from 'koa'
import { knowledgeSummary } from '../services/knowledge/llm-wiki-client'
import { getCompanyMetricsService } from '../services/company-metrics/service'

export const workbenchRoutes = new Router()

workbenchRoutes.get('/api/workbench/summary', async (ctx: Context) => {
  const [knowledge, company] = await Promise.all([
    knowledgeSummary(),
    getCompanyMetricsService().summary(),
  ])
  ctx.body = {
    generatedAt: new Date().toISOString(),
    knowledge,
    company: {
      metricCount: company.metricCount,
      lastUpdated: company.lastUpdated,
      status: company.status,
      anomalyCount: company.latestReport?.anomalyCount || 0,
    },
    reports: {
      nextRun: company.nextRun,
      lastStatus: company.latestReport?.status || 'not_run',
      lastReportDate: company.latestReport?.reportDate || null,
    },
    services: [
      { id: 'studio', name: 'Hermes Studio', status: 'ok' },
      { id: 'llm-wiki', name: 'LLM Wiki', status: knowledge.serviceOk ? 'ok' : 'unavailable' },
      { id: 'company-metrics', name: '公司指标', status: company.connector.ok ? 'ok' : 'unavailable' },
    ],
    dataBoundaries: {
      knowledge: 'public-papers-may-use-external-llm',
      company: 'local-only-no-llm',
    },
  }
})

