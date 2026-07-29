<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { NAlert, NButton, NEmpty, NSpin, NTag } from 'naive-ui'
import {
  fetchWorkbenchSummary,
  refreshPaperRecommendations,
  type PaperRecommendation,
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

// ─── 论文推荐：paperhub 风格展示 ───────────────────────────────
const paperRec = computed(() => summary.value?.paperRecommendations ?? null)

const paperStatusType = computed<'success' | 'error' | 'warning'>(() => {
  const status = paperRec.value?.status
  if (status === 'success') return 'success'
  if (status === 'failed') return 'error'
  return 'warning'
})

const activeFilter = ref<'all' | 'top'>('all')
const sortOrder = ref<'newest' | 'oldest'>('newest')
const savedIds = ref<Set<string>>(new Set())
const recentYear = new Date().getFullYear() - 1

// 顶会类别 → 中文标签 + 配色（贴近 paperhub 的多彩分类标签）。
const CATEGORY_LABELS: Record<string, string> = {
  ml: '机器学习',
  cv: '计算机视觉',
  arch: '体系结构',
  db: '数据/挖掘',
  sys: '系统',
  nlp: 'NLP',
  default: '顶会',
}

const PALETTE: Record<string, { bg: string; color: string }> = {
  ml: { bg: '#F3E5F5', color: '#6A1B9A' },
  cv: { bg: '#E0F7FA', color: '#006064' },
  arch: { bg: '#FFF3E0', color: '#E65100' },
  db: { bg: '#FFF8E1', color: '#F57F17' },
  sys: { bg: '#E3F2FD', color: '#0D47A1' },
  nlp: { bg: '#E8EAF6', color: '#283593' },
  default: { bg: '#E8EFF4', color: '#003B5C' },
}

function categoryKey(venue?: string | null): keyof typeof PALETTE {
  const v = (venue || '').toLowerCase()
  if (/(neurips|nips|icml|iclr|aaai|ijcai|uai|aistats|colt)/.test(v)) return 'ml'
  if (/(cvpr|iccv|eccv|wacv|bmvc|3dv)/.test(v)) return 'cv'
  if (/(isca|micro|hpca|asplos|dac|iccad|fpga|fpl|fpt|fccm|date|case|iscas|nocs|pact|cgo|esweek|rtas|rtss|samos|heap)/.test(v)) return 'arch'
  if (/(sigmod|vldb|icde|kdd|www|icse|ase|fse|issta|big data|proceedings of the vldb)/.test(v)) return 'db'
  if (/(osdi|sosp|nsdi|atc|eurosys|fast|socc|middleware)/.test(v)) return 'sys'
  if (/(acl|emnlp|naacl|coling|tacl)/.test(v)) return 'nlp'
  return 'default'
}

function categoryLabel(item: PaperRecommendation): string {
  if (!item.venue) return '论文推荐'
  return CATEGORY_LABELS[categoryKey(item.venue)]
}

function tagStyle(item: PaperRecommendation): Record<string, string> {
  const p = PALETTE[categoryKey(item.venue)]
  return { background: p.bg, color: p.color }
}

function formatAuthors(item: PaperRecommendation): string {
  const authors = item.authors ?? []
  if (!authors.length) return '佚名'
  return authors.slice(0, 3).join('、') + (authors.length > 3 ? ' 等' : '')
}

// 优先展示“推荐理由”（与本地知识库的关联），退化为摘要。
function displayAbstract(item: PaperRecommendation): string {
  return item.reason || item.abstract || ''
}

function yearText(item: PaperRecommendation): string {
  return item.year ? String(item.year) : '—'
}

function providerText(item: PaperRecommendation): string {
  return item.provider || '外部检索'
}

function isRecent(item: PaperRecommendation): boolean {
  return !!item.year && item.year >= recentYear
}

function toggleSave(id: string): void {
  const next = new Set(savedIds.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  savedIds.value = next
}

const visibleItems = computed<PaperRecommendation[]>(() => {
  const all = paperRec.value?.items ?? []
  let list = all
  if (activeFilter.value === 'top') list = list.filter((it) => !!it.venue)
  const sorted = [...list].sort((a, b) => {
    const ay = a.year ?? 0
    const by = b.year ?? 0
    return sortOrder.value === 'newest' ? by - ay : ay - by
  })
  return sorted
})

// 每行最多 3 张卡片，溢出自动换行。
const rows = computed<PaperRecommendation[][]>(() => {
  const items = visibleItems.value
  const out: PaperRecommendation[][] = []
  for (let i = 0; i < items.length; i += 3) out.push(items.slice(i, i + 3))
  return out
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

        <section v-if="paperRec" class="ph-section" aria-labelledby="ph-title">
          <div class="ph-section-header">
            <div class="ph-section-heading">
              <h3 id="ph-title" class="ph-section-title">论文推荐</h3>
              <p v-if="paperRec.focus" class="ph-section-sub">{{ paperRec.focus }}</p>
            </div>
            <div class="ph-section-actions">
              <NTag :type="paperStatusType" size="small" :bordered="false">{{ recStatusLabel }}</NTag>
              <NTag v-if="paperRec.topVenueOnly" type="error" size="small" :bordered="false">仅顶会</NTag>
              <NTag v-if="paperRec.recentPriority" type="success" size="small" :bordered="false">最新优先</NTag>
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

          <div class="ph-filter-bar">
            <div class="ph-filters">
              <button type="button" class="ph-chip" :class="{ active: activeFilter === 'all' }" @click="activeFilter = 'all'">全部</button>
              <button type="button" class="ph-chip" :class="{ active: activeFilter === 'top' }" @click="activeFilter = 'top'">顶会论文</button>
            </div>
            <div class="ph-sort">
              <span>排序</span>
              <select v-model="sortOrder" class="ph-sort-select" aria-label="排序方式">
                <option value="newest">最新优先</option>
                <option value="oldest">最早优先</option>
              </select>
            </div>
          </div>

          <NAlert v-if="recError" class="workbench-alert" type="error" :title="'刷新失败'">{{ recError }}</NAlert>

          <div v-if="visibleItems.length" class="ph-grid">
            <div v-for="(row, idx) in rows" :key="idx" class="ph-row">
              <article
                v-for="item in row"
                :key="item.id"
                class="ph-card"
                :class="{ 'ph-card--recent': isRecent(item) }"
              >
                <div class="ph-card-top">
                  <span class="ph-tag" :style="tagStyle(item)">{{ categoryLabel(item) }}</span>
                  <span class="ph-date">
                    {{ yearText(item) }}
                    <span v-if="isRecent(item)" class="ph-new">新</span>
                  </span>
                </div>
                <h4 class="ph-card-title">
                  <a v-if="item.url" :href="item.url" target="_blank" rel="noopener">{{ item.title }}</a>
                  <template v-else>{{ item.title }}</template>
                </h4>
                <p class="ph-card-authors">{{ formatAuthors(item) }}</p>
                <p v-if="displayAbstract(item)" class="ph-card-abstract">{{ displayAbstract(item) }}</p>
                <div class="ph-card-footer">
                  <div class="ph-metrics">
                    <span>来源 {{ providerText(item) }}</span>
                    <span v-if="item.year">· {{ item.year }}</span>
                  </div>
                  <button
                    type="button"
                    class="ph-bookmark"
                    :class="{ saved: savedIds.has(item.id) }"
                    :aria-pressed="savedIds.has(item.id)"
                    :title="savedIds.has(item.id) ? '已收藏' : '收藏'"
                    @click="toggleSave(item.id)"
                  >
                    <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                      <path
                        d="M6 4H18V20L12 16L6 20V4Z"
                        stroke="currentColor"
                        stroke-width="2"
                        stroke-linejoin="round"
                        :fill="savedIds.has(item.id) ? 'currentColor' : 'none'"
                      />
                    </svg>
                  </button>
                </div>
              </article>
            </div>
          </div>
          <NEmpty
            v-else
            :description="paperRec.error ? paperRec.error : '暂无可推荐的外部顶会论文，稍后自动刷新'"
          />
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

// ─── 论文推荐：paperhub 风格卡片 ──────────────────────────────
$ph-navy: #003b5c;
$ph-bg: #fafaf7;
$ph-card: #ffffff;
$ph-border: #e6e5d6;
$ph-border-light: #f0ebda;
$ph-text-dark: #1a1a1a;
$ph-text-medium: #666666;
$ph-text-light: #999999;
$ph-text-lighter: #999999;
$ph-text-abstract: #555555;
$ph-serif: 'Source Serif 4', Georgia, 'Songti SC', 'SimSun', serif;
$ph-sans: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'PingFang SC', 'Microsoft YaHei', sans-serif;

.ph-section {
  margin-top: 28px;
}

.ph-section-header {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 14px;
  flex-wrap: wrap;
}

.ph-section-title {
  margin: 0;
  font-family: $ph-serif;
  font-size: 26px;
  font-weight: 600;
  color: $ph-navy;
  line-height: 1.2;
}

.ph-section-sub {
  margin: 6px 0 0;
  font-size: 12.5px;
  line-height: 1.6;
  color: $ph-text-medium;
  max-width: 64ch;
}

.ph-section-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.ph-filter-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 14px;
  background: $ph-card;
  border: 1px solid $ph-border;
  border-radius: 10px;
  margin-bottom: 18px;
  flex-wrap: wrap;
}

.ph-filters {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.ph-chip {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: 32px;
  padding: 0 16px;
  border-radius: 100px;
  font-family: $ph-sans;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  border: 1px solid $ph-border;
  background: $ph-bg;
  color: $ph-text-medium;
  transition: all 0.2s;
  white-space: nowrap;
}

.ph-chip.active {
  background: $ph-navy;
  color: #fff;
  border-color: $ph-navy;
}

.ph-chip:not(.active):hover {
  border-color: $ph-navy;
  color: $ph-navy;
}

.ph-sort {
  display: flex;
  align-items: center;
  gap: 8px;
  font-family: $ph-sans;
  font-size: 13px;
  color: $ph-text-medium;
}

.ph-sort-select {
  height: 32px;
  padding: 0 10px;
  border-radius: 8px;
  border: 1px solid $ph-border;
  background: $ph-bg;
  color: $ph-text-dark;
  font-family: $ph-sans;
  font-size: 13px;
  cursor: pointer;
}

.ph-grid {
  display: flex;
  flex-direction: column;
  gap: 18px;
}

.ph-row {
  display: flex;
  gap: 18px;
}

.ph-card {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
  padding: 20px;
  background: $ph-card;
  border: 1px solid $ph-border-light;
  border-radius: 12px;
  box-shadow: 0 1px 2px rgba(6, 8, 10, 0.04), 0 4px 12px rgba(6, 8, 10, 0.06);
  transition: box-shadow 0.3s, transform 0.3s, border-color 0.3s;
}

.ph-card:hover {
  box-shadow: 0 2px 4px rgba(6, 8, 10, 0.06), 0 8px 24px rgba(6, 8, 10, 0.1);
  transform: translateY(-2px);
}

.ph-card--recent {
  border-color: #cfe3d2;
}

.ph-card-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.ph-tag {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: 24px;
  padding: 0 10px;
  border-radius: 5px;
  font-family: $ph-sans;
  font-size: 11px;
  font-weight: 600;
  white-space: nowrap;
}

.ph-date {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-family: $ph-sans;
  font-size: 12px;
  color: $ph-text-light;
}

.ph-new {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: 16px;
  padding: 0 5px;
  border-radius: 4px;
  background: #1f9d55;
  color: #fff;
  font-size: 10px;
  font-weight: 600;
}

.ph-card-title {
  margin: 0;
  font-family: $ph-serif;
  font-size: 18px;
  font-weight: 600;
  line-height: 1.45;
  color: $ph-text-dark;
}

.ph-card-title a {
  color: inherit;
  text-decoration: none;
}

.ph-card-title a:hover {
  color: $ph-navy;
  text-decoration: underline;
}

.ph-card-authors {
  margin: 0;
  font-family: $ph-sans;
  font-size: 13px;
  color: $ph-text-medium;
}

.ph-card-abstract {
  margin: 0;
  font-family: $ph-sans;
  font-size: 13.5px;
  line-height: 1.6;
  color: $ph-text-abstract;
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 3;
  overflow: hidden;
}

.ph-card-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-top: auto;
}

.ph-metrics {
  display: flex;
  align-items: center;
  gap: 8px;
  font-family: $ph-sans;
  font-size: 12px;
  color: $ph-text-lighter;
  flex-wrap: wrap;
}

.ph-bookmark {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border: 1px solid $ph-border;
  border-radius: 8px;
  background: $ph-bg;
  color: $ph-text-light;
  cursor: pointer;
  transition: all 0.2s;
  flex-shrink: 0;
}

.ph-bookmark:hover {
  border-color: $ph-navy;
  color: $ph-navy;
}

.ph-bookmark.saved {
  background: $ph-navy;
  border-color: $ph-navy;
  color: #fff;
}

.ph-bookmark svg {
  width: 16px;
  height: 16px;
}

@media (max-width: 900px) {
  .ph-row {
    flex-wrap: wrap;
  }

  .ph-card {
    min-width: 260px;
  }
}

@media (max-width: 600px) {
  .ph-row {
    flex-direction: column;
  }

  .ph-card {
    min-width: 0;
  }

  .ph-section-title {
    font-size: 22px;
  }
}

// 深色模式适配（保持 paperhub 的浅色卡片质感，仅调整容器与文字）
html.dark {
  .ph-section-title {
    color: #cfe3f2;
  }

  .ph-section-sub {
    color: #a0a0a0;
  }

  .ph-filter-bar {
    background: #2a2a2a;
    border-color: #3a3a3a;
  }

  .ph-chip {
    background: #252525;
    border-color: #3a3a3a;
    color: #a0a0a0;
  }

  .ph-chip.active {
    background: #005bac;
    border-color: #005bac;
    color: #fff;
  }

  .ph-chip:not(.active):hover {
    border-color: #4f9be0;
    color: #cfe3f2;
  }

  .ph-sort-select {
    background: #252525;
    border-color: #3a3a3a;
    color: #e0e0e0;
  }

  .ph-card {
    background: #2a2a2a;
    border-color: #3a3a3a;
    box-shadow: none;
  }

  .ph-card--recent {
    border-color: #2f5d3f;
  }

  .ph-card-title {
    color: #e0e0e0;
  }

  .ph-card-title a:hover {
    color: #76b6ea;
  }

  .ph-card-authors {
    color: #a0a0a0;
  }

  .ph-card-abstract {
    color: #bdbdbd;
  }

  .ph-date,
  .ph-metrics {
    color: #888;
  }

  .ph-bookmark {
    background: #252525;
    border-color: #3a3a3a;
    color: #888;
  }

  .ph-bookmark.saved {
    background: #005bac;
    border-color: #005bac;
    color: #fff;
  }
}
</style>
