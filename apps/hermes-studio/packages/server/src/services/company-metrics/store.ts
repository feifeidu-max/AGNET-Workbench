import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'fs'
import { dirname, join, resolve } from 'path'
import { config } from '../../config'
import type { MetricReport, StoredSnapshot } from './types'

function defaultDatabasePath(): string {
  const override = process.env.AGNET_METRICS_DB_PATH?.trim()
  if (override) return resolve(override)
  const isTest = process.env.VITEST === 'true' || process.env.NODE_ENV === 'test'
  const base = isTest
    ? resolve(process.cwd(), 'packages/server/data/test-runtime')
    : process.env.NODE_ENV === 'production'
      ? config.appHome
      : resolve(process.cwd(), 'packages/server/data')
  return join(base, 'company-metrics.sqlite')
}

export class CompanyMetricsStore {
  private readonly db: DatabaseSync

  constructor(databasePath = defaultDatabasePath()) {
    mkdirSync(dirname(databasePath), { recursive: true })
    this.db = new DatabaseSync(databasePath)
    this.db.exec('PRAGMA journal_mode=WAL')
    this.db.exec('PRAGMA synchronous=NORMAL')
    this.db.exec('PRAGMA busy_timeout=5000')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS metric_snapshots (
        id TEXT PRIMARY KEY,
        as_of TEXT NOT NULL,
        fetched_at TEXT NOT NULL,
        connector_id TEXT NOT NULL,
        payload_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_metric_snapshots_as_of
        ON metric_snapshots(as_of DESC);
      CREATE TABLE IF NOT EXISTS metric_reports (
        id TEXT PRIMARY KEY,
        report_date TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL,
        generated_at TEXT NOT NULL,
        payload_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_metric_reports_date
        ON metric_reports(report_date DESC);
    `)
  }

  saveSnapshot(snapshot: StoredSnapshot): void {
    this.db.prepare(`
      INSERT INTO metric_snapshots (id, as_of, fetched_at, connector_id, payload_json)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        as_of = excluded.as_of,
        fetched_at = excluded.fetched_at,
        connector_id = excluded.connector_id,
        payload_json = excluded.payload_json
    `).run(snapshot.id, snapshot.asOf, snapshot.fetchedAt, snapshot.connectorId, JSON.stringify(snapshot))
  }

  latestSnapshot(beforeAsOf?: string): StoredSnapshot | null {
    const row = beforeAsOf
      ? this.db.prepare(`
          SELECT payload_json FROM metric_snapshots
          WHERE as_of < ? ORDER BY as_of DESC LIMIT 1
        `).get(beforeAsOf)
      : this.db.prepare('SELECT payload_json FROM metric_snapshots ORDER BY as_of DESC LIMIT 1').get()
    return this.parseSnapshot(row)
  }

  listSnapshots(limit = 30): StoredSnapshot[] {
    const safeLimit = Math.max(1, Math.min(366, Math.trunc(limit)))
    const rows = this.db.prepare(
      'SELECT payload_json FROM metric_snapshots ORDER BY as_of DESC LIMIT ?',
    ).all(safeLimit) as Array<Record<string, unknown>>
    return rows.map(row => this.parseSnapshot(row)).filter((value): value is StoredSnapshot => Boolean(value))
  }

  saveReport(report: MetricReport): void {
    this.db.prepare(`
      INSERT INTO metric_reports (id, report_date, status, generated_at, payload_json)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(report_date) DO UPDATE SET
        id = excluded.id,
        status = excluded.status,
        generated_at = excluded.generated_at,
        payload_json = excluded.payload_json
    `).run(report.id, report.reportDate, report.status, report.generatedAt, JSON.stringify(report))
  }

  reportByDate(reportDate: string): MetricReport | null {
    const row = this.db.prepare(
      'SELECT payload_json FROM metric_reports WHERE report_date = ?',
    ).get(reportDate)
    return this.parseReport(row)
  }

  listReports(limit = 30): MetricReport[] {
    const safeLimit = Math.max(1, Math.min(366, Math.trunc(limit)))
    const rows = this.db.prepare(
      'SELECT payload_json FROM metric_reports ORDER BY report_date DESC LIMIT ?',
    ).all(safeLimit) as Array<Record<string, unknown>>
    return rows.map(row => this.parseReport(row)).filter((value): value is MetricReport => Boolean(value))
  }

  close(): void {
    this.db.close()
  }

  private parseSnapshot(row: unknown): StoredSnapshot | null {
    if (!row || typeof row !== 'object') return null
    const payload = (row as Record<string, unknown>).payload_json
    if (typeof payload !== 'string') return null
    try { return JSON.parse(payload) as StoredSnapshot } catch { return null }
  }

  private parseReport(row: unknown): MetricReport | null {
    if (!row || typeof row !== 'object') return null
    const payload = (row as Record<string, unknown>).payload_json
    if (typeof payload !== 'string') return null
    try { return JSON.parse(payload) as MetricReport } catch { return null }
  }
}

