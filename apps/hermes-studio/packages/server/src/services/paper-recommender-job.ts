/**
 * 将“论文推荐（本地知识库·顶会优先·最新优先）”注册为 Hermes 的 cron 任务（agent 模式），
 * 使其出现在工作台 Jobs 页面（/#/hermes/jobs），且由 Hermes 本身触发与执行：
 * Hermes 读取 llm-wiki 的 wiki（llm_wiki_search / llm_wiki_chat(web)），理解当前研究主题，
 * 联网检索与知识库相似、最近发表的顶会论文，并回写推荐结果。
 *
 * 设计：
 * - 任务以 agent prompt 方式定义：cron 守卫（hermes cron tick）或在 Jobs 页面手动运行时，
 *   Hermes 会真正“自己去网上搜”，而不是只打一通脚本。
 * - 为保证刷新一定会发生（即使 cron 守卫未运行），studio 内置定时器
 *   （paper-recommender.schedulePaperRecommendations，每 6h）仍作为兜底执行同一套引擎。
 * - 回写：每次刷新（无论引擎还是 agent）后调用 recordPaperRecommenderRun，更新任务的
 *   last_run_at / last_status / run_count / last_error，使 Jobs 卡片显示真实运行历史。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { spawn } from 'child_process'
import { join } from 'path'
import { getActiveProfileName, getProfileDir, listProfileNamesFromDisk } from './hermes/hermes-profile'
import { getHermesBin } from './hermes/hermes-path'
import { logger } from './logger'

export const PAPER_RECOMMENDER_JOB_ID = 'paper-recommender-kb'
const PAPER_RECOMMENDER_JOB_NAME = '论文推荐（本地知识库 · 顶会优先 · 最新优先）'
const LEGACY_JOB_NAMES = new Set([
  '数据工程论文推荐（本地知识库 · 最新优先）',
  '数据工程论文推荐（本地知识库 · 顶会优先 · 最新优先）',
])
const SCHEDULE = '0 */6 * * *' // 每 6 小时
const STUDIO_PORT = 8648

/**
 * Return the next local-time 0/6/12/18 boundary for the managed job.
 * Hermes cron uses the host's local timezone, so constructing the date with
 * local setters keeps the Jobs card aligned with the actual scheduler.
 */
export function nextScheduledRunAt(from = new Date()): string {
  const next = new Date(from)
  const nextHour = next.getHours() - (next.getHours() % 6) + 6
  next.setHours(nextHour, 0, 0, 0)
  if (next.getTime() <= from.getTime()) next.setHours(next.getHours() + 6, 0, 0, 0)
  return next.toISOString()
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

function cronSchedule(value: unknown): Record<string, string> {
  const text = typeof value === 'string'
    ? value.trim()
    : value && typeof value === 'object'
      ? String((value as any).expr || (value as any).display || '').trim()
      : ''
  return { kind: 'cron', expr: text || SCHEDULE, display: text || SCHEDULE }
}

/** Convert the pre-0.18 Studio job shape into Hermes' persisted cron schema. */
function normalizeManagedJob(job: any): any {
  const id = String(job?.id || job?.job_id || PAPER_RECOMMENDER_JOB_ID)
  // Migrate the old default display name so the Jobs page and the
  // recommendation refresh button refer to the same task name.
  const name = typeof job?.name === 'string' && LEGACY_JOB_NAMES.has(job.name)
    ? PAPER_RECOMMENDER_JOB_NAME
    : (job?.name ?? PAPER_RECOMMENDER_JOB_NAME)
  const schedule = cronSchedule(job?.schedule)
  const repeat = job?.repeat && typeof job.repeat === 'object'
    ? { times: job.repeat.times ?? null, completed: Number(job.repeat.completed) || 0 }
    : { times: null, completed: 0 }
  return {
    ...job,
    id,
    job_id: id,
    name,
    // This is a Studio-managed task. Always migrate old script-only jobs to
    // the current agent prompt so a stale script cannot silently run instead.
    prompt: JOB_PROMPT,
    skills: Array.isArray(job?.skills) ? job.skills : [],
    skill: job?.skill ?? null,
    model: job?.model ?? null,
    provider: job?.provider ?? null,
    base_url: job?.base_url ?? null,
    script: null,
    no_agent: false,
    context_from: job?.context_from ?? null,
    schedule,
    schedule_display: schedule.display,
    repeat,
    enabled: job?.enabled !== false,
    state: job?.state || (job?.enabled === false ? 'paused' : 'scheduled'),
    paused_at: job?.paused_at ?? null,
    paused_reason: job?.paused_reason ?? null,
    created_at: job?.created_at || new Date().toISOString(),
    next_run_at: job?.enabled === false ? null : nextScheduledRunAt(),
    last_run_at: job?.last_run_at ?? null,
    last_status: job?.last_status ?? null,
    last_error: job?.last_error ?? null,
    last_delivery_error: job?.last_delivery_error ?? null,
    deliver: typeof job?.deliver === 'string' && job.deliver.trim() ? job.deliver : 'local',
    origin: job?.origin && typeof job.origin === 'object' ? job.origin : null,
    enabled_toolsets: Array.isArray(job?.enabled_toolsets) ? job.enabled_toolsets : null,
    workdir: job?.workdir ?? null,
    profile: job?.profile ?? null,
  }
}

const JOB_PROMPT = [
  '你是论文推荐守护任务。请基于本地知识库（llm-wiki）的 wiki 内容理解当前研究主题，',
  '然后使用以下工具联网检索：llm_wiki_search（本地证据不足时会自动检索 OpenAlex/Crossref/arXiv），',
  '以及 llm_wiki_chat（设置 web:true）做更深度的网络搜索。',
  '目标：只找数据工程、数据平台、数据采集、数据存储、数据计算、数据治理、数据质量或数据安全方向的论文，',
  '排除点云、体素、近存计算和神经网络硬件加速主题。优先选择 VLDB/SIGMOD/ICDE/KDD/TPDS/Big Data ',
  '等数据系统会议或高质量期刊的最新论文，并按发表年份从新到旧排序（最新优先）。',
  `完成后，将结果通过 HTTP POST 提交到 http://127.0.0.1:${STUDIO_PORT}/api/workbench/paper-recommendations ，`,
  'body 为 {"items":[{"title":"...","authors":["..."],"year":2025,"url":"...","venue":"...","doi":"...","reason":"..."}]}。',
  '若无法调用接口，请在回复中清晰列出你找到的论文要点（标题/会议/年份/链接）。',
].join('')

function makeJob(): Record<string, unknown> {
  const now = new Date().toISOString()
  return {
    id: PAPER_RECOMMENDER_JOB_ID,
    job_id: PAPER_RECOMMENDER_JOB_ID,
    name: PAPER_RECOMMENDER_JOB_NAME,
    prompt: JOB_PROMPT,
    skills: [],
    skill: null,
    model: null,
    provider: null,
    base_url: null,
    script: null,
    no_agent: false,
    context_from: null,
    schedule: { kind: 'cron', expr: SCHEDULE, display: SCHEDULE },
    schedule_display: SCHEDULE,
    repeat: { times: null, completed: 0 },
    enabled_toolsets: null,
    workdir: null,
    profile: null,
    enabled: true,
    state: 'scheduled',
    paused_at: null,
    paused_reason: null,
    created_at: now,
    next_run_at: nextScheduledRunAt(),
    last_run_at: null,
    last_status: null,
    last_error: null,
    last_delivery_error: null,
    deliver: 'local',
    origin: null,
  }
}

/** 在指定 profile 的 cron/jobs.json 中种入任务（若已存在则跳过）。 */
function seedJobForProfile(profile: string): void {
  const path = cronJobsPathForProfile(profile)
  const { raw, jobs, asArray } = loadJobsFile(path)
  const index = jobs.findIndex((job) => (job?.job_id || job?.id) === PAPER_RECOMMENDER_JOB_ID)
  if (index >= 0) {
    const normalized = normalizeManagedJob(jobs[index])
    if (JSON.stringify(normalized) !== JSON.stringify(jobs[index])) {
      jobs[index] = normalized
      saveJobsFile(path, raw, jobs, asArray)
    }
    return
  }
  jobs.push(makeJob())
  saveJobsFile(path, raw, jobs, asArray)
}

/** 启动时调用：确保任务存在于活跃 profile（及 default 兜底）。 */
export function ensurePaperRecommenderJob(): void {
  const profiles = new Set<string>([getActiveProfileName(), 'default'])
  for (const p of profiles) {
    try { seedJobForProfile(p) } catch { /* ignore */ }
  }
}

/**
 * 手动触发“论文推荐（本地知识库 · 顶会优先）”Hermes cron 任务（agent 模式）。
 * hermes cron run 会把任务的 next_run_at 置为当前时间，由正在运行的 gateway
 * 的 cron ticker 在下一个 tick（通常 ≤60s）真正执行 agent 联网检索，
 * 完成后由 agent 通过 HTTP POST 回写到 /api/workbench/paper-recommendations。
 * 本函数不阻塞等待；返回 spawn 是否成功。
 */
export function runPaperRecommenderAgentJob(profile: string): { started: boolean; pid?: number; error?: string } {
  const profileName = profile || getActiveProfileName() || 'default'
  const profileDir = getProfileDir(profileName)
  try {
    const child = spawn(getHermesBin(), ['cron', 'run', '--profile', profileName, PAPER_RECOMMENDER_JOB_ID], {
      env: { ...process.env, HERMES_HOME: profileDir },
      stdio: 'ignore',
      windowsHide: true,
      detached: false,
    })
    child.on('error', (err) => {
      logger.warn(err, '[paper-recommender-job] hermes cron run spawn failed profile=%s', profileName)
    })
    child.unref()
    return { started: true, pid: child.pid }
  } catch (err) {
    return { started: false, error: err instanceof Error ? err.message : String(err) }
  }
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
      job.next_run_at = job.enabled === false ? null : nextScheduledRunAt(new Date(now))
      changed = true
    }
    if (changed) saveJobsFile(path, raw, jobs, asArray)
  }
}
