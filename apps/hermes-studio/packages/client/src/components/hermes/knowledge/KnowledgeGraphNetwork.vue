<script setup lang="ts">
import { nextTick, onUnmounted, shallowRef, watch } from 'vue'
import {
  VueFlow,
  useVueFlow,
  type Edge,
  type Node,
  type NodeMouseEvent,
} from '@vue-flow/core'
import { Background } from '@vue-flow/background'
import { Controls } from '@vue-flow/controls'
import { MiniMap } from '@vue-flow/minimap'

import '@vue-flow/core/dist/style.css'
import '@vue-flow/core/dist/theme-default.css'
import '@vue-flow/controls/dist/style.css'
import '@vue-flow/minimap/dist/style.css'

const props = defineProps<{
  nodes: Array<Record<string, unknown>>
  edges: Array<Record<string, unknown>>
  focusNodeId?: string | null
}>()

const emit = defineEmits<{
  open: [node: Record<string, unknown>]
}>()

const flowNodes = shallowRef<Node[]>([])
const flowEdges = shallowRef<Edge[]>([])
const { fitView } = useVueFlow('knowledge-graph')
let fitTimer: ReturnType<typeof setTimeout> | null = null

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback
}

function graphNodeId(node: Record<string, unknown>): string {
  return text(node.id ?? node.path)
}

function edgeLabel(edge: Record<string, unknown>): string {
  const relation = text(edge.relation ?? edge.label)
  if (!relation || /paper:|sourceId|^[([{]|[{}\]]/.test(relation)) return 'Wiki 链接'
  return relation
}

function nodeColor(type: string): string {
  if (type === 'paper') return '#003b5c' // navy
  if (type === 'source' || type === 'article') return '#0d47a1' // blue
  if (type === 'concept') return '#e65100' // amber
  if (type === 'entity') return '#006064' // teal
  if (type === 'method') return '#6a1b9a' // purple
  return '#666666'
}

function nodeTypeLabel(type: string): string {
  if (type === 'paper') return '论文'
  if (type === 'source' || type === 'article') return '技术文章'
  if (type === 'concept') return '概念'
  if (type === 'entity') return '实体'
  if (type === 'method') return '方法'
  return '知识节点'
}

function miniMapColor(node: Node): string {
  return nodeColor(text(node.data?.nodeType, 'other'))
}

function buildLayout(
  nodeInputs: Array<Record<string, unknown>>,
  edgeInputs: Array<Record<string, unknown>>,
  focusNodeId?: string | null,
) {
  const ids = nodeInputs.map(graphNodeId).filter(Boolean)
  const indexById = new Map(ids.map((id, index) => [id, index]))
  const positions = ids.map(() => ({ x: 0, y: 0 }))
  const layoutEdges = edgeInputs
    .map(edge => ({ source: text(edge.source), target: text(edge.target) }))
    .filter(edge => indexById.has(edge.source) && indexById.has(edge.target) && edge.source !== edge.target)

  const focusIndex = focusNodeId ? indexById.get(focusNodeId) : undefined
  if (focusIndex !== undefined) {
    positions[focusIndex] = { x: 0, y: 0 }
    const adjacent = new Map<string, Set<string>>()
    for (const id of ids) adjacent.set(id, new Set())
    for (const edge of layoutEdges) {
      adjacent.get(edge.source)?.add(edge.target)
      adjacent.get(edge.target)?.add(edge.source)
    }
    const neighbors = [...(adjacent.get(focusNodeId!) || [])]
      .map(id => indexById.get(id)!)
      .filter(index => Number.isInteger(index))
    if (neighbors.length) {
      const radius = Math.max(330, 170 / Math.sin(Math.PI / Math.max(2, neighbors.length)))
      neighbors.forEach((index, order) => {
        const angle = -Math.PI / 2 + (Math.PI * 2 * order) / neighbors.length
        positions[index] = { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius }
      })
    }

    const remaining = ids.map((_, index) => index).filter(index => index !== focusIndex && !neighbors.includes(index))
    const columns = Math.max(2, Math.ceil(Math.sqrt(Math.max(1, remaining.length))))
    const stepX = 300
    const stepY = 220
    const startX = ((columns - 1) * stepX) / -2
    const startY = Math.max(520, radiusForRing(neighbors.length))
    remaining.forEach((index, order) => {
      const column = order % columns
      const row = Math.floor(order / columns)
      positions[index] = { x: startX + column * stepX, y: startY + row * stepY }
    })
  } else {
    const columns = Math.max(1, Math.ceil(Math.sqrt(Math.max(1, ids.length) * 1.35)))
    const stepX = 300
    const stepY = 220
    const rows = Math.ceil(ids.length / columns)
    ids.forEach((_, index) => {
      const column = index % columns
      const row = Math.floor(index / columns)
      positions[index] = {
        x: (column - (columns - 1) / 2) * stepX,
        y: (row - (rows - 1) / 2) * stepY,
      }
    })
  }
  return positions
}

function radiusForRing(neighborCount: number): number {
  return Math.max(520, 170 / Math.sin(Math.PI / Math.max(2, neighborCount)) + 170)
}

async function rebuildGraph() {
  const validNodes = props.nodes.filter(node => graphNodeId(node))
  const validIds = new Set(validNodes.map(graphNodeId))
  const validEdges = props.edges.filter(edge => {
    if (text(edge.kind, 'wikilink').toLowerCase() === 'keyword_similarity') return false
    const source = text(edge.source)
    const target = text(edge.target)
    return source && target && source !== target && validIds.has(source) && validIds.has(target)
  })
  const linkCounts = new Map<string, number>()
  for (const edge of validEdges) {
    linkCounts.set(text(edge.source), (linkCounts.get(text(edge.source)) || 0) + 1)
    linkCounts.set(text(edge.target), (linkCounts.get(text(edge.target)) || 0) + 1)
  }
  const positions = buildLayout(validNodes, validEdges, props.focusNodeId)
  flowNodes.value = validNodes.map((node, index) => {
    const nodeType = text(node.nodeType ?? node.node_type, 'other')
    return {
      id: graphNodeId(node),
      type: 'knowledge',
      position: positions[index] || { x: 0, y: 0 },
      data: {
        label: text(node.titleZh ?? node.title_zh ?? node.label ?? node.title ?? node.name ?? node.id, '未命名页面'),
        nodeType,
        nodeTypeLabel: nodeTypeLabel(nodeType),
        linkCount: linkCounts.get(graphNodeId(node)) || 0,
        color: nodeColor(nodeType),
        raw: node,
        focused: graphNodeId(node) === props.focusNodeId,
      },
      style: { width: '210px' },
    }
  })
  flowEdges.value = validEdges.map((edge, index) => {
    const kind = text(edge.kind, 'wikilink')
    return {
      id: `${kind}:${text(edge.source)}:${text(edge.target)}:${index}`,
      source: text(edge.source),
      target: text(edge.target),
      type: 'default',
      label: edgeLabel(edge),
      labelStyle: { fill: 'var(--ph-text-medium, #555555)', fontSize: 10, fontWeight: 600 },
      labelBgStyle: { fill: 'var(--ph-card, #ffffff)', fillOpacity: 0.92 },
      labelBgPadding: [5, 3],
      labelBgBorderRadius: 2,
      style: { stroke: '#8c9aa0', strokeWidth: 1.8, opacity: 0.86 },
      data: { kind },
    }
  })
  await nextTick()
  if (fitTimer) clearTimeout(fitTimer)
  fitTimer = setTimeout(() => {
    void fitView({ padding: 0.16, minZoom: 0.12, maxZoom: 0.95, duration: 250 })
  }, 60)
}

function openNode(payload: NodeMouseEvent) {
  const raw = payload.node.data?.raw
  if (raw && typeof raw === 'object') emit('open', raw as Record<string, unknown>)
}

watch(() => [props.nodes, props.edges, props.focusNodeId], () => { void rebuildGraph() }, { deep: true, immediate: true })

onUnmounted(() => {
  if (fitTimer) clearTimeout(fitTimer)
})
</script>

<template>
  <div class="knowledge-graph-network">
    <div class="knowledge-graph-legend" aria-label="图谱图例">
      <span><i class="legend-line legend-line--wiki" />Wiki 显式链接</span>
      <small>双击节点打开 Wiki</small>
    </div>
    <VueFlow
      id="knowledge-graph"
      v-model:nodes="flowNodes"
      v-model:edges="flowEdges"
      :fit-view-on-init="true"
      :min-zoom="0.12"
      :max-zoom="2"
      :nodes-connectable="false"
      :edges-updatable="false"
      :zoom-on-double-click="false"
      class="knowledge-flow"
      @node-double-click="openNode"
    >
      <template #node-knowledge="{ data }">
        <div class="knowledge-flow-node" :class="{ 'knowledge-flow-node--focused': data.focused }" :style="{ '--node-color': data.color }" :title="`${data.label}，双击打开 Wiki`">
          <span>{{ data.nodeTypeLabel }}</span>
          <strong>{{ data.label }}</strong>
          <small>{{ data.linkCount }} 条关系</small>
        </div>
      </template>
      <Background :gap="24" :size="1" color="var(--ph-border, #d9d7cc)" />
      <MiniMap pannable zoomable :node-color="miniMapColor" />
      <Controls />
    </VueFlow>
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.knowledge-graph-network {
  position: relative;
  min-height: 560px;
  height: min(68vh, 760px);
  overflow: hidden;
  border: 0;
  border-radius: 0;
  background: var(--ph-section-bg, #f5f5f0);
}

.knowledge-flow { width: 100%; height: 100%; }

.knowledge-graph-legend {
  position: absolute;
  z-index: 6;
  top: 12px;
  left: 12px;
  display: flex;
  align-items: center;
  gap: 14px;
  border: 1px solid var(--ph-border, #d9d7cc);
  padding: 7px 9px;
  background: color-mix(in srgb, var(--ph-card, #ffffff) 94%, transparent);
  color: var(--ph-text-medium, #555555);
  box-shadow: 0 1px 2px rgba(6, 8, 10, .04);
  font-size: 11px;

  span { display: inline-flex; align-items: center; gap: 5px; }
  small { color: var(--ph-text-light, #888888); }
}

.legend-line { display: inline-block; width: 24px; border-top: 2px solid var(--ph-navy, #003b5c); }

.knowledge-flow-node {
  display: grid;
  width: 210px;
  min-height: 68px;
  box-sizing: border-box;
  gap: 4px;
  border: 1px solid color-mix(in srgb, var(--node-color) 34%, var(--ph-border, #d9d7cc));
  border-left: 4px solid var(--node-color);
  padding: 9px 10px;
  border-radius: 10px;
  background: var(--ph-card, #ffffff);
  color: var(--ph-text-dark, #222222);
  box-shadow: 0 1px 2px rgba(6, 8, 10, .04), 0 4px 12px rgba(6, 8, 10, .06);
  font-family: var(--ph-font-sans, system-ui, sans-serif);

  > span { color: var(--node-color); font-size: 10px; font-weight: 700; letter-spacing: .35px; }
  > strong { display: -webkit-box; overflow: hidden; font-family: var(--ph-font-serif, Georgia, serif); font-size: 13px; line-height: 1.4; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }
  > small { color: var(--ph-text-light, #888888); font-size: 10px; }
}

.knowledge-flow-node--focused {
  outline: 3px solid color-mix(in srgb, var(--node-color) 22%, transparent);
  outline-offset: 3px;
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--node-color) 12%, transparent), 0 6px 18px color-mix(in srgb, var(--node-color) 18%, transparent);
}

:deep(.vue-flow__edge-textbg) {
  stroke: var(--ph-border, #d9d7cc);
  stroke-width: 1px;
}

:deep(.vue-flow__node.selected .knowledge-flow-node) {
  outline: 2px solid var(--ph-navy, #003b5c);
  outline-offset: 2px;
}

:deep(.vue-flow__controls),
:deep(.vue-flow__minimap) {
  border: 1px solid var(--ph-border, #d9d7cc);
  border-radius: 8px;
  background: var(--ph-card, #ffffff);
  box-shadow: 0 1px 2px rgba(6, 8, 10, .04);
}

:deep(.vue-flow__controls-button) {
  border-bottom-color: var(--ph-border-light, #e8e6dc);
  background: var(--ph-card, #ffffff);
  color: var(--ph-text-dark, #222222);
}

@media (max-width: $breakpoint-mobile) {
  .knowledge-graph-network { min-height: 500px; height: 68vh; }
  .knowledge-graph-legend { right: 10px; flex-wrap: wrap; gap: 7px 12px; }
  .knowledge-graph-legend small { width: 100%; }
}
</style>
