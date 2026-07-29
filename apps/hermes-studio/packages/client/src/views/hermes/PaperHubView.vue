<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, RouterLink } from 'vue-router'
import { fetchWorkbenchSummary, refreshPaperRecommendations, type PaperRecommendation, type PaperRecommendationsPayload } from '@/api/workbench'

const route = useRoute()

const loading = ref(true)
const error = ref<string | null>(null)
const payload = ref<PaperRecommendationsPayload | null>(null)
const refreshing = ref(false)

const searchText = ref((route.query.q as string) || '')
const activeCategory = ref('全部')
const sortBy = ref<'hot' | 'newest' | 'oldest'>('hot')

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

function tagFor(venue?: string | null): { label: string; bg: string; fg: string } {
  if (venue && venue.trim()) {
    let hash = 0
    for (let i = 0; i < venue.length; i++) hash = (hash * 31 + venue.charCodeAt(i)) >>> 0
    const c = PALETTE[hash % PALETTE.length]
    return { label: venue, bg: c.bg, fg: c.fg }
  }
  return { label: '论文', bg: '#EEEEE6', fg: '#555555' }
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

async function load() {
  loading.value = true
  error.value = null
  try {
    const data = await fetchWorkbenchSummary()
    payload.value = data.paperRecommendations ?? null
  } catch (e) {
    error.value = e instanceof Error ? e.message : '加载失败'
  } finally {
    loading.value = false
  }
}

async function onRefresh() {
  refreshing.value = true
  try {
    const data = await refreshPaperRecommendations()
    payload.value = data
  } catch (e) {
    error.value = e instanceof Error ? e.message : '刷新失败'
  } finally {
    refreshing.value = false
  }
}

const items = computed<PaperRecommendation[]>(() => payload.value?.items ?? [])

const categories = computed<string[]>(() => {
  const set = new Set<string>()
  for (const it of items.value) {
    const t = tagFor(it.venue).label
    if (t && t !== '论文') set.add(t)
  }
  return ['全部', ...[...set]]
})

const filtered = computed<PaperRecommendation[]>(() => {
  const q = searchText.value.trim().toLowerCase()
  let list = items.value.filter((it) => {
    if (activeCategory.value !== '全部' && tagFor(it.venue).label !== activeCategory.value) return false
    if (q) {
      const hay = `${it.title} ${(it.authors ?? []).join(' ')} ${it.venue ?? ''}`.toLowerCase()
      if (!hay.includes(q)) return false
    }
    return true
  })
  if (sortBy.value === 'newest') list = [...list].sort((a, b) => (b.year ?? 0) - (a.year ?? 0))
  else if (sortBy.value === 'oldest') list = [...list].sort((a, b) => (a.year ?? 0) - (b.year ?? 0))
  return list
})

const trending = computed<{ name: string; count: number }[]>(() => {
  if (!items.value.length) {
    return [
      { name: '人工智能', count: 2341 },
      { name: '大数据', count: 1876 },
      { name: '深度学习', count: 1567 },
      { name: '计算机视觉', count: 1342 },
      { name: '体系结构', count: 980 },
      { name: '系统', count: 845 },
    ]
  }
  const map = new Map<string, number>()
  for (const it of items.value) {
    const key = tagFor(it.venue).label
    map.set(key, (map.get(key) ?? 0) + 1)
  }
  return [...map.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 6)
})

const stats = computed(() => {
  const kb = payload.value?.paperCount ?? 0
  return {
    recommendations: items.value.length,
    kb,
  }
})

const heroStats = computed(() =>
  `${stats.value.recommendations} 篇顶会推荐 · ${stats.value.kb} 篇知识库论文 · 按发表时间排序（最新优先）`,
)

// ===== Graph view =====
const selectedPaper = computed(() => items.value.find((it) => it.id === selectedId.value) ?? null)

const GRAPH_W = 700
const GRAPH_H = 500
const CX = 350
const CY = 250
const RADIUS = 155

const graphNodes = computed(() => {
  const center = selectedPaper.value
  if (!center) return []
  const others = items.value.filter((it) => it.id !== center.id).slice(0, 7)
  const nodes = others.map((paper, i) => {
    const angle = (i / others.length) * 2 * Math.PI - Math.PI / 2
    return {
      id: paper.id,
      paper,
      x: CX + Math.cos(angle) * RADIUS,
      y: CY + Math.sin(angle) * RADIUS,
      angle,
    }
  })
  return nodes
})

const graphEdges = computed(() =>
  graphNodes.value.map((n) => ({
    x1: CX,
    y1: CY,
    x2: n.x,
    y2: n.y,
    color: tagFor(n.paper.venue).fg,
  })),
)

const tooltip = ref<{ x: number; y: number; title: string; sub: string } | null>(null)
function showTooltip(event: MouseEvent, paper: PaperRecommendation) {
  const container = (event.currentTarget as SVGElement).ownerSVGElement?.parentElement
  if (!container) return
  const cRect = container.getBoundingClientRect()
  const nRect = (event.currentTarget as SVGElement).getBoundingClientRect()
  tooltip.value = {
    x: nRect.left - cRect.left + nRect.width / 2,
    y: nRect.top - cRect.top,
    title: paper.title,
    sub: tagFor(paper.venue).label,
  }
}
function hideTooltip() {
  tooltip.value = null
}
function openGraph(id: string) {
  selectedId.value = id
  document.querySelector('.ph-content')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}
function closeGraph() {
  selectedId.value = null
  hideTooltip()
}

watch(
  () => route.query.q,
  (q) => {
    searchText.value = (q as string) || ''
  },
)

onMounted(() => {
  loadFavorites()
  load()
})
</script>

<template>
  <div class="ph-page">
    <!-- ===== Hero ===== -->
    <section class="ph-hero">
      <h1 class="ph-hero-title">探索 AI 与数据科学前沿研究</h1>
      <p class="ph-hero-subtitle">基于本地知识库 wiki 相似检索，定时推荐最新的顶会论文</p>
      <div class="ph-hero-search">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
          <circle cx="11" cy="11" r="7" stroke="#666666" stroke-width="2" />
          <path d="M16 16L20 20" stroke="#666666" stroke-width="2" stroke-linecap="round" />
        </svg>
        <input v-model="searchText" type="text" placeholder="输入论文标题、关键词或作者姓名" />
      </div>
      <p class="ph-hero-stats">{{ heroStats }}</p>
    </section>

    <!-- ===== Filter Bar ===== -->
    <div class="ph-filter-bar">
      <div class="ph-filter-chips">
        <button
          v-for="cat in categories"
          :key="cat"
          class="ph-chip"
          :class="{ active: activeCategory === cat }"
          @click="activeCategory = cat"
        >{{ cat }}</button>
      </div>
      <div class="ph-sort">
        <select v-model="sortBy" class="ph-sort-select">
          <option value="hot">热度排序</option>
          <option value="newest">最新优先</option>
          <option value="oldest">最早优先</option>
        </select>
      </div>
    </div>

    <!-- ===== Content Section ===== -->
    <section class="ph-content">
      <div class="ph-section-header">
        <h2 class="ph-section-title">热门论文推荐</h2>
        <div class="ph-section-actions">
          <button class="ph-refresh" :disabled="refreshing" @click="onRefresh">
            {{ refreshing ? '生成中…' : '刷新' }}
          </button>
          <RouterLink class="ph-section-link" :to="{ name: 'hermes.personalWorkbench' }">查看全部 →</RouterLink>
        </div>
      </div>

      <div v-if="loading" class="ph-state">加载中…</div>
      <div v-else-if="error" class="ph-state ph-state-error">{{ error }}</div>
      <div v-else-if="!filtered.length" class="ph-state">暂无匹配的推荐论文</div>

      <!-- Normal card grid -->
      <div v-if="!selectedId" class="ph-card-grid">
        <div v-for="row in Math.ceil(filtered.length / 3)" :key="row" class="ph-card-row">
          <article
            v-for="item in filtered.slice((row - 1) * 3, row * 3)"
            :key="item.id"
            class="ph-paper-card"
            @click="openGraph(item.id)"
          >
            <div class="ph-card-top-row">
              <span class="ph-card-tag" :style="{ background: tagFor(item.venue).bg, color: tagFor(item.venue).fg }">
                {{ tagFor(item.venue).label }}
              </span>
              <span class="ph-card-date">{{ item.year ?? '—' }}</span>
            </div>
            <h3 class="ph-card-title">
              <a v-if="item.url" :href="item.url" target="_blank" rel="noopener" @click.stop>{{ item.title }}</a>
              <template v-else>{{ item.title }}</template>
            </h3>
            <p class="ph-card-authors">{{ (item.authors ?? []).slice(0, 4).join('、') }}{{ (item.authors ?? []).length > 4 ? ' 等' : '' }}</p>
            <p class="ph-card-abstract">{{ item.reason || item.abstract || '—' }}</p>
            <div class="ph-card-footer">
              <div class="ph-card-metrics">
                <span v-if="item.venue">会议 {{ item.venue }}</span>
                <span v-if="item.provider">来源 {{ item.provider }}</span>
              </div>
              <svg
                class="ph-card-bookmark"
                :class="{ active: favorites.has(item.id) }"
                viewBox="0 0 24 24"
                fill="none"
                xmlns="http://www.w3.org/2000/svg"
                @click.stop="toggleFavorite(item.id)"
              >
                <path d="M6 4H18V20L12 16L6 20V4Z" :stroke="favorites.has(item.id) ? '#003B5C' : '#999999'" :fill="favorites.has(item.id) ? '#003B5C' : 'none'" stroke-width="2" stroke-linejoin="round" />
              </svg>
            </div>
          </article>
        </div>
      </div>

      <!-- Graph view -->
      <div v-else class="ph-graph-view">
        <div class="ph-graph-left">
          <article
            v-for="item in [selectedPaper, ...filtered.filter((i) => i.id !== selectedId)]"
            :key="item?.id"
            class="ph-paper-card"
            :class="item?.id === selectedId ? 'selected' : 'compact'"
            @click="item && item.id !== selectedId && openGraph(item.id)"
          >
            <div class="ph-card-top-row">
              <span class="ph-card-tag" :style="{ background: tagFor(item?.venue).bg, color: tagFor(item?.venue).fg }">
                {{ tagFor(item?.venue).label }}
              </span>
              <span class="ph-card-date">{{ item?.year ?? '—' }}</span>
            </div>
            <h3 class="ph-card-title" :class="item?.id !== selectedId && 'compact-title'">{{ item?.title }}</h3>
            <p class="ph-card-authors">{{ (item?.authors ?? []).slice(0, 4).join('、') }}</p>
            <p v-if="item?.id === selectedId" class="ph-card-abstract">{{ item?.reason || item?.abstract || '—' }}</p>
          </article>
        </div>
        <div class="ph-graph-right">
          <div class="ph-graph-panel-header">
            <div class="ph-graph-panel-title-wrap">
              <span class="ph-graph-panel-title">论文关联图谱</span>
              <span class="ph-graph-panel-subtitle">{{ selectedPaper?.title }} 的相关推荐</span>
            </div>
            <button class="ph-graph-close" title="返回论文列表" @click="closeGraph">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M6 6L18 18M6 18L18 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
              </svg>
            </button>
          </div>
          <div class="ph-graph-svg-container">
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
                @click="openGraph(n.paper.id)"
              >
                <circle :cx="n.x" :cy="n.y" r="28" :fill="tagFor(n.paper.venue).bg" :stroke="tagFor(n.paper.venue).fg" stroke-width="2" filter="url(#nodeShadow)" />
                <text :x="n.x" :y="n.y + 4" text-anchor="middle" :fill="tagFor(n.paper.venue).fg" font-size="9" font-family="Inter,sans-serif" font-weight="600">{{ tagFor(n.paper.venue).label.slice(0, 4) }}</text>
                <text :x="n.x" :y="n.y + 44" text-anchor="middle" fill="#555" font-size="10" font-family="Inter,sans-serif">{{ n.paper.title.slice(0, 12) }}…</text>
              </g>
              <g v-if="selectedPaper" class="ph-center-node">
                <circle :cx="CX" :cy="CY" r="40" :fill="tagFor(selectedPaper.venue).fg" filter="url(#centerGlow)" />
                <text :x="CX" :y="CY - 2" text-anchor="middle" fill="#fff" font-size="10" font-family="Inter,sans-serif" font-weight="500" opacity="0.85">本文</text>
                <text :x="CX" :y="CY + 13" text-anchor="middle" fill="#fff" font-size="9" font-family="Inter,sans-serif" font-weight="600">{{ tagFor(selectedPaper.venue).label.slice(0, 4) }}</text>
                <text :x="CX" :y="CY + 64" text-anchor="middle" :fill="tagFor(selectedPaper.venue).fg" font-size="12" font-family="Source Serif 4,serif" font-weight="600">{{ selectedPaper.title.slice(0, 16) }}…</text>
              </g>
            </svg>
            <div v-if="tooltip" class="ph-graph-tooltip" :style="{ left: tooltip.x + 'px', top: tooltip.y + 'px' }">
              <div class="ph-tt-title">{{ tooltip.title }}</div>
              <div class="ph-tt-meta">{{ tooltip.sub }} · 相关推荐（点击切换）</div>
            </div>
          </div>
          <div class="ph-graph-legend">
            <div class="ph-legend-item"><span class="ph-legend-dot" style="background:#003B5C" />核心论文（可点击切换）</div>
            <div class="ph-legend-item"><span class="ph-legend-dot" style="background:#CCC;border:1px solid #999" />相关推荐论文</div>
          </div>
        </div>
      </div>
    </section>

    <!-- ===== Trending Section ===== -->
    <section class="ph-trending-section">
      <div class="ph-trending-header">
        <h2 class="ph-trending-title">热门研究方向</h2>
        <RouterLink class="ph-section-link" :to="{ name: 'hermes.knowledge' }">查看知识库 →</RouterLink>
      </div>
      <div class="ph-trending-grid">
        <div v-for="t in trending" :key="t.name" class="ph-trending-card">
          <div class="ph-trending-name">{{ t.name }}</div>
          <div class="ph-trending-count">{{ t.count }} 篇论文</div>
        </div>
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
  height: 56px;
  padding: 0 80px;
  background: var(--ph-card);
  border-bottom: 1px solid var(--ph-border);
  flex-wrap: wrap;
  gap: 8px;
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
  gap: 16px;
  padding: 24px;
  background: var(--ph-card);
  border: 1px solid var(--ph-border-light);
  border-radius: 12px;
  box-shadow: 0 1px 2px rgba(6, 8, 10, 0.04), 0 4px 12px rgba(6, 8, 10, 0.06);
  transition: box-shadow 0.3s, transform 0.3s, border-color 0.3s;
  cursor: pointer;

  &:hover {
    box-shadow: 0 2px 4px rgba(6, 8, 10, 0.06), 0 8px 24px rgba(6, 8, 10, 0.1);
    transform: translateY(-2px);
  }
  &.compact {
    padding: 16px;
    gap: 10px;
    opacity: 0.75;
    &:hover { opacity: 1; transform: translateX(4px); }
  }
  &.selected {
    border: 2px solid var(--ph-navy);
    box-shadow: 0 0 0 3px rgba(0, 59, 92, 0.08), 0 4px 16px rgba(6, 8, 10, 0.1);
  }
}
.ph-card-top-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.ph-card-tag {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: 24px;
  padding: 0 8px;
  border-radius: 4px;
  font-family: var(--ph-font-sans);
  font-size: 11px;
  font-weight: 500;
}
.ph-card-date {
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
.ph-card-authors {
  font-family: var(--ph-font-sans);
  font-size: 13px;
  color: var(--ph-text-medium);
}
.ph-card-abstract {
  font-family: var(--ph-font-serif);
  font-size: 14px;
  color: var(--ph-text-abstract);
  line-height: 22px;
}
.ph-card-footer {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.ph-card-metrics {
  display: flex;
  align-items: center;
  gap: 16px;
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
  max-height: 680px;
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
  transition: border-color 0.2s, box-shadow 0.2s;
  cursor: pointer;
  &:hover { border-color: var(--ph-navy); box-shadow: 0 2px 8px rgba(0, 59, 92, 0.08); }
}
.ph-trending-name {
  font-family: var(--ph-font-serif);
  font-size: 16px;
  font-weight: 600;
  color: var(--ph-text-dark);
}
.ph-trending-count {
  font-family: var(--ph-font-sans);
  font-size: 13px;
  color: var(--ph-text-light);
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
  .ph-filter-bar { padding: 0 24px; }
  .ph-content { padding: 32px 24px; }
  .ph-card-row { flex-direction: column; }
  .ph-trending-section { padding: 32px 24px; }
  .ph-footer { padding: 32px 24px; flex-direction: column; gap: 16px; text-align: center; }
  .ph-graph-left { flex-direction: column; }
  .ph-graph-left .ph-paper-card { min-width: auto; }
}
</style>
