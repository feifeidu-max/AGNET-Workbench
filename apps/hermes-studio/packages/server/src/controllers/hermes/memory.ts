import { createHash, randomUUID } from 'crypto'
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import { readConfigYamlForProfile, safeReadFile, safeStat } from '../../services/config-helpers'
import { getActiveProfileName, getProfileDir } from '../../services/hermes/hermes-profile'

export type MemorySection = 'memory' | 'user' | 'soul'

interface RevisionEntry {
  revision: number
  mtime: number | null
  sha256: string
}

type RevisionMap = Partial<Record<MemorySection, RevisionEntry>>

const locks = new Map<string, Promise<unknown>>()
const MAX_MEMORY_CHARS = 200_000
const META_FILE = '.memory-revisions.json'
const HISTORY_DIR = '.memory-history'

function requestedProfile(ctx: any): string {
  return ctx.state?.profile?.name || getActiveProfileName() || 'default'
}

function requestProfileDir(ctx: any): string {
  return getProfileDir(requestedProfile(ctx))
}

function sectionPath(profileDir: string, section: MemorySection): string {
  if (section === 'soul') return join(profileDir, 'SOUL.md')
  return join(profileDir, 'memories', section === 'memory' ? 'MEMORY.md' : 'USER.md')
}

function normalizeSection(value: unknown): MemorySection | null {
  return value === 'memory' || value === 'user' || value === 'soul' ? value : null
}

async function readRevisionMap(profileDir: string): Promise<RevisionMap> {
  try {
    const raw = await readFile(join(profileDir, META_FILE), 'utf8')
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed as RevisionMap : {}
  } catch {
    return {}
  }
}

async function atomicWrite(filePath: string, content: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true })
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, content, 'utf8')
    await rename(temporary, filePath)
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined)
  }
}

function withSectionLock<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) || Promise.resolve()
  const current = previous.then(task, task)
  locks.set(key, current.then(() => undefined, () => undefined))
  return current
}

function revisionOf(revisions: RevisionMap, section: MemorySection): RevisionEntry {
  const entry = revisions[section]
  return {
    revision: Number.isFinite(Number(entry?.revision)) ? Number(entry?.revision) : 0,
    mtime: entry?.mtime == null ? null : Number(entry.mtime),
    sha256: typeof entry?.sha256 === 'string' ? entry.sha256 : '',
  }
}

function sensitiveFindings(content: string): string[] {
  const findings: string[] = []
  const patterns: Array<[string, RegExp]> = [
    ['private_key', /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/i],
    ['api_key_assignment', /\b(?:api[_-]?key|secret[_-]?key|access[_-]?token|auth[_-]?token)\b\s*[:=]\s*['"]?[^\s'"`]{12,}/i],
    ['bearer_token', /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/i],
    ['provider_key', /\b(?:sk-[A-Za-z0-9]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{16,}|AKIA[0-9A-Z]{16})\b/],
  ]
  for (const [name, pattern] of patterns) {
    if (pattern.test(content)) findings.push(name)
  }
  return findings
}

async function memorySnapshot(ctx: any) {
  const profileDir = requestProfileDir(ctx)
  const memoryPath = sectionPath(profileDir, 'memory')
  const userPath = sectionPath(profileDir, 'user')
  const soulPath = sectionPath(profileDir, 'soul')
  const [memory, user, soul, memoryStat, userStat, soulStat, revisions, config] = await Promise.all([
    safeReadFile(memoryPath), safeReadFile(userPath), safeReadFile(soulPath),
    safeStat(memoryPath), safeStat(userPath), safeStat(soulPath), readRevisionMap(profileDir),
    readConfigYamlForProfile(requestedProfile(ctx)).catch(() => ({} as Record<string, any>)),
  ])
  const sections = {
    memory: { path: memoryPath, revision: revisionOf(revisions, 'memory').revision, mtime: memoryStat?.mtime || null },
    user: { path: userPath, revision: revisionOf(revisions, 'user').revision, mtime: userStat?.mtime || null },
    soul: { path: soulPath, revision: revisionOf(revisions, 'soul').revision, mtime: soulStat?.mtime || null },
  }
  return {
    memory: memory || '', user: user || '', soul: soul || '',
    memory_mtime: memoryStat?.mtime || null, user_mtime: userStat?.mtime || null, soul_mtime: soulStat?.mtime || null,
    memory_path: memoryPath, user_path: userPath, soul_path: soulPath,
    memory_revision: sections.memory.revision, user_revision: sections.user.revision, soul_revision: sections.soul.revision,
    sections,
    character_budget: {
      max_chars: MAX_MEMORY_CHARS,
      memory: (memory || '').length,
      user: (user || '').length,
      soul: (soul || '').length,
    },
    effective_status: {
      memory_enabled: config?.memory?.memory_enabled !== false,
      user_profile_enabled: config?.memory?.user_profile_enabled !== false,
      soul_always_loaded: true,
      clean_mode_excludes_profile_files: true,
    },
  }
}

export async function get(ctx: any) {
  ctx.body = await memorySnapshot(ctx)
}

async function saveSection(profileDir: string, section: MemorySection, content: string, expectedRevision?: unknown) {
  if (content.length > MAX_MEMORY_CHARS) {
    const error = new Error(`Content exceeds ${MAX_MEMORY_CHARS} characters`)
    ;(error as any).status = 413
    throw error
  }
  const findings = sensitiveFindings(content)
  if (findings.length > 0) {
    const error = new Error('Sensitive credential-like content detected')
    ;(error as any).status = 400
    ;(error as any).code = 'SENSITIVE_CONTENT'
    ;(error as any).findings = findings
    throw error
  }

  const path = sectionPath(profileDir, section)
  const metaPath = join(profileDir, META_FILE)
  const historyPath = join(profileDir, HISTORY_DIR, section)
  return withSectionLock(`${profileDir}:${section}`, async () => {
    const revisions = await readRevisionMap(profileDir)
    const current = revisionOf(revisions, section)
    if (expectedRevision !== undefined && expectedRevision !== null && String(expectedRevision) !== String(current.revision)) {
      const error = new Error('Memory revision conflict')
      ;(error as any).status = 409
      ;(error as any).code = 'REVISION_CONFLICT'
      ;(error as any).revision = current.revision
      throw error
    }
    const nextRevision = current.revision + 1
    const now = Date.now()
    const sha256 = createHash('sha256').update(content, 'utf8').digest('hex')
    await atomicWrite(path, content)
    await mkdir(historyPath, { recursive: true })
    await atomicWrite(join(historyPath, `${nextRevision}.md`), content)
    revisions[section] = { revision: nextRevision, mtime: now, sha256 }
    await atomicWrite(metaPath, JSON.stringify(revisions, null, 2) + '\n')
    return { revision: nextRevision, mtime: now, path, sha256 }
  })
}

export async function save(ctx: any) {
  const body = (ctx.request.body || {}) as { section?: unknown; content?: unknown; expectedRevision?: unknown; expected_revision?: unknown }
  const section = normalizeSection(body.section)
  if (!section || typeof body.content !== 'string') {
    ctx.status = 400
    ctx.body = { error: 'Missing section or content' }
    return
  }
  try {
    const headerRevision = ctx.get?.('If-Match')
    const expectedRevision = body.expectedRevision
      ?? body.expected_revision
      ?? (headerRevision ? String(headerRevision).replace(/^W\//i, '').replace(/^"|"$/g, '') : undefined)
    const result = await saveSection(
      requestProfileDir(ctx),
      section,
      body.content,
      expectedRevision,
    )
    ctx.body = { success: true, section, ...result }
  } catch (err: any) {
    ctx.status = Number(err?.status) || 500
    ctx.body = {
      error: err?.message || 'Failed to save memory',
      ...(err?.code ? { code: err.code } : {}),
      ...(err?.findings ? { findings: err.findings } : {}),
      ...(err?.revision != null ? { revision: err.revision } : {}),
    }
  }
}

export async function history(ctx: any) {
  const section = normalizeSection(ctx.query?.section)
  if (!section) {
    ctx.status = 400
    ctx.body = { error: 'section must be "memory", "user", or "soul"' }
    return
  }
  const profileDir = requestProfileDir(ctx)
  const revisions = await readRevisionMap(profileDir)
  const dir = join(profileDir, HISTORY_DIR, section)
  let names: string[] = []
  try { names = await readdir(dir) } catch { names = [] }
  const entries = names
    .map(name => Number(name.replace(/\.md$/, '')))
    .filter(value => Number.isInteger(value) && value > 0)
    .sort((a, b) => b - a)
    .map(revision => ({ revision, current: revision === revisionOf(revisions, section).revision }))
  ctx.body = { section, path: sectionPath(profileDir, section), current_revision: revisionOf(revisions, section).revision, history: entries }
}

export async function restore(ctx: any) {
  const body = (ctx.request.body || {}) as { section?: unknown; revision?: unknown; expectedRevision?: unknown; expected_revision?: unknown }
  const section = normalizeSection(body.section)
  const revision = Number(body.revision)
  if (!section || !Number.isInteger(revision) || revision <= 0) {
    ctx.status = 400
    ctx.body = { error: 'section and a positive revision are required' }
    return
  }
  try {
    const profileDir = requestProfileDir(ctx)
    const content = await readFile(join(profileDir, HISTORY_DIR, section, `${revision}.md`), 'utf8')
    const headerRevision = ctx.get?.('If-Match')
    const expectedRevision = body.expectedRevision
      ?? body.expected_revision
      ?? (headerRevision ? String(headerRevision).replace(/^W\//i, '').replace(/^"|"$/g, '') : undefined)
    const result = await saveSection(profileDir, section, content, expectedRevision)
    ctx.body = { success: true, section, restored_from: revision, ...result }
  } catch (err: any) {
    ctx.status = Number(err?.status) || (err?.code === 'ENOENT' ? 404 : 500)
    ctx.body = { error: err?.code === 'ENOENT' ? 'Memory revision not found' : err?.message || 'Failed to restore memory', ...(err?.code ? { code: err.code } : {}), ...(err?.revision != null ? { revision: err.revision } : {}) }
  }
}
