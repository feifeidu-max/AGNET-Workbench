<script setup lang="ts">
import { ref, onMounted, computed, defineAsyncComponent } from 'vue'
import { NButton, NModal, NSpin, NTag, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import {
  fetchMemory,
  fetchMemoryHistory,
  restoreMemory,
  saveMemory,
  type MemoryData,
  type MemoryHistoryEntry,
} from '@/api/hermes/skills'
import { useProfilesStore } from '@/stores/hermes/profiles'

const MarkdownRenderer = defineAsyncComponent(async () => (await import('@/components/hermes/chat/MarkdownRenderer.vue')).default)

const { t } = useI18n()
const message = useMessage()
const profilesStore = useProfilesStore()
const loading = ref(false)
const data = ref<MemoryData | null>(null)
const editingSection = ref<'memory' | 'user' | 'soul' | null>(null)
const editContent = ref('')
const saving = ref(false)
const historySection = ref<'memory' | 'user' | 'soul' | null>(null)
const historyPath = ref('')
const historyEntries = ref<MemoryHistoryEntry[]>([])
const historyLoading = ref(false)
const historyError = ref('')
const restoringRevision = ref<number | null>(null)

onMounted(loadMemory)

async function loadMemory() {
  loading.value = true
  try {
    if (!profilesStore.activeProfileName || profilesStore.profiles.length === 0) {
      await profilesStore.fetchProfiles()
    }
    data.value = await fetchMemory()
  } catch (err: any) {
    console.error('Failed to load memory:', err)
    message.error(t('memory.loadFailed'))
  } finally {
    loading.value = false
  }
}

function startEdit(section: 'memory' | 'user' | 'soul') {
  editingSection.value = section
  editContent.value = data.value?.[section] || ''
}

function cancelEdit() {
  editingSection.value = null
  editContent.value = ''
}

function sectionLabel(section: 'memory' | 'user' | 'soul'): string {
  if (section === 'memory') return t('memory.myNotes')
  if (section === 'user') return t('memory.userProfile')
  return t('memory.soul')
}

async function openHistory(section: 'memory' | 'user' | 'soul') {
  historySection.value = section
  historyEntries.value = []
  historyPath.value = ''
  historyError.value = ''
  historyLoading.value = true
  try {
    const result = await fetchMemoryHistory(section)
    if (historySection.value !== section) return
    historyEntries.value = result.history || []
    historyPath.value = result.path || ''
  } catch (err: any) {
    historyError.value = err?.message || t('memory.historyLoadFailed')
  } finally {
    historyLoading.value = false
  }
}

function closeHistory() {
  if (restoringRevision.value !== null) return
  historySection.value = null
  historyEntries.value = []
  historyError.value = ''
}

function handleHistoryVisibility(show: boolean) {
  if (!show) closeHistory()
}

function currentRevision(section: 'memory' | 'user' | 'soul'): number | undefined {
  if (!data.value) return undefined
  return section === 'memory'
    ? data.value.memory_revision
    : section === 'user'
      ? data.value.user_revision
      : data.value.soul_revision
}

async function restoreRevision(revision: number) {
  const section = historySection.value
  if (!section || restoringRevision.value !== null) return
  if (!window.confirm(`${t('memory.restoreConfirm')} (${sectionLabel(section)} r${revision})`)) return
  restoringRevision.value = revision
  historyError.value = ''
  try {
    await restoreMemory(section, revision, currentRevision(section))
    await loadMemory()
    await openHistory(section)
    message.success(t('memory.restoreSuccess'))
  } catch (err: any) {
    if (err?.status === 409 || err?.response?.status === 409) {
      message.warning(t('memory.revisionConflict'))
      await loadMemory()
      await openHistory(section)
    } else {
      historyError.value = err?.message || t('memory.restoreFailed')
    }
  } finally {
    restoringRevision.value = null
  }
}

function openRawDocument(section: 'memory' | 'user' | 'soul') {
  const content = data.value?.[section] || ''
  const url = URL.createObjectURL(new Blob([content], { type: 'text/markdown;charset=utf-8' }))
  const opened = window.open(url, '_blank', 'noopener,noreferrer')
  if (!opened) message.info('浏览器阻止了新窗口，请允许弹出窗口后重试')
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

async function handleSave() {
  if (!editingSection.value) return
  saving.value = true
  try {
    const section = editingSection.value
    const expectedRevision = section === 'memory'
      ? data.value?.memory_revision
      : section === 'user'
        ? data.value?.user_revision
        : data.value?.soul_revision
    await saveMemory(section, editContent.value, expectedRevision)
    await loadMemory()
    editingSection.value = null
    editContent.value = ''
    message.success(t('common.saved'))
  } catch (err: any) {
    if (err?.status === 409 || err?.response?.status === 409) {
      message.warning(t('memory.revisionConflict'))
      await loadMemory()
    } else {
      message.error(`${t('common.saveFailed')}: ${err.message}`)
    }
  } finally {
    saving.value = false
  }
}

function formatTime(ts: number | null): string {
  if (!ts) return ''
  return new Date(ts).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

const memoryEmpty = computed(() => !data.value?.memory?.trim())
const userEmpty = computed(() => !data.value?.user?.trim())
const soulEmpty = computed(() => !data.value?.soul?.trim())

const displayMemory = computed(() => (data.value?.memory || '').replace(/§/g, '\n\n'))
const displayUser = computed(() => (data.value?.user || '').replace(/§/g, '\n\n'))
const displaySoul = computed(() => (data.value?.soul || '').replace(/§/g, '\n\n'))
const memoryRiskHint = computed(() => t('memory.publicModelWarning'))
</script>

<template>
  <div class="memory-view">
    <header class="page-header">
      <h2 class="header-title">{{ t('memory.title') }}</h2>
      <NButton size="small" quaternary @click="loadMemory">
        <template #icon>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="23 4 23 10 17 10" />
            <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
          </svg>
        </template>
        {{ t('memory.refresh') }}
      </NButton>
    </header>

    <div class="memory-content">
      <div class="memory-risk-warning">{{ memoryRiskHint }}</div>
      <div v-if="data?.character_budget" class="memory-budget-status">
        {{ t('memory.characterBudget') }}: {{ data.character_budget.memory }} / {{ data.character_budget.max_chars }} ·
        {{ t('memory.effectiveStatus') }}: {{ data.effective_status?.memory_enabled === false ? t('memory.disabled') : t('memory.enabled') }}
      </div>
      <div v-if="loading && !data" class="memory-loading">{{ t('common.loading') }}</div>
      <div v-else class="memory-sections">
          <!-- My Notes -->
          <div class="memory-section">
            <div class="section-header">
              <div class="section-title-row">
                <span class="section-icon">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                    <polyline points="14 2 14 8 20 8" />
                    <line x1="16" y1="13" x2="8" y2="13" />
                    <line x1="16" y1="17" x2="8" y2="17" />
                  </svg>
                </span>
                <span class="section-title">{{ t('memory.myNotes') }}</span>
                <span v-if="data?.memory_mtime" class="section-mtime">{{ formatTime(data.memory_mtime) }}</span>
                <span v-if="data?.memory_revision != null" class="section-revision">r{{ data.memory_revision }}</span>
              </div>
              <div class="section-header-actions">
                <NButton size="tiny" quaternary @click="openRawDocument('memory')">打开原始文档</NButton>
                <NButton size="tiny" quaternary @click="openHistory('memory')">{{ t('memory.history') }}</NButton>
                <NButton v-if="editingSection !== 'memory'" size="tiny" quaternary @click="startEdit('memory')">
                <template #icon>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                    <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                  </svg>
                </template>
                {{ t('common.edit') }}
                </NButton>
              </div>
            </div>

            <!-- View mode -->
            <div v-if="editingSection !== 'memory'" class="section-body">
              <div v-if="data?.memory_path" class="section-path">{{ data.memory_path }}</div>
              <MarkdownRenderer v-if="!memoryEmpty" :content="displayMemory" />
              <p v-else class="empty-text">{{ t('memory.noNotes') }}</p>
            </div>

            <!-- Edit mode -->
            <div v-else class="section-edit">
              <textarea
                v-model="editContent"
                class="edit-textarea"
                :placeholder="t('memory.notesPlaceholder')"
                spellcheck="false"
              ></textarea>
              <div class="edit-actions">
                <NButton size="small" @click="cancelEdit">{{ t('common.cancel') }}</NButton>
                <NButton size="small" type="primary" :loading="saving" @click="handleSave">{{ t('common.save') }}</NButton>
              </div>
            </div>
          </div>

          <!-- User Profile -->
          <div class="memory-section">
            <div class="section-header">
              <div class="section-title-row">
                <span class="section-icon">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                    <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                    <circle cx="12" cy="7" r="4" />
                  </svg>
                </span>
                <span class="section-title">{{ t('memory.userProfile') }}</span>
                <span v-if="data?.user_mtime" class="section-mtime">{{ formatTime(data.user_mtime) }}</span>
                <span v-if="data?.user_revision != null" class="section-revision">r{{ data.user_revision }}</span>
              </div>
              <div class="section-header-actions">
                <NButton size="tiny" quaternary @click="openRawDocument('user')">打开原始文档</NButton>
                <NButton size="tiny" quaternary @click="openHistory('user')">{{ t('memory.history') }}</NButton>
                <NButton v-if="editingSection !== 'user'" size="tiny" quaternary @click="startEdit('user')">
                <template #icon>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                    <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                  </svg>
                </template>
                {{ t('common.edit') }}
                </NButton>
              </div>
            </div>

            <!-- View mode -->
            <div v-if="editingSection !== 'user'" class="section-body">
              <div v-if="data?.user_path" class="section-path">{{ data.user_path }}</div>
              <MarkdownRenderer v-if="!userEmpty" :content="displayUser" />
              <p v-else class="empty-text">{{ t('memory.noProfile') }}</p>
            </div>

            <!-- Edit mode -->
            <div v-else class="section-edit">
              <textarea
                v-model="editContent"
                class="edit-textarea"
                :placeholder="t('memory.profilePlaceholder')"
                spellcheck="false"
              ></textarea>
              <div class="edit-actions">
                <NButton size="small" @click="cancelEdit">{{ t('common.cancel') }}</NButton>
                <NButton size="small" type="primary" :loading="saving" @click="handleSave">{{ t('common.save') }}</NButton>
              </div>
            </div>
          </div>

          <!-- Soul -->
          <div class="memory-section">
            <div class="section-header">
              <div class="section-title-row">
                <span class="section-icon">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                    <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2z" />
                    <path d="M8 14s1.5 2 4 2 4-2 4-2" />
                    <line x1="9" y1="9" x2="9.01" y2="9" />
                    <line x1="15" y1="9" x2="15.01" y2="9" />
                  </svg>
                </span>
                <span class="section-title">{{ t('memory.soul') }}</span>
                <span v-if="data?.soul_mtime" class="section-mtime">{{ formatTime(data.soul_mtime) }}</span>
                <span v-if="data?.soul_revision != null" class="section-revision">r{{ data.soul_revision }}</span>
              </div>
              <div class="section-header-actions">
                <NButton size="tiny" quaternary @click="openRawDocument('soul')">打开原始文档</NButton>
                <NButton size="tiny" quaternary @click="openHistory('soul')">{{ t('memory.history') }}</NButton>
                <NButton v-if="editingSection !== 'soul'" size="tiny" quaternary @click="startEdit('soul')">
                <template #icon>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                    <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                  </svg>
                </template>
                {{ t('common.edit') }}
                </NButton>
              </div>
            </div>

            <!-- View mode -->
            <div v-if="editingSection !== 'soul'" class="section-body">
              <div v-if="data?.soul_path" class="section-path">{{ data.soul_path }}</div>
              <MarkdownRenderer v-if="!soulEmpty" :content="displaySoul" />
              <p v-else class="empty-text">{{ t('memory.noSoul') }}</p>
            </div>

            <!-- Edit mode -->
            <div v-else class="section-edit">
              <textarea
                v-model="editContent"
                class="edit-textarea"
                :placeholder="t('memory.soulPlaceholder')"
                spellcheck="false"
              ></textarea>
              <div class="edit-actions">
                <NButton size="small" @click="cancelEdit">{{ t('common.cancel') }}</NButton>
                <NButton size="small" type="primary" :loading="saving" @click="handleSave">{{ t('common.save') }}</NButton>
              </div>
            </div>
          </div>
        </div>

        <NModal
          :show="historySection !== null"
          preset="card"
          :title="historySection ? `${sectionLabel(historySection)} - ${t('memory.history')}` : t('memory.history')"
          style="width: min(560px, calc(100vw - 32px))"
          :mask-closable="restoringRevision === null"
          @update:show="handleHistoryVisibility"
        >
          <div class="memory-history-modal">
            <div v-if="historyPath" class="section-path">{{ historyPath }}</div>
            <NSpin v-if="historyLoading" size="small" />
            <p v-else-if="historyError" class="memory-history-error">{{ historyError }}</p>
            <p v-else-if="historyEntries.length === 0" class="empty-text">{{ t('memory.noHistory') }}</p>
            <div v-else class="memory-history-list">
              <div v-for="entry in historyEntries" :key="entry.revision" class="memory-history-row">
                <div>
                  <strong>r{{ entry.revision }}</strong>
                  <NTag v-if="entry.current" size="tiny" type="success" :bordered="false">{{ t('memory.currentRevision') }}</NTag>
                </div>
                <NButton
                  v-if="!entry.current"
                  size="tiny"
                  quaternary
                  :loading="restoringRevision === entry.revision"
                  :disabled="restoringRevision !== null"
                  @click="restoreRevision(entry.revision)"
                >
                  {{ t('memory.restore') }}
                </NButton>
              </div>
            </div>
          </div>
        </NModal>
    </div>
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.memory-view {
  height: calc(100 * var(--vh));
  display: flex;
  flex-direction: column;
}

.memory-content {
  flex: 1;
  overflow: hidden;
  padding: 20px;
  display: flex;
  flex-direction: column;
}

.memory-risk-warning {
  flex: 0 0 auto;
  margin-bottom: 12px;
  padding: 9px 12px;
  border-left: 3px solid $warning;
  background: rgba(var(--warning-rgb), 0.08);
  color: $text-secondary;
  font-size: 12px;
  line-height: 1.5;
}

.memory-budget-status {
  flex: 0 0 auto;
  margin: -4px 0 12px;
  color: $text-muted;
  font-size: 11px;
}

.memory-loading {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
  color: $text-muted;
}

.memory-sections {
  display: flex;
  gap: 16px;
  flex: 1;
  min-height: 0;

  @media (max-width: $breakpoint-mobile) {
    flex-direction: column;
  }
}

.memory-section {
  flex: 1;
  min-height: 0;
  border: 1px solid $border-color;
  border-radius: $radius-md;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px 12px;
  padding: 10px 16px;
  background: $bg-secondary;
  border-bottom: 1px solid $border-color;
  flex-shrink: 0;
}

.section-header-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  flex-wrap: wrap;
  gap: 4px;
  min-width: 0;
  max-width: 100%;
  margin-left: auto;
  flex: 0 1 auto;
}

.section-title-row {
  display: flex;
  align-items: center;
  flex: 1 1 160px;
  flex-wrap: wrap;
  gap: 8px;
  min-width: 0;
}

.section-icon {
  color: $text-secondary;
  display: flex;
}

.section-title {
  font-size: 14px;
  font-weight: 600;
  color: $text-primary;
}

.section-mtime {
  font-size: 11px;
  color: $text-muted;
}

.section-revision {
  color: $text-muted;
  font-family: $font-code;
  font-size: 10px;
}

.section-body {
  flex: 1;
  overflow-y: auto;
  padding: 16px;
  min-height: 0;
}

.section-path {
  margin-bottom: 10px;
  overflow-wrap: anywhere;
  color: $text-muted;
  font-family: $font-code;
  font-size: 10px;
}

.empty-text {
  color: $text-muted;
  font-style: italic;
  font-size: 13px;
}

.section-edit {
  flex: 1;
  display: flex;
  flex-direction: column;
  padding: 12px 16px;
  min-height: 0;
}

.edit-textarea {
  flex: 1;
  width: 100%;
  min-height: 0;
  padding: 12px;
  border: 1px solid $border-color;
  border-radius: $radius-sm;
  background: $bg-input;
  color: $text-primary;
  font-family: $font-code;
  font-size: 13px;
  line-height: 1.6;
  resize: none;
  outline: none;

  &:focus {
    border-color: $accent-primary;
  }
}

.edit-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 10px;
}

.memory-history-modal {
  min-height: 120px;
}

.memory-history-error {
  margin: 0;
  color: $error;
  font-size: 12px;
}

.memory-history-list {
  display: flex;
  flex-direction: column;
  border-top: 1px solid $border-light;
}

.memory-history-row {
  display: flex;
  min-height: 42px;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  border-bottom: 1px solid $border-light;
}

.memory-history-row > div {
  display: flex;
  align-items: center;
  gap: 8px;
}

.memory-history-row strong {
  color: $text-primary;
  font-family: $font-code;
  font-size: 12px;
}

@media (max-width: $breakpoint-mobile) {
  .memory-content {
    overflow-x: hidden;
    overflow-y: auto;
    padding: 18px 14px 28px;
  }

  .memory-sections {
    flex: 0 0 auto;
  }

  .memory-section {
    flex: 0 0 auto;
    min-height: 320px;
  }

  .section-header {
    align-items: stretch;
    flex-direction: column;
  }

  .section-title-row {
    flex-basis: auto;
    width: 100%;
  }

  .section-header-actions {
    justify-content: flex-start;
    width: 100%;
    margin-left: 0;
  }
}
</style>
