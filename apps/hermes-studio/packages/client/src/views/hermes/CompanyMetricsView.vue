<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { NAlert, NButton, NEmpty, NSpin, NTag, useMessage } from 'naive-ui'
import {
  fetchCompanyMetricsSummary,
  refreshCompanyMetrics,
  type CompanyMetric,
  type CompanyMetricsSummary,
} from '@/api/workbench'

const message = useMessage()
const summary = ref<CompanyMetricsSummary | null>(null)
const loading = ref(false)
const refreshing = ref(false)
const error = ref('')

function formatDateTime(value: string | null | undefined): string {
  if (!value) return '尚未采集'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
}

function metricValue(metric: CompanyMetric): string {
  if (metric.value == null) return '--'
  if (typeof metric.value === 'number') {
    return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(metric.value)
  }
  return metric.value
}

function statusLabel(status: CompanyMetric['status'] | CompanyMetricsSummary['status']): string {
  const labels: Record<string, string> = {
    ok: '数据正常',
    normal: '正常',
    degraded: '部分异常',
    warning: '预警',
    down: '不可用',
    critical: '严重异常',
    unknown: '待采集',
    success: '数据正常',
    failed: '采集失败',
    not_run: '尚未采集',
  }
  return labels[status] || status
}

function statusType(status: CompanyMetric['status'] | CompanyMetricsSummary['status']): 'success' | 'warning' | 'error' | 'default' {
  if (status === 'ok' || status === 'normal' || status === 'success') return 'success'
  if (status === 'degraded' || status === 'warning') return 'warning'
  if (status === 'down' || status === 'critical' || status === 'failed') return 'error'
  return 'default'
}

function directionLabel(direction: CompanyMetric['direction']): string {
  if (direction === 'higher_better') return '越高越好'
  if (direction === 'lower_better') return '越低越好'
  return '中性指标'
}

function changeLabel(metric: CompanyMetric): string {
  if (metric.changePercent == null) return '暂无上一工作日对比'
  const sign = metric.changePercent > 0 ? '+' : ''
  return `较上一工作日 ${sign}${metric.changePercent.toFixed(1)}%`
}

async function loadSummary() {
  loading.value = true
  error.value = ''
  try {
    summary.value = await fetchCompanyMetricsSummary()
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : '公司指标加载失败'
  } finally {
    loading.value = false
  }
}

async function handleRefresh() {
  refreshing.value = true
  error.value = ''
  try {
    summary.value = await refreshCompanyMetrics()
    message.success('指标快照与当日报告已刷新')
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : '手动采集失败'
    message.error(error.value)
  } finally {
    refreshing.value = false
  }
}

onMounted(() => {
  void loadSummary()
})
</script>

<template>
  <div class="workbench-page">
    <header class="page-header">
      <div class="workbench-page-heading">
        <h2 class="header-title">公司数据</h2>
        <p>独立本地数据域；指标和报告不会提供给 Hermes 或公网模型</p>
      </div>
      <NButton type="primary" size="small" :loading="refreshing" :disabled="loading" @click="handleRefresh">
        <template #icon>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <polyline points="23 4 23 10 17 10" />
            <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
          </svg>
        </template>
        立即采集
      </NButton>
    </header>

    <div class="workbench-content">
      <NAlert v-if="error" class="workbench-alert" type="error" :title="summary ? '本次采集失败' : '无法加载公司指标'">
        {{ error }}
        <NButton class="alert-retry" size="tiny" @click="loadSummary">重新读取</NButton>
      </NAlert>
      <NAlert class="workbench-alert" type="info" :bordered="false">
        当前使用只读模拟连接器。取得公司平台 API 文档和指标口径后，可替换为正式连接器。
      </NAlert>

      <div v-if="loading && !summary" class="workbench-state"><NSpin description="正在读取本地指标快照…" /></div>

      <template v-else-if="summary">
        <div class="workbench-toolbar">
          <div class="workbench-toolbar-group">
            <NTag size="small" :type="statusType(summary.status)" :bordered="false">{{ statusLabel(summary.status) }}</NTag>
            <span class="workbench-section-note">最后更新：{{ formatDateTime(summary.lastUpdated) }}</span>
          </div>
          <RouterLink class="report-link" :to="{ name: 'hermes.reports' }">查看定时报告</RouterLink>
        </div>

        <section aria-labelledby="company-metric-title">
          <div class="workbench-section-header">
            <h3 id="company-metric-title" class="workbench-section-title">当前指标</h3>
            <span class="workbench-section-note">{{ summary.metrics.length }} 项</span>
          </div>
          <div v-if="summary.metrics.length" class="metric-grid">
            <article v-for="metric in summary.metrics" :key="metric.id" class="metric-tile">
              <div class="metric-heading">
                <span class="metric-label">{{ metric.name }}</span>
                <NTag size="tiny" :type="statusType(metric.status)" :bordered="false">{{ statusLabel(metric.status) }}</NTag>
              </div>
              <strong class="metric-value">{{ metricValue(metric) }}<small v-if="metric.unit"> {{ metric.unit }}</small></strong>
              <span class="metric-meta">{{ changeLabel(metric) }}</span>
              <span class="metric-meta">{{ directionLabel(metric.direction) }} · 源数据 {{ formatDateTime(metric.sourceTime) }}</span>
              <span v-if="metric.definitionVersion" class="metric-version">口径 {{ metric.definitionVersion }}</span>
            </article>
          </div>
          <div v-else class="workbench-state"><NEmpty description="尚未配置指标或还没有成功采集" /></div>
        </section>
      </template>

      <div v-else-if="!error" class="workbench-state"><NEmpty description="暂无公司指标" /></div>
    </div>
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/workbench';
@use '@/styles/variables' as *;

.metric-heading {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px;
}

.metric-value small {
  color: $text-secondary;
  font-family: $font-ui;
  font-size: 13px;
  font-weight: 400;
}

.metric-version {
  display: block;
  margin-top: 10px;
  color: $text-muted;
  font-family: $font-code;
  font-size: 10px;
}

.report-link {
  color: $text-secondary;
  font-size: 13px;
}
</style>
