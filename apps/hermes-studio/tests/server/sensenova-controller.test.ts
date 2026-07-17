import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import YAML from 'js-yaml'

let hermesHome = ''

async function loadController() {
  vi.resetModules()
  process.env.HERMES_HOME = hermesHome
  return import('../../packages/server/src/controllers/hermes/sensenova')
}

function makeCtx(body: Record<string, unknown> = {}, profile = 'default') {
  return {
    request: { body },
    state: { profile: { name: profile } },
    status: 200,
    body: undefined as unknown,
  }
}

describe('SenseNova configuration controller', () => {
  beforeEach(() => {
    hermesHome = mkdtempSync(join(tmpdir(), 'hermes-sensenova-'))
    writeFileSync(join(hermesHome, 'config.yaml'), 'model: {}\n', 'utf8')
    writeFileSync(join(hermesHome, '.env'), '', 'utf8')
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    delete process.env.HERMES_HOME
    vi.resetModules()
    if (hermesHome) rmSync(hermesHome, { recursive: true, force: true })
    hermesHome = ''
  })

  it('stores the key in the profile env and only returns a masked hint', async () => {
    const { saveConfig, getConfig } = await loadController()
    const saveCtx = makeCtx({
      base_url: 'https://token.sensenova.cn',
      api_key: 'sk-test-sensenova-1234',
      model: 'deepseek-v4-flash',
    })

    await saveConfig(saveCtx)

    expect(saveCtx.body).toMatchObject({ success: true, model: 'deepseek-v4-flash', api_key_configured: true })
    const config = YAML.load(readFileSync(join(hermesHome, 'config.yaml'), 'utf8')) as any
    expect(config.model).toEqual({ default: 'deepseek-v4-flash', provider: 'custom:sensenova' })
    expect(config.custom_providers[0]).toMatchObject({
      name: 'sensenova',
      base_url: 'https://token.sensenova.cn/v1',
      key_env: 'SENSENOVA_API_KEY',
      model: 'deepseek-v4-flash',
    })
    expect(config.custom_providers[0].api_key).toBeUndefined()
    expect(readFileSync(join(hermesHome, '.env'), 'utf8')).toContain('SENSENOVA_API_KEY=sk-test-sensenova-1234')

    const getCtx = makeCtx()
    await getConfig(getCtx)
    expect(getCtx.body).toMatchObject({ api_key_configured: true, api_key_hint: 'sk-***1234' })
    expect(JSON.stringify(getCtx.body)).not.toContain('sk-test-sensenova-1234')
  })

  it('keeps the existing key when only the model is changed', async () => {
    const { saveConfig } = await loadController()
    await saveConfig(makeCtx({ api_key: 'sk-test-sensenova-1234', model: 'deepseek-v4-flash', base_url: 'https://token.sensenova.cn/v1' }))
    const updateCtx = makeCtx({ model: 'sensenova-6.7-flash-lite', base_url: 'https://token.sensenova.cn/v1' })
    await saveConfig(updateCtx)

    expect(updateCtx.body).toMatchObject({ success: true, model: 'sensenova-6.7-flash-lite' })
    expect(readFileSync(join(hermesHome, '.env'), 'utf8')).toContain('SENSENOVA_API_KEY=sk-test-sensenova-1234')
    const config = YAML.load(readFileSync(join(hermesHome, 'config.yaml'), 'utf8')) as any
    expect(config.model.default).toBe('sensenova-6.7-flash-lite')
    expect(config.custom_providers[0].model).toBe('sensenova-6.7-flash-lite')
  })

  it('tests the normalized OpenAI-compatible models endpoint', async () => {
    const { testConfig } = await loadController()
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ id: 'deepseek-v4-flash' }, { id: 'sensenova-6.7-flash-lite' }] }),
    })
    vi.stubGlobal('fetch', fetchMock)

    const ctx = makeCtx({
      base_url: 'https://token.sensenova.cn',
      api_key: 'sk-test-sensenova-1234',
      model: 'deepseek-v4-flash',
    })
    await testConfig(ctx)

    expect(ctx.body).toMatchObject({ success: true, base_url: 'https://token.sensenova.cn/v1', model_available: true })
    expect((ctx.body as any).models).toEqual(['deepseek-v4-flash', 'sensenova-6.7-flash-lite'])
    expect(fetchMock).toHaveBeenCalledWith(
      'https://token.sensenova.cn/v1/models',
      expect.objectContaining({ headers: { Authorization: 'Bearer sk-test-sensenova-1234' } }),
    )
  })
})
