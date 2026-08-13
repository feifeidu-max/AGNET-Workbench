<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { NPopconfirm, useMessage } from 'naive-ui'
import { deleteKnowledgeFile } from '@/api/knowledge-workbench'
import {
  fetchKnowledgeGraph,
  fetchWorkbenchSummary,
  refreshPaperRecommendationsAndWait,
  type KnowledgeGraph,
  type PaperRecommendation,
  type PaperRecommendationsPayload,
  type WorkbenchSummary,
} from '@/api/workbench'
import KnowledgeGraphNetwork from '@/components/hermes/knowledge/KnowledgeGraphNetwork.vue'
import {
  domainTagColor,
  normalizeWikiTags,
  paperCategory,
} from '@/utils/paperCategories'

interface DisplayPaper {
  id: string
  title: string
  originalTitle?: string
  authors: string[]
  year: number | null
  category: string
  categoryColor: { bg: string; fg: string }
  source: 'kb' | 'recommend'
  /** 知识库条目类型：论文 / 公众号文章（technical_article） */
  kind?: 'paper' | 'article'
  summary: string
  tags: string[]
  newlyFound?: boolean
  foundAt?: string | null
  url?: string
  provider?: string
  venue?: string
  raw?: Record<string, unknown>
  recommendation?: PaperRecommendation
}

interface TrendingTopic {
  name: string
  terms: string[]
}

const route = useRoute()

const loading = ref(true)
const error = ref('')
const refreshError = ref('')
const refreshMessage = ref('')
const graph = ref<KnowledgeGraph>({ nodes: [], edges: [] })
const payload = ref<PaperRecommendationsPayload | null>(null)
const workbench = ref<WorkbenchSummary | null>(null)
const refreshing = ref(false)

const searchText = ref((route.query.q as string) || '')
const activeCategory = ref('全部')
const activeSource = ref<'all' | 'kb' | 'recommend'>('all')
const activeTopic = ref<string | null>(null)
const sortBy = ref<'newest' | 'oldest'>('newest')
const selectedId = ref<string | null>(null)

const favorites = ref<Set<string>>(new Set())

const PALETTE = [
  { bg: '#E8EFF4', fg: '#003B5C' },
  { bg: '#E3F2FD', fg: '#0D47A1' },
  { bg: '#F3E5F5', fg: '#6A1B9A' },
  { bg: '#FFF3E0', fg: '#E65100' },
  { bg: '#E0F7FA', fg: '#006064' },
  { bg: '#FFF8E1', fg: '#F57F17' },
  { bg: '#E8F5E9', fg: '#1B5E20' },
  { bg: '#FCE4EC', fg: '#880E4F' },
]

const TRENDING_TOPICS: TrendingTopic[] = [
  { name: '人工智能', terms: ['人工智能', 'artificial intelligence', 'machine learning', 'neural', 'deep learning', 'ai'] },
  { name: '大数据', terms: ['大数据', 'big data', 'data lake', 'data warehouse', 'lakehouse', 'data platform'] },
  { name: '深度学习', terms: ['深度学习', 'deep learning', 'machine learning', 'neural network', 'transformer'] },
  { name: '计算机视觉', terms: ['计算机视觉', 'computer vision', 'image', 'vision', '3d', 'point cloud'] },
  { name: '体系结构', terms: ['体系结构', 'architecture', 'framework', 'platform', 'warehouse', 'lakehouse'] },
  { name: '系统', terms: ['系统', 'system', 'framework', 'platform', 'pipeline', 'stream', 'database'] },
]

function tagFor(label?: string | null): { label: string; bg: string; fg: string } {
  const key = label && label.trim() ? label.trim() : '论文'
  let hash = 0
  for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) >>> 0
  const c = PALETTE[hash % PALETTE.length]
  return { label: key, bg: c.bg, fg: c.fg }
}

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && !!item.trim())
    : []
}

function nodeId(node: Record<string, unknown>): string {
  return text(node.id ?? node.path)
}

function isKbEntry(node: Record<string, unknown>): 'paper' | 'article' | null {
  const explicit = text(node.contentKind ?? node.content_kind).toLowerCase()
  const type = text(node.nodeType ?? node.node_type ?? node.type).toLowerCase()
  if (explicit === 'paper' || type === 'paper') return 'paper'
  // 已批准发布的公众号文章 / 技术文章（wiki/sources/*.md）也是可信知识库内容
  if (explicit === 'technical_article' || explicit === 'article' || type === 'source') return 'article'
  return null
}

function isWikiEdge(edge: Record<string, unknown>): boolean {
  const kind = text(edge.kind, 'wikilink').toLowerCase()
  // 关键词相似边（keyword_graph 检索模式下文章/论文之间的主要连接）也是图谱连线
  if (kind !== 'wikilink' && kind !== 'keyword_similarity') return false
  // 排除只与系统页（index/overview/log/query/purpose）相连的入口链接，
  // 否则文章会“孤零零”只剩一条来自 index 的边
  const s = text(edge.source).toLowerCase()
  const t = text(edge.target).toLowerCase()
  const isSystem = (id: string) => ['index', 'overview', 'log', 'query', 'purpose']
    .some((n) => id === n || id.startsWith(n + '/'))
  return !isSystem(s) && !isSystem(t)
}

function extractKb(node: Record<string, unknown>): DisplayPaper | null {
  const id = nodeId(node)
  const kind = isKbEntry(node)
  if (!id || !kind) return null
  const originalTitle = text(node.label ?? node.title ?? node.name, '未命名论文')
  const title = text(node.titleZh ?? node.title_zh, originalTitle)
  const rawSummary = text(node.summary)
  // 标签白名单归一化：只保留 LLM Wiki 固定中文体系（数据采集/存储/计算/传输/治理/质量/安全/智能）。
  const tags = normalizeWikiTags(stringList(node.tags ?? node.domainTags ?? node.domain_tags))
  const category = tags[0] || '知识库'
  const rawYear = node.year
  return {
    id,
    title,
    originalTitle,
    authors: stringList(node.authors),
    year: typeof rawYear === 'number' && Number.isFinite(rawYear) ? rawYear : null,
    category,
    categoryColor: tagFor(category),
    source: 'kb',
    kind,
    summary: rawSummary.startsWith('<!--') || rawSummary.includes('evidence-locators') ? '' : rawSummary,
    tags,
    raw: node,
  }
}

function extractRec(it: PaperRecommendation): DisplayPaper {
  // 推荐论文的标签来自服务端按 LLM-Wiki 同款关键词规则提取的中文域标签（it.tags），
  // 固定为 数据采集/存储/计算/治理/质量/安全/传输/智能 之一，不会一篇论文多一个标签。
  // 英文会议名只保留在 venue 字段供卡片底部展示，绝不当标签。
  const category = paperCategory(it.tags, `${it.title} ${it.abstract ?? ''}`)
  return {
    id: it.id,
    title: it.title,
    authors: it.authors ?? [],
    year: it.year ?? null,
    category,
    categoryColor: domainTagColor(category),
    source: 'recommend',
    summary: it.reason || it.abstract || '',
    tags: normalizeWikiTags(it.tags as unknown[] | undefined | null),
    newlyFound: it.newlyFound === true,
    foundAt: it.foundAt ?? null,
    url: it.url ?? undefined,
    provider: it.provider ?? undefined,
    venue: it.venue ?? undefined,
    recommendation: it,
  }
}

const kbPapers = computed<DisplayPaper[]>(() =>
  graph.value.nodes
    .map(extractKb)
    .filter((p): p is DisplayPaper => p !== null)
    .sort((a, b) => (b.year ?? 0) - (a.year ?? 0) || a.title.localeCompare(b.title, 'zh-CN')),
)

const recPapers = computed<DisplayPaper[]>(() =>
  (payload.value?.items ?? []).map(extractRec),
)

const allPapers = computed<DisplayPaper[]>(() => [...kbPapers.value, ...recPapers.value])

const categories = computed<string[]>(() => {
  const set = new Set<string>()
  for (const p of allPapers.value) set.add(p.category)
  return ['全部', ...[...set]]
})

const filtered = computed<DisplayPaper[]>(() => {
  const q = searchText.value.trim().toLowerCase()
  let list = allPapers.value.filter((p) => {
    if (activeSource.value !== 'all' && p.source !== activeSource.value) return false
    if (activeCategory.value !== '全部' && p.category !== activeCategory.value) return false
    if (activeTopic.value) {
      const topic = TRENDING_TOPICS.find((item) => item.name === activeTopic.value)
      const haystack = `${p.title} ${p.originalTitle ?? ''} ${p.authors.join(' ')} ${p.category} ${p.tags.join(' ')} ${p.venue ?? ''} ${p.summary}`.toLowerCase()
      if (topic && !topic.terms.some((term) => haystack.includes(term.toLowerCase()))) return false
    }
    if (q) {
      const hay = `${p.title} ${p.originalTitle ?? ''} ${p.authors.join(' ')} ${p.category} ${p.venue ?? ''}`.toLowerCase()
      if (!hay.includes(q)) return false
    }
    return true
  })
  if (sortBy.value === 'newest') list = [...list].sort((a, b) => (b.year ?? 0) - (a.year ?? 0))
  else if (sortBy.value === 'oldest') list = [...list].sort((a, b) => (a.year ?? 0) - (b.year ?? 0))
  return list
})

const selected = computed(() => allPapers.value.find((p) => p.id === selectedId.value) ?? null)

const localGraph = computed<KnowledgeGraph>(() => {
  if (!selected.value || selected.value.source !== 'kb' || !selected.value.raw) return { nodes: [], edges: [] }
  const explicitEdges = graph.value.edges.filter(isWikiEdge)
  const ids = new Set([selected.value.id])
  for (const edge of explicitEdges) {
    const s = text(edge.source)
    const t = text(edge.target)
    if (s === selected.value.id) ids.add(t)
    if (t === selected.value.id) ids.add(s)
  }
  const nodes = graph.value.nodes.filter((node) => {
    const type = text(node.nodeType ?? node.node_type ?? node.type).toLowerCase()
    return ids.has(nodeId(node)) && !['overview', 'query', 'index', 'log'].includes(type)
  })
  const visibleIds = new Set(nodes.map(nodeId))
  return {
    nodes,
    edges: explicitEdges.filter((e) => visibleIds.has(text(e.source)) && visibleIds.has(text(e.target))),
  }
})

// ===== Radial graph for recommendations =====
const GRAPH_W = 700
const GRAPH_H = 500
const CX = 350
const CY = 250
const RADIUS = 155

const graphNodes = computed(() => {
  const center = selected.value
  if (!center || center.source !== 'recommend') return []
  const others = filtered.value.filter((p) => p.source === 'recommend' && p.id !== center.id).slice(0, 7)
  return others.map((paper, i) => {
    const angle = (i / others.length) * 2 * Math.PI - Math.PI / 2
    return { id: paper.id, paper, x: CX + Math.cos(angle) * RADIUS, y: CY + Math.sin(angle) * RADIUS, angle }
  })
})

const graphEdges = computed(() =>
  graphNodes.value.map((n) => ({ x1: CX, y1: CY, x2: n.x, y2: n.y, color: n.paper.categoryColor.fg })),
)

const tooltip = ref<{ x: number; y: number; title: string; sub: string } | null>(null)
function showTooltip(event: MouseEvent, paper: DisplayPaper) {
  const container = (event.currentTarget as SVGElement).ownerSVGElement?.parentElement
  if (!container) return
  const cRect = container.getBoundingClientRect()
  const nRect = (event.currentTarget as SVGElement).getBoundingClientRect()
  tooltip.value = {
    x: nRect.left - cRect.left + nRect.width / 2,
    y: nRect.top - cRect.top,
    title: paper.title,
    sub: paper.category,
  }
}
function hideTooltip() {
  tooltip.value = null
}

function loadFavorites() {
  try {
    const raw = localStorage.getItem('ph-favorites')
    if (raw) favorites.value = new Set(JSON.parse(raw) as string[])
  } catch {
    favorites.value = new Set()
  }
}
function toggleFavorite(id: string) {
  const next = new Set(favorites.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  favorites.value = next
  try {
    localStorage.setItem('ph-favorites', JSON.stringify([...next]))
  } catch {
    /* ignore */
  }
}

function selectItem(item: DisplayPaper) {
  selectedId.value = selectedId.value === item.id ? null : item.id
}

function setSource(source: 'all' | 'kb' | 'recommend') {
  activeSource.value = source
  activeCategory.value = '全部'
  activeTopic.value = null
  selectedId.value = null
}

function setCategory(category: string) {
  activeCategory.value = category
  activeTopic.value = null
  selectedId.value = null
}

function selectTrending(topic: TrendingTopic) {
  activeTopic.value = activeTopic.value === topic.name ? null : topic.name
  activeSource.value = 'all'
  activeCategory.value = '全部'
  searchText.value = ''
  selectedId.value = null
  document.querySelector('.ph-content')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

function selectGraphNode(node: Record<string, unknown>) {
  const id = nodeId(node)
  if (allPapers.value.some((p) => p.id === id)) selectedId.value = id
}

function openRecommendation(id: string) {
  selectedId.value = id
}
function closeGraph() {
  selectedId.value = null
  hideTooltip()
}

async function loadHome() {
  loading.value = true
  error.value = ''
  try {
    const [g, summary] = await Promise.all([
      fetchKnowledgeGraph().catch(() => null),
      fetchWorkbenchSummary().catch(() => null),
    ])
    if (g) graph.value = g
    if (summary) {
      workbench.value = summary
      payload.value = summary.paperRecommendations ?? null
    }
    if (!g) error.value = '知识库加载失败'
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : '数据加载失败'
  } finally {
    loading.value = false
  }
}

function formatGeneratedAt(value: string | null | undefined): string {
  if (!value) return '尚未生成'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '尚未生成'
  return date.toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
}

/** 手动执行「论文推荐（本地知识库 · 顶会优先）」任务：
 *  后端会基于 LLM Wiki 知识库重新检索外部顶会论文并回写 paper-recommendations.json。 */
async function onRefresh() {
  if (refreshing.value) return
  refreshing.value = true
  refreshError.value = ''
  refreshMessage.value = '正在执行论文推荐任务（基于本地知识库检索顶会论文）…'
  try {
    // 手动执行“论文推荐（本地知识库 · 顶会优先）”任务并轮询等待结果
    const data = await refreshPaperRecommendationsAndWait()
    payload.value = data
    refreshMessage.value = data.status === 'failed'
      ? `论文推荐任务执行失败：${data.error || '未知错误'}`
      : (() => {
          const newCount = (data.items ?? []).filter((it) => it.newlyFound === true).length
          const newHint = newCount > 0 ? `（本次新增 ${newCount} 篇，已标注“新发现”）` : '（本次无新增论文）'
          return `论文推荐任务已执行：${data.items.length} 篇${data.topVenueOnly ? '顶会' : '数据方向'}推荐${newHint} · ${formatGeneratedAt(data.generatedAt)}`
        })()
    if (data.status === 'failed') refreshError.value = data.error || '论文推荐任务执行失败'
  } catch (reason) {
    refreshError.value = reason instanceof Error ? reason.message : '刷新失败'
    refreshMessage.value = `论文推荐任务执行失败：${refreshError.value}`
  } finally {
    refreshing.value = false
  }
}

const message = useMessage()
const deletingId = ref('')

/** 删除已入库的论文/文章（wiki 页面；删除前会留历史快照，可从 Wiki 历史恢复）。 */
async function deleteKbItem(item: DisplayPaper) {
  const path = item.raw && typeof item.raw.path === 'string' ? item.raw.path : ''
  if (!path) {
    message.error('缺少 Wiki 路径，无法删除')
    return
  }
  deletingId.value = item.id
  try {
    await deleteKnowledgeFile(path)
    message.success(`已删除「${item.title}」`)
    if (selectedId.value === item.id) selectedId.value = null
    // 轻量刷新：图谱 + 工作台摘要（不闪整页加载态）
    const [g, summary] = await Promise.all([
      fetchKnowledgeGraph().catch(() => null),
      fetchWorkbenchSummary().catch(() => null),
    ])
    if (g) graph.value = g
    if (summary) {
      workbench.value = summary
      payload.value = summary.paperRecommendations ?? null
    }
  } catch (reason) {
    message.error(reason instanceof Error ? reason.message : '删除失败')
  } finally {
    deletingId.value = ''
  }
}

const stats = computed(() => ({
  kb: kbPapers.value.length,
  papers: kbPapers.value.filter((p) => p.kind !== 'article').length,
  articles: kbPapers.value.filter((p) => p.kind === 'article').length,
  recommendations: recPapers.value.length,
}))

const heroStats = computed(
  () => `${stats.value.papers} 篇论文 · ${stats.value.articles} 篇文章 · ${stats.value.recommendations} 篇${payload.value?.topVenueOnly === false ? '数据方向' : '顶会'}推荐 · 点击任意条目查看知识图谱`,
)

// 后端/模型服务状态条：确认 Hermes 是否随启动运行、API Key/Base URL 是否生效
const serviceById = (id: string) => workbench.value?.services.find((s) => s.id === id)
const serviceStatusText = (id: string): { label: string; ok: boolean; detail?: string } => {
  const s = serviceById(id)
  if (!s) return { label: '未检查', ok: false }
  const ok = s.status === 'ok'
  return { label: ok ? '正常' : (s.status === 'degraded' ? '部分可用' : '异常'), ok, detail: s.detail }
}
const hermesStatus = computed(() => serviceStatusText('hermes-agent'))
const modelStatus = computed(() => serviceStatusText('model-provider'))
const wikiStatus = computed(() => serviceStatusText('llm-wiki'))

const trending = computed<TrendingTopic[]>(() => TRENDING_TOPICS)

watch(
  () => route.query.q,
  (q) => {
    searchText.value = (q as string) || ''
  },
)

onMounted(() => {
  loadFavorites()
  void loadHome()
})
</script>

<template>
  <div class="ph-page">
    <!-- ===== Hero ===== -->
    <section class="ph-hero">
      <h1 class="ph-hero-title">探索 AI 与数据科学前沿研究</h1>
      <p class="ph-hero-subtitle">基于本地知识库 wiki 相似检索，融合知识图谱与顶会论文推荐</p>
      <div class="ph-hero-search">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
          <circle cx="11" cy="11" r="7" stroke="#666666" stroke-width="2" />
          <path d="M16 16L20 20" stroke="#666666" stroke-width="2" stroke-linecap="round" />
        </svg>
        <input v-model="searchText" type="text" placeholder="输入论文标题、关键词或作者姓名" />
      </div>
      <p class="ph-hero-stats">{{ heroStats }}</p>
      <div class="ph-service-strip" aria-label="后端服务状态">
        <span class="ph-service-item" :class="{ ok: hermesStatus.ok }">
          <i class="ph-service-dot" /> Hermes 后端 {{ hermesStatus.label }}
          <em v-if="hermesStatus.detail" class="ph-service-detail" :title="hermesStatus.detail">{{ hermesStatus.detail }}</em>
        </span>
        <span class="ph-service-item" :class="{ ok: modelStatus.ok }">
          <i class="ph-service-dot" /> 模型服务 {{ modelStatus.label }}
          <em v-if="modelStatus.detail" class="ph-service-detail" :title="modelStatus.detail">{{ modelStatus.detail }}</em>
        </span>
        <span class="ph-service-item" :class="{ ok: wikiStatus.ok }">
          <i class="ph-service-dot" /> LLM Wiki {{ wikiStatus.label }}
        </span>
      </div>
    </section>

    <!-- ===== Filter Bar ===== -->
    <div class="ph-filter-bar">
      <div class="ph-filter-left">
        <div class="ph-source-switch">
          <button :class="{ active: activeSource === 'all' }" @click="setSource('all')">全部</button>
          <button :class="{ active: activeSource === 'kb' }" @click="setSource('kb')">知识库</button>
          <button :class="{ active: activeSource === 'recommend' }" @click="setSource('recommend')">推荐</button>
        </div>
        <div class="ph-filter-chips">
          <button
            v-for="cat in categories"
            :key="cat"
            class="ph-chip"
            :class="{ active: activeCategory === cat }"
            @click="setCategory(cat)"
          >{{ cat }}</button>
        </div>
      </div>
      <div class="ph-sort">
        <select v-model="sortBy" class="ph-sort-select">
          <option value="newest">最新优先</option>
          <option value="oldest">最早优先</option>
        </select>
      </div>
    </div>

    <!-- ===== Content Section ===== -->
    <section class="ph-content">
      <div v-if="error && !loading" class="ph-state ph-state-error">{{ error }}</div>
      <div v-else-if="loading" class="ph-state">加载中…</div>
      <div v-else-if="!filtered.length" class="ph-state">
        <strong>{{ activeSource === 'recommend' && !recPapers.length ? '推荐论文暂时为空' : '暂无匹配的论文' }}</strong>
        <p v-if="activeSource === 'recommend' && !recPapers.length" class="ph-state-detail">
          {{ payload?.error || '正在等待下一轮数据方向推荐。' }}
        </p>
        <button v-if="activeSource === 'recommend' && !recPapers.length" class="ph-refresh" :disabled="refreshing" @click="onRefresh">
          {{ refreshing ? '生成中…' : '立即刷新推荐' }}
        </button>
      </div>

      <!-- Card grid -->
      <template v-else-if="!selected">
        <div class="ph-section-header">
          <h2 class="ph-section-title">论文与知识图谱</h2>
          <div class="ph-section-actions">
            <span v-if="payload?.generatedAt" class="ph-refresh-hint">上次更新 {{ formatGeneratedAt(payload.generatedAt) }}</span>
            <button class="ph-refresh" :disabled="refreshing" @click="onRefresh">
              {{ refreshing ? '执行任务中…' : '刷新推荐' }}
            </button>
          </div>
        </div>
        <p v-if="refreshMessage" class="ph-refresh-message" :class="{ 'is-error': refreshError }">{{ refreshMessage }}</p>

        <div class="ph-card-grid">
          <div v-for="row in Math.ceil(filtered.length / 3)" :key="row" class="ph-card-row">
            <article
              v-for="item in filtered.slice((row - 1) * 3, row * 3)"
              :key="item.id"
              class="ph-paper-card"
              :class="{ 'is-kb': item.source === 'kb' }"
              @click="selectItem(item)"
            >
              <div class="ph-card-top-row">
                <span class="ph-source-badge" :class="item.source === 'kb' ? 'kb' : 'rec'">
                  {{ item.source === 'kb' ? (item.kind === 'paper' ? '论文' : '文章') : '推荐' }}
                </span>
                <span class="ph-card-tag" :style="{ background: item.categoryColor.bg, color: item.categoryColor.fg }">
                  {{ item.category }}
                </span>
                <span class="ph-card-date">{{ item.year ?? '—' }}<span v-if="item.newlyFound" class="ph-newly" :title="'本次刷新搜出 · ' + (item.foundAt ? formatGeneratedAt(item.foundAt) : '')">新发现</span></span>
              </div>
              <h3 class="ph-card-title">
                <a v-if="item.url" :href="item.url" target="_blank" rel="noopener" @click.stop>{{ item.title }}</a>
                <template v-else>{{ item.title }}</template>
              </h3>
              <p v-if="item.originalTitle && item.originalTitle !== item.title" class="ph-original-title">{{ item.originalTitle }}</p>
              <p class="ph-card-authors">{{ item.authors.slice(0, 3).join('、') }}{{ item.authors.length > 3 ? ' 等' : '' }}</p>
              <p class="ph-card-abstract">{{ item.summary || '—' }}</p>
              <div class="ph-card-footer">
                <div class="ph-card-metrics">
                  <span v-if="item.venue">会议 {{ item.venue }}</span>
                  <span v-if="item.provider">来源 {{ item.provider }}</span>
                  <span v-if="item.source === 'kb'">{{ item.kind === 'paper' ? '知识库论文' : '公众号文章' }}</span>
                  <span v-if="item.foundAt" class="ph-found-at">搜出于 {{ formatGeneratedAt(item.foundAt) }}</span>
                </div>
                <svg
                  v-if="item.source === 'recommend'"
                  class="ph-card-bookmark"
                  :class="{ active: favorites.has(item.id) }"
                  viewBox="0 0 24 24"
                  fill="none"
                  xmlns="http://www.w3.org/2000/svg"
                  @click.stop="toggleFavorite(item.id)"
                >
                  <path d="M6 4H18V20L12 16L6 20V4Z" :stroke="favorites.has(item.id) ? '#003B5C' : '#999999'" :fill="favorites.has(item.id) ? '#003B5C' : 'none'" stroke-width="2" stroke-linejoin="round" />
                </svg>
                <NPopconfirm
                  v-if="item.source === 'kb'"
                  :positive-text="deletingId === item.id ? '删除中…' : '确认删除'"
                  negative-text="取消"
                  :disabled="deletingId === item.id"
                  @positive-click="deleteKbItem(item)"
                >
                  <template #trigger>
                    <button
                      type="button"
                      class="ph-card-delete"
                      :disabled="deletingId === item.id"
                      :title="`删除${item.kind === 'paper' ? '该论文' : '该文章'}`"
                      @click.stop
                    >
                      <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                        <path d="M4 7H20M9 7V5C9 4.44772 9.44772 4 10 4H14C14.5523 4 15 4.44772 15 5V7M7 7L8 19C8 19.5523 8.44772 20 9 20H15C15.5523 20 16 19.5523 16 19L17 7M10 11V16M14 11V16" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" />
                      </svg>
                    </button>
                  </template>
                  确认删除「{{ item.title }}」？删除后可从 Wiki 文件历史快照恢复。
                </NPopconfirm>
              </div>
            </article>
          </div>
        </div>
      </template>

      <!-- Graph view -->
      <div v-else class="ph-graph-view">
        <div class="ph-graph-left">
          <article
            v-for="item in [selected, ...filtered.filter((i) => i.id !== selected?.id)]"
            :key="item?.id"
            class="ph-paper-card"
            :class="item?.id === selected?.id ? 'selected' : 'compact'"
            @click="item && item.id !== selected?.id && selectItem(item)"
          >
            <div class="ph-card-top-row">
              <span class="ph-source-badge" :class="item?.source === 'kb' ? 'kb' : 'rec'">
                {{ item?.source === 'kb' ? (item?.kind === 'paper' ? '论文' : '文章') : '推荐' }}
              </span>
              <span class="ph-card-tag" :style="{ background: item?.categoryColor.bg, color: item?.categoryColor.fg }">
                {{ item?.category }}
              </span>
              <span class="ph-card-date">{{ item?.year ?? '—' }}<span v-if="item?.newlyFound" class="ph-newly" :title="'本次刷新搜出 · ' + (item?.foundAt ? formatGeneratedAt(item.foundAt) : '')">新发现</span></span>
            </div>
            <h3 class="ph-card-title" :class="item?.id !== selected?.id && 'compact-title'">{{ item?.title }}</h3>
            <p class="ph-card-authors">{{ (item?.authors ?? []).slice(0, 3).join('、') }}</p>
            <p v-if="item?.id === selected?.id" class="ph-card-abstract">{{ item?.summary || '—' }}</p>
          </article>
        </div>

        <div class="ph-graph-right">
          <div class="ph-graph-panel-header">
            <div class="ph-graph-panel-title-wrap">
              <span class="ph-graph-panel-title">
                {{ selected.source === 'kb' ? '知识图谱' : '论文关联图谱' }}
              </span>
              <span class="ph-graph-panel-subtitle">{{ selected.title }}</span>
            </div>
            <button class="ph-graph-close" title="返回论文列表" @click="closeGraph">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M6 6L18 18M6 18L18 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
              </svg>
            </button>
          </div>

          <div v-if="selected.source === 'kb'" class="ph-graph-body">
            <div v-if="localGraph.nodes.length" class="ph-kb-graph">
              <KnowledgeGraphNetwork
                :nodes="localGraph.nodes"
                :edges="localGraph.edges"
                :focus-node-id="selected.id"
                @open="selectGraphNode"
              />
            </div>
            <div v-else class="ph-graph-empty">该条目暂无关联的 Wiki 知识节点</div>
          </div>

          <div v-else class="ph-graph-svg-container">
            <svg :viewBox="`0 0 ${GRAPH_W} ${GRAPH_H}`" preserveAspectRatio="xMidYMid meet" class="ph-knowledge-graph">
              <defs>
                <filter id="nodeShadow" x="-50%" y="-50%" width="200%" height="200%">
                  <feDropShadow dx="0" dy="2" stdDeviation="3" flood-opacity="0.12" />
                </filter>
                <filter id="centerGlow" x="-50%" y="-50%" width="200%" height="200%">
                  <feDropShadow dx="0" dy="3" stdDeviation="6" flood-opacity="0.2" />
                </filter>
              </defs>
              <g v-for="(e, i) in graphEdges" :key="'e' + i">
                <path
                  :d="`M ${CX} ${CY} Q ${(CX + e.x2) / 2} ${(CY + e.y2) / 2} ${e.x2} ${e.y2}`"
                  :stroke="e.color"
                  stroke-width="1.5"
                  fill="none"
                  opacity="0.35"
                />
                <text :x="(CX + e.x2) / 2" :y="(CY + e.y2) / 2 - 6" text-anchor="middle" :fill="e.color" font-size="10" font-family="Inter,sans-serif" font-weight="500">相关推荐</text>
              </g>
              <g
                v-for="(n, i) in graphNodes"
                :key="'n' + i"
                class="ph-related-node"
                @mouseenter="showTooltip($event, n.paper)"
                @mouseleave="hideTooltip"
                @click="openRecommendation(n.paper.id)"
              >
                <circle :cx="n.x" :cy="n.y" r="28" :fill="n.paper.categoryColor.bg" :stroke="n.paper.categoryColor.fg" stroke-width="2" filter="url(#nodeShadow)" />
                <text :x="n.x" :y="n.y + 4" text-anchor="middle" :fill="n.paper.categoryColor.fg" font-size="9" font-family="Inter,sans-serif" font-weight="600">{{ n.paper.category.slice(0, 4) }}</text>
                <text :x="n.x" :y="n.y + 44" text-anchor="middle" fill="#555" font-size="10" font-family="Inter,sans-serif">{{ n.paper.title.slice(0, 12) }}…</text>
              </g>
              <g v-if="selected" class="ph-center-node">
                <circle :cx="CX" :cy="CY" r="40" :fill="selected.categoryColor.fg" filter="url(#centerGlow)" />
                <text :x="CX" :y="CY - 2" text-anchor="middle" fill="#fff" font-size="10" font-family="Inter,sans-serif" font-weight="500" opacity="0.85">本文</text>
                <text :x="CX" :y="CY + 13" text-anchor="middle" fill="#fff" font-size="9" font-family="Inter,sans-serif" font-weight="600">{{ selected.category.slice(0, 4) }}</text>
                <text :x="CX" :y="CY + 64" text-anchor="middle" :fill="selected.categoryColor.fg" font-size="12" font-family="Source Serif 4,serif" font-weight="600">{{ selected.title.slice(0, 16) }}…</text>
              </g>
            </svg>
            <div v-if="tooltip" class="ph-graph-tooltip" :style="{ left: tooltip.x + 'px', top: tooltip.y + 'px' }">
              <div class="ph-tt-title">{{ tooltip.title }}</div>
              <div class="ph-tt-meta">{{ tooltip.sub }} · 相关推荐（点击切换）</div>
            </div>
          </div>

          <div class="ph-graph-legend">
            <template v-if="selected.source === 'kb'">
              <div class="ph-legend-item"><span class="ph-legend-dot" style="background:#003B5C" />核心论文</div>
              <div class="ph-legend-item"><span class="ph-legend-dot" style="background:#CCC;border:1px solid #999" />关联知识节点</div>
            </template>
            <template v-else>
              <div class="ph-legend-item"><span class="ph-legend-dot" style="background:#003B5C" />核心论文（可点击切换）</div>
              <div class="ph-legend-item"><span class="ph-legend-dot" style="background:#CCC;border:1px solid #999" />相关推荐论文</div>
            </template>
          </div>
        </div>
      </div>
    </section>

    <!-- ===== Trending Section ===== -->
    <section class="ph-trending-section">
      <div class="ph-trending-header">
        <h2 class="ph-trending-title">热门研究方向</h2>
      </div>
      <div class="ph-trending-grid">
        <button
          v-for="t in trending"
          :key="t.name"
          type="button"
          class="ph-trending-card"
          :class="{ active: activeTopic === t.name }"
          :aria-pressed="activeTopic === t.name"
          @click="selectTrending(t)"
        >
          <div class="ph-trending-name">{{ t.name }}</div>
        </button>
      </div>
    </section>

    <!-- ===== Footer ===== -->
    <footer class="ph-footer">
      <div class="ph-footer-brand">PaperHub</div>
      <div class="ph-footer-links">基于本地知识库 · 顶会优先 · 最新优先</div>
      <div class="ph-footer-copyright">© 2026 Hermes Studio</div>
    </footer>
  </div>
</template>

<style scoped lang="scss">
.ph-page {
  font-family: var(--ph-font-sans);
  color: var(--ph-text-dark);
  background: var(--ph-bg);
  min-height: 100%;
}

/* ===== Hero ===== */
.ph-hero {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 56px 80px 40px;
  gap: 20px;
}
.ph-hero-title {
  font-family: var(--ph-font-serif);
  font-size: 48px;
  font-weight: 600;
  color: var(--ph-text-dark);
  text-align: center;
  letter-spacing: -0.5px;
  line-height: 1.2;
}
.ph-hero-subtitle {
  font-size: 18px;
  color: var(--ph-text-medium);
  text-align: center;
}
.ph-hero-search {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 640px;
  max-width: 100%;
  height: 52px;
  padding: 0 8px 0 16px;
  background: var(--ph-card);
  border: 1px solid #cfcab8;
  border-radius: 12px;
  box-shadow: 0 1px 2px rgba(6, 8, 10, 0.04);

  input {
    flex: 1;
    border: none;
    background: none;
    outline: none;
    font-family: var(--ph-font-sans);
    font-size: 15px;
    color: var(--ph-text-dark);

    &::placeholder {
      color: var(--ph-text-light);
    }
  }
}
.ph-hero-stats {
  font-size: 14px;
  color: var(--ph-text-light);
  text-align: center;
}

/* ===== Filter Bar ===== */
.ph-filter-bar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  min-height: 56px;
  padding: 8px 80px;
  background: var(--ph-card);
  border-bottom: 1px solid var(--ph-border);
  flex-wrap: wrap;
  gap: 10px;
}
.ph-filter-left {
  display: flex;
  align-items: center;
  gap: 18px;
  flex-wrap: wrap;
  min-width: 0;
}
.ph-source-switch {
  display: inline-flex;
  border: 1px solid var(--ph-border);
  border-radius: 100px;
  overflow: hidden;
  flex-shrink: 0;

  button {
    height: 32px;
    padding: 0 16px;
    border: none;
    background: var(--ph-bg);
    color: var(--ph-text-medium);
    font-family: var(--ph-font-sans);
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.2s;

    & + button { border-left: 1px solid var(--ph-border); }
    &.active { background: var(--ph-navy); color: #fff; }
    &:not(.active):hover { color: var(--ph-navy); }
  }
}
.ph-filter-chips {
  display: flex;
  align-items: center;
  gap: 12px;
  overflow-x: auto;
}
.ph-chip {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 32px;
  padding: 0 16px;
  border-radius: 100px;
  font-family: var(--ph-font-sans);
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  white-space: nowrap;
  border: 1px solid var(--ph-border);
  background: var(--ph-bg);
  color: var(--ph-text-medium);
  transition: all 0.2s;

  &.active {
    background: var(--ph-navy);
    color: #fff;
    border: none;
  }
  &:not(.active):hover {
    border-color: var(--ph-navy);
    color: var(--ph-navy);
  }
}
.ph-sort-select {
  height: 32px;
  padding: 0 12px;
  border-radius: 8px;
  border: 1px solid var(--ph-border);
  background: var(--ph-bg);
  font-family: var(--ph-font-sans);
  font-size: 13px;
  font-weight: 500;
  color: var(--ph-text-medium);
  cursor: pointer;
}

/* ===== Content Section ===== */
.ph-content {
  padding: 48px 80px;
  background: var(--ph-section-bg);
  display: flex;
  flex-direction: column;
  gap: 32px;
}
.ph-section-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.ph-section-title {
  font-family: var(--ph-font-serif);
  font-size: 28px;
  font-weight: 600;
  color: var(--ph-text-dark);
}
.ph-section-actions {
  display: flex;
  align-items: center;
  gap: 16px;
}
.ph-refresh {
  height: 32px;
  padding: 0 16px;
  border-radius: 8px;
  border: 1px solid var(--ph-border);
  background: var(--ph-bg);
  color: var(--ph-text-medium);
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  &:hover { border-color: var(--ph-navy); color: var(--ph-navy); }
  &:disabled { opacity: 0.6; cursor: default; }
}
.ph-refresh-hint {
  font-family: var(--ph-font-sans);
  font-size: 12px;
  color: var(--ph-text-medium);
  opacity: 0.85;
  white-space: nowrap;
}
.ph-refresh-message {
  margin: 0;
  font-family: var(--ph-font-sans);
  font-size: 13px;
  color: #1B5E20;
  &.is-error { color: #b91c1c; }
}
.ph-section-link {
  font-family: var(--ph-font-sans);
  font-size: 14px;
  font-weight: 500;
  color: var(--ph-navy);
  transition: opacity 0.2s;
  &:hover { opacity: 0.7; }
}
.ph-state {
  padding: 48px;
  text-align: center;
  color: var(--ph-text-medium);
  font-size: 15px;
}
.ph-state-detail {
  max-width: 520px;
  margin: 10px auto 0;
  color: var(--ph-text-light);
  font-size: 13px;
}
.ph-state-error { color: #b91c1c; }

/* ===== Card Grid ===== */
.ph-card-grid {
  display: flex;
  flex-direction: column;
  gap: 24px;
}
.ph-card-row {
  display: flex;
  gap: 24px;
}
.ph-paper-card {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 24px;
  background: var(--ph-card);
  border: 1px solid var(--ph-border-light);
  border-left: 4px solid transparent;
  border-radius: 12px;
  box-shadow: 0 1px 2px rgba(6, 8, 10, 0.04), 0 4px 12px rgba(6, 8, 10, 0.06);
  transition: box-shadow 0.3s, transform 0.3s, border-color 0.3s;
  cursor: pointer;

  &:hover {
    box-shadow: 0 2px 4px rgba(6, 8, 10, 0.06), 0 8px 24px rgba(6, 8, 10, 0.1);
    transform: translateY(-2px);
  }
  &.is-kb { border-left-color: var(--ph-navy); }
  &.compact {
    padding: 16px;
    gap: 8px;
    opacity: 0.75;
    &:hover { opacity: 1; transform: translateX(4px); }
  }
  &.selected {
    border: 2px solid var(--ph-navy);
    border-left: 4px solid var(--ph-navy);
    box-shadow: 0 0 0 3px rgba(0, 59, 92, 0.08), 0 4px 16px rgba(6, 8, 10, 0.1);
  }
}
.ph-card-top-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.ph-source-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: 20px;
  padding: 0 8px;
  border-radius: 4px;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.4px;

  &.kb { background: #E8EFF4; color: #003B5C; }
  &.rec { background: #FFF3E0; color: #E65100; }
}
.ph-card-tag {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: 22px;
  padding: 0 8px;
  border-radius: 4px;
  font-family: var(--ph-font-sans);
  font-size: 11px;
  font-weight: 500;
}
.ph-card-date {
  margin-left: auto;
  font-family: var(--ph-font-sans);
  font-size: 12px;
  color: var(--ph-text-light);
}
.ph-card-title {
  font-family: var(--ph-font-serif);
  font-size: 18px;
  font-weight: 600;
  color: var(--ph-text-dark);
  line-height: 26px;

  &.compact-title { font-size: 15px; line-height: 22px; }

  a { color: inherit; text-decoration: none; &:hover { text-decoration: underline; color: var(--ph-navy); } }
}
.ph-original-title {
  margin: 0;
  color: var(--ph-text-light);
  font-size: 12px;
  line-height: 1.45;
}
.ph-card-authors {
  margin: 0;
  font-family: var(--ph-font-sans);
  font-size: 13px;
  color: var(--ph-text-medium);
}
.ph-card-abstract {
  margin: 0;
  font-family: var(--ph-font-serif);
  font-size: 14px;
  color: var(--ph-text-abstract);
  line-height: 22px;
  display: -webkit-box;
  overflow: hidden;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 3;
}
.ph-card-footer {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-top: auto;
}
.ph-card-metrics {
  display: flex;
  align-items: center;
  gap: 16px;
  flex-wrap: wrap;
  span {
    font-family: var(--ph-font-sans);
    font-size: 12px;
    color: var(--ph-text-light);
  }
}
.ph-card-bookmark {
  width: 18px;
  height: 18px;
  cursor: pointer;
  opacity: 0.6;
  transition: opacity 0.2s;
  &:hover { opacity: 1; }
  &.active { opacity: 1; }
}

/* ===== Graph View ===== */
.ph-graph-view {
  display: flex;
  gap: 24px;
  align-items: flex-start;
}
.ph-graph-left {
  width: 380px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
  max-height: 720px;
  overflow-y: auto;
  padding-right: 4px;
}
.ph-graph-left::-webkit-scrollbar { width: 4px; }
.ph-graph-left::-webkit-scrollbar-thumb { background: #d0cfc0; border-radius: 2px; }
.ph-graph-right {
  flex: 1;
  min-width: 0;
  background: var(--ph-card);
  border: 1px solid var(--ph-border-light);
  border-radius: 12px;
  box-shadow: 0 1px 2px rgba(6, 8, 10, 0.04), 0 4px 12px rgba(6, 8, 10, 0.06);
  display: flex;
  flex-direction: column;
  min-height: 640px;
  overflow: hidden;
}
.ph-graph-panel-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 18px 24px;
  border-bottom: 1px solid var(--ph-border);
}
.ph-graph-panel-title {
  font-family: var(--ph-font-serif);
  font-size: 18px;
  font-weight: 600;
  color: var(--ph-text-dark);
}
.ph-graph-panel-subtitle {
  font-size: 12px;
  color: var(--ph-text-light);
  max-width: 500px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ph-graph-close {
  width: 32px;
  height: 32px;
  border: 1px solid var(--ph-border);
  background: var(--ph-bg);
  border-radius: 8px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--ph-text-medium);
  &:hover { background: #edebe0; }
}
.ph-graph-body {
  flex: 1;
  display: flex;
  min-height: 540px;
}
.ph-kb-graph {
  flex: 1;
  min-height: 540px;
}
.ph-graph-empty {
  flex: 1;
  display: grid;
  place-items: center;
  color: var(--ph-text-light);
  font-size: 14px;
}
.ph-graph-svg-container {
  flex: 1;
  position: relative;
  background: linear-gradient(135deg, #fafaf7 0%, #f5f5f0 100%);
  overflow: hidden;
  min-height: 460px;
}
.ph-knowledge-graph {
  width: 100%;
  height: 100%;
  display: block;
}
.ph-related-node { cursor: pointer; transition: opacity 0.2s; &:hover { opacity: 0.85; } }
.ph-graph-tooltip {
  position: absolute;
  background: var(--ph-text-dark);
  color: #fff;
  padding: 8px 12px;
  border-radius: 6px;
  font-size: 12px;
  pointer-events: none;
  z-index: 100;
  max-width: 280px;
  line-height: 1.5;
  transform: translate(-50%, -100%);
  margin-top: -8px;
}
.ph-tt-title { font-weight: 500; margin-bottom: 3px; }
.ph-tt-meta { font-size: 11px; opacity: 0.7; }
.ph-graph-legend {
  padding: 10px 24px;
  border-top: 1px solid var(--ph-border);
  display: flex;
  gap: 18px;
  flex-wrap: wrap;
  align-items: center;
}
.ph-legend-item {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--ph-text-light);
}
.ph-legend-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
}

/* ===== Trending Section ===== */
.ph-trending-section {
  padding: 48px 80px;
  background: var(--ph-card);
  display: flex;
  flex-direction: column;
  gap: 24px;
}
.ph-trending-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.ph-trending-title {
  font-family: var(--ph-font-serif);
  font-size: 24px;
  font-weight: 600;
  color: var(--ph-text-dark);
}
.ph-trending-grid {
  display: flex;
  gap: 24px;
  flex-wrap: wrap;
}
.ph-trending-card {
  flex: 1;
  min-width: 160px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 20px 24px;
  background: var(--ph-section-bg);
  border: 1px solid var(--ph-border);
  border-radius: 12px;
  color: inherit;
  font: inherit;
  text-align: left;
  transition: border-color 0.2s, box-shadow 0.2s;
  cursor: pointer;
  &:hover,
  &.active { border-color: var(--ph-navy); box-shadow: 0 2px 8px rgba(0, 59, 92, 0.08); }
  &.active { background: var(--ph-card); outline: 2px solid rgba(0, 59, 92, 0.12); outline-offset: 1px; }
}
.ph-trending-name {
  font-family: var(--ph-font-serif);
  font-size: 16px;
  font-weight: 600;
  color: var(--ph-text-dark);
}
/* ===== Footer ===== */
.ph-footer {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 40px 80px;
  background: var(--ph-footer, #1a1a1a);
}
.ph-footer-brand {
  font-family: var(--ph-font-serif);
  font-size: 18px;
  font-weight: 600;
  color: #fff;
}
.ph-footer-links {
  font-family: var(--ph-font-sans);
  font-size: 13px;
  color: var(--ph-text-light);
}
.ph-footer-copyright {
  font-family: var(--ph-font-sans);
  font-size: 13px;
  color: #666;
}

/* ===== Responsive ===== */
@media (max-width: 1200px) {
  .ph-card-row { flex-wrap: wrap; }
  .ph-paper-card { min-width: 300px; }
  .ph-graph-view { flex-direction: column; }
  .ph-graph-left { width: 100%; max-height: none; flex-direction: row; overflow-x: auto; flex-wrap: nowrap; }
  .ph-graph-left .ph-paper-card { min-width: 260px; flex-shrink: 0; }
}
@media (max-width: 768px) {
  .ph-hero { padding: 40px 24px 32px; }
  .ph-hero-title { font-size: 32px; }
  .ph-hero-search { width: 100%; }
  .ph-filter-bar { padding: 8px 24px; }
  .ph-content { padding: 32px 24px; }
  .ph-card-row { flex-direction: column; }
  .ph-trending-section { padding: 32px 24px; }
  .ph-footer { padding: 32px 24px; flex-direction: column; gap: 16px; text-align: center; }
  .ph-graph-left { flex-direction: column; }
  .ph-graph-left .ph-paper-card { min-width: auto; }
}

/* ===== 后端服务状态条 ===== */
.ph-service-strip {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 18px;
  justify-content: center;
  font-family: var(--ph-font-sans);
  font-size: 12px;
  color: #666;
}
.ph-service-item {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  background: #fff;
  border: 1px solid #e6e5d6;
  border-radius: 100px;
  padding: 4px 12px;
  color: #c0392b;
}
.ph-service-item.ok {
  color: #1b5e20;
  border-color: #cfe3d2;
}
.ph-service-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #c0392b;
  flex-shrink: 0;
}
.ph-service-item.ok .ph-service-dot {
  background: #1f9d55;
}
.ph-service-detail {
  font-style: normal;
  color: #999;
  max-width: 30ch;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
html.dark .ph-service-item {
  background: #2a2a2a;
  border-color: #3a3a3a;
}
html.dark .ph-service-detail {
  color: #888;
}

/* ===== 新发现角标（本次刷新新检索到的论文） ===== */
.ph-newly {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: 16px;
  padding: 0 6px;
  margin-left: 6px;
  border-radius: 4px;
  background: #e65100;
  color: #fff;
  font-size: 10px;
  font-weight: 600;
  vertical-align: middle;
  animation: ph-newly-pulse 2s ease-in-out infinite;
}
@keyframes ph-newly-pulse {
  0%, 100% { box-shadow: 0 0 0 0 rgba(230, 81, 0, 0.35); }
  50% { box-shadow: 0 0 0 4px rgba(230, 81, 0, 0); }
}

.ph-found-at {
  color: #e65100;
  font-weight: 500;
}

/* ===== 删除已入库论文/文章按钮 ===== */
.ph-card-delete {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border: 1px solid #e6e5d6;
  border-radius: 8px;
  background: transparent;
  color: #999;
  cursor: pointer;
  transition: all 0.2s;
  flex-shrink: 0;
}
.ph-card-delete:hover {
  border-color: #e65100;
  color: #e65100;
  background: #fff5ef;
}
.ph-card-delete:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.ph-card-delete svg {
  width: 15px;
  height: 15px;
}
html.dark .ph-card-delete {
  background: #252525;
  border-color: #3a3a3a;
  color: #888;
}
html.dark .ph-card-delete:hover {
  border-color: #e65100;
  color: #e65100;
  background: #3a2a20;
}
</style>
