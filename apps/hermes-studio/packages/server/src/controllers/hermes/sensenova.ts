import { readFile } from 'fs/promises'
import { join } from 'path'
import { getActiveProfileName, getProfileDir } from '../../services/hermes/hermes-profile'
import {
  fetchProviderModels,
  readConfigYamlForProfile,
  saveEnvValueForProfile,
  updateConfigYamlForProfile,
} from '../../services/config-helpers'
import { getCompatibleCustomProviders } from '../../services/hermes/custom-providers-compat'

export const SENSENOVA_PROVIDER = 'custom:sensenova'
export const SENSENOVA_NAME = 'sensenova'
export const SENSENOVA_API_KEY_ENV = 'SENSENOVA_API_KEY'
export const SENSENOVA_DEFAULT_BASE_URL = 'https://token.sensenova.cn/v1'
export const SENSENOVA_DEFAULT_MODEL = 'deepseek-v4-flash'

type ProviderApiMode = 'chat_completions' | 'codex_responses' | 'anthropic_messages' | 'bedrock_converse' | 'codex_app_server'

function requestedProfile(ctx: any): string {
  return ctx.state?.profile?.name || getActiveProfileName() || 'default'
}

function normalizeBaseUrl(value: unknown): string {
  const raw = String(value || '').trim().replace(/\/+$/, '')
  if (!raw) return ''

  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    throw new Error('Invalid SenseNova endpoint URL')
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('SenseNova endpoint must use http or https')
  }

  // The provider publishes its OpenAI-compatible API under /v1. Accept the
  // hostname-only value from the user and normalize it once for Hermes.
  if (!parsed.pathname || parsed.pathname === '/') {
    parsed.pathname = '/v1'
  }
  return parsed.toString().replace(/\/+$/, '')
}

function providerKeyForName(name: string): string {
  return `custom:${name.trim().toLowerCase().replace(/\s+/g, '-')}`
}

function maskSecret(value: string): string {
  const secret = String(value || '').trim()
  if (!secret) return ''
  if (secret.length <= 8) return '***'
  return `${secret.slice(0, 3)}***${secret.slice(-4)}`
}

function parseDotenvValue(raw: string): string {
  const value = raw.trim()
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1)
  }
  return value
}

async function readProfileEnvValue(profile: string, key: string): Promise<string> {
  try {
    const raw = await readFile(join(getProfileDir(profile), '.env'), 'utf8')
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const index = trimmed.indexOf('=')
      if (index < 1 || trimmed.slice(0, index).trim() !== key) continue
      return parseDotenvValue(trimmed.slice(index + 1))
    }
  } catch {
    // A missing profile .env means the provider is simply not configured yet.
  }
  return ''
}

async function resolveStoredApiKey(profile: string): Promise<string> {
  const envKey = await readProfileEnvValue(profile, SENSENOVA_API_KEY_ENV)
  if (envKey) return envKey
  const config = await readConfigYamlForProfile(profile)
  const provider = getCompatibleCustomProviders(config).find((entry) => {
    const name = entry.name.trim().toLowerCase()
    const key = String(entry.provider_key || '').trim().toLowerCase()
    return name === SENSENOVA_NAME || key === SENSENOVA_NAME
  })
  return String(provider?.api_key || '').trim()
}

function normalizeApiMode(value: unknown): ProviderApiMode {
  return value === 'codex_responses' || value === 'anthropic_messages' || value === 'bedrock_converse' || value === 'codex_app_server'
    ? value
    : 'chat_completions'
}

function normalizeModels(value: unknown, selectedModel: string): string[] {
  const values = Array.isArray(value) ? value : []
  return Array.from(new Set([
    ...values.map(item => String(item || '').trim()).filter(Boolean),
    selectedModel,
  ])).slice(0, 200)
}

async function resolveConfig(profile: string) {
  const config = await readConfigYamlForProfile(profile)
  const providers = getCompatibleCustomProviders(config)
  const provider = providers.find((entry) => {
    const name = entry.name.trim().toLowerCase()
    const key = String(entry.provider_key || '').trim().toLowerCase()
    return name === SENSENOVA_NAME || key === SENSENOVA_NAME
  })
  const modelConfig = config?.model && typeof config.model === 'object' ? config.model : {}
  const apiKey = await resolveStoredApiKey(profile)
  const model = String(provider?.model || '').trim() || (
    String(modelConfig.provider || '').trim() === SENSENOVA_PROVIDER
      ? String(modelConfig.default || '').trim()
      : ''
  ) || SENSENOVA_DEFAULT_MODEL
  const baseUrl = normalizeBaseUrl(provider?.base_url || SENSENOVA_DEFAULT_BASE_URL)
  const models = provider?.models && typeof provider.models === 'object'
    ? Object.keys(provider.models).filter(Boolean)
    : []

  return {
    provider: SENSENOVA_PROVIDER,
    name: provider?.name || SENSENOVA_NAME,
    base_url: baseUrl,
    model,
    api_mode: normalizeApiMode(provider?.api_mode),
    api_key_configured: Boolean(apiKey),
    api_key_hint: maskSecret(apiKey),
    models: Array.from(new Set([model, ...models].filter(Boolean))),
  }
}

export async function getConfig(ctx: any) {
  try {
    ctx.body = await resolveConfig(requestedProfile(ctx))
  } catch (error: any) {
    ctx.status = 500
    ctx.body = { error: error?.message || 'Failed to read SenseNova configuration' }
  }
}

export async function saveConfig(ctx: any) {
  const body = ctx.request.body || {}
  const profile = requestedProfile(ctx)
  const model = String(body.model || '').trim()
  const apiMode = normalizeApiMode(body.api_mode)
  const clearApiKey = body.clear_api_key === true
  const incomingKey = typeof body.api_key === 'string' ? body.api_key.trim() : ''

  if (!model) {
    ctx.status = 400
    ctx.body = { error: 'SenseNova model is required' }
    return
  }

  try {
    const baseUrl = normalizeBaseUrl(body.base_url || SENSENOVA_DEFAULT_BASE_URL)
    const models = normalizeModels(body.models, model)
    const existing = await resolveConfig(profile)
    const nextKey = clearApiKey ? '' : (incomingKey || (existing.api_key_configured ? await resolveStoredApiKey(profile) : ''))
    if (!nextKey) {
      ctx.status = 400
      ctx.body = { error: 'SenseNova API key is required' }
      return
    }

    await saveEnvValueForProfile(profile, SENSENOVA_API_KEY_ENV, nextKey)
    await updateConfigYamlForProfile(profile, (config) => {
      if (!config.model || typeof config.model !== 'object' || Array.isArray(config.model)) config.model = {}
      const entry = {
        name: SENSENOVA_NAME,
        base_url: baseUrl,
        key_env: SENSENOVA_API_KEY_ENV,
        model,
        api_mode: apiMode,
        models: Object.fromEntries(models.map(item => [item, {}])),
      }

      if (Array.isArray(config.custom_providers)) {
        const existingEntry = config.custom_providers.find((item: any) => providerKeyForName(item?.name || '') === SENSENOVA_PROVIDER)
        if (existingEntry) {
          Object.assign(existingEntry, entry)
          delete existingEntry.api_key
        }
        else config.custom_providers.push(entry)
      } else if (config.providers && typeof config.providers === 'object' && !Array.isArray(config.providers) && config.providers.sensenova && typeof config.providers.sensenova === 'object') {
        const existingEntry = config.providers.sensenova
        Object.assign(existingEntry, {
          name: SENSENOVA_NAME,
          api: baseUrl,
          base_url: baseUrl,
          key_env: SENSENOVA_API_KEY_ENV,
          default_model: model,
          models: Object.fromEntries(models.map(item => [item, {}])),
          transport: apiMode,
        })
        delete existingEntry.api_key
      } else {
        config.custom_providers = [entry]
      }

      config.model.default = model
      config.model.provider = SENSENOVA_PROVIDER
      delete config.model.base_url
      delete config.model.api_key
      return config
    })

    ctx.body = {
      success: true,
      ...(await resolveConfig(profile)),
    }
  } catch (error: any) {
    ctx.status = 400
    ctx.body = { error: error?.message || 'Failed to save SenseNova configuration' }
  }
}

export async function testConfig(ctx: any) {
  const profile = requestedProfile(ctx)
  const body = ctx.request.body || {}
  try {
    const current = await resolveConfig(profile)
    const baseUrl = normalizeBaseUrl(body.base_url || current.base_url)
    const apiKey = String(body.api_key || '').trim() || await readProfileEnvValue(profile, SENSENOVA_API_KEY_ENV)
    const model = String(body.model || current.model || '').trim()
    if (!apiKey) {
      ctx.status = 400
      ctx.body = { error: 'SenseNova API key is required' }
      return
    }
    const models = await fetchProviderModels(baseUrl, apiKey)
    if (models.length === 0) {
      ctx.status = 502
      ctx.body = { error: 'SenseNova returned no models', base_url: baseUrl, models: [] }
      return
    }
    ctx.body = {
      success: true,
      base_url: baseUrl,
      models,
      model,
      model_available: !model || models.includes(model),
    }
  } catch (error: any) {
    ctx.status = 502
    ctx.body = { error: error?.message || 'SenseNova connection failed' }
  }
}
