import Router from '@koa/router'
import type { Context } from 'koa'
import { knowledgeSummary } from '../services/knowledge/llm-wiki-client'
import { loadRecommendations, saveAgentRecommendations, triggerPaperRecommendationRefresh } from '../services/paper-recommender'
import { getHermesGatewayHealth, getModelHealth } from '../services/model-health'
import {
  addWechatSource,
  importDiscoveredWechatArticles,
  importWechatArticleLink,
  listWechatSources,
  removeWechatSource,
  syncWechatSources,
} from '../services/wechat-article-sync'
import { recordWechatDiscoveryRun } from '../services/wechat-article-discovery-job'

export const workbenchRoutes = new Router()

// Single-link WeChat import: paste one mp.weixin.qq.com/s/... URL and
// create a strict draft behind the same generated-drafts gate as PDF import.
// Rate-limited and SSRF-guarded (normalizeUrl + mp.weixin.qq.com/s allowlist),
// deduplicated via state.seen, and gated by the same score threshold.
const WECHAT_LINK_RATE = new Map<string, number[]>()
function allowWechatLink(ip: string): boolean {
  const now = Date.now()
  const windowMs = 60_000
  const maxInWindow = 6
  let hits = WECHAT_LINK_RATE.get(ip) ?? []
  hits = hits.filter((t) => now - t < windowMs)
  if (hits.length >= maxInWindow) return false
  hits.push(now)
  WECHAT_LINK_RATE.set(ip, hits)
  return true
}
workbenchRoutes.post('/api/workbench/wechat-import', async (ctx: Context) => {
  const ip = (ctx.ip || (ctx.request as { ip?: string }).ip || 'unknown').toString()
  if (!allowWechatLink(ip)) {
    ctx.status = 429
    ctx.body = { error: '操作过于频繁，请稍后再试' }
    return
  }
  try {
    const body = (ctx.request as { body?: unknown }).body as Record<string, unknown> | undefined
    const rawUrl = typeof body?.url === 'string' ? body.url : typeof body?.link === 'string' ? body.link : ''
    const sourceName = typeof body?.sourceName === 'string' ? body.sourceName : undefined
    const result = await importWechatArticleLink(rawUrl, sourceName)
    ctx.status = 201
    ctx.body = { draftId: result.draftId, title: result.title, url: result.url }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const isBadRequest =
      /仅支持|请输入合法|未提取到|相关度不足|已导入过|验证页/.test(message)
    ctx.status = isBadRequest ? 400 : 502
    ctx.body = { error: message }
  }
})

workbenchRoutes.get('/api/workbench/summary', async (ctx: Context) => {
  const knowledge = await knowledgeSummary()
  const hermes = getHermesGatewayHealth()
  const model = await getModelHealth()
  const modelStatus = !model.keyConfigured
    ? 'down'
    : model.probe.status === 'ok'
      ? 'ok'
      : model.probe.status === 'failed'
        ? 'degraded'
        : 'unknown'
  const modelDetailParts = [
    model.baseUrl ? `base_url=${model.baseUrl}` : 'base_url 未配置',
    model.model ? `模型 ${model.model}` : '模型未配置',
    model.keyMasked
      ? `API Key ${model.keyMasked}`
      : model.keyEnv
        ? `API Key 缺失（环境变量 ${model.keyEnv} 未设置）`
        : 'API Key 未配置',
  ]
  if (model.probe.status === 'ok') modelDetailParts.push('连通性测试通过')
  else if (model.probe.error) modelDetailParts.push(model.probe.error)
  ctx.body = {
    generatedAt: new Date().toISOString(),
    knowledge,
    paperRecommendations: loadRecommendations(),
    hermes,
    model,
    services: [
      { id: 'studio', name: 'Hermes Studio', status: 'ok' },
      {
        id: 'hermes-agent',
        name: 'Hermes Agent',
        status: hermes.running ? 'ok' : 'down',
        detail: hermes.running
          ? `gateway 运行中 · profile ${hermes.profile}（PID ${hermes.pid}）`
          : 'gateway 未运行，对话与定时任务不可用',
      },
      { id: 'llm-wiki', name: 'LLM Wiki', status: knowledge.serviceOk ? 'ok' : 'unavailable' },
      {
        id: 'model-provider',
        name: model.providerName ? `模型服务 · ${model.providerName}` : '模型服务',
        status: modelStatus,
        detail: modelDetailParts.join(' · '),
      },
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
  // 手动执行“论文推荐（本地知识库 · 顶会优先）”任务：
  // 后台触发 Hermes cron（agent 模式）+ 本地引擎兜底，立即返回 pending，前端轮询。
  ctx.body = await triggerPaperRecommendationRefresh()
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
