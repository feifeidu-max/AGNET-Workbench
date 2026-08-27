/**
 * WeChat multi-member binding.
 *
 * iLink bots are private 1:1 channels: whoever scans the QR owns that bot and
 * only they can chat with it. To let multiple people use the agent, each
 * member scans their own QR and gets a DEDICATED hermes home directory plus a
 * dedicated gateway process. Members share nothing except the knowledge base
 * (every agent hits the same local LLM Wiki API).
 *
 * Layout per member:
 *   <hermesBase>/profiles/wx-<id>/           ← full hermes home (HERMES_HOME)
 *     ├─ config.yaml                          model/provider (mimo-v2.5)
 *     ├─ .env                                 WEIXIN_* + KB/LLM credentials
 *     └─ sessions/, state.db, ...             isolated conversation history
 */

import axios from 'axios'
import { randomUUID } from 'crypto'
import { existsSync, statSync } from 'fs'
import { join } from 'path'

import { logger } from './logger'
import { safeFileStore } from './safe-file-store'
import { getHermesBaseDir } from './hermes/hermes-profile'
import {
  retireManagedGatewayForProfile,
  startGatewayRunManaged,
} from './hermes/gateway-runner'

const ILINK_BASE = 'https://ilinkai.weixin.qq.com'
const ILINK_CDN_DEFAULT = 'https://novac2c.cdn.weixin.qq.com/c2c'
export const WECHAT_MEMBERS_MAX = 0 // 0 = 无限制（仅受系统资源限制）

interface WechatMember {
  id: string
  displayName: string
  accountId: string
  /** Dedicated hermes home directory name under profiles/. */
  profileName: string
  boundAt: string
  status: 'active' | 'revoked'
}

interface MemberStore {
  version: 1
  maxMembers: number
  members: WechatMember[]
}

function storePath(): string {
  const home =
    process.env.HERMES_WEB_UI_HOME ||
    process.env.HERMES_WEBUI_STATE_DIR ||
    join(process.env.USERPROFILE || process.env.HOME || '.', '.hermes-web-ui')
  return join(home, 'wechat-members.json')
}

async function readStore(): Promise<MemberStore> {
  try {
    const raw = await safeFileStore.readText(storePath())
    const parsed = JSON.parse(raw) as MemberStore
    if (!Array.isArray(parsed.members)) throw new Error('bad shape')
    // 旧版上限 10 现改为无限制，自动迁移
    if (parsed.maxMembers === 10) {
      parsed.maxMembers = 0
      writeStore(parsed).catch(() => {})
    }
    return parsed
  } catch {
    return { version: 1, maxMembers: WECHAT_MEMBERS_MAX, members: [] }
  }
}

async function writeStore(store: MemberStore): Promise<void> {
  await safeFileStore.writeText(storePath(), JSON.stringify(store, null, 2))
}

function memberHomeDir(member: WechatMember): string {
  return join(getHermesBaseDir(), 'profiles', member.profileName)
}

function resolveHermesBin(): string {
  return process.env.HERMES_BIN?.trim() || 'hermes'
}

function isPidAlive(pid: number | undefined | null): boolean {
  if (!pid || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err: any) {
    return err?.code === 'EPERM'
  }
}

/** Best-effort liveness probe driven by the profile's own gateway_state.json. */
function isMemberGatewayRunning(member: WechatMember): boolean {
  try {
    const stateFile = join(memberHomeDir(member), 'gateway_state.json')
    if (!existsSync(stateFile)) return false
    const raw = JSON.parse(require('fs').readFileSync(stateFile, 'utf-8'))
    return raw?.gateway_state === 'running' && isPidAlive(Number(raw?.pid))
  } catch {
    return false
  }
}

export interface MemberActivity {
  /** Agent turns currently in flight (>0 = 正在对话中). */
  activeAgents: number
  /** ISO time of the latest inbound/reply log line, null when never used. */
  lastActivityAt: string | null
  /** 'inbound' | 'reply' — direction of the most recent event. */
  lastEvent: 'inbound' | 'reply' | null
}

const LOG_TAIL_BYTES = 48 * 1024

function summarizeActivity(home: string): MemberActivity {
  const result: MemberActivity = { activeAgents: 0, lastActivityAt: null, lastEvent: null }
  try {
    const stateFile = join(home, 'gateway_state.json')
    if (existsSync(stateFile)) {
      const raw = JSON.parse(require('fs').readFileSync(stateFile, 'utf-8'))
      result.activeAgents = Number(raw?.active_agents) || 0
    }
  } catch { /* keep defaults */ }
  try {
    const logFile = join(home, 'logs', 'gateway.log')
    if (existsSync(logFile)) {
      const stat = statSync(logFile)
      if (!result.lastActivityAt && stat.mtime) {
        // 网关日志的 mtime 即最近一次任何活动的兜底时间。
        result.lastActivityAt = stat.mtime.toISOString()
      }
      const fd = require('fs').openSync(logFile, 'r')
      try {
        const size = require('fs').fstatSync(fd).size
        const start = Math.max(0, size - LOG_TAIL_BYTES)
        const buffer = Buffer.alloc(size - start)
        require('fs').readSync(fd, buffer, 0, buffer.length, start)
        const lines = buffer.toString('utf-8').split(/\r?\n/).reverse()
        for (const line of lines) {
          if (!result.lastEvent) {
            if (/response ready:/.test(line)) {
              result.lastEvent = 'reply'
              const m = line.match(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/)
              if (m) result.lastActivityAt = new Date(m[1].replace(' ', 'T') + '+08:00').toISOString()
              break
            }
            if (/inbound from=/.test(line)) {
              result.lastEvent = 'inbound'
              const m = line.match(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/)
              if (m) result.lastActivityAt = new Date(m[1].replace(' ', 'T') + '+08:00').toISOString()
              break
            }
          }
        }
      } finally {
        require('fs').closeSync(fd)
      }
    }
  } catch { /* keep defaults */ }
  return result
}

function buildMemberConfigYaml(): Record<string, any> {
  const config: Record<string, any> = {
    model: {
      default: 'mimo-v2.5',
      provider: 'opencode-go',
      context_length: 200000,
    },
    custom_providers: [
      {
        name: 'opencode-go',
        base_url: 'https://opencode.ai/zen/go/v1',
        key_env: 'OPENCODE_GO_API_KEY',
        api_key: process.env.OPENCODE_GO_API_KEY || '',
        models: {
          'mimo-v2.5': { context_length: 200000 },
        },
      },
    ],
    agent: {
      reasoning_effort: process.env.WECHAT_MEMBER_REASONING_EFFORT || 'xhigh',
    },
  }

  // 成员 Agent 也需要 Studio MCP（hermes_studio_knowledge_draft_review 等），
  // 才能在微信里直接 批准/拒绝 知识库草稿。
  const studioUrl =
    process.env.HERMES_WEB_UI_URL ||
    process.env.LLM_WIKI_STUDIO_URL ||
    'http://127.0.0.1:8648'
  const stateHome =
    process.env.HERMES_WEB_UI_HOME ||
    process.env.HERMES_WEBUI_STATE_DIR ||
    join(process.env.USERPROFILE || process.env.HOME || '.', '.hermes-web-ui')
  const mcpScript = findStudioMcpScript()
  if (mcpScript) {
    config.mcp_servers = {
      'hermes-studio-api': {
        command: process.env.NODE_EXECUTABLE?.trim() || 'node',
        args: [mcpScript, 'api'],
        env: {
          HERMES_WEB_UI_URL: studioUrl,
          HERMES_WEB_UI_HOME: stateHome,
          HERMES_WEBUI_STATE_DIR: stateHome,
          HERMES_WEB_UI_PROFILE: 'default',
          HERMES_MCP_SERVER_NAME: 'hermes-studio-api',
          HERMES_MCP_TOOLSET: 'api',
          HERMES_WEB_UI_MANAGED_MCP: '1',
        },
        enabled: true,
      },
    }
  } else {
    logger.warn('[wechat-members] studio mcp script not found; member will lack knowledge tools')
  }
  return config
}

/** 从服务进程 cwd 向上寻找 bin/hermes-studio-mcp.mjs。 */
function findStudioMcpScript(): string | null {
  let dir = process.cwd()
  for (let depth = 0; depth < 6; depth += 1) {
    const candidate = join(dir, 'bin', 'hermes-studio-mcp.mjs')
    if (existsSync(candidate)) return candidate
    const parent = join(dir, '..')
    if (parent === dir) break
    dir = parent
  }
  return null
}

function buildMemberEnvLines(member: WechatMember, baseUrl?: string): string[] {
  const lines: string[] = []
  const push = (key: string, value: unknown) => {
    if (value === undefined || value === null) return
    const text = String(value).trim()
    if (text) lines.push(`${key}=${text}`)
  }
  push('WEIXIN_ACCOUNT_ID', member.accountId)
  push('WEIXIN_TOKEN', process.env.__MEMBER_TOKEN__)
  push('WEIXIN_BASE_URL', baseUrl || ILINK_BASE)
  push('WEIXIN_CDN_BASE_URL', ILINK_CDN_DEFAULT)
  // 与主 bot 一致：开放私聊，任何加到该 bot 的人可直接对话（即本人）。
  push('WEIXIN_DM_POLICY', 'open')
  push('WEIXIN_ALLOW_ALL_USERS', 'true')
  // 成员网关需走本机 Clash 代理才能连通 iLink，外网直连在部分网络下会 ssl 失败
  const proxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.https_proxy || process.env.http_proxy || 'http://127.0.0.1:7897'
  push('HTTPS_PROXY', proxy)
  push('HTTP_PROXY', proxy)
  push('NO_PROXY', '127.0.0.1,localhost,::1')
  push('no_proxy', '127.0.0.1,localhost,::1')
  // 模型凭据与知识库共享：成员 Agent 调同一套本地服务。
  push('OPENCODE_GO_API_KEY', process.env.OPENCODE_GO_API_KEY)
  for (const key of [
    'AGNET_LLM_WIKI_API_TOKEN',
    'LLM_WIKI_API_TOKEN',
    'LLM_WIKI_BASE_URL',
    'LLM_WIKI_API_BASE_URL',
    'LLM_WIKI_MCP_TOOLSET',
  ]) {
    push(key, process.env[key])
  }
  return lines
}

/** 从研究 profile 复制知识库技能（knowledge-control 等）到成员 home。 */
async function copyKnowledgeSkills(memberHome: string): Promise<void> {
  try {
    const { cp, mkdir } = await import('fs/promises')
    const srcSkills = join(getHermesBaseDir(), 'profiles', 'research', 'skills')
    if (!existsSync(srcSkills)) return
    const dstSkills = join(memberHome, 'skills')
    await mkdir(dstSkills, { recursive: true })
    await cp(srcSkills, dstSkills, { recursive: true, force: true })
  } catch (err) {
    logger.warn(err, '[wechat-members] copy skills failed (member will lack KB skill)')
  }
}

export async function fetchQrcode(): Promise<{ qrcode: string; qrcode_url: string }> {
  const res = await axios.get(`${ILINK_BASE}/ilink/bot/get_bot_qrcode`, {
    params: { bot_type: 3 },
    timeout: 15000,
  })
  const data = res.data || {}
  if (!data.qrcode) throw new Error('Failed to get QR code')
  return { qrcode: String(data.qrcode), qrcode_url: String(data.qrcode_img_content || '') }
}

export async function pollQrcodeStatus(
  qrcode: string,
): Promise<{ status: string; account_id?: string; token?: string; base_url?: string }> {
  const res = await axios.get(`${ILINK_BASE}/ilink/bot/get_qrcode_status`, {
    params: { qrcode },
    timeout: 35000,
  })
  const data = res.data || {}
  const status = data?.status || 'wait'
  if (status !== 'confirmed') return { status }
  return {
    status: 'confirmed',
    account_id: data.ilink_bot_id,
    token: data.bot_token,
    base_url: data.baseurl,
  }
}

export interface BindInput {
  displayName?: string
  accountId: string
  token: string
  baseUrl?: string
}

export async function bindMember(input: BindInput): Promise<WechatMember> {
  const trimmedToken = String(input.token || '').trim()
  const accountId = String(input.accountId || '').trim()
  if (!accountId || !trimmedToken) throw new Error('Missing account_id or token')

  const store = await readStore()
  const activeCount = store.members.filter(m => m.status === 'active').length
  if (store.maxMembers > 0 && activeCount >= store.maxMembers) {
    throw new Error(`成员数已达上限（${store.maxMembers}），请先解绑部分成员`)
  }
  const dup = store.members.find(m => m.status === 'active' && m.accountId === accountId)
  if (dup) {
    throw new Error(`该微信账号已绑定为成员“${dup.displayName}”，无需重复添加`)
  }

  const id = randomUUID().replace(/-/g, '').slice(0, 8)
  const member: WechatMember = {
    id,
    displayName: (input.displayName || '').trim() || `成员-${id.slice(0, 4).toUpperCase()}`,
    accountId,
    profileName: `wx-${id}`,
    boundAt: new Date().toISOString(),
    status: 'active',
  }
  const home = memberHomeDir(member)

  // 1) 独立 hermes home：config.yaml + .env + 技能目录
  await safeFileStore.writeYaml(join(home, 'config.yaml'), buildMemberConfigYaml())
  await copyKnowledgeSkills(home)
  // token 通过临时环境变量传递给 env 构建器，避免写入 JSON 存储。
  process.env.__MEMBER_TOKEN__ = trimmedToken
  try {
    const envText =
      '# AGNET wechat member bindings (auto-generated)\n' +
      buildMemberEnvLines(member, input.baseUrl).join('\n') +
      '\n'
    await safeFileStore.writeText(join(home, '.env'), envText)
  } finally {
    delete process.env.__MEMBER_TOKEN__
  }

  // 2) 记录并启动专属网关进程
  store.members.push(member)
  await writeStore(store)
  try {
    startGatewayRunManaged(resolveHermesBin(), { profileDir: home })
    logger.info(
      '[wechat-members] member %s (%s) bound, gateway starting in %s',
      member.id, member.displayName, home,
    )
  } catch (err) {
    logger.error(err, '[wechat-members] failed to start gateway for member %s', member.id)
  }
  return member
}

export interface MemberView extends WechatMember {
  running: boolean
  homeDir: string
  activity: MemberActivity
}

export async function listMembers(): Promise<{ maxMembers: number; members: MemberView[] }> {
  const store = await readStore()
  return {
    maxMembers: store.maxMembers,
    members: store.members.map(member => {
      const running = member.status === 'active' && isMemberGatewayRunning(member)
      return {
        ...member,
        running,
        homeDir: memberHomeDir(member),
        activity: summarizeActivity(memberHomeDir(member)),
      }
    }),
  }
}

export async function unbindMember(id: string, opts: { purge?: boolean } = {}): Promise<boolean> {
  const store = await readStore()
  const member = store.members.find(m => m.id === id)
  if (!member) return false

  // 停掉该成员的网关进程（含托管 respawn 清理）。
  try {
    await retireManagedGatewayForProfile(memberHomeDir(member))
  } catch (err) {
    logger.warn(err, '[wechat-members] retire gateway failed for %s', id)
  }

  member.status = 'revoked'
  await writeStore(store)

  if (opts.purge) {
    const { rm } = await import('fs/promises')
    await rm(memberHomeDir(member), { recursive: true, force: true }).catch(() => undefined)
    store.members = store.members.filter(m => m.id !== id)
    await writeStore(store)
  }
  return true
}
