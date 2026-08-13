/**
 * Hermes 后端与模型配置健康检查
 *
 * 用途：让用户能确认
 *   1) Hermes gateway（后端 agent 进程）是否随 Studio 一起启动、当前是否在运行；
 *   2) 配置的 API Key / Base URL 是否真实生效（mask 展示 + 真实连通性探测）。
 *
 * 数据来源：
 *   - gateway.pid / gateway_state.json（活跃 profile 与 hermes home 下的运行时文件）
 *   - 活跃 profile 的 config.yaml（model / custom_providers）
 *   - key_env 指定的环境变量（进程环境或 profile 的 .env 兜底）
 * 探测：GET {base_url}/v1/models（OpenAI 兼容端点，带 Bearer key），结果缓存 60s。
 */

import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { getActiveProfileDir, getActiveProfileName } from './hermes/hermes-profile'
import { PROVIDER_ENV_MAP, readConfigYamlForProfile } from './config-helpers'
import { logger } from './logger'

export interface ModelProbe {
  status: 'ok' | 'failed' | 'skipped' | 'unknown'
  error: string | null
  checkedAt: string | null
}

export interface ModelHealth {
  profile: string
  provider: string | null
  providerName: string | null
  model: string | null
  baseUrl: string | null
  keyEnv: string | null
  keyConfigured: boolean
  keyMasked: string | null
  apiMode: string | null
  probe: ModelProbe
}

export interface HermesGatewayHealth {
  running: boolean
  pid: number | null
  profile: string
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err: any) {
    return err?.code === 'EPERM'
  }
}

function readGatewayPid(dir: string): number | null {
  for (const fileName of ['gateway.pid', 'gateway_state.json']) {
    const path = join(dir, fileName)
    if (!existsSync(path)) continue
    try {
      const data = JSON.parse(readFileSync(path, 'utf-8'))
      if (fileName === 'gateway_state.json') {
        const state = String(data?.gateway_state || '').toLowerCase()
        if (state && state !== 'running' && state !== 'starting') continue
      }
      const pid = typeof data?.pid === 'number' ? data.pid : parseInt(String(data?.pid || ''), 10)
      if (Number.isFinite(pid) && pid > 0) return pid
    } catch { /* malformed runtime file, try next */ }
  }
  return null
}

/** Hermes gateway 是否随 Studio 启动并存活（读取运行时 pid 文件 + 进程探活）。 */
export function getHermesGatewayHealth(): HermesGatewayHealth {
  const profile = getActiveProfileName()
  const activeDir = getActiveProfileDir()
  const seen = new Set<string>()
  // 同时检查活跃 profile 目录与其父目录（hermes home），兼容统一/分 profile 两种网关模式
  for (const dir of [activeDir, join(activeDir, '..')]) {
    const normalized = dir.replace(/[\\/]+$/, '')
    if (seen.has(normalized)) continue
    seen.add(normalized)
    const pid = readGatewayPid(normalized)
    if (pid !== null && isProcessAlive(pid)) {
      return { running: true, pid, profile }
    }
  }
  return { running: false, pid: null, profile }
}

interface ResolvedProvider {
  provider: string
  providerName: string
  model: string
  baseUrl: string
  keyEnv: string
  apiMode: string
}

function resolveProvider(config: Record<string, any>): ResolvedProvider | null {
  const modelSection = config?.model
  let defaultModel = ''
  let providerKey = ''
  if (modelSection && typeof modelSection === 'object' && modelSection !== null) {
    defaultModel = String(modelSection.default || '').trim()
    providerKey = String(modelSection.provider || '').trim()
  }
  if (!providerKey) return null

  const customName = providerKey.startsWith('custom:') ? providerKey.slice('custom:'.length).trim() : ''
  const cps = Array.isArray(config.custom_providers) ? config.custom_providers : []
  if (customName) {
    const cp = cps.find((c: any) => String(c?.name || '').trim() === customName)
      ?? cps.find((c: any) => String(c?.model || '') === defaultModel)
    if (cp) {
      return {
        provider: providerKey,
        providerName: String(cp.name || customName || ''),
        model: String(cp.model || defaultModel || '').trim(),
        baseUrl: String(cp.base_url || '').trim(),
        keyEnv: String(cp.key_env || '').trim(),
        apiMode: String(cp.api_mode || 'chat_completions'),
      }
    }
  }

  // 内置 provider：key/base_url 来自环境变量
  const envMap = PROVIDER_ENV_MAP[providerKey]
  if (!envMap) return null
  const baseUrlEnv = envMap.base_url_env
  const baseUrl = baseUrlEnv && process.env[baseUrlEnv] ? String(process.env[baseUrlEnv]).trim() : ''
  return {
    provider: providerKey,
    providerName: providerKey,
    model: defaultModel,
    baseUrl,
    keyEnv: envMap.api_key_env || '',
    apiMode: 'chat_completions',
  }
}

function resolveKeyFromEnv(keyEnv: string): string | null {
  if (!keyEnv) return null
  const fromProcess = process.env[keyEnv]
  if (fromProcess && fromProcess.trim()) return fromProcess.trim()
  // 兜底：读取活跃 profile 的 .env
  try {
    const envPath = join(getActiveProfileDir(), '.env')
    if (existsSync(envPath)) {
      for (const line of readFileSync(envPath, 'utf-8').split(/\r?\n/)) {
        const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
        if (match && match[1] === keyEnv) {
          const value = match[2].trim().replace(/^["']|["']$/g, '')
          if (value) return value
        }
      }
    }
  } catch { /* ignore */ }
  return null
}

function maskKey(key: string): string {
  if (!key) return ''
  if (key.length <= 8) return '****'
  return `${key.slice(0, 4)}****${key.slice(-4)}`
}

let probeCache: { at: number; result: ModelProbe } | null = null

async function probeProvider(baseUrl: string, apiKey: string): Promise<ModelProbe> {
  if (probeCache && Date.now() - probeCache.at < 60_000) return probeCache.result
  const checkedAt = new Date().toISOString()
  let result: ModelProbe
  if (!baseUrl || !apiKey) {
    result = {
      status: 'skipped',
      error: apiKey ? '缺少 base_url 配置' : '缺少 API Key（环境变量未设置）',
      checkedAt,
    }
  } else {
    try {
      const base = baseUrl.replace(/\/+$/, '')
      const modelsUrl = /\/v\d+\/?$/.test(base) ? `${base}/models` : `${base}/v1/models`
      const res = await fetch(modelsUrl, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(8000),
      })
      if (res.ok) {
        result = { status: 'ok', error: null, checkedAt }
      } else {
        result = { status: 'failed', error: `连通性测试失败：HTTP ${res.status} ${res.statusText}`, checkedAt }
      }
    } catch (err: any) {
      result = {
        status: 'failed',
        error: `连通性测试失败：${err?.name === 'TimeoutError' ? '请求超时（8s）' : (err?.message || String(err))}`,
        checkedAt,
      }
    }
  }
  probeCache = { at: Date.now(), result }
  return result
}

/** 读取活跃 profile 的模型配置并做一次真实连通性探测。 */
export async function getModelHealth(): Promise<ModelHealth> {
  const profile = getActiveProfileName()
  try {
    const config = await readConfigYamlForProfile(profile)
    const resolved = resolveProvider(config)
    if (!resolved) {
      return {
        profile,
        provider: null,
        providerName: null,
        model: null,
        baseUrl: null,
        keyEnv: null,
        keyConfigured: false,
        keyMasked: null,
        apiMode: null,
        probe: { status: 'unknown', error: 'config.yaml 未配置 model.provider', checkedAt: new Date().toISOString() },
      }
    }
    const apiKey = resolveKeyFromEnv(resolved.keyEnv)
    const probe = await probeProvider(resolved.baseUrl, apiKey || '')
    return {
      profile,
      provider: resolved.provider,
      providerName: resolved.providerName,
      model: resolved.model,
      baseUrl: resolved.baseUrl,
      keyEnv: resolved.keyEnv,
      keyConfigured: !!apiKey,
      keyMasked: apiKey ? maskKey(apiKey) : null,
      apiMode: resolved.apiMode,
      probe,
    }
  } catch (err) {
    logger.warn(err, '[model-health] failed to read model config profile=%s', profile)
    return {
      profile,
      provider: null,
      providerName: null,
      model: null,
      baseUrl: null,
      keyEnv: null,
      keyConfigured: false,
      keyMasked: null,
      apiMode: null,
      probe: { status: 'unknown', error: '读取 config.yaml 失败', checkedAt: new Date().toISOString() },
    }
  }
}
