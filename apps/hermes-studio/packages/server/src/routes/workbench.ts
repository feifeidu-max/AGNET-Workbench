import Router from '@koa/router'
import type { Context } from 'koa'
import { knowledgeSummary } from '../services/knowledge/llm-wiki-client'
import { loadRecommendations, refreshRecommendations, saveAgentRecommendations } from '../services/paper-recommender'
import {
  addWechatSource,
  importDiscoveredWechatArticles,
  listWechatSources,
  removeWechatSource,
  syncWechatSources,
} from '../services/wechat-article-sync'
import { recordWechatDiscoveryRun } from '../services/wechat-article-discovery-job'

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

// 由 Hermes cron 任务（agent 模式）回写：基于知识库 wiki 联网检索后提交顶会论文列表。
workbenchRoutes.post('/api/workbench/paper-recommendations', async (ctx: Context) => {
  const body = (ctx.request as any)?.body as unknown
  const items = Array.isArray((body as any)?.items) ? ((body as any).items as unknown[]) : []
  ctx.body = saveAgentRecommendations(items)
})

workbenchRoutes.get('/api/workbench/wechat-sources', async (ctx: Context) => {
  ctx.body = { sources: listWechatSources() }
})

workbenchRoutes.post('/api/workbench/wechat-sources', async (ctx: Context) => {
  try {
    const source = addWechatSource((ctx.request as any)?.body || {})
    ctx.status = 201
    ctx.body = { source }
  } catch (error) {
    ctx.status = 400
    ctx.body = { error: error instanceof Error ? error.message : '来源配置无效' }
  }
})

workbenchRoutes.delete('/api/workbench/wechat-sources/:id', async (ctx: Context) => {
  if (!removeWechatSource(ctx.params.id)) {
    ctx.status = 404
    ctx.body = { error: '来源不存在' }
    return
  }
  ctx.body = { ok: true }
})

workbenchRoutes.post('/api/workbench/wechat-sources/sync', async (ctx: Context) => {
  try {
    const body = (ctx.request as any)?.body as Record<string, unknown> | undefined
    ctx.body = await syncWechatSources(typeof body?.sourceId === 'string' ? body.sourceId : undefined)
  } catch (error) {
    ctx.status = 502
    ctx.body = { error: error instanceof Error ? error.message : '公众号同步失败' }
  }
})

// Hermes cron 回写联网检索到的微信公众号文章链接；正文仍由 Studio 抓取、评分并进入 LLM Wiki 草稿审核。
workbenchRoutes.post('/api/workbench/wechat-discovery', async (ctx: Context) => {
  try {
    const body = (ctx.request as any)?.body as Record<string, unknown> | undefined
    const items = Array.isArray(body?.items) ? body.items : []
    const report = await importDiscoveredWechatArticles(items)
    const status = report.errors.length > 0
      ? (report.imported > 0 || report.skipped > 0 ? 'partial' : 'failed')
      : report.rejected > 0 ? 'partial' : 'success'
    recordWechatDiscoveryRun(status, report.errors[0] || null)
    ctx.body = report
  } catch (error) {
    recordWechatDiscoveryRun('failed', error instanceof Error ? error.message : '微信公众号文章导入失败')
    ctx.status = 502
    ctx.body = { error: error instanceof Error ? error.message : '微信公众号文章导入失败' }
  }
})
