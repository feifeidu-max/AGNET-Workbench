import type {
  ConnectorHealth,
  MetricDefinition,
  MetricsConnector,
  MetricValue,
} from './types'

const DEFINITIONS: MetricDefinition[] = [
  {
    id: 'business_volume',
    name: '业务处理量',
    unit: '笔',
    decimals: 0,
    betterDirection: 'higher',
    definitionVersion: 'demo-v1',
    description: '演示平台当日累计处理量。',
    threshold: { maxDailyChangePercent: 35 },
  },
  {
    id: 'completion_rate',
    name: '任务完成率',
    unit: '%',
    decimals: 1,
    betterDirection: 'higher',
    definitionVersion: 'demo-v1',
    description: '已完成任务占当日应完成任务的比例。',
    threshold: { warningBelow: 92, criticalBelow: 88 },
  },
  {
    id: 'exception_count',
    name: '异常数量',
    unit: '项',
    decimals: 0,
    betterDirection: 'lower',
    definitionVersion: 'demo-v1',
    description: '当前仍未关闭的异常记录数量。',
    threshold: { warningAbove: 5, criticalAbove: 10, consecutiveAnomalyRuns: 2 },
  },
  {
    id: 'average_duration',
    name: '平均处理时长',
    unit: '分钟',
    decimals: 1,
    betterDirection: 'lower',
    definitionVersion: 'demo-v1',
    description: '当日已完成任务的平均处理时长。',
    threshold: { warningAbove: 45, criticalAbove: 60 },
  },
  {
    id: 'availability',
    name: '平台可用率',
    unit: '%',
    decimals: 2,
    betterDirection: 'higher',
    definitionVersion: 'demo-v1',
    description: '按演示监控口径计算的平台可用率。',
    threshold: { warningBelow: 99.5, criticalBelow: 99 },
  },
]

function daySeed(date: Date): number {
  const day = Math.floor(date.getTime() / 86_400_000)
  return ((day * 9301 + 49297) % 233280) / 233280
}

export class MockMetricsConnector implements MetricsConnector {
  readonly id = 'mock-company-platform'

  async testConnection(): Promise<ConnectorHealth> {
    return {
      ok: true,
      connectorId: this.id,
      checkedAt: new Date().toISOString(),
      message: '使用脱敏模拟数据，尚未连接公司正式平台。',
    }
  }

  async listMetricDefinitions(): Promise<MetricDefinition[]> {
    return DEFINITIONS.map(definition => ({
      ...definition,
      threshold: { ...definition.threshold },
    }))
  }

  async fetchSnapshot(asOf: Date): Promise<MetricValue[]> {
    const seed = daySeed(asOf)
    const values: Record<string, number> = {
      business_volume: Math.round(960 + seed * 240),
      completion_rate: Number((91.5 + seed * 7).toFixed(1)),
      exception_count: Math.round(seed * 8),
      average_duration: Number((31 + seed * 18).toFixed(1)),
      availability: Number((99.2 + seed * 0.78).toFixed(2)),
    }
    const timestamp = asOf.toISOString()
    const requestId = `mock-${timestamp.slice(0, 10)}`
    return DEFINITIONS.map(definition => ({
      metricId: definition.id,
      value: values[definition.id],
      asOf: timestamp,
      sourceTimestamp: timestamp,
      requestId,
    }))
  }
}

export function mockMetricDefinitions(): MetricDefinition[] {
  return DEFINITIONS.map(definition => ({ ...definition, threshold: { ...definition.threshold } }))
}
