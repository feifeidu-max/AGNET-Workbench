import { logger } from '../logger'
import { getCompanyMetricsService, shanghaiDateKey } from './service'

const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000
const TICK_MS = 60_000

export function shouldRunDailyReport(now: Date): boolean {
  const local = new Date(now.getTime() + SHANGHAI_OFFSET_MS)
  const day = local.getUTCDay()
  if (day === 0 || day === 6) return false
  return local.getUTCHours() >= 9
}

export class CompanyMetricsScheduler {
  private timer: ReturnType<typeof setInterval> | null = null
  private running = false

  async tick(now = new Date()): Promise<void> {
    if (this.running || !shouldRunDailyReport(now)) return
    const service = getCompanyMetricsService()
    if (service.reportByDate(shanghaiDateKey(now))) return
    this.running = true
    try {
      const report = await service.runDailyReport(now)
      logger.info({ reportDate: report.reportDate, status: report.status }, '[company-metrics] daily report generated')
    } catch (error) {
      logger.error(error, '[company-metrics] scheduler tick failed')
    } finally {
      this.running = false
    }
  }

  start(): void {
    if (this.timer) return
    void this.tick()
    this.timer = setInterval(() => void this.tick(), TICK_MS)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }
}

const scheduler = new CompanyMetricsScheduler()

export function startCompanyMetricsScheduler(): void {
  scheduler.start()
}

export function stopCompanyMetricsScheduler(): void {
  scheduler.stop()
}

