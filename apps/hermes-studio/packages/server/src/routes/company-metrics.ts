import Router from '@koa/router'
import type { Context } from 'koa'
import { getCompanyMetricsService } from '../services/company-metrics/service'

export const companyMetricsRoutes = new Router()

companyMetricsRoutes.get('/api/company-metrics/summary', async (ctx: Context) => {
  ctx.body = await getCompanyMetricsService().summary()
})

companyMetricsRoutes.post('/api/company-metrics/refresh', async (ctx: Context) => {
  const report = await getCompanyMetricsService().runDailyReport(new Date(), true)
  ctx.status = report.status === 'success' ? 200 : 503
  ctx.body = report
})

companyMetricsRoutes.get('/api/company-metrics/reports', (ctx: Context) => {
  const requested = Number(ctx.query.limit || 30)
  ctx.body = { reports: getCompanyMetricsService().listReports(requested) }
})

companyMetricsRoutes.get('/api/company-metrics/reports/:date', (ctx: Context) => {
  const date = String(ctx.params.date || '')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    ctx.status = 400
    ctx.body = { error: 'invalid_report_date' }
    return
  }
  const report = getCompanyMetricsService().reportByDate(date)
  if (!report) {
    ctx.status = 404
    ctx.body = { error: 'report_not_found' }
    return
  }
  ctx.body = report
})

