import { randomUUID } from 'crypto'
import { CompanyMetricsStore } from './store'
import { MockMetricsConnector } from './mock-connector'
import type {
  EvaluatedMetric,
  MetricDefinition,
  MetricReport,
  MetricsConnector,
  MetricStatus,
  MetricValue,
  StoredSnapshot,
} from './types'

const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000

export function shanghaiDateKey(date: Date): string {
  return new Date(date.getTime() + SHANGHAI_OFFSET_MS).toISOString().slice(0, 10)
}

function evaluateMetric(
  definition: MetricDefinition,
  value: MetricValue,
  previousValue: number | null,
  previousSnapshots: StoredSnapshot[],
): EvaluatedMetric {
  const threshold = definition.threshold
  const reasons: string[] = []
  let status: MetricStatus = Number.isFinite(value.value) ? 'normal' : 'unknown'
  const critical = thresholdStatus(definition, value.value) === 'critical'
  const warning = thresholdStatus(definition, value.value) === 'warning'

  if (critical) {
    status = 'critical'
    reasons.push('超过严重阈值')
  } else if (warning) {
    status = 'warning'
    reasons.push('超过预警阈值')
  }

  const changePercent = previousValue !== null && previousValue !== 0
    ? ((value.value - previousValue) / Math.abs(previousValue)) * 100
    : null
  if (
    status === 'normal'
    && changePercent !== null
    && threshold.maxDailyChangePercent !== undefined
    && Math.abs(changePercent) > threshold.maxDailyChangePercent
  ) {
    status = 'warning'
    reasons.push(`日变化超过 ${threshold.maxDailyChangePercent}%`)
  }

  const requiredRuns = threshold.consecutiveAnomalyRuns
  if (requiredRuns !== undefined && requiredRuns > 1 && status !== 'unknown') {
    const consecutiveRuns = countConsecutiveThresholdBreaches(definition, value.value, previousSnapshots)
    if (consecutiveRuns >= Math.trunc(requiredRuns)) {
      if (status === 'normal') status = 'warning'
      reasons.push(`连续异常 ${consecutiveRuns} 次`)
    }
  }

  return {
    definition,
    value,
    previousValue,
    changePercent,
    status,
    reasons,
  }
}

function thresholdStatus(definition: MetricDefinition, value: number): MetricStatus {
  const threshold = definition.threshold
  if (
    (threshold.criticalBelow !== undefined && value < threshold.criticalBelow)
    || (threshold.criticalAbove !== undefined && value > threshold.criticalAbove)
  ) return 'critical'
  if (
    (threshold.warningBelow !== undefined && value < threshold.warningBelow)
    || (threshold.warningAbove !== undefined && value > threshold.warningAbove)
  ) return 'warning'
  return 'normal'
}

function countConsecutiveThresholdBreaches(
  definition: MetricDefinition,
  currentValue: number,
  previousSnapshots: StoredSnapshot[],
): number {
  let count = thresholdStatus(definition, currentValue) === 'normal' ? 0 : 1
  if (count === 0) return 0
  for (const snapshot of previousSnapshots) {
    const previous = snapshot.values.find((item) => item.metricId === definition.id)
    if (!previous || thresholdStatus(definition, previous.value) === 'normal') break
    count += 1
  }
  return count
}

function metricStatusLabel(status: MetricStatus): string {
  if (status === 'critical') return '严重'
  if (status === 'warning') return '预警'
  if (status === 'normal') return '正常'
  return '未知'
}

function renderValue(metric: EvaluatedMetric, value: number | null): string {
  if (value === null) return '-'
  return `${value.toFixed(metric.definition.decimals)} ${metric.definition.unit}`
}

function buildReportMarkdown(
  reportDate: string,
  generatedAt: string,
  metrics: EvaluatedMetric[],
): string {
  const lines = [
    '# 公司指标日报',
    '',
    `- 报告日期：${reportDate}`,
    `- 生成时间：${generatedAt}`,
    '- 数据来源：脱敏模拟连接器（未接入正式公司平台）',
    '',
    '| 指标 | 当前值 | 上一工作日 | 变化 | 状态 |',
    '| --- | ---: | ---: | ---: | --- |',
  ]
  for (const metric of metrics) {
    const change = metric.changePercent === null ? '-' : `${metric.changePercent >= 0 ? '+' : ''}${metric.changePercent.toFixed(1)}%`
    lines.push(`| ${metric.definition.name} | ${renderValue(metric, metric.value.value)} | ${renderValue(metric, metric.previousValue)} | ${change} | ${metricStatusLabel(metric.status)} |`)
  }
  const anomalies = metrics.filter(metric => metric.status === 'warning' || metric.status === 'critical')
  lines.push('', '## 异常摘要', '')
  if (anomalies.length === 0) {
    lines.push('当前未触发配置的确定性阈值。')
  } else {
    for (const metric of anomalies) {
      lines.push(`- ${metric.definition.name}：${metricStatusLabel(metric.status)}；${metric.reasons.join('；')}`)
    }
  }
  lines.push('', '> 本报告完全由本地规则生成，未调用任何大模型。')
  return `${lines.join('\n')}\n`
}

export class CompanyMetricsService {
  constructor(
    private readonly store = new CompanyMetricsStore(),
    private readonly connector: MetricsConnector = new MockMetricsConnector(),
  ) {}

  async runDailyReport(asOf = new Date(), force = false): Promise<MetricReport> {
    const reportDate = shanghaiDateKey(asOf)
    const existing = this.store.reportByDate(reportDate)
    if (existing && !force) return existing

    try {
      const health = await this.connector.testConnection()
      if (!health.ok) throw new Error(health.message || '公司数据连接器不可用')
      const [definitions, values] = await Promise.all([
        this.connector.listMetricDefinitions(),
        this.connector.fetchSnapshot(asOf),
      ])
      const valueById = new Map(values.map(value => [value.metricId, value]))
      const previousSnapshot = this.store.latestSnapshot(asOf.toISOString())
      const previousSnapshots = this.store
        .listSnapshots(31)
        .filter(snapshot => snapshot.asOf < asOf.toISOString())
      const previousById = new Map(previousSnapshot?.values.map(value => [value.metricId, value.value]) || [])
      const metrics = definitions.map(definition => {
        const value = valueById.get(definition.id)
        if (!value) throw new Error(`连接器未返回指标 ${definition.id}`)
        return evaluateMetric(definition, value, previousById.get(definition.id) ?? null, previousSnapshots)
      })
      const generatedAt = new Date().toISOString()
      const snapshot: StoredSnapshot = {
        id: `snapshot-${reportDate}-${randomUUID()}`,
        asOf: asOf.toISOString(),
        fetchedAt: generatedAt,
        connectorId: this.connector.id,
        definitions,
        values,
      }
      this.store.saveSnapshot(snapshot)
      const report: MetricReport = {
        id: `report-${reportDate}`,
        reportDate,
        status: 'success',
        snapshotId: snapshot.id,
        previousSnapshotId: previousSnapshot?.id || null,
        generatedAt,
        anomalyCount: metrics.filter(metric => metric.status === 'warning' || metric.status === 'critical').length,
        title: `${reportDate} 公司指标日报`,
        markdown: buildReportMarkdown(reportDate, generatedAt, metrics),
        metrics,
        error: null,
      }
      this.store.saveReport(report)
      return report
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const generatedAt = new Date().toISOString()
      const failed: MetricReport = {
        id: `report-${reportDate}`,
        reportDate,
        status: 'failed',
        snapshotId: null,
        previousSnapshotId: null,
        generatedAt,
        anomalyCount: 0,
        title: `${reportDate} 公司指标日报（采集失败）`,
        markdown: `# 公司指标日报\n\n数据采集失败：${message}\n\n> 未使用历史数据冒充当日结果。\n`,
        metrics: [],
        error: message,
      }
      this.store.saveReport(failed)
      return failed
    }
  }

  async summary() {
    const health = await this.connector.testConnection()
    const definitions = await this.connector.listMetricDefinitions()
    const snapshot = this.store.latestSnapshot()
    const reports = this.store.listReports(30)
    const latestReport = reports[0] || null
    return {
      connector: health,
      metricCount: definitions.length,
      definitions,
      snapshot,
      metrics: latestReport?.metrics || [],
      lastUpdated: snapshot?.fetchedAt || null,
      status: latestReport?.status || 'not_run',
      latestReport,
      nextRun: nextScheduledRun(new Date()).toISOString(),
      schedule: { weekdaysOnly: true, hour: 9, minute: 0, timezone: 'Asia/Shanghai' },
      dataBoundary: 'local-only-no-llm',
    }
  }

  listReports(limit = 30): MetricReport[] {
    return this.store.listReports(limit)
  }

  reportByDate(date: string): MetricReport | null {
    return this.store.reportByDate(date)
  }

  close(): void {
    this.store.close()
  }
}

export function nextScheduledRun(now: Date): Date {
  const local = new Date(now.getTime() + SHANGHAI_OFFSET_MS)
  const candidate = new Date(local)
  candidate.setUTCHours(9, 0, 0, 0)
  if (candidate.getTime() <= local.getTime()) candidate.setUTCDate(candidate.getUTCDate() + 1)
  while (candidate.getUTCDay() === 0 || candidate.getUTCDay() === 6) {
    candidate.setUTCDate(candidate.getUTCDate() + 1)
  }
  return new Date(candidate.getTime() - SHANGHAI_OFFSET_MS)
}

let singleton: CompanyMetricsService | null = null

export function getCompanyMetricsService(): CompanyMetricsService {
  if (!singleton) singleton = new CompanyMetricsService()
  return singleton
}

export function closeCompanyMetricsService(): void {
  singleton?.close()
  singleton = null
}
