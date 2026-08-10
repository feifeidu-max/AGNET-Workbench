<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { NAlert, NButton, NInput } from 'naive-ui'
import {
  addWechatSource,
  fetchWechatSources,
  removeWechatSource,
  syncWechatSources,
  type WechatSource,
} from '@/api/workbench'

const sources = ref<WechatSource[]>([])
const name = ref('')
const url = ref('')
const busy = ref(false)
const loading = ref(false)
const error = ref('')
const notice = ref('')

async function loadSources() {
  loading.value = true
  error.value = ''
  try {
    sources.value = await fetchWechatSources()
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : '无法读取公众号来源'
  } finally {
    loading.value = false
  }
}

async function addSource() {
  if (!url.value.trim() || busy.value) return
  busy.value = true
  error.value = ''
  notice.value = ''
  try {
    const source = await addWechatSource(name.value.trim(), url.value.trim())
    sources.value = [...sources.value, source]
    name.value = ''
    url.value = ''
    notice.value = '来源已保存，可以立即同步。'
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : '来源保存失败'
  } finally {
    busy.value = false
  }
}

async function syncSource(sourceId?: string) {
  if (busy.value) return
  busy.value = true
  error.value = ''
  notice.value = ''
  try {
    const report = await syncWechatSources(sourceId)
    notice.value = `同步完成：发现 ${report.discovered} 篇，新增 ${report.imported} 篇，跳过 ${report.skipped} 篇，未通过质量门槛 ${report.rejected} 篇。`
    await loadSources()
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : '公众号同步失败'
  } finally {
    busy.value = false
  }
}

async function deleteSource(source: WechatSource) {
  if (busy.value) return
  busy.value = true
  error.value = ''
  try {
    await removeWechatSource(source.id)
    sources.value = sources.value.filter(item => item.id !== source.id)
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : '来源删除失败'
  } finally {
    busy.value = false
  }
}

function statusLabel(status: WechatSource['lastSyncStatus']): string {
  return status === 'success' ? '已同步' : status === 'partial' ? '部分完成' : status === 'failed' ? '失败' : '未同步'
}

onMounted(() => { void loadSources() })
</script>

<template>
  <section class="wechat-manager" aria-label="微信公众号来源">
    <div class="wechat-manager__heading">
      <div>
        <span class="wechat-manager__kicker">微信公众号 · 数据技术文章</span>
        <h3>自动收录来源</h3>
        <p>文章先进入 LLM Wiki 审核队列，审核通过后才会成为正式知识页面。</p>
      </div>
      <NButton size="small" :loading="busy" :disabled="!sources.length" @click="syncSource()">立即同步</NButton>
    </div>
    <div class="wechat-manager__form">
      <NInput v-model:value="name" size="small" placeholder="来源名称（可选）" />
      <NInput v-model:value="url" size="small" placeholder="公众号文章页、列表页或 RSS/Atom URL" @keyup.enter="addSource" />
      <NButton size="small" type="primary" :loading="busy" :disabled="!url.trim()" @click="addSource">添加来源</NButton>
    </div>
    <NAlert v-if="error" class="wechat-manager__alert" type="error" :show-icon="false">{{ error }}</NAlert>
    <NAlert v-if="notice" class="wechat-manager__alert" type="success" :show-icon="false">{{ notice }}</NAlert>
    <div v-if="sources.length" class="wechat-manager__sources">
      <article v-for="source in sources" :key="source.id" class="wechat-source-row">
        <div class="wechat-source-row__main">
          <strong>{{ source.name }}</strong>
          <a :href="source.url" target="_blank" rel="noreferrer">{{ source.url }}</a>
        </div>
        <div class="wechat-source-row__meta">
          <span>{{ statusLabel(source.lastSyncStatus) }}</span>
          <span>新增 {{ source.importedCount }}</span>
          <NButton size="tiny" quaternary :loading="busy" @click="syncSource(source.id)">同步</NButton>
          <NButton size="tiny" quaternary type="error" :loading="busy" @click="deleteSource(source)">移除</NButton>
        </div>
        <p v-if="source.lastSyncError" class="wechat-source-row__error">{{ source.lastSyncError }}</p>
      </article>
    </div>
    <p v-else-if="!loading" class="wechat-manager__empty">尚未配置公众号来源</p>
  </section>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.wechat-manager { display: grid; gap: 12px; border-top: 1px solid $border-light; padding-top: 16px; }
.wechat-manager__heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
.wechat-manager__kicker { color: $accent-primary; font-family: $font-code; font-size: 10px; font-weight: 700; }
.wechat-manager h3 { margin: 5px 0 0; font-size: 15px; }
.wechat-manager p { margin: 5px 0 0; color: $text-secondary; font-size: 12px; line-height: 1.5; }
.wechat-manager__form { display: grid; grid-template-columns: minmax(150px, .7fr) minmax(260px, 2fr) auto; gap: 8px; }
.wechat-manager__alert { margin: 0; }
.wechat-manager__sources { display: grid; gap: 7px; }
.wechat-source-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; border-top: 1px solid $border-light; padding-top: 9px; }
.wechat-source-row__main { display: grid; min-width: 0; gap: 3px; }
.wechat-source-row__main strong { font-size: 12px; }
.wechat-source-row__main a { overflow: hidden; color: $text-muted; font-size: 10px; text-overflow: ellipsis; white-space: nowrap; }
.wechat-source-row__meta { display: flex; align-items: center; gap: 8px; flex: 0 0 auto; color: $text-secondary; font-size: 10px; }
.wechat-source-row__error { width: 100%; color: $error !important; font-size: 10px !important; }
.wechat-manager__empty { color: $text-muted !important; font-size: 11px !important; }

@media (max-width: 760px) {
  .wechat-manager__heading { align-items: stretch; flex-direction: column; }
  .wechat-manager__form { grid-template-columns: 1fr; }
  .wechat-source-row { align-items: flex-start; flex-direction: column; }
  .wechat-source-row__meta { width: 100%; justify-content: space-between; }
}
</style>
