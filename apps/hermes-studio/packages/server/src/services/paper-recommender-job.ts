/**
 * 将“论文推荐（本地知识库·顶会优先）”注册为 Hermes 的 cron 任务，
 * 使其出现在工作台 Jobs 页面（/#/hermes/jobs）。
 *
 * 设计：
 * - 真正的刷新由 studio 内置定时器（paper-recommender.schedulePaperRecommendations，
 *   每 6h）兜底执行，保证刷新一定会发生，不依赖 cron 守卫（cron tick）是否在运行。
 * - 本模块负责：(1) 在活跃 profile（及 default 兜底）的 cron/jobs.json 中“种入”
 *   该任务（幂等），使其在前台 Jobs 页面可见、可暂停/恢复/手动运行；
 *   (2) 每次刷新后回写该任务的运行元数据（last_run_at / last_status /
 *   run_count / last_error），让 Jobs 卡片显示真实运行历史。
 * - 任务以 no-agent 脚本方式定义（~/.hermes/scripts/refresh_paper_recommendations.py），
 *   若用户的 cron 守卫（hermes cron tick）在运行，也会由 cron 直接触发刷新。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { detectHermesRootHome } from './hermes/hermes-path'
import { getActiveProfileName, getProfileDir, listProfileNamesFromDisk } from './hermes/hermes-profile'

export const PAPER_RECOMMENDER_JOB_ID = 'paper-recommender-kb'
const JOB_SCRIPT_NAME = 'refresh_paper_recommendations.py'
const SCHEDULE = '0 */6 * * *' // 每 6 小时
const STUDIO_PORT = 8648

function jobScriptPath(): string {
  return join(detectHermesRootHome(), 'scripts', JOB_SCRIPT_NAME)
}

function cronJobsPathForProfile(profile: string): string {
  return join(getProfileDir(profile), 'cron', 'jobs.json')
}

function loadJobsFile(path: string): { raw: any; jobs: any[]; asArray: boolean } {
  if (!existsSync(path)) return { raw: { jobs: [] }, jobs: [], asArray: false }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8'))
    if (Array.isArray(parsed)) return { raw: parsed, jobs: parsed, asArray: true }
    if (parsed && typeof parsed === 'object' && Array.isArray((parsed as any).jobs)) {
      return { raw: parsed, jobs: (parsed as any).jobs, asArray: false }
    }
  } catch { /* fallthrough */ }
  return { raw: { jobs: [] }, jobs: [], asArray: false }
}

function saveJobsFile(path: string, raw: any, jobs: any[], asArray: boolean): void {
  try {
    mkdirSync(join(path, '..'), { recursive: true })
    const payload = asArray ? jobs : { ...(raw && typeof raw === 'object' ? raw : {}), jobs }
    writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, 'utf-8')
  } catch { /* 忽略写入失败，不影响推荐刷新 */ }
}

function makeJob(): Record<string, unknown> {
  const now = new Date().toISOString()
  return {
    job_id: PAPER_RECOMMENDER_JOB_ID,
    name: '论文推荐（本地知识库 · 顶会优先）',
    schedule: SCHEDULE,
    prompt: '依据本地知识库 wiki 中已收录的论文，检索并推荐相似的顶会论文。由 Hermes Studio 内置调度执行。',
    skills: [],
    no_agent: true,
    script: JOB_SCRIPT_NAME,
    enabled: true,
    state: 'scheduled',
    created_at: now,
    origin: 'hermes-studio',
    run_count: 0,
  }
}

/** 在指定 profile 的 cron/jobs.json 中种入任务（若已存在则跳过）。 */
function seedJobForProfile(profile: string): void {
  const path = cronJobsPathForProfile(profile)
  const { raw, jobs, asArray } = loadJobsFile(path)
  if (jobs.some((j) => (j?.job_id || j?.id) === PAPER_RECOMMENDER_JOB_ID)) return
  jobs.push(makeJob())
  saveJobsFile(path, raw, jobs, asArray)
}

/** 确保刷新脚本存在于 ~/.hermes/scripts/（cron tick 触发时使用）。 */
function ensureRefreshScript(): void {
  const scriptPath = jobScriptPath()
  if (existsSync(scriptPath)) return
  const content = `#!/usr/bin/env python3
# 由 Hermes Studio 注入：定期刷新“本地知识库顶会论文推荐”。
import json
import sys
import urllib.request

PORT = ${STUDIO_PORT}
URL = f"http://127.0.0.1:{PORT}/api/workbench/paper-recommendations/refresh"
try:
    req = urllib.request.Request(
        URL, data=b"{}",
        headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=120) as resp:
        payload = json.loads(resp.read().decode("utf-8"))
    count = payload.get("count") if isinstance(payload, dict) else None
    print(f"paper-recommender refresh ok: count={count}")
    sys.exit(0)
except Exception as e:
    print(f"paper-recommender refresh failed: {e}")
    sys.exit(1)
`
  try {
    mkdirSync(join(scriptPath, '..'), { recursive: true })
    writeFileSync(scriptPath, content, 'utf-8')
  } catch { /* 忽略 */ }
}

/** 启动时调用：确保任务存在于活跃 profile（及 default 兜底），并放置刷新脚本。 */
export function ensurePaperRecommenderJob(): void {
  const profiles = new Set<string>([getActiveProfileName(), 'default'])
  for (const p of profiles) {
    try { seedJobForProfile(p) } catch { /* ignore */ }
  }
  try { ensureRefreshScript() } catch { /* ignore */ }
}

/** 每次刷新后调用：回写运行元数据，使 Jobs 卡片显示真实历史。 */
export function recordPaperRecommenderRun(
  status: 'pending' | 'success' | 'partial' | 'failed',
  error: string | null,
): void {
  const now = new Date().toISOString()
  const profiles = new Set<string>([...listProfileNamesFromDisk(), 'default'])
  for (const profile of profiles) {
    const path = cronJobsPathForProfile(profile)
    const { raw, jobs, asArray } = loadJobsFile(path)
    let changed = false
    for (const job of jobs) {
      if ((job?.job_id || job?.id) !== PAPER_RECOMMENDER_JOB_ID) continue
      job.last_run_at = now
      job.last_status = status
      job.last_error = error ?? null
      job.run_count = (typeof job.run_count === 'number' ? job.run_count : 0) + 1
      changed = true
    }
    if (changed) saveJobsFile(path, raw, jobs, asArray)
  }
}
