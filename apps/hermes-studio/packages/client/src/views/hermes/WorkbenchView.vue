<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { NAlert, NButton, NEmpty, NSpin, NTag } from 'naive-ui'
import { fetchWorkbenchSummary, type ServiceStatus, type WorkbenchSummary } from '@/api/workbench'

const loading = ref(false)
const error = ref('')
const summary = ref<WorkbenchSummary | null>(null)

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
</script>

<template>
  <div class="workbench-page">
    <header class="page-header">
      <div class="workbench-page-heading">
        <h2 class="header-title">个人工作台</h2>
        <p>论文知识、公司指标与定时报告的本地概览</p>
      </div>
      <NButton size="small" quaternary :loading="loading" aria-label="刷新工作台" @click="loadSummary">
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
      <NAlert v-if="error" class="workbench-alert" type="error" :title="summary ? '部分数据刷新失败' : '无法加载工作台'">
        {{ error }}
        <NButton class="alert-retry" size="tiny" @click="loadSummary">重试</NButton>
      </NAlert>

      <div v-if="loading && !summary" class="workbench-state">
        <NSpin size="medium" description="正在汇总本地服务状态…" />
      </div>

      <template v-else-if="summary">
        <section class="workbench-section" aria-labelledby="workbench-overview-title">
          <div class="workbench-section-header">
            <h3 id="workbench-overview-title" class="workbench-section-title">今日概览</h3>
            <span class="workbench-section-note">仅展示本机已同步数据</span>
          </div>
          <div class="workbench-summary-grid">
            <RouterLink class="summary-tile" :to="{ name: 'hermes.knowledge', query: { tab: 'drafts' } }">
              <span class="summary-label">今日论文</span>
              <strong class="summary-value">{{ summary.knowledge.todayPapers ?? 0 }}</strong>
              <span class="summary-meta">{{ summary.knowledge.awaitingReview ?? 0 }} 篇待审核</span>
            </RouterLink>
            <RouterLink class="summary-tile" :to="{ name: 'hermes.knowledge', query: { tab: 'trusted' } }">
              <span class="summary-label">可信知识库</span>
              <strong class="summary-value">{{ summary.knowledge.trusted }}</strong>
              <span class="summary-meta">{{ summary.knowledge.candidates }} 篇待读候选</span>
            </RouterLink>
            <RouterLink class="summary-tile" :to="{ name: 'hermes.companyMetrics' }">
              <span class="summary-label">公司指标</span>
              <strong class="summary-value">{{ summary.company.metricCount }}</strong>
              <span class="summary-meta status-dot-label" :class="summary.company.status">
                {{ statusLabel(summary.company.status) }} · {{ formatDateTime(summary.company.lastUpdated) }}
              </span>
            </RouterLink>
            <RouterLink class="summary-tile" :to="{ name: 'hermes.reports' }">
              <span class="summary-label">下一次报告</span>
              <strong class="summary-value summary-value--date">{{ formatDateTime(summary.reports.nextRun, '待调度') }}</strong>
              <span class="summary-meta">上次：{{ statusLabel(summary.reports.lastStatus) }}</span>
            </RouterLink>
          </div>
        </section>

        <section class="workbench-section" aria-labelledby="service-status-title">
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

      <div v-else-if="!error" class="workbench-state">
        <NEmpty description="暂无工作台数据" />
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/workbench';
@use '@/styles/variables' as *;

.summary-value--date {
  font-family: $font-ui;
  font-size: 17px;
  line-height: 1.65;
  letter-spacing: 0;
}
</style>
