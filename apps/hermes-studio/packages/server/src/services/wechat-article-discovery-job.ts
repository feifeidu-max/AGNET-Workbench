/**
 * Seed a Hermes cron task that discovers high-quality data-engineering WeChat
 * articles with the configured web-search tools. The task returns URLs to
 * Studio; Studio fetches, scores, de-duplicates, and stages the content in
 * LLM Wiki's draft queue.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { getActiveProfileName, getProfileDir, listProfileNamesFromDisk } from './hermes/hermes-profile'

export const WECHAT_DISCOVERY_JOB_ID = 'wechat-article-discovery-kb'
const SCHEDULE = '20 */6 * * *'
const STUDIO_PORT = 8648

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
  } catch { /* fall through */ }
  return { raw: { jobs: [] }, jobs: [], asArray: false }
}

function saveJobsFile(path: string, raw: any, jobs: any[], asArray: boolean): void {
  try {
    mkdirSync(join(path, '..'), { recursive: true })
    const payload = asArray ? jobs : { ...(raw && typeof raw === 'object' ? raw : {}), jobs }
    writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, 'utf-8')
  } catch { /* cron registration must not prevent Studio startup */ }
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
  const id = String(job?.id || job?.job_id || WECHAT_DISCOVERY_JOB_ID)
  const schedule = cronSchedule(job?.schedule)
  const repeat = job?.repeat && typeof job.repeat === 'object'
    ? { times: job.repeat.times ?? null, completed: Number(job.repeat.completed) || 0 }
    : { times: null, completed: 0 }
  return {
    ...job,
    id,
    job_id: id,
    // Keep the managed task prompt in sync when the workflow is upgraded.
    // Preserving an older prompt would re-enable browser/chat fallbacks that
    // the current discovery flow explicitly avoids.
    prompt: JOB_PROMPT,
    skills: Array.isArray(job?.skills) ? job.skills : [],
    skill: job?.skill ?? null,
    model: job?.model ?? null,
    provider: job?.provider ?? null,
    base_url: job?.base_url ?? null,
    script: job?.script ?? null,
    no_agent: job?.no_agent === true,
    context_from: job?.context_from ?? null,
    schedule,
    schedule_display: schedule.display,
    repeat,
    enabled: job?.enabled !== false,
    state: job?.state || (job?.enabled === false ? 'paused' : 'scheduled'),
    paused_at: job?.paused_at ?? null,
    paused_reason: job?.paused_reason ?? null,
    created_at: job?.created_at || new Date().toISOString(),
    next_run_at: job?.next_run_at ?? null,
    last_run_at: job?.last_run_at ?? null,
    last_status: job?.last_status ?? null,
    last_error: job?.last_error ?? null,
    last_delivery_error: job?.last_delivery_error ?? null,
    deliver: typeof job?.deliver === 'string' && job.deliver.trim() ? job.deliver : 'local',
    origin: job?.origin && typeof job.origin === 'object' ? job.origin : null,
    enabled_toolsets: Array.isArray(job?.enabled_toolsets) && job.enabled_toolsets.length > 0
      ? job.enabled_toolsets
      : ['web'],
    workdir: job?.workdir ?? null,
    profile: job?.profile ?? null,
  }
}

const JOB_PROMPT = [
  '你是数据工程微信公众号文章发现守护任务。每次运行只完成一次检索和一次回写，回写成功后立即结束，不要重复调用工具。',
  '先检查本轮是否真的存在可用的 web_search/web.search 工具。若工具不存在、没有 API key 或第一次调用报错，立即放弃联网检索，不要打开浏览器、不要调用 hermes_studio_use_chat_run、llm_wiki_chat 或 terminal。',
  'web 不可用时，必须直接调用 hermes_studio_api_request，参数明确写成 method="POST", path="/api/workbench/wechat-discovery", body={"items":[]}，不要省略 method，也不要用 GET。Studio 会使用本地公共检索兜底。',
  'web 可用时，只用 web_search 搜索新的高质量中文技术文章，检索词为：',
  'site:mp.weixin.qq.com/s/ 数据工程、数据平台、数据治理、数据质量、数据湖、湖仓、数据仓库、数据采集、数据存储、实时计算、流处理、数据安全。',
  '只保留原创或有工程细节的技术文章，排除招聘、课程报名、广告、营销、生活方式和重复转载；最多提交 12 篇。',
  '每条必须是可直接访问的 https://mp.weixin.qq.com/s/... 文章链接，并尽量给出公众号名称 sourceName。不要提交搜索结果页、公众号主页或文章正文。',
  `检索结束后必须调用 hermes_studio_api_request，method="POST"，path="/api/workbench/wechat-discovery"，body 严格为 `,
  '{"items":[{"url":"https://mp.weixin.qq.com/s/...","sourceName":"公众号名称"}]}。',
  '没有候选时也必须提交 {"items":[]}。Studio 会自己抓取、去重、质量评分并写入 LLM Wiki 草稿审核队列；不要绕过接口直接改 Wiki 文件。',
].join('')

function makeJob(): Record<string, unknown> {
  const now = new Date().toISOString()
  return {
    id: WECHAT_DISCOVERY_JOB_ID,
    job_id: WECHAT_DISCOVERY_JOB_ID,
    name: '数据工程微信公众号文章自动发现',
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
    enabled_toolsets: ['web'],
    workdir: null,
    profile: null,
    enabled: true,
    state: 'scheduled',
    paused_at: null,
    paused_reason: null,
    created_at: now,
    next_run_at: null,
    last_run_at: null,
    last_status: null,
    last_error: null,
    last_delivery_error: null,
    deliver: 'local',
    origin: null,
  }
}

function seedJobForProfile(profile: string): void {
  const path = cronJobsPathForProfile(profile)
  const { raw, jobs, asArray } = loadJobsFile(path)
  const index = jobs.findIndex((job) => (job?.job_id || job?.id) === WECHAT_DISCOVERY_JOB_ID)
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

export function ensureWechatDiscoveryJob(): void {
  const profiles = new Set<string>([getActiveProfileName(), 'default'])
  for (const profile of profiles) {
    try { seedJobForProfile(profile) } catch { /* ignore profile-specific failures */ }
  }
}

export function recordWechatDiscoveryRun(
  status: 'success' | 'partial' | 'failed',
  error: string | null,
): void {
  const now = new Date().toISOString()
  const profiles = new Set<string>([...listProfileNamesFromDisk(), 'default'])
  for (const profile of profiles) {
    const path = cronJobsPathForProfile(profile)
    const { raw, jobs, asArray } = loadJobsFile(path)
    let changed = false
    for (const job of jobs) {
      if ((job?.job_id || job?.id) !== WECHAT_DISCOVERY_JOB_ID) continue
      job.last_run_at = now
      job.last_status = status
      job.last_error = error ?? null
      job.run_count = Math.max(0, Number(job.run_count) || 0) + 1
      changed = true
    }
    if (changed) saveJobsFile(path, raw, jobs, asArray)
  }
}
