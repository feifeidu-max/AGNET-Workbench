import { existsSync, readFileSync, readdirSync } from 'fs'
import { mkdtemp, readFile, rm, stat } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const profileDirState = vi.hoisted(() => ({
  active: 'default',
  dirs: {} as Record<string, string>,
}))

vi.mock('../../packages/server/src/services/hermes/hermes-profile', () => ({
  getActiveProfileName: () => profileDirState.active,
  getProfileDir: (profile: string) => profileDirState.dirs[profile] || profileDirState.dirs.default,
}))

function createContext(profile: string, body: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
  return {
    state: { profile: { name: profile } },
    request: { body },
    query: {},
    get: (name: string) => headers[name] || '',
    status: undefined,
    body: undefined,
  } as any
}

async function loadController() {
  return import('../../packages/server/src/controllers/hermes/memory')
}

describe('Hermes memory controller revisions', () => {
  let defaultDir = ''
  let researchDir = ''

  beforeEach(async () => {
    vi.resetModules()
    defaultDir = await mkdtemp(join(tmpdir(), 'hermes-memory-controller-default-'))
    researchDir = await mkdtemp(join(tmpdir(), 'hermes-memory-controller-research-'))
    profileDirState.active = 'default'
    profileDirState.dirs = { default: defaultDir, research: researchDir }
  })

  afterEach(async () => {
    await Promise.all([
      defaultDir ? rm(defaultDir, { recursive: true, force: true }) : Promise.resolve(),
      researchDir ? rm(researchDir, { recursive: true, force: true }) : Promise.resolve(),
    ])
    defaultDir = ''
    researchDir = ''
  })

  it('creates the first revision and history entry on save', async () => {
    const { save, history } = await loadController()
    const ctx = createContext('default', { section: 'memory', content: '# First note\n' })

    await save(ctx)

    expect(ctx.status).toBeUndefined()
    expect(ctx.body).toMatchObject({ success: true, section: 'memory', revision: 1 })
    expect(readFileSync(join(defaultDir, 'memories', 'MEMORY.md'), 'utf8')).toBe('# First note\n')
    expect(readFileSync(join(defaultDir, '.memory-history', 'memory', '1.md'), 'utf8')).toBe('# First note\n')
    expect(JSON.parse(readFileSync(join(defaultDir, '.memory-revisions.json'), 'utf8'))).toMatchObject({
      memory: { revision: 1 },
    })

    const historyCtx = createContext('default')
    historyCtx.query = { section: 'memory' }
    await history(historyCtx)
    expect(historyCtx.body).toEqual({
      section: 'memory',
      path: join(defaultDir, 'memories', 'MEMORY.md'),
      current_revision: 1,
      history: [{ revision: 1, current: true }],
    })
  })

  it('rejects an If-Match conflict without overwriting the current revision', async () => {
    const { save } = await loadController()
    const initial = createContext('default', { section: 'memory', content: 'stable content' })
    await save(initial)

    const conflicting = createContext(
      'default',
      { section: 'memory', content: 'must not be written' },
      { 'If-Match': 'W/"0"' },
    )
    await save(conflicting)

    expect(conflicting.status).toBe(409)
    expect(conflicting.body).toMatchObject({ error: 'Memory revision conflict', code: 'REVISION_CONFLICT', revision: 1 })
    expect(readFileSync(join(defaultDir, 'memories', 'MEMORY.md'), 'utf8')).toBe('stable content')
    expect(readdirSync(join(defaultDir, '.memory-history', 'memory'))).toEqual(['1.md'])
  })

  it('restores an older revision as a new revision', async () => {
    const { save, restore } = await loadController()
    await save(createContext('default', { section: 'memory', content: 'version one' }))
    await save(createContext('default', { section: 'memory', content: 'version two', expectedRevision: 1 }))

    const restoring = createContext('default', {
      section: 'memory',
      revision: 1,
      expectedRevision: 2,
    })
    await restore(restoring)

    expect(restoring.status).toBeUndefined()
    expect(restoring.body).toMatchObject({
      success: true,
      section: 'memory',
      restored_from: 1,
      revision: 3,
    })
    expect(readFileSync(join(defaultDir, 'memories', 'MEMORY.md'), 'utf8')).toBe('version one')
    expect(readFileSync(join(defaultDir, '.memory-history', 'memory', '3.md'), 'utf8')).toBe('version one')
    expect(readdirSync(join(defaultDir, '.memory-history', 'memory')).sort()).toEqual(['1.md', '2.md', '3.md'])
  })

  it('rejects a restore If-Match conflict without changing content or history', async () => {
    const { save, restore } = await loadController()
    await save(createContext('default', { section: 'memory', content: 'version one' }))
    await save(createContext('default', { section: 'memory', content: 'version two', expectedRevision: 1 }))

    const conflicting = createContext(
      'default',
      { section: 'memory', revision: 1 },
      { 'If-Match': '"1"' },
    )
    await restore(conflicting)

    expect(conflicting.status).toBe(409)
    expect(conflicting.body).toMatchObject({ error: 'Memory revision conflict', code: 'REVISION_CONFLICT', revision: 2 })
    expect(readFileSync(join(defaultDir, 'memories', 'MEMORY.md'), 'utf8')).toBe('version two')
    expect(readdirSync(join(defaultDir, '.memory-history', 'memory')).sort()).toEqual(['1.md', '2.md'])
  })

  it('rejects credential-like content before creating any file', async () => {
    const { save } = await loadController()
    const ctx = createContext('default', {
      section: 'memory',
      content: 'api_key = "abcdefghijklmnop"\n',
    })

    await save(ctx)

    expect(ctx.status).toBe(400)
    expect(ctx.body).toMatchObject({ error: 'Sensitive credential-like content detected', code: 'SENSITIVE_CONTENT' })
    expect(existsSync(join(defaultDir, 'memories', 'MEMORY.md'))).toBe(false)
    expect(existsSync(join(defaultDir, '.memory-revisions.json'))).toBe(false)
    expect(existsSync(join(defaultDir, '.memory-history'))).toBe(false)
  })

  it('keeps revisions and paths isolated by request profile', async () => {
    const { save, get } = await loadController()
    await save(createContext('research', { section: 'memory', content: 'research-only' }))

    const researchGet = createContext('research')
    await get(researchGet)
    expect(researchGet.body).toMatchObject({
      memory: 'research-only',
      memory_revision: 1,
      memory_path: join(researchDir, 'memories', 'MEMORY.md'),
    })

    const defaultGet = createContext('default')
    await get(defaultGet)
    expect(defaultGet.body).toMatchObject({
      memory: '',
      memory_revision: 0,
      memory_path: join(defaultDir, 'memories', 'MEMORY.md'),
    })
    expect(await stat(join(researchDir, 'memories', 'MEMORY.md'))).toBeTruthy()
    await expect(readFile(join(defaultDir, 'memories', 'MEMORY.md'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
