
<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { NAlert, NButton, NEmpty, NSpin, NTag, NSwitch, NInput, NCollapse, NCollapseItem, useMessage } from 'naive-ui'
import { useRouter } from 'vue-router'
import {
  fetchWorkbenchSummary,
  type ServiceStatus,
  type WorkbenchSummary,
} from '@/api/workbench'
import { getStoredUsername } from '@/api/client'
import { useProfilesStore } from '@/stores/hermes/profiles'
import { useSettingsStore } from '@/stores/hermes/settings'
import { fetchProfileRuntimeStatus, startProfileGateway, stopProfileGateway, restartProfileGateway } from '@/api/hermes/profiles'
import type { ProfileRuntimeStatus } from '@/api/hermes/profiles'
import { fetchWeixinQrCode, pollWeixinQrStatus, saveWeixinCredentials } from '@/api/hermes/config'
import {
  bindWechatMember,
  fetchWechatMemberQr,
  listWechatMembers,
  pollWechatMemberQrStatus,
  unbindWechatMember,
  type WechatMemberView,
} from '@/api/knowledge-workbench'

const message = useMessage()
const router = useRouter()
const profilesStore = useProfilesStore()
const settingsStore = useSettingsStore()

const loading = ref(false)
const error = ref('')
const summary = ref<WorkbenchSummary | null>(null)
const username = ref(getStoredUsername())

// --- Gateway state ---
const gatewayStatus = ref<ProfileRuntimeStatus['gateway'] | null>(null)
const gatewayLoading = ref(false)
const gatewayAction = ref<'' | 'start' | 'stop' | 'restart'>('')
const gatewayError = ref('')
const activeProfileName = computed(() => profilesStore.activeProfileName || profilesStore.profiles.find(p=>p.active)?.name || 'default')
const gatewayRunning = computed(() => gatewayStatus.value?.running === true)
const gatewayUnified = computed(() => gatewayStatus.value?.unified === true)
const gatewayTargetProfile = computed(() => gatewayStatus.value?.targetProfile || activeProfileName.value)

// --- Weixin QR state ---
const wxQrUrl = ref('')
const wxQrId = ref('')
const wxQrStatus = ref<'idle' | 'loading' | 'waiting' | 'scaned' | 'confirmed' | 'error' | 'expired'>('idle')
let wxPollTimer: ReturnType<typeof setTimeout> | null = null
const wxManualSaving = ref(false)
const wxToken = ref('')
const wxAccountId = ref('')
const wxBaseUrl = ref('')

const weixinConfigured = computed(() => {
  const plat = (settingsStore.platforms as any)?.weixin || {}
  const w = (settingsStore.weixin as any) || {}
  const token = plat.token || w.token || wxToken.value
  const accountId = plat.extra?.account_id || w.extra?.account_id || wxAccountId.value
  return !!token && !!accountId
})

// --- 多成员接入状态 ---
const members = ref<WechatMemberView[]>([])
const memberMax = ref(0) // 0 = 无限制
const memberQrUrl = ref('')
const memberQrId = ref('')
const memberQrStatus = ref<'idle' | 'loading' | 'waiting' | 'scaned' | 'confirmed' | 'error'>('idle')
const memberDisplayName = ref('')
const memberBinding = ref(false)
let memberPollTimer: ReturnType<typeof setTimeout> | null = null
let memberListTimer: ReturnType<typeof setInterval> | null = null
let memberAutoTimer: ReturnType<typeof setInterval> | null = null

async function loadMembers() {
  try {
    const data = await listWechatMembers()
    members.value = data.members
    memberMax.value = data.maxMembers
  } catch { /* 静默：列表失败不阻塞工作台 */ }
}

const visibleMembers = computed(() => members.value)
const activeMemberCount = computed(() => members.value.filter(m => m.status === 'active' && m.running).length)
function isMemberBusy(m: WechatMemberView): boolean {
  return m.status === 'active' && (m.activity?.activeAgents ?? 0) > 0
}
function avatarText(name: string): string {
  return (name || '?').trim().slice(0, 1).toUpperCase()
}
function memberStateType(m: WechatMemberView): 'success' | 'warning' | 'default' {
  if (m.status !== 'active') return 'default'
  return m.running ? 'success' : 'warning'
}
function memberStateText(m: WechatMemberView): string {
  if (m.status !== 'active') return '已解绑'
  return m.running ? '在线' : '启动中/离线'
}
function relativeActivity(m: WechatMemberView): string {
  const iso = m.activity?.lastActivityAt
  if (!iso) return '从未使用'
  const ts = Date.parse(iso)
  if (!Number.isFinite(ts)) return '未知'
  const diff = Date.now() - ts
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  return `${Math.floor(diff / 86_400_000)} 天前`
}

async function startMemberQrLogin() {
  memberQrStatus.value = 'loading'
  memberQrUrl.value = ''
  memberQrId.value = ''
  if (memberPollTimer) clearTimeout(memberPollTimer)
  try {
    const data = await fetchWechatMemberQr()
    memberQrId.value = data.qrcode
    memberQrUrl.value = data.qrcode_url
    memberQrStatus.value = 'waiting'
    pollMemberQrStatus()
  } catch (err: any) {
    memberQrStatus.value = 'error'
    message.error(err?.message || '获取成员二维码失败')
  }
}

function pollMemberQrStatus() {
  if (!memberQrId.value) return
  memberPollTimer = setTimeout(async () => {
    try {
      const data = await pollWechatMemberQrStatus(memberQrId.value)
      if (data.status === 'wait') { pollMemberQrStatus(); return }
      if (data.status === 'scaned' || data.status === 'scaned_but_redirect') {
        memberQrStatus.value = 'scaned'
        pollMemberQrStatus()
        return
      }
      if (data.status === 'expired') {
        memberQrStatus.value = 'idle'
        message.warning('成员二维码已过期，请重新获取')
        return
      }
      if (data.status === 'confirmed' && data.account_id && data.token) {
        memberQrStatus.value = 'confirmed'
        memberBinding.value = true
        try {
          const member = await bindWechatMember({
            displayName: memberDisplayName.value.trim() || undefined,
            account_id: data.account_id,
            token: data.token,
            base_url: data.base_url || undefined,
          })
          message.success(`成员「${member.displayName}」已绑定，专属网关启动中`)
          memberDisplayName.value = ''
          memberQrUrl.value = ''
          await loadMembers()
          scheduleMemberListRefresh()
        } finally {
          memberBinding.value = false
        }
      }
    } catch {
      pollMemberQrStatus()
    }
  }, 2500)
}

function scheduleMemberListRefresh() {
  // 网关进程启动需要数秒，轮询几次刷新 running 状态。
  let ticks = 0
  if (memberListTimer) clearInterval(memberListTimer)
  memberListTimer = setInterval(async () => {
    ticks += 1
    await loadMembers()
    if (ticks >= 6 || members.value.every(m => m.running || m.status !== 'active')) {
      if (memberListTimer) clearInterval(memberListTimer)
      memberListTimer = null
    }
  }, 3000)
}

async function handleUnbindMember(id: string) {
  try {
    await unbindWechatMember(id)
    message.success('已解绑并停止其网关')
    await loadMembers()
  } catch (err: any) {
    message.error(err?.message || '解绑失败')
  }
}

const weixinTokenDisplay = computed(() => {
  const plat = (settingsStore.platforms as any)?.weixin || {}
  const w = (settingsStore.weixin as any) || {}
  return plat.token || w.token || ''
})
const weixinAccountDisplay = computed(() => {
  const plat = (settingsStore.platforms as any)?.weixin || {}
  const w = (settingsStore.weixin as any) || {}
  return plat.extra?.account_id || w.extra?.account_id || plat.account_id || w.account_id || ''
})

function syncWeixinDraftsFromStore() {
  const plat = (settingsStore.platforms as any)?.weixin || {}
  const w = (settingsStore.weixin as any) || {}
  wxToken.value = plat.token || w.token || ''
  wxAccountId.value = plat.extra?.account_id || w.extra?.account_id || plat.account_id || w.account_id || ''
  wxBaseUrl.value = plat.extra?.base_url || w.extra?.base_url || plat.base_url || ''
}
watch(() => [settingsStore.platforms, settingsStore.weixin], () => syncWeixinDraftsFromStore(), { deep: true })

const gatewayAutoEnabled = computed({
  get: () => settingsStore.gatewayAutoStart.enabled !== false,
  set: (v: boolean) => { void toggleGatewayAutoStart(v) }
})
const gatewayAutoSaving = ref(false)
async function toggleGatewayAutoStart(enabled: boolean) {
  gatewayAutoSaving.value = true
  try {
    await settingsStore.saveSection('gatewayAutoStart', { enabled })
    message.success(enabled ? '已开启 Gateway 自动启动' : '已关闭 Gateway 自动启动')
  } catch (err: any) {
    message.error(err?.message || '保存失败')
  } finally {
    gatewayAutoSaving.value = false
  }
}

const greeting = computed(() => {
  const hour = new Date().getHours()
  if (hour < 11) return '早上好，'
  if (hour < 14) return '中午好，'
  if (hour < 18) return '下午好，'
  return '晚上好，'
})

interface FeatureCard {
  key: string
  title: string
  desc: string
  meta: string
  to: { name: string; query?: Record<string, string> }
  icon: 'book' | 'chat' | 'memory' | 'history' | 'agent' | 'jobs' | 'papers' | 'settings'
}

const featureCards = computed<FeatureCard[]>(() => {
  const k = summary.value?.knowledge
  return [
    {
      key: 'knowledge',
      title: '个人知识库',
      desc: '管理本地知识库与论文，沉淀可信内容。',
      meta: k ? `可信 ${k.trusted ?? 0} 篇论文${(k.sources ?? 0) > 0 ? ` · ${k.sources ?? 0} 篇文章` : ''}` : '本地知识',
      to: { name: 'hermes.knowledge', query: { tab: 'management' } },
      icon: 'book',
    },
    {
      key: 'chat',
      title: 'Hermes 对话',
      desc: '与智能体对话，处理复杂任务与工作流。',
      meta: '开始新对话',
      to: { name: 'hermes.chat' },
      icon: 'chat',
    },
    {
      key: 'memory',
      title: '记忆管理',
      desc: '查看与编辑智能体的长期记忆。',
      meta: '长期记忆',
      to: { name: 'hermes.memory' },
      icon: 'memory',
    },
    {
      key: 'history',
      title: '会话历史',
      desc: '回顾过往的对话与任务记录。',
      meta: '回顾过往',
      to: { name: 'hermes.history' },
      icon: 'history',
    },
    {
      key: 'agent',
      title: '全局智能体',
      desc: '调用跨会话的通用智能体能力。',
      meta: '跨会话',
      to: { name: 'hermes.globalAgent' },
      icon: 'agent',
    },
    {
      key: 'jobs',
      title: '定时任务',
      desc: '管理自动触发的定时任务与守护进程（Cron）。',
      meta: '自动触发',
      to: { name: 'hermes.jobs' },
      icon: 'jobs',
    },
    {
      key: 'papers',
      title: '论文推荐',
      desc: '依据本地知识库，定时推荐相似的顶会论文。',
      meta: summary.value?.paperRecommendations?.count ? `已推荐 ${summary.value.paperRecommendations.count} 篇` : '每 6 小时刷新',
      to: { name: 'hermes.knowledge', query: { tab: 'candidates' } },
      icon: 'papers',
    },
    {
      key: 'settings',
      title: '模型与设置',
      desc: '配置模型、外观与系统偏好。',
      meta: '配置',
      to: { name: 'hermes.settings' },
      icon: 'settings',
    },
  ]
})

function formatDateTime(value: string | null | undefined, fallback = '暂无数据'): string {
  if (!value) return fallback
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
}

function statusLabel(status: ServiceStatus | string | null): string {
  const labels: Record<string, string> = {
    ok: '正常',
    degraded: '部分可用',
    down: '不可用',
    unknown: '未检查',
    success: '已生成',
    failed: '生成失败',
    partial: '部分完成',
  }
  return labels[status || 'unknown'] || status || '未检查'
}

function tagType(status: ServiceStatus | string): 'success' | 'warning' | 'error' | 'default' {
  if (status === 'ok' || status === 'success') return 'success'
  if (status === 'degraded' || status === 'partial') return 'warning'
  if (status === 'down' || status === 'failed') return 'error'
  return 'default'
}

async function loadSummary() {
  loading.value = true
  error.value = ''
  try {
    summary.value = await fetchWorkbenchSummary()
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : '工作台加载失败'
  } finally {
    loading.value = false
  }
}

async function loadGateway() {
  gatewayLoading.value = true
  gatewayError.value = ''
  try {
    if (!profilesStore.profiles.length) await profilesStore.fetchProfiles()
    if (!profilesStore.activeProfileName && profilesStore.profiles.length) await profilesStore.fetchProfiles()
    const name = activeProfileName.value
    const status = await fetchProfileRuntimeStatus(name)
    gatewayStatus.value = status.gateway
  } catch (err: any) {
    gatewayError.value = err?.message || '无法获取 Gateway 状态'
  } finally {
    gatewayLoading.value = false
  }
}

async function handleStartGateway() {
  gatewayAction.value = 'start'
  gatewayError.value = ''
  try {
    const gw = await startProfileGateway(activeProfileName.value)
    gatewayStatus.value = gw
    message.success('Gateway 已启动')
    void loadSummary()
  } catch (err: any) {
    gatewayError.value = err?.message || '启动失败'
    message.error(gatewayError.value)
  } finally {
    gatewayAction.value = ''
  }
}
async function handleStopGateway() {
  gatewayAction.value = 'stop'
  gatewayError.value = ''
  try {
    const gw = await stopProfileGateway(activeProfileName.value)
    gatewayStatus.value = gw
    message.success('Gateway 已停止')
    void loadSummary()
  } catch (err: any) {
    gatewayError.value = err?.message || '停止失败'
    message.error(gatewayError.value)
  } finally {
    gatewayAction.value = ''
  }
}
async function handleRestartGateway() {
  gatewayAction.value = 'restart'
  gatewayError.value = ''
  try {
    const gw = await restartProfileGateway(activeProfileName.value)
    gatewayStatus.value = gw
    message.success('Gateway 已重启')
    void loadSummary()
  } catch (err: any) {
    gatewayError.value = err?.message || '重启失败'
    message.error(gatewayError.value)
  } finally {
    gatewayAction.value = ''
  }
}

async function startWeixinQrLogin() {
  wxQrStatus.value = 'loading'
  wxQrUrl.value = ''
  wxQrId.value = ''
  stopWeixinPoll()
  try {
    const data = await fetchWeixinQrCode()
    wxQrId.value = data.qrcode
    wxQrUrl.value = data.qrcode_url
    if (data.qrcode_url) window.open(data.qrcode_url, '_blank')
    wxQrStatus.value = 'waiting'
    pollWeixinStatus()
  } catch (err: any) {
    wxQrStatus.value = 'error'
    message.error(err.message || '获取二维码失败')
  }
}
function pollWeixinStatus() {
  if (!wxQrId.value) return
  wxPollTimer = setTimeout(async () => {
    try {
      const data = await pollWeixinQrStatus(wxQrId.value)
      if (data.status === 'wait') {
        pollWeixinStatus()
      } else if (data.status === 'scaned' || data.status === 'scaned_but_redirect') {
        wxQrStatus.value = 'scaned'
        pollWeixinStatus()
      } else if (data.status === 'expired') {
        wxQrStatus.value = 'expired'
        message.warning('二维码已过期，请重新获取')
      } else if (data.status === 'confirmed') {
        wxQrStatus.value = 'confirmed'
        await saveWeixinCredentials({ account_id: data.account_id!, token: data.token!, base_url: data.base_url })
        await settingsStore.fetchSettings()
        syncWeixinDraftsFromStore()
        message.success('微信已绑定，Gateway 正在重启...')
        void loadGateway()
        void loadSummary()
      }
    } catch {
      pollWeixinStatus()
    }
  }, 2500)
}
function stopWeixinPoll() {
  if (wxPollTimer) { clearTimeout(wxPollTimer); wxPollTimer = null }
}
async function handleSaveWeixinManual() {
  if (!wxToken.value.trim() || !wxAccountId.value.trim()) {
    message.warning('请填写 Token 与 Account ID')
    return
  }
  wxManualSaving.value = true
  try {
    await saveWeixinCredentials({ account_id: wxAccountId.value.trim(), token: wxToken.value.trim(), base_url: wxBaseUrl.value.trim() || undefined })
    await settingsStore.fetchSettings()
    syncWeixinDraftsFromStore()
    message.success('微信凭据已保存，Gateway 已重启')
    void loadGateway()
  } catch (err: any) {
    message.error(err?.message || '保存失败')
  } finally {
    wxManualSaving.value = false
  }
}
function goChannels() { router.push({ name: 'hermes.channels' }) }
function goProfiles() { router.push({ name: 'hermes.profiles' }) }

onMounted(() => {
  void loadSummary()
  void loadGateway()
  void loadMembers()
  // 成员在线/对话状态每 8 秒自动刷新。
  memberAutoTimer = setInterval(() => { void loadMembers() }, 8000)
  const p = settingsStore.fetchSettings().then(() => syncWeixinDraftsFromStore())
  void p
})
onUnmounted(() => {
  stopWeixinPoll()
  if (memberPollTimer) { clearTimeout(memberPollTimer); memberPollTimer = null }
  if (memberListTimer) { clearInterval(memberListTimer); memberListTimer = null }
  if (memberAutoTimer) { clearInterval(memberAutoTimer); memberAutoTimer = null }
})
</script>
<template>
  <div class="workbench-page">
    <div class="workbench-content">
      <NAlert v-if="error" class="workbench-alert" type="error" :title="summary ? '部分数据刷新失败' : '无法加载工作台'">
        {{ error }}
        <NButton class="alert-retry" size="tiny" @click="loadSummary">重试</NButton>
      </NAlert>

      <div v-if="loading && !summary" class="workbench-state">
        <NSpin size="medium" description="正在汇总本地服务状态…" />
      </div>

      <template v-else>
        <section class="home-hero" aria-label="欢迎">
          <button class="home-hero-refresh" type="button" :disabled="loading" :aria-busy="loading" @click="loadSummary">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <polyline points="23 4 23 10 17 10" />
              <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
            </svg>
            刷新
          </button>
          <p class="home-eyebrow">Workspace</p>
          <h1 class="home-title">{{ greeting }}<template v-if="username">{{ username }}</template></h1>
          <p class="home-subtitle">在一处管理你的知识库、对话与记忆。微信联动与 Gateway 控制已集成到本页。</p>
          <div class="home-stats" v-if="summary">
            <div class="home-stat">
              <span class="home-stat-value">{{ summary.knowledge.todayPapers ?? 0 }}</span>
              <span class="home-stat-label">今日论文</span>
            </div>
            <div class="home-stat">
              <span class="home-stat-value">{{ summary.knowledge.trusted ?? 0 }}</span>
              <span class="home-stat-label">可信知识库</span>
            </div>
            <div class="home-stat">
              <span class="home-stat-value">{{ summary.knowledge.awaitingReview ?? 0 }}</span>
              <span class="home-stat-label">待审核</span>
            </div>
            <div class="home-stat">
              <span class="home-stat-value">{{ gatewayRunning ? '运行中' : '已停止' }}</span>
              <span class="home-stat-label">Gateway · {{ activeProfileName }}</span>
            </div>
          </div>
        </section>

        <!-- 微信联动 · Gateway 控制 -->
        <section class="workbench-section gateway-weixin-section" aria-labelledby="gateway-weixin-title">
          <div class="workbench-section-header">
            <h3 id="gateway-weixin-title" class="workbench-section-title">微信联动 · Gateway 控制</h3>
            <div style="display:flex;gap:8px;align-items:center">
              <NTag :type="gatewayRunning ? 'success' : 'error'" size="small" :bordered="false">{{ gatewayRunning ? 'Gateway 运行中' : 'Gateway 已停止' }}</NTag>
              <NTag v-if="weixinConfigured" type="success" size="small" :bordered="false">微信已绑定</NTag>
              <NTag v-else type="warning" size="small" :bordered="false">微信未绑定</NTag>
            </div>
          </div>
          <p class="workbench-section-note" style="margin-bottom:12px">Hermes 通过 Gateway 进程与微信（Weixin）保持长连接。手机微信扫码后即可在微信里给 Hermes 发号施令；关闭 Gateway 将断开所有渠道。</p>

          <div class="gw-wx-grid">
            <!-- Gateway 卡 -->
            <div class="gw-card">
              <div class="gw-card-head">
                <h4 class="gw-card-title">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="7" width="18" height="10" rx="2"/><path d="M7 7V5a5 5 0 0 1 10 0v2"/><circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none"/></svg>
                  Gateway 控制
                </h4>
                <NButton size="tiny" quaternary @click="loadGateway" :loading="gatewayLoading">刷新</NButton>
              </div>

              <div class="gw-status">
                <span class="status-dot" :class="gatewayRunning ? 'running' : 'stopped'"></span>
                <span class="gw-status-text">{{ gatewayRunning ? '运行中' : '已停止' }}</span>
                <span class="gw-profile">profile: {{ gatewayTargetProfile }}</span>
                <NTag v-if="gatewayUnified" size="tiny" type="info" :bordered="false" style="margin-left:6px">统一网关</NTag>
              </div>
              <div v-if="gatewayStatus?.pid" class="gw-meta">PID {{ gatewayStatus.pid }}<template v-if="gatewayStatus?.url"> · {{ gatewayStatus.url }}</template></div>
              <div v-if="gatewayError" class="gw-error">{{ gatewayError }}</div>

              <div class="gw-actions">
                <NButton size="small" type="primary" :loading="gatewayAction==='start'" :disabled="gatewayRunning" @click="handleStartGateway">启动</NButton>
                <NButton size="small" :loading="gatewayAction==='stop'" :disabled="!gatewayRunning" @click="handleStopGateway">停止</NButton>
                <NButton size="small" :loading="gatewayAction==='restart'" @click="handleRestartGateway">重启</NButton>
                <NButton size="small" quaternary @click="goProfiles">配置管理</NButton>
              </div>

              <div class="gw-divider"></div>

              <div class="gw-row">
                <span class="gw-row-label">自动启动</span>
                <NSwitch :value="gatewayAutoEnabled" :loading="gatewayAutoSaving" @update:value="toggleGatewayAutoStart" />
              </div>
              <p class="gw-hint">开启后，Studio 启动时会自动拉起 Gateway；关闭则需手动启动。此项写入 Web UI 配置，不影响 Hermes 既有会话。</p>

              <div class="gw-help">
                <NCollapse>
                  <NCollapseItem title="如何用命令行开启 / 关闭 Gateway？" name="cli">
                    <div class="help-block">
                      <p><code>hermes gateway start</code> —— 启动网关（或 <code>hermes gateway run</code> 前台运行）</p>
                      <p><code>hermes gateway stop</code> —— 停止网关</p>
                      <p><code>hermes gateway restart</code> —— 重启网关</p>
                      <p><code>hermes gateway status</code> —— 查看状态</p>
                      <p>指定配置：<code>HERMES_HOME=~/.hermes/profiles/&lt;name&gt; hermes gateway status</code> 或 <code>hermes --profile &lt;name&gt; gateway status</code></p>
                      <p>关闭自启：设置环境变量 <code>HERMES_GATEWAY_AUTOSTART=0</code> 或在“模型与设置 → Gateway 自动启动”中关闭。</p>
                      <p>日志：<code>~/.hermes/&lt;profile&gt;/logs/gateway.log</code> 或本页“本地服务”状态。</p>
                    </div>
                  </NCollapseItem>
                </NCollapse>
              </div>
            </div>

            <!-- Weixin 卡 -->
            <div class="gw-card">
              <div class="gw-card-head">
                <h4 class="gw-card-title">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M8 12a3 3 0 0 1 3-3h2a3 3 0 0 1 3 3v1a3 3 0 0 1-3 3h-.5L10 18l.5-2H11a3 3 0 0 1-3-3v-1z"/><path d="M16 8a3 3 0 0 1 3 3v1a2.5 2.5 0 0 1-2.5 2.5H16"/></svg>
                  微信连接（Weixin）
                </h4>
                <NTag :type="weixinConfigured ? 'success' : 'warning'" size="small" :bordered="false">{{ weixinConfigured ? '已配置' : '未配置' }}</NTag>
              </div>

              <p class="gw-hint" style="margin-top:0">扫码绑定后，Hermes 会通过 iLink 网关在微信中响应你。同一时间同一微信账号只能被一个 profile 独占。</p>

              <div class="wx-qr-area">
                <div class="wx-qr-actions">
                  <NButton type="primary" size="small" :loading="wxQrStatus==='loading'" @click="startWeixinQrLogin">{{ wxQrStatus==='confirmed' ? '重新扫码' : '扫码登录微信' }}</NButton>
                  <NButton size="small" quaternary @click="goChannels">前往频道设置</NButton>
                  <span v-if="wxQrStatus==='waiting'" class="wx-hint">等待扫码…</span>
                  <span v-else-if="wxQrStatus==='scaned'" class="wx-hint scaned">已扫码，请在手机上确认</span>
                  <span v-else-if="wxQrStatus==='confirmed'" class="wx-hint success">✓ 已确认并绑定</span>
                  <span v-else-if="wxQrStatus==='expired'" class="wx-hint error">二维码已过期</span>
                  <span v-else-if="wxQrStatus==='error'" class="wx-hint error">获取失败</span>
                </div>
                <div v-if="wxQrUrl" class="wx-qr-preview">
                  <a :href="wxQrUrl" target="_blank" rel="noopener">
                    <img :src="wxQrUrl" alt="微信扫码二维码" class="wx-qr-img" />
                  </a>
                  <p class="wx-qr-tip">若二维码未自动弹出，请 <a :href="wxQrUrl" target="_blank">点此在新窗口打开</a> 后用手机微信扫码。</p>
                </div>
              </div>

              <div class="gw-divider"></div>

              <div class="wx-manual">
                <div class="wx-field">
                  <label class="wx-label">Token</label>
                  <NInput v-model:value="wxToken" size="small" placeholder="WEIXIN_TOKEN" clearable />
                </div>
                <div class="wx-field">
                  <label class="wx-label">Account ID</label>
                  <NInput v-model:value="wxAccountId" size="small" placeholder="WEIXIN_ACCOUNT_ID" clearable />
                </div>
                <div class="wx-field">
                  <label class="wx-label">Base URL <span class="muted">（可选）</span></label>
                  <NInput v-model:value="wxBaseUrl" size="small" placeholder="https://..." clearable />
                </div>
                <div class="wx-field-actions">
                  <NButton type="primary" size="small" :loading="wxManualSaving" @click="handleSaveWeixinManual">保存并重启 Gateway</NButton>
                  <span class="gw-hint" style="margin:0">保存后会自动重启 Gateway 使微信配置生效。</span>
                </div>
                <p v-if="weixinTokenDisplay || weixinAccountDisplay" class="wx-current">当前：Token {{ weixinTokenDisplay ? '••••' + weixinTokenDisplay.slice(-4) : '未设置' }} · Account {{ weixinAccountDisplay || '未设置' }}</p>
              </div>

              <div class="gw-divider"></div>

              <!-- 多成员接入：每人扫码绑定专属 bot，独立会话共享知识库 -->
              <div class="member-section">
                <div class="wx-field-actions" style="justify-content: space-between">
                  <b style="font-size:13px">多成员接入（{{ activeMemberCount }}/{{ memberMax > 0 ? memberMax : '∞' }} 在线）</b>
                  <NButton type="primary" size="tiny" secondary :disabled="memberMax > 0 && members.filter(m => m.status === 'active').length >= memberMax" :loading="memberQrStatus === 'loading' || memberBinding" @click="startMemberQrLogin">添加成员（扫码）</NButton>
                </div>
                <p class="gw-hint" style="margin:4px 0 8px">每个成员用<b>自己的微信</b>扫一次码，即获得专属机器人与独立会话（互不可见），并共享同一个知识库。无需加好友。列表每 8 秒自动刷新。</p>

                <div v-if="memberQrUrl && memberQrStatus !== 'confirmed'" class="wx-qr-preview">
                  <p class="wx-qr-tip" style="margin:0 0 4px">
                    请成员用手机微信扫码确认 · {{ memberQrStatus === 'scaned' ? '已扫码，等待确认…' : '等待扫码…' }}
                  </p>
                  <NButton size="small" type="primary" tag="a" :href="memberQrUrl" target="_blank" rel="noopener">打开二维码图片</NButton>
                  <span class="gw-hint" style="margin-left:8px">若无法显示，把链接发给成员，在手机浏览器打开后长按识别即可</span>
                  <div style="margin-top:6px">
                    <NInput v-model:value="memberDisplayName" size="small" placeholder="备注名（可选，如：张三）" style="max-width:220px" />
                  </div>
                </div>

                <div v-if="visibleMembers.length" class="member-grid">
                  <div v-for="m in visibleMembers" :key="m.id" class="member-card" :class="{ 'is-busy': isMemberBusy(m), 'is-offline': m.status !== 'active' || !m.running }">
                    <div class="member-card__head">
                      <span class="member-avatar">{{ avatarText(m.displayName) }}</span>
                      <div class="member-idbox">
                        <b class="member-name">{{ m.displayName }}</b>
                        <code class="member-account">{{ m.accountId.slice(0, 10) }}…</code>
                      </div>
                      <span v-if="isMemberBusy(m)" class="member-live"><i class="pulse-dot" />对话中</span>
                      <NTag v-else size="tiny" :bordered="false" :type="memberStateType(m)">{{ memberStateText(m) }}</NTag>
                    </div>
                    <div class="member-card__meta">
                      <span>最近活动：{{ relativeActivity(m) }}</span>
                      <span v-if="m.activity?.lastEvent">· {{ m.activity.lastEvent === 'inbound' ? '收到消息' : '已回复' }}</span>
                      <span v-if="m.activity?.activeAgents > 0">· {{ m.activity.activeAgents }} 个会话处理中</span>
                    </div>
                    <div class="member-card__foot">
                      <span class="member-bound">绑定于 {{ m.boundAt.slice(0, 10) }}</span>
                      <NPopconfirm v-if="m.status === 'active'" @positive-click="handleUnbindMember(m.id)">
                        <template #trigger><NButton size="tiny" type="error" quaternary>解绑</NButton></template>
                        解绑「{{ m.displayName }}」？将停止其专属网关；聊天记录保留在其独立目录。
                      </NPopconfirm>
                    </div>
                  </div>
                </div>
                <p v-else class="gw-hint" style="margin:6px 0 0">还没有成员。点“添加成员（扫码）”邀请第一位同事接入。</p>
              </div>

              <div class="gw-help">
                <NCollapse>
                  <NCollapseItem title="微信绑定常见问题" name="faq">
                    <div class="help-block">
                      <p><b>扫码后无响应？</b> 请确认 Gateway 处于运行中，且微信未被其他 profile 占用（独占 token 锁）。</p>
                      <p><b>换绑？</b> 重新扫码或手动更新 Token/Account ID 后重启 Gateway。</p>
                      <p><b>解绑？</b> 在“频道”中清空 weixin 的 Token 并保存，或删除环境变量后重启 Gateway。</p>
                    </div>
                  </NCollapseItem>
                  <NCollapseItem title="微信控制知识库 · 免 LLM Wiki 手动导入" name="kb">
                    <div class="help-block">
                      <p><b>导入公众号文章：</b> 在微信里发送 <code>https://mp.weixin.qq.com/s/... 帮我导入</code>，Hermes 会自动抓取正文（双 UA + 12 MB 上限 + 去重）并通过审核闸门**自动入库**（导入即审核决定，无需再回复批准），文章直接进入 <code>wiki/sources/*.md</code> 参与检索与知识图谱。</p>
                      <p><b>关键词检索：</b> 发送 <code>知识库里关于 数据湖 的文章有哪些？</code> 或 <code>帮我总结 湖仓 相关论文</code>，Hermes 会调用 <code>GET /api/knowledge/search</code> / <code>POST /api/knowledge/chat</code> 并带标题/路径/摘要引用回答。</p>
                      <p><b>管理：</b> <code>列一下待审核草稿</code> / <code>知识库概览</code> / <code>删除 wiki/sources/xxx.md</code> 均可通过语言直接完成。</p>
                      <p style="color:var(--warning);">提示：单链导入会自动通过审核直接入库（自动发现/订阅同步的文章仍需在审核队列人工批准）。知识页的 <b>AI 语义增强</b> 为手动可选步骤，可为文章补充摘要/实体/关系并丰富知识图谱。限流 6 次/分，重复链接会提示“已导入过”。</p>
                    </div>
                  </NCollapseItem>
                </NCollapse>
              </div>
            </div>
          </div>

          <div class="gw-steps">
            <h5 class="gw-steps-title">快速上手（4 步）</h5>
            <ol class="gw-steps-list">
              <li><b>启动 Gateway</b>：确保上侧 Gateway 显示为“运行中”（若未运行，点“启动”；需关闭时点“停止”。<code>自动启动</code> 开启后 Studio 启动时自动拉起）。</li>
              <li><b>绑定微信</b>：点“扫码登录微信”，用手机微信扫码并在手机上确认；也可在下方手动粘贴 Token/AccountID 保存并自动重启 Gateway。</li>
              <li><b>在微信中说话</b>：对已绑定的微信账号发送消息，Hermes 将通过 Gateway 回复；可在“频道”中配置白名单与回复策略。</li>
              <li><b>用微信控制知识库（免手动导入）</b>：在微信里直接发 <code>https://mp.weixin.qq.com/s/...</code> 链接并说“帮我导入”，Hermes 会自动抓取并**直接入库**（导入即审核决定，无需批准）。发关键词如“知识库里关于 数据治理 的文章有哪些？”即可让 Hermes 检索并引用已入库论文/文章。</li>
            </ol>
          </div>
          <div class="gw-steps" style="margin-top:12px; background: var(--bg-secondary); border-style: dashed;">
            <h5 class="gw-steps-title">微信控制知识库 · 常用语句（已全量接入 Hermes）</h5>
            <div class="help-block">
              <p><code>https://mp.weixin.qq.com/s/xxx 帮我收录</code> —— 单链导入（SSRF 白名单仅 mp.weixin.qq.com/s、6 次/分限流、内容哈希去重），草稿过闸后自动批准入库，返回已发布页面路径。</p>
              <p><code>批准 / 直接入库 / 帮我批准 abcd1234</code> —— 批准审核队列中的草稿（自动发现/订阅同步的文章，或自动入库降级时使用），写入 <code>wiki/sources/*.md</code> 后即可被关键词检索与知识图谱收录。</p>
              <p><code>知识库里有没有关于 数据湖 的论文？</code> —— Hermes 会调用 <code>GET /api/knowledge/search</code> 或 <code>POST /api/knowledge/chat</code> 并带引用回答（local_first，本地检索不外发）。</p>
              <p><code>列一下待审核草稿 / 知识库概览</code> —— Hermes 会查 <code>GET /api/knowledge/drafts</code> / <code>GET /api/knowledge/summary</code>。</p>
              <p><b>如何开启/关闭 Gateway：</b>本页 Gateway 卡点“启动 / 停止 / 重启”按钮；或命令行 <code>hermes gateway start</code> / <code>hermes gateway stop</code> / <code>hermes gateway restart</code> / <code>hermes gateway status</code>；指定 profile 用 <code>hermes --profile &lt;name&gt; gateway status</code>；关闭自启可设环境变量 <code>HERMES_GATEWAY_AUTOSTART=0</code> 或关闭本页自动启动开关。</p>
            </div>
          </div>
        </section>

        <nav class="home-cards" aria-label="功能入口">
          <RouterLink
            v-for="card in featureCards"
            :key="card.key"
            class="feature-card"
            :to="card.to"
          >
            <span class="feature-icon" aria-hidden="true">
              <svg v-if="card.icon === 'book'" width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
                <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" /><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
              </svg>
              <svg v-else-if="card.icon === 'chat'" width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
                <path d="M21 11.5a8.5 8.5 0 0 1-12.06 7.72L4 20l.78-4.94A8.5 8.5 0 1 1 21 11.5z" />
              </svg>
              <svg v-else-if="card.icon === 'memory'" width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
                <path d="M9 18h6" /><path d="M10 22h4" /><path d="M12 2a7 7 0 0 0-4 12.7V17h8v-2.3A7 7 0 0 0 12 2z" />
              </svg>
              <svg v-else-if="card.icon === 'history'" width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
                <path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5" /><path d="M12 8v4l3 2" />
              </svg>
              <svg v-else-if="card.icon === 'agent'" width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
                <rect x="5" y="8" width="14" height="10" rx="2" /><path d="M12 8V5" /><circle cx="12" cy="4" r="1.4" fill="currentColor" stroke="none" /><path d="M9.5 13h.01" /><path d="M14.5 13h.01" />
              </svg>
              <svg v-else-if="card.icon === 'jobs'" width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
                <rect x="3" y="4" width="18" height="18" rx="2" ry="2" /><line x1="16" y1="2" x2="16" y2="6" /><line x1="8" y1="2" x2="8" y2="6" /><line x1="3" y1="10" x2="21" y2="10" />
              </svg>
              <svg v-else-if="card.icon === 'papers'" width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
                <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" /><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" /><path d="M9 8h7" /><path d="M9 12h7" /><path d="M9 16h4" />
              </svg>
              <svg v-else width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
              </svg>
            </span>
            <div class="feature-body">
              <h3 class="feature-title">{{ card.title }}</h3>
              <p class="feature-desc">{{ card.desc }}</p>
            </div>
            <span class="feature-meta">{{ card.meta }}</span>
            <svg class="feature-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <polyline points="9 18 15 12 9 6" />
            </svg>
          </RouterLink>
        </nav>


        <section v-if="summary" class="workbench-section" aria-labelledby="service-status-title">
          <div class="workbench-section-header">
            <h3 id="service-status-title" class="workbench-section-title">本地服务</h3>
            <NTag :type="summary.knowledge.serviceOk ? 'success' : 'error'" size="small" :bordered="false">
              LLM Wiki {{ summary.knowledge.serviceOk ? '已连接' : '未连接' }}
            </NTag>
          </div>

          <div v-if="summary.services.length" class="workbench-list">
            <div v-for="service in summary.services" :key="service.name" class="workbench-list-item">
              <div class="workbench-list-main">
                <h4 class="workbench-list-title status-dot-label" :class="service.status">{{ service.name }}</h4>
                <p v-if="service.detail" class="workbench-list-summary">{{ service.detail }}</p>
              </div>
              <div class="workbench-list-actions">
                <NTag size="small" :type="tagType(service.status)" :bordered="false">{{ statusLabel(service.status) }}</NTag>
                <span v-if="service.checkedAt" class="workbench-section-note">{{ formatDateTime(service.checkedAt) }}</span>
              </div>
            </div>
          </div>
          <NEmpty v-else description="尚未获得服务健康状态" />
        </section>
      </template>

      <div v-if="!loading && !summary && !error" class="workbench-state">
        <NEmpty description="暂无工作台数据" />
      </div>
    </div>
  </div>
</template>
<style scoped lang="scss">
@use '@/styles/workbench';
@use '@/styles/variables' as *;

.feature-body {
  min-width: 0;
}
.gateway-weixin-section {
  margin-bottom: 28px;
  padding: 18px;
  border: 1px solid $border-color;
  border-radius: 12px;
  background: $bg-card;
}
.gw-wx-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
}
@media (max-width: 960px) {
  .gw-wx-grid { grid-template-columns: 1fr; }
}
.gw-card {
  padding: 14px;
  border: 1px solid $border-light;
  border-radius: 10px;
  background: $bg-card;
}
.gw-card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 10px;
}
.gw-card-title {
  margin: 0;
  display: inline-flex;
  align-items: center;
  gap: 7px;
  font-size: 13px;
  font-weight: 600;
  color: $text-primary;
}
.gw-status {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: $text-primary;
}
.status-dot {
  width: 8px; height: 8px; border-radius: 50%;
  &.running { background: var(--success); box-shadow: 0 0 0 4px rgba(var(--success-rgb),0.18); }
  &.stopped { background: var(--error); box-shadow: 0 0 0 4px rgba(var(--error-rgb),0.12); }
}
.gw-status-text { font-weight: 600; }
.gw-profile { color: $text-muted; font-size: 12px; font-family: $font-code; }
.gw-meta { margin-top: 6px; font-size: 12px; color: $text-muted; font-family: $font-code; word-break: break-all; }
.gw-error { margin-top: 8px; color: var(--error); font-size: 12px; }
.gw-actions { display: flex; gap: 8px; margin-top: 12px; flex-wrap: wrap; }
.gw-divider { height: 1px; background: $border-light; margin: 14px 0; }
.gw-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.gw-row-label { font-size: 13px; color: $text-primary; font-weight: 500; }
.gw-hint { color: $text-muted; font-size: 12px; line-height: 1.5; margin: 6px 0 0; }
.gw-help { margin-top: 10px; }
.help-block { font-size: 12px; line-height: 1.6; color: $text-secondary; }
.help-block p { margin: 4px 0; }
.help-block code { background: var(--code-bg); padding: 1px 4px; border-radius: 4px; font-family: $font-code; font-size: 11px; }
.wx-qr-area { margin-top: 8px; }
.wx-qr-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.wx-hint { font-size: 12px; color: $text-secondary; &.scaned{ color: var(--warning); } &.success{ color: var(--success); font-weight:600; } &.error{ color: var(--error); } }
.wx-qr-preview { margin-top: 10px; }
.wx-qr-img { width: 160px; height: 160px; object-fit: contain; border: 1px solid $border-color; border-radius: 8px; background: #fff; }
.wx-qr-tip { font-size: 12px; color: $text-muted; margin-top: 6px; }
.wx-qr-tip a { color: var(--brand); }
.wx-manual { display: flex; flex-direction: column; gap: 10px; }
.wx-field { display: flex; flex-direction: column; gap: 4px; }
.wx-label { font-size: 12px; color: $text-secondary; font-weight: 500; .muted{ font-weight:400; color:$text-muted; } }
.wx-field-actions { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.wx-current { font-size: 12px; color: $text-muted; font-family: $font-code; margin: 0; }

.member-section { display: block; }

.member-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(230px, 1fr));
  gap: 10px;
  margin-top: 8px;
}
.member-card {
  display: flex;
  flex-direction: column;
  gap: 7px;
  padding: 11px 12px;
  border: 1px solid $border-light;
  border-radius: $radius-sm;
  background: var(--bg-primary);
  transition: border-color .2s, box-shadow .2s;

  &.is-busy {
    border-color: #18a058;
    box-shadow: 0 0 0 1px rgba(24,160,88,.25), 0 2px 10px rgba(24,160,88,.12);
  }
  &.is-offline { opacity: .62; }
}
.member-card__head { display: flex; align-items: center; gap: 9px; }
.member-idbox { display: grid; gap: 1px; min-width: 0; flex: 1; }
.member-name { font-size: 13px; line-height: 1.2; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.member-account { font-size: 10px; color: $text-muted; font-family: $font-code; }
.member-avatar {
  width: 30px; height: 30px; flex-shrink: 0;
  display: inline-flex; align-items: center; justify-content: center;
  border-radius: 50%;
  background: #E8EFF4; color: #003B5C;
  font-weight: 700; font-size: 13px;
}
.member-live {
  display: inline-flex; align-items: center; gap: 5px;
  color: #18a058; font-size: 11px; font-weight: 700; white-space: nowrap;
}
.pulse-dot {
  width: 8px; height: 8px; border-radius: 50%;
  background: #18a058;
  animation: member-pulse 1.4s ease-in-out infinite;
}
@keyframes member-pulse {
  0%, 100% { box-shadow: 0 0 0 0 rgba(24,160,88,.55); opacity: 1; }
  50%      { box-shadow: 0 0 0 6px rgba(24,160,88,0);  opacity: .75; }
}
.member-card__meta {
  display: flex; flex-wrap: wrap; gap: 3px 6px;
  font-size: 11px; color: $text-secondary;
}
.member-card__foot {
  display: flex; align-items: center; justify-content: space-between;
  font-size: 11px; color: $text-muted;
}
.gw-steps { margin-top: 16px; padding: 12px; border: 1px dashed $border-color; border-radius: 8px; background: var(--bg-secondary); }
.gw-steps-title { margin: 0 0 6px; font-size: 13px; font-weight: 600; color: $text-primary; }
.gw-steps-list { margin: 0; padding-left: 18px; font-size: 12px; line-height: 1.7; color: $text-secondary; }
.gw-steps-list b { color: $text-primary; }
</style>


