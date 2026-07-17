export type MetricStatus = 'normal' | 'warning' | 'critical' | 'unknown'

export interface MetricThresholdRule {
  warningBelow?: number
  criticalBelow?: number
  warningAbove?: number
  criticalAbove?: number
  maxDailyChangePercent?: number
  /** Require the threshold breach to persist for this many snapshots. */
  consecutiveAnomalyRuns?: number
}

export interface MetricDefinition {
  id: string
  name: string
  unit: string
  decimals: number
  betterDirection: 'higher' | 'lower' | 'neutral'
  definitionVersion: string
  description: string
  threshold: MetricThresholdRule
}

export interface MetricValue {
  metricId: string
  value: number
  asOf: string
  sourceTimestamp: string
  requestId: string
}

export interface ConnectorHealth {
  ok: boolean
  connectorId: string
  checkedAt: string
  message?: string
}

export interface MetricsConnector {
  readonly id: string
  testConnection(): Promise<ConnectorHealth>
  listMetricDefinitions(): Promise<MetricDefinition[]>
  fetchSnapshot(asOf: Date): Promise<MetricValue[]>
}

export interface StoredSnapshot {
  id: string
  asOf: string
  fetchedAt: string
  connectorId: string
  definitions: MetricDefinition[]
  values: MetricValue[]
}

export interface EvaluatedMetric {
  definition: MetricDefinition
  value: MetricValue
  previousValue: number | null
  changePercent: number | null
  status: MetricStatus
  reasons: string[]
}

export interface MetricReport {
  id: string
  reportDate: string
  status: 'success' | 'failed'
  snapshotId: string | null
  previousSnapshotId: string | null
  generatedAt: string
  anomalyCount: number
  title: string
  markdown: string
  metrics: EvaluatedMetric[]
  error: string | null
}
