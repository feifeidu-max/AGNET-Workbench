<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { NAlert, NButton, NEmpty, NSpin, NTag } from 'naive-ui'
import {
  fetchWorkbenchSummary,
  refreshPaperRecommendations,
  type ServiceStatus,
  type WorkbenchSummary,
} from '@/api/workbench'
import { getStoredUsername } from '@/api/client'

const loading = ref(false)
const error = ref('')
const summary = ref<WorkbenchSummary | null>(null)
const username = ref(getStoredUsername())
const recommending = ref(false)
const recError = ref('')

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
      meta: k ? `可信 ${k.trusted ?? 0} 篇` : '本地知识',
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
      desc: '依据你最近的对话与研究方向，定时推荐相关的待读论文。',
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

onMounted(() => {
  void loadSummary()
})

async function refreshRecs() {
  recommending.value = true
  recError.value = ''
  try {
    const result = await refreshPaperRecommendations()
    summary.value = summary.value
      ? { ...summary.value, paperRecommendations: result }
      : summary.value
  } catch (reason) {
    recError.value = reason instanceof Error ? reason.message : '刷新论文推荐失败'
  } finally {
    recommending.value = false
  }
}

const recStatusLabel = computed(() => {
  const status = summary.value?.paperRecommendations?.status
  if (status === 'success') return '已生成'
  if (status === 'partial') return '部分生成'
  if (status === 'failed') return '生成失败'
  if (status === 'pending') return '待生成'
  return '未知'
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
          <p class="home-subtitle">在一处管理你的知识库、对话与记忆。</p>
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
                <path d="M21 15a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
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

        <section v-if="summary && summary.paperRecommendations" class="workbench-section" aria-labelledby="paper-rec-title">
          <div class="workbench-section-header">
            <h3 id="paper-rec-title" class="workbench-section-title">论文推荐</h3>
            <div class="workbench-section-actions">
              <NTag :type="summary.paperRecommendations && summary.paperRecommendations.status === 'success' ? 'success' : (summary.paperRecommendations && summary.paperRecommendations.status === 'failed' ? 'error' : 'warning')" size="small" :bordered="false">
                {{ recStatusLabel }}
              </NTag>
              <NButton size="tiny" :disabled="recommending" :aria-busy="recommending" @click="refreshRecs">
                <template #icon>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <polyline points="23 4 23 10 17 10" />
                    <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
                  </svg>
                </template>
                {{ recommending ? '生成中…' : '刷新' }}
              </NButton>
              <RouterLink class="section-link" :to="{ name: 'hermes.knowledge', query: { tab: 'candidates' } }">查看全部</RouterLink>
            </div>
          </div>

          <NAlert v-if="recError" class="workbench-alert" type="error" :title="'刷新失败'">{{ recError }}</NAlert>

          <div v-if="summary.paperRecommendations && summary.paperRecommendations.items.length" class="paper-rec-list">
            <article
              v-for="item in summary.paperRecommendations.items.slice(0, 5)"
              :key="item.id"
              class="paper-rec-item"
            >
              <h4 class="paper-rec-title">
                <a v-if="item.url" :href="item.url" target="_blank" rel="noopener">{{ item.title }}</a>
                <template v-else>{{ item.title }}</template>
              </h4>
              <p v-if="item.reason" class="paper-rec-reason">{{ item.reason }}</p>
              <p class="paper-rec-meta">
                <span v-if="item.authors && item.authors.length">作者：{{ item.authors.slice(0, 3).join('、') }}{{ item.authors.length > 3 ? ' 等' : '' }}</span>
                <span v-if="item.year"> · {{ item.year }}</span>
                <span v-if="item.provider"> · {{ item.provider }}</span>
              </p>
            </article>
          </div>
          <NEmpty
            v-else
            :description="summary.paperRecommendations && summary.paperRecommendations.error ? summary.paperRecommendations.error : '暂无可推荐的外部论文，稍后自动刷新'"
          />
          <p v-if="summary.paperRecommendations && summary.paperRecommendations.focus" class="paper-rec-focus">
            依据本地知识库（{{ summary.paperRecommendations.paperCount }} 篇已收录论文）相似推荐
          </p>
        </section>

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

.section-link {
  font-size: 12px;
  color: var(--primary-color, #4f7cff);
  text-decoration: none;
  margin-left: 4px;
}

.section-link:hover {
  text-decoration: underline;
}

.paper-rec-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin-top: 12px;
}

.paper-rec-item {
  padding: 14px 16px;
  border: 1px solid $border-color;
  border-radius: $radius-md;
  background: $bg-card;
}

.paper-rec-title {
  margin: 0 0 8px;
  font-size: 15px;
  font-weight: 600;
  line-height: 1.45;
  color: $text-primary;
}

.paper-rec-title a {
  color: inherit;
  text-decoration: none;
}

.paper-rec-title a:hover {
  color: $brand;
  text-decoration: underline;
}

.paper-rec-reason {
  margin: 0 0 8px;
  font-size: 13px;
  color: $text-secondary;
  line-height: 1.55;
}

.paper-rec-meta {
  margin: 0;
  font-size: 12px;
  color: $text-muted;
}

.paper-rec-focus {
  margin: 12px 0 0;
  padding: 8px 12px;
  font-size: 12px;
  color: $text-secondary;
  background: $bg-secondary;
  border-radius: $radius-sm;
  font-style: italic;
}
</style>
