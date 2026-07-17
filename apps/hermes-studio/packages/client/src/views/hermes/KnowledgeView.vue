<script setup lang="ts">
import { computed, defineAsyncComponent, onMounted, ref } from 'vue'
import {
  NAlert,
  NButton,
  NEmpty,
  NInput,
  NModal,
  NPopconfirm,
  NSpin,
  NTabPane,
  NTabs,
  NTag,
  useMessage,
} from 'naive-ui'
import {
  askTrustedKnowledge,
  approveKnowledgeDraft,
  dismissReadingCandidate,
  fetchKnowledgeDraftDetail,
  fetchKnowledgeGraph,
  listKnowledgeDrafts,
  rejectKnowledgeDraft,
  reviseKnowledgeDraft,
  searchReadingCandidates,
  searchTrustedKnowledge,
  uploadKnowledgePdf,
  type KnowledgeDraft,
  type KnowledgeDraftDetail,
  type KnowledgeDraftStatus,
  type KnowledgeAnswer,
  type KnowledgeSearchResult,
  type KnowledgeGraph,
  type ReadingCandidate,
} from '@/api/workbench'

const MarkdownRenderer = defineAsyncComponent(async () => (
  await import('@/components/hermes/chat/MarkdownRenderer.vue')
).default)

const message = useMessage()
const activeTab = ref<'drafts' | 'trusted' | 'qa' | 'candidates'>('drafts')
const fileInput = ref<HTMLInputElement | null>(null)
const drafts = ref<KnowledgeDraft[]>([])
const draftsLoading = ref(false)
const draftsError = ref('')
const uploading = ref(false)
const uploadProgress = ref('')
const actingId = ref('')

const trustedQuery = ref('')
const trustedResults = ref<KnowledgeSearchResult[]>([])
const trustedLoading = ref(false)
const trustedError = ref('')
const trustedSearched = ref(false)

const question = ref('')
const answer = ref<KnowledgeAnswer | null>(null)
const answerLoading = ref(false)
const answerError = ref('')

const candidateQuery = ref('')
const candidates = ref<ReadingCandidate[]>([])
const candidatesLoading = ref(false)
const candidatesError = ref('')
const candidatesSearched = ref(false)

const revisionDraft = ref<KnowledgeDraft | null>(null)
const revisionGuidance = ref('')
const graphOpen = ref(false)
const graphLoading = ref(false)
const graphError = ref('')
const graph = ref<KnowledgeGraph | null>(null)
const candidateActionId = ref('')
const detailOpen = ref(false)
const detailLoading = ref(false)
const detailError = ref('')
const draftDetail = ref<KnowledgeDraftDetail | null>(null)

const reviewCount = computed(() => drafts.value.filter((draft) => draft.status === 'awaiting_review').length)

const statusLabels: Record<KnowledgeDraftStatus, string> = {
  uploaded: '已上传',
  parsing: '正在解析',
  drafting: '正在归纳',
  awaiting_review: '待审核',
  publishing: '正在发布',
  trusted: '已入库',
  revision_requested: '已退回',
  rejected: '已拒绝',
  failed: '处理失败',
}

function statusType(status: KnowledgeDraftStatus): 'success' | 'warning' | 'error' | 'info' | 'default' {
  if (status === 'trusted') return 'success'
  if (status === 'awaiting_review' || status === 'revision_requested') return 'warning'
  if (status === 'failed' || status === 'rejected') return 'error'
  if (status === 'parsing' || status === 'drafting' || status === 'publishing') return 'info'
  return 'default'
}

function formatDateTime(value: string | null): string {
  if (!value) return '时间未知'
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

function authorLine(authors: string[], year: number | null): string {
  const authorText = authors.length ? authors.join('、') : '作者未知'
  return year ? `${authorText} · ${year}` : authorText
}

async function loadDrafts() {
  draftsLoading.value = true
  draftsError.value = ''
  try {
    drafts.value = await listKnowledgeDrafts()
  } catch (reason) {
    draftsError.value = reason instanceof Error ? reason.message : '草稿列表加载失败'
  } finally {
    draftsLoading.value = false
  }
}

function openFilePicker() {
  fileInput.value?.click()
}

async function handleFiles(event: Event) {
  const target = event.target as HTMLInputElement
  const files = Array.from(target.files || [])
  target.value = ''
  if (!files.length) return

  const invalid = files.find((file) => file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf'))
  if (invalid) {
    message.error(`“${invalid.name}” 不是 PDF 文件`)
    return
  }

  uploading.value = true
  let uploaded = 0
  try {
    for (const [index, file] of files.entries()) {
      uploadProgress.value = `正在上传 ${index + 1}/${files.length}：${file.name}`
      await uploadKnowledgePdf(file)
      uploaded += 1
    }
    message.success(`已提交 ${uploaded} 篇论文，完成归纳后会进入审核队列`)
    await loadDrafts()
  } catch (reason) {
    const detail = reason instanceof Error ? reason.message : '上传失败'
    message.error(`已上传 ${uploaded}/${files.length}：${detail}`)
    await loadDrafts()
  } finally {
    uploading.value = false
    uploadProgress.value = ''
  }
}

async function approveDraft(draft: KnowledgeDraft) {
  actingId.value = draft.id
  try {
    await approveKnowledgeDraft(draft.id)
    message.success(`“${draft.title}” 已开始发布到可信知识库`)
    await loadDrafts()
  } catch (reason) {
    message.error(reason instanceof Error ? reason.message : '批准失败')
  } finally {
    actingId.value = ''
  }
}

async function openDraftDetail(draft: KnowledgeDraft) {
  detailOpen.value = true
  detailLoading.value = true
  detailError.value = ''
  draftDetail.value = null
  try {
    draftDetail.value = await fetchKnowledgeDraftDetail(draft.id)
  } catch (reason) {
    detailError.value = reason instanceof Error ? reason.message : '草稿详情加载失败'
  } finally {
    detailLoading.value = false
  }
}

function changeLabel(operation: string): string {
  return operation.toLowerCase() === 'create' ? '拟新增' : '拟修改'
}

function openRevision(draft: KnowledgeDraft) {
  revisionDraft.value = draft
  revisionGuidance.value = ''
}

function closeRevision() {
  if (actingId.value) return
  revisionDraft.value = null
  revisionGuidance.value = ''
}

async function submitRevision() {
  if (!revisionDraft.value) return
  const draft = revisionDraft.value
  actingId.value = draft.id
  try {
    await reviseKnowledgeDraft(draft.id, revisionGuidance.value.trim() || undefined)
    message.success(`“${draft.title}” 已退回重做`)
    revisionDraft.value = null
    revisionGuidance.value = ''
    await loadDrafts()
  } catch (reason) {
    message.error(reason instanceof Error ? reason.message : '退回失败')
  } finally {
    actingId.value = ''
  }
}

async function rejectDraft(draft: KnowledgeDraft) {
  actingId.value = draft.id
  try {
    await rejectKnowledgeDraft(draft.id, '用户在 Studio 中拒绝入库')
    message.success(`“${draft.title}” 已拒绝`)
    await loadDrafts()
  } catch (reason) {
    message.error(reason instanceof Error ? reason.message : '拒绝失败')
  } finally {
    actingId.value = ''
  }
}

async function runTrustedSearch() {
  const query = trustedQuery.value.trim()
  if (!query) return
  trustedLoading.value = true
  trustedError.value = ''
  trustedSearched.value = true
  try {
    trustedResults.value = await searchTrustedKnowledge(query)
  } catch (reason) {
    trustedResults.value = []
    trustedError.value = reason instanceof Error ? reason.message : '可信库搜索失败'
  } finally {
    trustedLoading.value = false
  }
}

async function askQuestion() {
  const value = question.value.trim()
  if (!value || answerLoading.value) return
  answerLoading.value = true
  answerError.value = ''
  try {
    answer.value = await askTrustedKnowledge(value)
  } catch (reason) {
    answer.value = null
    answerError.value = reason instanceof Error ? reason.message : 'Wiki 问答失败'
  } finally {
    answerLoading.value = false
  }
}

async function runCandidateSearch() {
  const query = candidateQuery.value.trim()
  if (!query) return
  candidatesLoading.value = true
  candidatesError.value = ''
  candidatesSearched.value = true
  try {
    candidates.value = await searchReadingCandidates(query)
  } catch (reason) {
    candidates.value = []
    candidatesError.value = reason instanceof Error ? reason.message : '候选论文搜索失败'
  } finally {
    candidatesLoading.value = false
  }
}

async function openGraph() {
  graphOpen.value = true
  if (graph.value) return
  graphLoading.value = true
  graphError.value = ''
  try {
    graph.value = await fetchKnowledgeGraph()
  } catch (reason) {
    graphError.value = reason instanceof Error ? reason.message : '知识图谱加载失败'
  } finally {
    graphLoading.value = false
  }
}

function graphItemLabel(item: Record<string, unknown>): string {
  const value = item.title ?? item.name ?? item.label ?? item.id
  return typeof value === 'string' ? value : '未命名节点'
}

async function dismissCandidate(candidate: ReadingCandidate) {
  candidateActionId.value = candidate.id
  try {
    await dismissReadingCandidate(candidate.id)
    candidates.value = candidates.value.filter((item) => item.id !== candidate.id)
    message.success('已从待读候选中移除')
  } catch (reason) {
    message.error(reason instanceof Error ? reason.message : '移除候选失败')
  } finally {
    candidateActionId.value = ''
  }
}

onMounted(() => {
  void loadDrafts()
})
</script>

<template>
  <div class="workbench-page knowledge-page">
    <header class="page-header">
      <div class="workbench-page-heading">
        <h2 class="header-title">个人知识库</h2>
        <p>先审核、后入库；Hermes 只引用可信知识与可定位的论文证据</p>
      </div>
      <div class="knowledge-header-actions">
        <NButton size="small" quaternary @click="openGraph">知识图谱</NButton>
        <NTag size="small" :type="reviewCount ? 'warning' : 'default'" :bordered="false">
          {{ reviewCount }} 篇待审核
        </NTag>
      </div>
    </header>

    <div class="workbench-content">
      <NTabs v-model:value="activeTab" type="line" animated>
        <NTabPane name="drafts" tab="论文归纳与审核">
          <NAlert v-if="draftsError" class="workbench-alert" type="error" title="无法加载审核队列">
            {{ draftsError }}
            <NButton class="alert-retry" size="tiny" @click="loadDrafts">重试</NButton>
          </NAlert>

          <section class="upload-band" aria-label="上传论文">
            <div class="upload-band-copy">
              <strong>导入每日读过的论文</strong>
              <span>{{ uploadProgress || '支持一次选择多篇 PDF。批准前不会进入正式 Wiki 或向量检索。' }}</span>
            </div>
            <input ref="fileInput" class="visually-hidden" type="file" accept="application/pdf,.pdf" multiple @change="handleFiles" />
            <NButton type="primary" :loading="uploading" @click="openFilePicker">
              <template #icon>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="17 8 12 3 7 8" />
                  <line x1="12" y1="3" x2="12" y2="15" />
                </svg>
              </template>
              选择 PDF
            </NButton>
          </section>

          <section class="workbench-section" aria-labelledby="draft-list-title">
            <div class="workbench-section-header">
              <h3 id="draft-list-title" class="workbench-section-title">审核队列</h3>
              <NButton size="tiny" quaternary :loading="draftsLoading" @click="loadDrafts">刷新状态</NButton>
            </div>
            <NSpin :show="draftsLoading && drafts.length > 0">
              <div v-if="drafts.length" class="workbench-list">
                <article v-for="draft in drafts" :key="draft.id" class="workbench-list-item">
                  <div class="workbench-list-main">
                    <h4 class="workbench-list-title">{{ draft.title }}</h4>
                    <div class="workbench-list-meta">
                      <span>{{ draft.fileName }}</span>
                      <span>{{ authorLine(draft.authors, draft.year) }}</span>
                      <span>{{ formatDateTime(draft.updatedAt || draft.createdAt) }}</span>
                    </div>
                    <p v-if="draft.summary" class="workbench-list-summary">{{ draft.summary }}</p>
                    <p v-if="draft.error" class="draft-error">{{ draft.error }}</p>
                    <div v-if="draft.changeCount || draft.additions || draft.modifications" class="draft-change-counts">
                      <span v-if="draft.changeCount">拟变更页面 {{ draft.changeCount }}</span>
                      <span v-if="draft.additions">新增页面 {{ draft.additions }}</span>
                      <span v-if="draft.modifications">修改页面 {{ draft.modifications }}</span>
                    </div>
                  </div>
                  <div class="workbench-list-actions">
                    <NTag size="small" :type="statusType(draft.status)" :bordered="false">{{ statusLabels[draft.status] || draft.status }}</NTag>
                    <NButton size="tiny" secondary :disabled="!!actingId" @click="openDraftDetail(draft)">查看草稿</NButton>
                    <template v-if="draft.status === 'awaiting_review'">
                      <NButton size="tiny" :disabled="!!actingId" @click="openRevision(draft)">退回重做</NButton>
                      <NPopconfirm positive-text="拒绝" negative-text="取消" @positive-click="rejectDraft(draft)">
                        <template #trigger>
                          <NButton size="tiny" type="error" secondary :disabled="!!actingId">拒绝</NButton>
                        </template>
                        拒绝后该草稿不会进入可信知识库，确认继续？
                      </NPopconfirm>
                      <NPopconfirm positive-text="批准入库" negative-text="取消" @positive-click="approveDraft(draft)">
                        <template #trigger>
                          <NButton size="tiny" type="primary" :loading="actingId === draft.id" :disabled="!!actingId && actingId !== draft.id">批准</NButton>
                        </template>
                        批准后会发布 Wiki 页面并生成向量索引，确认继续？
                      </NPopconfirm>
                    </template>
                  </div>
                </article>
              </div>
              <div v-else-if="draftsLoading" class="workbench-state"><NSpin description="正在读取审核队列…" /></div>
              <div v-else-if="!draftsError" class="workbench-state"><NEmpty description="暂无论文草稿" /></div>
            </NSpin>
          </section>
        </NTabPane>

        <NTabPane name="trusted" tab="可信库搜索">
          <div class="search-bar">
            <NInput v-model:value="trustedQuery" clearable placeholder="输入研究主题、概念或作者" @keyup.enter="runTrustedSearch" />
            <NButton type="primary" :loading="trustedLoading" :disabled="!trustedQuery.trim()" @click="runTrustedSearch">搜索可信库</NButton>
          </div>
          <NAlert v-if="trustedError" class="workbench-alert" type="error" title="搜索失败">{{ trustedError }}</NAlert>
          <div v-if="trustedLoading" class="workbench-state"><NSpin description="正在检索已批准知识…" /></div>
          <div v-else-if="trustedResults.length" class="workbench-list">
            <article v-for="result in trustedResults" :key="result.id" class="workbench-list-item">
              <div class="workbench-list-main">
                <h4 class="workbench-list-title">{{ result.title }}</h4>
                <div class="workbench-list-meta">
                  <span>{{ authorLine(result.authors, result.year) }}</span>
                  <span v-if="result.score != null">相关度 {{ Math.round(result.score * 100) }}%</span>
                  <span v-if="result.locator">第 {{ result.locator.page }} 页<span v-if="result.locator.section"> · {{ result.locator.section }}</span></span>
                </div>
                <p class="workbench-list-summary">{{ result.excerpt || '暂无摘要' }}</p>
              </div>
              <div v-if="result.sourceUrl" class="workbench-list-actions">
                <NButton tag="a" :href="result.sourceUrl" target="_blank" rel="noopener noreferrer" size="tiny">打开证据</NButton>
              </div>
            </article>
          </div>
          <div v-else-if="trustedSearched && !trustedError" class="workbench-state"><NEmpty description="可信库中没有匹配结果" /></div>
          <div v-else-if="!trustedError" class="workbench-state"><NEmpty description="输入问题，优先检索你已经读过并批准的论文" /></div>
        </NTabPane>

        <NTabPane name="qa" tab="Wiki 问答">
          <div class="qa-composer">
            <NInput
              v-model:value="question"
              type="textarea"
              :autosize="{ minRows: 2, maxRows: 6 }"
              maxlength="8000"
              show-count
              placeholder="向已批准的本地 Wiki 提问"
              @keydown.ctrl.enter.prevent="askQuestion"
              @keydown.meta.enter.prevent="askQuestion"
            />
            <NButton type="primary" :loading="answerLoading" :disabled="answerLoading || !question.trim()" @click="askQuestion">提问</NButton>
          </div>
          <NAlert v-if="answerError" class="workbench-alert" type="error" title="问答失败">{{ answerError }}</NAlert>
          <div v-if="answerLoading" class="workbench-state"><NSpin description="正在检索已批准 Wiki 并生成回答…" /></div>
          <section v-else-if="answer" class="qa-result" aria-live="polite">
            <div class="qa-answer"><MarkdownRenderer :content="answer.content || '未生成回答'" /></div>
            <div v-if="answer.references.length" class="qa-references">
              <h3 class="workbench-section-title">本地参考页面</h3>
              <div v-for="reference in answer.references" :key="`${reference.kind}:${reference.path}`" class="qa-reference">
                <strong>{{ reference.title }}</strong>
                <code>{{ reference.path }}</code>
                <span v-if="reference.score != null">相关度 {{ Math.round(reference.score * 100) }}%</span>
                <p v-if="reference.snippet">{{ reference.snippet }}</p>
              </div>
            </div>
          </section>
          <div v-else-if="!answerError" class="workbench-state"><NEmpty description="回答只使用已批准 Wiki；外部论文请在待读候选中单独检索" /></div>
        </NTabPane>

        <NTabPane name="candidates" tab="待读候选">
          <NAlert class="workbench-alert" type="info" :bordered="false">
            外部结果只保存题录、摘要和链接，不会自动下载，也不会直接进入可信知识库。
          </NAlert>
          <div class="search-bar">
            <NInput v-model:value="candidateQuery" clearable placeholder="搜索 OpenAlex、Crossref 与 arXiv" @keyup.enter="runCandidateSearch" />
            <NButton type="primary" :loading="candidatesLoading" :disabled="!candidateQuery.trim()" @click="runCandidateSearch">搜索候选论文</NButton>
          </div>
          <NAlert v-if="candidatesError" class="workbench-alert" type="error" title="外部搜索失败">{{ candidatesError }}</NAlert>
          <div v-if="candidatesLoading" class="workbench-state"><NSpin description="正在查找外部论文…" /></div>
          <div v-else-if="candidates.length" class="workbench-list">
            <article v-for="candidate in candidates" :key="candidate.id" class="workbench-list-item">
              <div class="workbench-list-main">
                <h4 class="workbench-list-title">{{ candidate.title }}</h4>
                <div class="workbench-list-meta">
                  <span>{{ authorLine(candidate.authors, candidate.year) }}</span>
                  <span v-if="candidate.provider">{{ candidate.provider }}</span>
                  <span v-if="candidate.reason">推荐理由：{{ candidate.reason }}</span>
                </div>
                <p class="workbench-list-summary">{{ candidate.abstract || '暂无摘要' }}</p>
              </div>
              <div class="workbench-list-actions">
                <NTag size="small" :bordered="false">待读</NTag>
                <NButton v-if="candidate.url" tag="a" :href="candidate.url" target="_blank" rel="noopener noreferrer" size="tiny">查看来源</NButton>
                <NButton size="tiny" secondary :loading="candidateActionId === candidate.id" :disabled="!!candidateActionId && candidateActionId !== candidate.id" @click="dismissCandidate(candidate)">忽略</NButton>
              </div>
            </article>
          </div>
          <div v-else-if="candidatesSearched && !candidatesError" class="workbench-state"><NEmpty description="没有找到候选论文" /></div>
          <div v-else-if="!candidatesError" class="workbench-state"><NEmpty description="本地证据不足时，再从外部来源查找候选论文" /></div>
        </NTabPane>
      </NTabs>
    </div>

    <NModal
      :show="!!revisionDraft"
      preset="dialog"
      title="退回重做"
      positive-text="提交"
      negative-text="取消"
      :positive-button-props="{ loading: !!actingId }"
      :mask-closable="!actingId"
      style="width: min(520px, calc(100vw - 32px));"
      @positive-click="submitRevision"
      @negative-click="closeRevision"
      @close="closeRevision"
    >
      <p class="revision-copy">说明需要修正的归纳、页面或证据定位，LLM Wiki 会据此重新生成草稿。</p>
      <NInput v-model:value="revisionGuidance" type="textarea" :rows="5" placeholder="例如：补充实验限制，并核对第 7 页消融实验的结论。" />
    </NModal>

    <NModal v-model:show="detailOpen" preset="dialog" title="草稿页面对照" style="width: min(980px, calc(100vw - 32px));">
      <NAlert v-if="detailError" type="error" title="详情加载失败">{{ detailError }}</NAlert>
      <div v-else-if="detailLoading" class="graph-state"><NSpin description="正在读取草稿与当前 Wiki 页面…" /></div>
      <template v-else-if="draftDetail">
        <div class="draft-detail-header">
          <div>
            <strong>{{ draftDetail.draft.title }}</strong>
            <span>{{ authorLine(draftDetail.draft.authors, draftDetail.draft.year) }}</span>
          </div>
          <NTag size="small" :type="statusType(draftDetail.draft.status)" :bordered="false">
            {{ statusLabels[draftDetail.draft.status] || draftDetail.draft.status }}
          </NTag>
        </div>

        <div v-if="draftDetail.changes.length" class="draft-change-list">
          <section v-for="change in draftDetail.changes" :key="`${change.operation}:${change.path}`" class="draft-change">
            <header class="draft-change-header">
              <div>
                <strong>{{ change.title }}</strong>
                <code>{{ change.path }}</code>
              </div>
              <NTag size="small" :type="change.operation.toLowerCase() === 'create' ? 'success' : 'warning'" :bordered="false">
                {{ changeLabel(change.operation) }}
              </NTag>
            </header>

            <div class="draft-comparison" :class="{ 'is-create': change.operation.toLowerCase() === 'create' }">
              <div v-if="change.operation.toLowerCase() !== 'create'" class="draft-version">
                <span>当前 Wiki 版本</span>
                <pre>{{ change.previousContent || '当前页面不存在或无法读取' }}</pre>
              </div>
              <div class="draft-version draft-version--proposed">
                <span>拟发布版本</span>
                <pre>{{ change.content }}</pre>
              </div>
            </div>

            <div v-if="change.evidenceLocators.length" class="evidence-pages">
              <span>证据页码</span>
              <NTag v-for="locator in change.evidenceLocators" :key="`${locator.sourceId}:${locator.page}:${locator.snippetHash || ''}`" size="small" :bordered="false">
                p.{{ locator.page }}<template v-if="locator.section"> · {{ locator.section }}</template>
              </NTag>
            </div>
          </section>
        </div>
        <NEmpty v-else description="该草稿还没有生成页面变更" />

        <details v-if="draftDetail.extractedTextPreview" class="extracted-preview">
          <summary>查看原文解析预览</summary>
          <pre>{{ draftDetail.extractedTextPreview }}</pre>
        </details>
      </template>
      <NEmpty v-else description="暂无草稿详情" />
    </NModal>

    <NModal v-model:show="graphOpen" preset="dialog" title="知识图谱" style="width: min(640px, calc(100vw - 32px));">
      <NAlert v-if="graphError" type="error" title="图谱加载失败">{{ graphError }}</NAlert>
      <div v-else-if="graphLoading" class="graph-state"><NSpin description="正在读取图谱…" /></div>
      <template v-else-if="graph">
        <div class="graph-stats">
          <span>节点 {{ graph.nodes.length }}</span>
          <span>关系 {{ graph.edges.length }}</span>
        </div>
        <div v-if="graph.nodes.length" class="graph-node-list">
          <span v-for="(node, index) in graph.nodes.slice(0, 24)" :key="String(node.id || index)" class="graph-node">{{ graphItemLabel(node) }}</span>
        </div>
        <NEmpty v-else description="可信知识库还没有图谱节点" />
      </template>
      <NEmpty v-else description="暂无图谱数据" />
    </NModal>
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/workbench';
@use '@/styles/variables' as *;

.knowledge-page :deep(.n-tabs-pane-wrapper) {
  overflow: visible;
}

.visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}

.draft-error {
  margin: 8px 0 0;
  color: $error;
  font-size: 12px;
}

.draft-change-counts {
  display: flex;
  gap: 12px;
  margin-top: 8px;
  color: $text-secondary;
  font-size: 12px;
}

.revision-copy {
  margin: 0 0 14px;
  color: $text-secondary;
  font-size: 13px;
  line-height: 1.6;
}

.draft-detail-header,
.draft-change-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}

.draft-detail-header {
  padding-bottom: 14px;
  border-bottom: 1px solid $border-light;

  > div {
    display: grid;
    gap: 4px;
    min-width: 0;
  }

  span {
    color: $text-secondary;
    font-size: 12px;
  }
}

.draft-change-list {
  max-height: min(68vh, 760px);
  overflow-y: auto;
}

.draft-change {
  padding: 18px 0;
  border-bottom: 1px solid $border-light;
}

.draft-change-header {
  margin-bottom: 12px;

  > div {
    display: grid;
    gap: 4px;
    min-width: 0;
  }

  code {
    overflow-wrap: anywhere;
    color: $text-muted;
    font-size: 11px;
  }
}

.draft-comparison {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 12px;

  &.is-create {
    grid-template-columns: minmax(0, 1fr);
  }
}

.draft-version {
  min-width: 0;

  > span {
    display: block;
    margin-bottom: 6px;
    color: $text-secondary;
    font-size: 12px;
  }

  pre {
    min-height: 180px;
    max-height: 360px;
    margin: 0;
    overflow: auto;
    padding: 12px;
    border: 1px solid $border-light;
    border-radius: $radius-sm;
    background: $bg-secondary;
    color: $text-secondary;
    font-family: $font-code;
    font-size: 11px;
    line-height: 1.6;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
}

.draft-version--proposed pre {
  border-color: $border-color;
  color: $text-primary;
}

.evidence-pages {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 10px;

  > span {
    margin-right: 2px;
    color: $text-muted;
    font-size: 11px;
  }
}

.extracted-preview {
  margin-top: 14px;

  summary {
    cursor: pointer;
    color: $text-secondary;
    font-size: 12px;
  }

  pre {
    max-height: 280px;
    overflow: auto;
    margin: 10px 0 0;
    padding: 12px;
    background: $bg-secondary;
    color: $text-secondary;
    font-family: $font-code;
    font-size: 11px;
    line-height: 1.6;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
}

.knowledge-header-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 0 0 auto;
}

.qa-composer {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: end;
  gap: 10px;
}

.qa-result {
  margin-top: 18px;
}

.qa-answer {
  min-width: 0;
  padding-bottom: 16px;
  border-bottom: 1px solid $border-light;
}

.qa-references {
  display: grid;
  gap: 0;
  margin-top: 16px;
}

.qa-reference {
  display: grid;
  grid-template-columns: minmax(140px, 1fr) minmax(180px, 1.5fr) auto;
  gap: 12px;
  align-items: baseline;
  padding: 10px 0;
  border-bottom: 1px solid $border-light;
  color: $text-secondary;
  font-size: 12px;

  strong {
    color: $text-primary;
  }

  code {
    overflow-wrap: anywhere;
    color: $text-muted;
    font-family: $font-code;
  }

  p {
    grid-column: 1 / -1;
    margin: 0;
    line-height: 1.55;
  }
}

.graph-state {
  min-height: 160px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.graph-stats {
  display: flex;
  gap: 18px;
  margin-bottom: 14px;
  color: $text-secondary;
  font-family: $font-code;
  font-size: 12px;
}

.graph-node-list {
  display: flex;
  flex-wrap: wrap;
  gap: 7px;
  max-height: 280px;
  overflow-y: auto;
}

.graph-node {
  max-width: 100%;
  overflow: hidden;
  padding: 5px 8px;
  border: 1px solid $border-light;
  border-radius: $radius-sm;
  color: $text-secondary;
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

@media (max-width: 720px) {
  .qa-composer {
    grid-template-columns: minmax(0, 1fr);
  }

  .qa-composer :deep(.n-button) {
    justify-self: stretch;
  }

  .qa-reference {
    grid-template-columns: minmax(0, 1fr);
    gap: 4px;
  }

  .qa-reference p {
    grid-column: auto;
  }

  .draft-comparison {
    grid-template-columns: minmax(0, 1fr);
  }

  .draft-version pre {
    min-height: 140px;
    max-height: 300px;
  }
}
</style>
