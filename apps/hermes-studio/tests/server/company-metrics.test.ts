import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { CompanyMetricsStore } from '../../packages/server/src/services/company-metrics/store'
import { CompanyMetricsService, nextScheduledRun } from '../../packages/server/src/services/company-metrics/service'
import { MockMetricsConnector } from '../../packages/server/src/services/company-metrics/mock-connector'
import { shouldRunDailyReport } from '../../packages/server/src/services/company-metrics/scheduler'
import type { ConnectorHealth, MetricDefinition, MetricsConnector, MetricValue } from '../../packages/server/src/services/company-metrics/types'

const cleanup: string[] = []

afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true })
})

function createService(connector: MetricsConnector = new MockMetricsConnector()) {
  const dir = mkdtempSync(join(tmpdir(), 'agnet-metrics-'))
  cleanup.push(dir)
  const store = new CompanyMetricsStore(join(dir, 'metrics.sqlite'))
  return new CompanyMetricsService(store, connector)
}

describe('company metrics service', () => {
  it('creates one idempotent deterministic report per Shanghai date', async () => {
    const service = createService()
    const at = new Date('2026-07-16T01:30:00.000Z')
    const first = await service.runDailyReport(at)
    const second = await service.runDailyReport(new Date('2026-07-16T03:00:00.000Z'))

    expect(first.status).toBe('success')
    expect(first.reportDate).toBe('2026-07-16')
    expect(second.snapshotId).toBe(first.snapshotId)
    expect(service.listReports()).toHaveLength(1)
    expect(first.markdown).toContain('未调用任何大模型')
    expect(first.metrics).toHaveLength(5)
    service.close()
  })

  it('stores a failed report without falling back to stale values', async () => {
    const definitions: MetricDefinition[] = []
    const failing: MetricsConnector = {
      id: 'failing',
      async testConnection(): Promise<ConnectorHealth> {
        return { ok: false, connectorId: 'failing', checkedAt: new Date().toISOString(), message: 'offline' }
      },
      async listMetricDefinitions(): Promise<MetricDefinition[]> { return definitions },
      async fetchSnapshot(): Promise<MetricValue[]> { throw new Error('must not run') },
    }
    const service = createService(failing)
    const report = await service.runDailyReport(new Date('2026-07-16T01:00:00.000Z'))

    expect(report.status).toBe('failed')
    expect(report.snapshotId).toBeNull()
    expect(report.metrics).toEqual([])
    expect(report.markdown).toContain('未使用历史数据冒充当日结果')
    service.close()
  })

  it('marks a persistent threshold breach with a consecutive-run reason', async () => {
    const definition: MetricDefinition = {
      id: 'queue_depth',
      name: '队列深度',
      unit: '项',
      decimals: 0,
      betterDirection: 'lower',
      definitionVersion: 'test-v1',
      description: 'test',
      threshold: { warningAbove: 5, consecutiveAnomalyRuns: 2 },
    }
    const connector: MetricsConnector = {
      id: 'consecutive-test',
      async testConnection(): Promise<ConnectorHealth> {
        return { ok: true, connectorId: 'consecutive-test', checkedAt: new Date().toISOString() }
      },
      async listMetricDefinitions(): Promise<MetricDefinition[]> { return [definition] },
      async fetchSnapshot(asOf: Date): Promise<MetricValue[]> {
        return [{ metricId: definition.id, value: 8, asOf: asOf.toISOString(), sourceTimestamp: asOf.toISOString(), requestId: 'test' }]
      },
    }
    const service = createService(connector)
    const first = await service.runDailyReport(new Date('2026-07-13T01:00:00.000Z'))
    const second = await service.runDailyReport(new Date('2026-07-14T01:00:00.000Z'))

    expect(first.metrics[0].status).toBe('warning')
    expect(first.metrics[0].reasons).not.toContain('连续异常 2 次')
    expect(second.metrics[0].reasons).toContain('连续异常 2 次')
    service.close()
  })
})

describe('company report schedule', () => {
  it('runs after 09:00 Asia/Shanghai on weekdays only', () => {
    expect(shouldRunDailyReport(new Date('2026-07-16T00:59:00.000Z'))).toBe(false)
    expect(shouldRunDailyReport(new Date('2026-07-16T01:00:00.000Z'))).toBe(true)
    expect(shouldRunDailyReport(new Date('2026-07-18T02:00:00.000Z'))).toBe(false)
  })

  it('calculates the next weekday 09:00 run', () => {
    expect(nextScheduledRun(new Date('2026-07-17T02:00:00.000Z')).toISOString())
      .toBe('2026-07-20T01:00:00.000Z')
  })
})
