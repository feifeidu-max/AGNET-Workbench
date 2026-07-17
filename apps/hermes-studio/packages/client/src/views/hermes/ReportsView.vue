<script setup lang="ts">
import { defineAsyncComponent, onMounted, ref } from 'vue'
import { NAlert, NButton, NEmpty, NSpin, NTag } from 'naive-ui'
import { listCompanyReports, type CompanyReport } from '@/api/workbench'

const MarkdownRenderer = defineAsyncComponent(async () => (
  await import('@/components/hermes/chat/MarkdownRenderer.vue')
).default)

const reports = ref<CompanyReport[]>([])
const loading = ref(false)
const error = ref('')

function formatDate(value: string): string {
  if (!value) return '日期未知'
  const date = new Date(`${value}T00:00:00+08:00`)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleDateString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    weekday: 'short',
  })
}

function formatDateTime(value: string | null): string {
  if (!value) return '生成时间未知'
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

function statusLabel(status: string): string {
  if (status === 'success') return '已完成'
  if (status === 'partial') return '部分完成'
  if (status === 'failed') return '采集失败'
  return status || '未知'
}

function statusType(status: string): 'success' | 'warning' | 'error' | 'default' {
  if (status === 'success') return 'success'
  if (status === 'partial') return 'warning'
  if (status === 'failed') return 'error'
  return 'default'
}

async function loadReports() {
  loading.value = true
  error.value = ''
  try {
    reports.value = await listCompanyReports()
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : '报告历史加载失败'
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  void loadReports()
})
</script>

<template>
  <div class="workbench-page">
    <header class="page-header">
      <div class="workbench-page-heading">
        <h2 class="header-title">定时报告</h2>
        <p>工作日 09:00 自动采集，使用确定性规则生成，不调用 LLM</p>
      </div>
      <NButton size="small" quaternary :loading="loading" @click="loadReports">
        <template #icon>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <polyline points="23 4 23 10 17 10" />
            <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
          </svg>
        </template>
        刷新
      </NButton>
    </header>

    <div class="workbench-content">
      <NAlert v-if="error" class="workbench-alert" type="error" title="无法加载报告历史">
        {{ error }}
        <NButton class="alert-retry" size="tiny" @click="loadReports">重试</NButton>
      </NAlert>

      <div v-if="loading && !reports.length" class="workbench-state"><NSpin description="正在读取报告历史…" /></div>

      <section v-else-if="reports.length" aria-labelledby="report-history-title">
        <div class="workbench-section-header">
          <h3 id="report-history-title" class="workbench-section-title">历史报告</h3>
          <span class="workbench-section-note">共 {{ reports.length }} 份</span>
        </div>
        <div class="workbench-list">
          <article v-for="report in reports" :key="report.id" class="workbench-list-item report-item">
            <div class="report-date-column">
              <strong>{{ formatDate(report.reportDate) }}</strong>
              <span>{{ formatDateTime(report.generatedAt) }}</span>
            </div>
            <div class="workbench-list-main">
              <h4 class="workbench-list-title">{{ report.title || '公司指标日报' }}</h4>
              <div class="workbench-list-meta">
                <span>指标 {{ report.metricCount || 0 }} 项</span>
                <span>异常 {{ report.abnormalCount || 0 }} 项</span>
              </div>
              <div v-if="report.summary" class="report-summary">
                <MarkdownRenderer :content="report.summary" />
              </div>
              <p v-if="report.error" class="report-error">{{ report.error }}</p>
            </div>
            <div class="workbench-list-actions">
              <NTag size="small" :type="statusType(report.status)" :bordered="false">{{ statusLabel(report.status) }}</NTag>
            </div>
          </article>
        </div>
      </section>

      <div v-else-if="!error" class="workbench-state"><NEmpty description="暂无报告；工作日首次采集后会在这里生成记录" /></div>
    </div>
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/workbench';
@use '@/styles/variables' as *;

.report-item {
  display: grid;
  grid-template-columns: 168px minmax(0, 1fr) auto;
}

.report-date-column {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.report-date-column strong {
  color: $text-primary;
  font-size: 13px;
}

.report-date-column span {
  color: $text-muted;
  font-size: 11px;
}

.report-error {
  margin-top: 8px;
  color: $error;
  font-size: 12px;
}

.report-summary {
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px solid $border-light;
  min-width: 0;
  overflow-x: auto;
  font-size: 12px;

  :deep(.markdown-body) {
    font-size: 12px;
  }

  :deep(h1) {
    margin: 0 0 8px;
    font-size: 16px;
    line-height: 1.35;
  }

  :deep(h2) {
    margin: 12px 0 6px;
    font-size: 14px;
    line-height: 1.4;
  }
}

@media (max-width: $breakpoint-mobile) {
  .report-item {
    display: flex;
  }
}
</style>
