<script setup lang="ts">
import { computed, defineAsyncComponent, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  NAlert,
  NButton,
  NCheckbox,
  NEmpty,
  NInput,
  NModal,
  NPopconfirm,
  NSelect,
  NSpin,
  NTag,
  NTree,
  useMessage,
} from 'naive-ui'
import {
  approveKnowledgeDraft,
  dismissReadingCandidate,
  fetchKnowledgeDraftDetail,
  fetchKnowledgeGraph,
  fetchKnowledgeWorkspace,
  listKnowledgeDrafts,
  rejectKnowledgeDraft,
  reviseKnowledgeDraft,
  searchReadingCandidates,
  searchTrustedKnowledge,
  selectKnowledgeProject,
  uploadKnowledgePdf,
  type KnowledgeDraft,
  type KnowledgeDraftDetail,
  type KnowledgeGraph,
  type KnowledgeSearchResult,
  type KnowledgeWorkspace,
  type ReadingCandidate,
} from '@/api/workbench'
import {
  createManagedKnowledgeProject,
  createMissingKnowledgePage,
  deleteKnowledgeFile,
  fetchKnowledgeChatSession,
  fetchKnowledgeFile,
  fetchKnowledgeLint,
  fetchKnowledgePageLinks,
  fetchKnowledgeSettings,
  listKnowledgeChatSessions,
  listKnowledgeFileHistory,
  listKnowledgeFiles,
  listKnowledgeReviews,
  listKnowledgeSkills,
  listTrustedKnowledgeSources,
  rebuildKnowledgeIndex,
  rescanKnowledgeSources,
  resolveKnowledgeReviews,
  restoreKnowledgeFileHistory,
  saveKnowledgeFile,
  sendKnowledgeChat,
  stageGeneratedKnowledgeDraft,
  updateKnowledgeReview,
  type KnowledgeChatMessage,
  type KnowledgeChatSession,
  type KnowledgeFileHistoryEntry,
  type KnowledgeFileNode,
  type KnowledgeLintIssue,
  type KnowledgePageLinks,
  type KnowledgeReview,
  type KnowledgeSettings,
  type KnowledgeSkill,
  type TrustedKnowledgeSource,
} from '@/api/knowledge-workbench'

const MarkdownRenderer = defineAsyncComponent(async () => (
  await import('@/components/hermes/chat/MarkdownRenderer.vue')
).default)

type WorkbenchView =
  | 'overview'
  | 'wiki'
  | 'sources'
  | 'search'
  | 'graph'
  | 'review'
  | 'chat'
  | 'research'
  | 'lint'
  | 'skills'
  | 'settings'

const route = useRoute()
const router = useRouter()
const message = useMessage()

const viewItems: Array<{ key: WorkbenchView; label: string }> = [
  { key: 'overview', label: '概览' },
  { key: 'wiki', label: 'Wiki' },
  { key: 'sources', label: '来源库' },
  { key: 'search', label: '检索' },
  { key: 'graph', label: '知识图谱' },
  { key: 'review', label: '审核' },
  { key: 'chat', label: '对话' },
  { key: 'research', label: '深度研究' },
  { key: 'lint', label: '检查' },
  { key: 'skills', label: 'Skills' },
  { key: 'settings', label: '设置' },
]

const legacyViews: Record<string, WorkbenchView> = {
  management: 'overview',
  drafts: 'review',
  trusted: 'search',
  qa: 'chat',
  candidates: 'research',
}

function resolveView(value: unknown): WorkbenchView {
  const candidate = typeof value === 'string' ? value : ''
  if (viewItems.some(item => item.key === candidate)) return candidate as WorkbenchView
  return legacyViews[candidate] || 'overview'
}

const activeView = ref<WorkbenchView>(resolveView(route.query.tab))
const workspace = ref<KnowledgeWorkspace | null>(null)
const workspaceLoading = ref(false)
const workspaceError = ref('')
const selectedProjectId = ref<string | null>(null)
const switchingProject = ref(false)
const newProjectOpen = ref(false)
const newProjectName = ref('')
const creatingProject = ref(false)

const wikiFiles = ref<KnowledgeFileNode[]>([])
const sourceFiles = ref<KnowledgeFileNode[]>([])
const trustedSources = ref<TrustedKnowledgeSource[]>([])
const filesLoading = ref(false)
const selectedWikiPath = ref('')
const selectedSourcePath = ref('')
const activeFileContent = ref('')
const savedFileContent = ref('')
const activeFileRevision = ref('')
const activeFileLoading = ref(false)
const editorMode = ref<'preview' | 'edit'>('preview')
const links = ref<KnowledgePageLinks>({ outgoing: [], backlinks: [], missing: [] })
const historyOpen = ref(false)
const historyLoading = ref(false)
const fileHistory = ref<KnowledgeFileHistoryEntry[]>([])
const restoringHistoryId = ref('')
const createMissingOpen = ref(false)
const missingPageTitle = ref('')
const creatingMissingPage = ref(false)

const trustedQuery = ref('')
const trustedResults = ref<KnowledgeSearchResult[]>([])
const trustedLoading = ref(false)
const trustedSearched = ref(false)
const trustedError = ref('')

const graph = ref<KnowledgeGraph>({ nodes: [], edges: [] })
const graphLoading = ref(false)
const graphError = ref('')
const graphFilter = ref('')

const drafts = ref<KnowledgeDraft[]>([])
const draftsLoading = ref(false)
const uploading = ref(false)
const uploadProgress = ref('')
const fileInput = ref<HTMLInputElement | null>(null)
const draftDetailOpen = ref(false)
const draftDetail = ref<KnowledgeDraftDetail | null>(null)
const draftDetailLoading = ref(false)
const actingDraftId = ref('')
const reviseDraft = ref<KnowledgeDraft | null>(null)
const revisionGuidance = ref('')
const reviews = ref<KnowledgeReview[]>([])
const reviewsLoading = ref(false)
const resolvingReviewId = ref('')

const chatSessions = ref<KnowledgeChatSession[]>([])
const chatMessages = ref<KnowledgeChatMessage[]>([])
const chatLoading = ref(false)
const chatSessionsLoading = ref(false)
const activeChatSessionId = ref('')
const chatInput = ref('')
const chatMode = ref<'fast' | 'standard' | 'deep' | 'local_first'>('local_first')
const chatWebSearch = ref(false)
const skills = ref<KnowledgeSkill[]>([])
const selectedSkillIds = ref<string[]>([])

const researchTopic = ref('')
const researchLoading = ref(false)
const researchResult = ref('')
const researchReferences = ref<Array<{ title: string; path: string; kind: string; snippet: string | null }>>([])
const generatedDraftTitle = ref('')
const generatedDraftPath = ref('wiki/synthesis/research-note.md')
const stagingResearch = ref(false)
const candidateQuery = ref('')
const candidates = ref<ReadingCandidate[]>([])
const candidatesLoading = ref(false)
const candidateActionId = ref('')

const lintIssues = ref<KnowledgeLintIssue[]>([])
const lintPages = ref(0)
const lintLoading = ref(false)
const settings = ref<KnowledgeSettings | null>(null)
const settingsLoading = ref(false)
const maintenanceLoading = ref(false)

const projectOptions = computed(() => (workspace.value?.projects || []).map(project => ({
  label: project.name,
  value: project.id,
})))
const awaitingDrafts = computed(() => drafts.value.filter(draft => draft.status === 'awaiting_review'))
const dirtyFile = computed(() => activeFileContent.value !== savedFileContent.value)
const wikiTree = computed(() => toTreeNodes(wikiFiles.value))
const sourceTree = computed(() => toTreeNodes(sourceFiles.value))
const filteredGraphNodes = computed(() => {
  const query = graphFilter.value.trim().toLowerCase()
  if (!query) return graph.value.nodes
  return graph.value.nodes.filter((node) => graphLabel(node).toLowerCase().includes(query))
})
const selectedWikiFileName = computed(() => selectedWikiPath.value.split('/').pop() || 'Wiki 页面')

function setActiveView(value: WorkbenchView) {
  activeView.value = value
  if (route.query.tab !== value) {
    void router.replace({ query: { ...route.query, tab: value } })
  }
}

watch(() => route.query.tab, (tab) => {
  activeView.value = resolveView(tab)
})

watch(activeView, (view) => {
  void ensureViewLoaded(view)
})

function toTreeNodes(nodes: KnowledgeFileNode[]): Array<Record<string, unknown>> {
  return nodes.map(node => ({
    key: node.path,
    label: node.name,
    isDir: node.isDir,
    children: node.children.length ? toTreeNodes(node.children) : undefined,
  }))
}

function findFileNode(nodes: KnowledgeFileNode[], path: string): KnowledgeFileNode | null {
  for (const node of nodes) {
    if (node.path === path) return node
    const child = findFileNode(node.children, path)
    if (child) return child
  }
  return null
}

function graphLabel(node: Record<string, unknown>): string {
  const value = node.label ?? node.title ?? node.name ?? node.id
  return typeof value === 'string' ? value : '未命名节点'
}

function graphPath(node: Record<string, unknown>): string {
  const value = node.path
  return typeof value === 'string' ? value : ''
}

function formatTime(value: number | string | null | undefined): string {
  if (value === null || value === undefined || value === '') return '未知时间'
  const date = typeof value === 'number' ? new Date(value) : new Date(value)
  if (Number.isNaN(date.getTime())) return String(value)
  return date.toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  })
}

function draftStatusLabel(status: string): string {
  return {
    uploaded: '已上传', parsing: '解析中', drafting: '归纳中', awaiting_review: '待审核', publishing: '发布中',
    trusted: '已入库', revision_requested: '已退回', rejected: '已拒绝', failed: '处理失败',
  }[status] || status
}

function draftStatusType(status: string): 'success' | 'warning' | 'error' | 'info' | 'default' {
  if (status === 'trusted') return 'success'
  if (status === 'awaiting_review' || status === 'revision_requested') return 'warning'
  if (status === 'failed' || status === 'rejected') return 'error'
  if (status === 'parsing' || status === 'drafting' || status === 'publishing') return 'info'
  return 'default'
}

async function loadWorkspace() {
  workspaceLoading.value = true
  workspaceError.value = ''
  try {
    const next = await fetchKnowledgeWorkspace()
    workspace.value = next
    selectedProjectId.value = next.currentProject?.id || next.projects.find(project => project.current)?.id || null
  } catch (error) {
    workspaceError.value = error instanceof Error ? error.message : '无法读取知识库服务状态'
  } finally {
    workspaceLoading.value = false
  }
}

async function createProject() {
  const name = newProjectName.value.trim()
  if (!name || creatingProject.value) return
  creatingProject.value = true
  try {
    await createManagedKnowledgeProject(name)
    newProjectName.value = ''
    newProjectOpen.value = false
    await resetProjectData()
    message.success('已新建并切换到知识库项目')
  } catch (error) {
    message.error(error instanceof Error ? error.message : '新建项目失败')
  } finally {
    creatingProject.value = false
  }
}

async function switchProject() {
  const id = selectedProjectId.value
  if (!id || id === workspace.value?.currentProject?.id || switchingProject.value) return
  switchingProject.value = true
  try {
    await selectKnowledgeProject(id)
    await resetProjectData()
    message.success('已切换当前知识库')
  } catch (error) {
    message.error(error instanceof Error ? error.message : '切换项目失败')
    await loadWorkspace()
  } finally {
    switchingProject.value = false
  }
}

async function resetProjectData() {
  selectedWikiPath.value = ''
  selectedSourcePath.value = ''
  activeFileContent.value = ''
  savedFileContent.value = ''
  activeFileRevision.value = ''
  links.value = { outgoing: [], backlinks: [], missing: [] }
  graph.value = { nodes: [], edges: [] }
  chatSessions.value = []
  chatMessages.value = []
  activeChatSessionId.value = ''
  await Promise.all([loadWorkspace(), loadFiles(), loadDrafts(), loadSkills()])
  await ensureViewLoaded(activeView.value)
}

async function loadFiles() {
  filesLoading.value = true
  try {
    const [wiki, sources, trusted] = await Promise.all([
      listKnowledgeFiles('wiki'),
      listKnowledgeFiles('sources'),
      listTrustedKnowledgeSources(),
    ])
    wikiFiles.value = wiki
    sourceFiles.value = sources
    trustedSources.value = trusted
  } catch (error) {
    message.error(error instanceof Error ? error.message : '无法读取 Wiki 文件')
  } finally {
    filesLoading.value = false
  }
}

async function ensureViewLoaded(view: WorkbenchView) {
  if (view === 'wiki' || view === 'sources') {
    if (!wikiFiles.value.length && !filesLoading.value) await loadFiles()
  }
  if (view === 'graph' && !graph.value.nodes.length && !graphLoading.value) await loadGraph()
  if (view === 'review') await Promise.all([loadDrafts(), loadReviews()])
  if (view === 'chat') await Promise.all([loadChatSessions(), loadSkills()])
  if (view === 'research') await loadSkills()
  if (view === 'lint') await loadLint()
  if (view === 'skills') await loadSkills()
  if (view === 'settings') await loadSettings()
}

async function selectWikiTree(keys: Array<string | number>) {
  const path = typeof keys[0] === 'string' ? keys[0] : ''
  const node = findFileNode(wikiFiles.value, path)
  if (!node || node.isDir) return
  await openWikiFile(path)
}

async function selectSourceTree(keys: Array<string | number>) {
  const path = typeof keys[0] === 'string' ? keys[0] : ''
  const node = findFileNode(sourceFiles.value, path)
  if (!node || node.isDir) return
  selectedSourcePath.value = path
  if (path.toLowerCase().endsWith('.pdf')) {
    activeFileContent.value = '受信任 PDF 通过论文引用中的“打开证据”访问，以便精确跳转到对应页码。'
    savedFileContent.value = activeFileContent.value
    activeFileRevision.value = ''
    return
  }
  await openWikiFile(path, false)
}

async function openWikiFile(path: string, loadLinks = true) {
  if (dirtyFile.value && path !== selectedWikiPath.value && !window.confirm('当前页面有未保存的修改，仍要切换吗？')) return
  activeFileLoading.value = true
  try {
    const [file, pageLinks] = await Promise.all([
      fetchKnowledgeFile(path),
      loadLinks && path.startsWith('wiki/') ? fetchKnowledgePageLinks(path) : Promise.resolve(null),
    ])
    selectedWikiPath.value = path
    activeFileContent.value = file.content
    savedFileContent.value = file.content
    activeFileRevision.value = file.revision
    links.value = pageLinks || { outgoing: [], backlinks: [], missing: [] }
    editorMode.value = 'preview'
    if (path.startsWith('wiki/')) setActiveView('wiki')
  } catch (error) {
    message.error(error instanceof Error ? error.message : '无法打开文件')
  } finally {
    activeFileLoading.value = false
  }
}

async function saveActiveFile() {
  if (!selectedWikiPath.value || !dirtyFile.value) return
  try {
    activeFileRevision.value = await saveKnowledgeFile(selectedWikiPath.value, activeFileContent.value, activeFileRevision.value)
    savedFileContent.value = activeFileContent.value
    links.value = await fetchKnowledgePageLinks(selectedWikiPath.value)
    await loadFiles()
    message.success('已保存 Wiki 页面')
  } catch (error) {
    message.error(error instanceof Error ? error.message : '保存失败')
  }
}

async function deleteActiveFile() {
  if (!selectedWikiPath.value) return
  try {
    await deleteKnowledgeFile(selectedWikiPath.value, activeFileRevision.value)
    const deleted = selectedWikiPath.value
    selectedWikiPath.value = ''
    activeFileContent.value = ''
    savedFileContent.value = ''
    links.value = { outgoing: [], backlinks: [], missing: [] }
    await loadFiles()
    message.success(`已删除 ${deleted}`)
  } catch (error) {
    message.error(error instanceof Error ? error.message : '删除失败')
  }
}

async function openHistory() {
  if (!selectedWikiPath.value) return
  historyOpen.value = true
  historyLoading.value = true
  try {
    fileHistory.value = await listKnowledgeFileHistory(selectedWikiPath.value)
  } catch (error) {
    message.error(error instanceof Error ? error.message : '无法读取文件历史')
  } finally {
    historyLoading.value = false
  }
}

async function restoreHistory(entry: KnowledgeFileHistoryEntry) {
  if (!selectedWikiPath.value || restoringHistoryId.value) return
  restoringHistoryId.value = entry.id
  try {
    const file = await restoreKnowledgeFileHistory(selectedWikiPath.value, entry.id)
    activeFileContent.value = file.content
    savedFileContent.value = file.content
    activeFileRevision.value = file.revision
    links.value = await fetchKnowledgePageLinks(file.path)
    await loadFiles()
    historyOpen.value = false
    message.success('已恢复历史版本')
  } catch (error) {
    message.error(error instanceof Error ? error.message : '恢复失败')
  } finally {
    restoringHistoryId.value = ''
  }
}

async function createMissingPage() {
  if (!missingPageTitle.value.trim() || creatingMissingPage.value) return
  creatingMissingPage.value = true
  try {
    const file = await createMissingKnowledgePage(missingPageTitle.value.trim())
    missingPageTitle.value = ''
    createMissingOpen.value = false
    await loadFiles()
    await openWikiFile(file.path)
    message.success('已创建 Wiki 页面')
  } catch (error) {
    message.error(error instanceof Error ? error.message : '创建页面失败')
  } finally {
    creatingMissingPage.value = false
  }
}

async function loadDrafts() {
  if (draftsLoading.value) return
  draftsLoading.value = true
  try {
    drafts.value = await listKnowledgeDrafts()
  } catch (error) {
    message.error(error instanceof Error ? error.message : '无法读取审核草稿')
  } finally {
    draftsLoading.value = false
  }
}

function openFilePicker() {
  fileInput.value?.click()
}

async function uploadPdfs(event: Event) {
  const target = event.target as HTMLInputElement
  const files = Array.from(target.files || [])
  target.value = ''
  if (!files.length) return
  if (files.some(file => file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf'))) {
    message.error('只能上传 PDF 文件')
    return
  }
  uploading.value = true
  let count = 0
  try {
    for (const file of files) {
      uploadProgress.value = `正在上传 ${count + 1}/${files.length}: ${file.name}`
      await uploadKnowledgePdf(file)
      count += 1
    }
    message.success(`已提交 ${count} 篇论文，完成归纳后将进入审核队列`)
  } catch (error) {
    message.error(error instanceof Error ? error.message : `上传在第 ${count + 1} 篇时失败`)
  } finally {
    uploading.value = false
    uploadProgress.value = ''
    await loadDrafts()
  }
}

async function openDraft(draft: KnowledgeDraft) {
  draftDetailOpen.value = true
  draftDetailLoading.value = true
  draftDetail.value = null
  try {
    draftDetail.value = await fetchKnowledgeDraftDetail(draft.id)
  } catch (error) {
    message.error(error instanceof Error ? error.message : '无法读取草稿详情')
  } finally {
    draftDetailLoading.value = false
  }
}

async function approveDraft(draft: KnowledgeDraft) {
  actingDraftId.value = draft.id
  try {
    await approveKnowledgeDraft(draft.id)
    message.success('已开始将草稿发布到可信 Wiki')
    await Promise.all([loadDrafts(), loadFiles()])
  } catch (error) {
    message.error(error instanceof Error ? error.message : '批准失败')
  } finally {
    actingDraftId.value = ''
  }
}

async function rejectDraft(draft: KnowledgeDraft) {
  actingDraftId.value = draft.id
  try {
    await rejectKnowledgeDraft(draft.id, '在 Studio 审核中拒绝')
    message.success('已拒绝草稿')
    await loadDrafts()
  } catch (error) {
    message.error(error instanceof Error ? error.message : '拒绝失败')
  } finally {
    actingDraftId.value = ''
  }
}

async function submitRevision() {
  if (!reviseDraft.value) return
  actingDraftId.value = reviseDraft.value.id
  try {
    await reviseKnowledgeDraft(reviseDraft.value.id, revisionGuidance.value.trim() || undefined)
    reviseDraft.value = null
    revisionGuidance.value = ''
    message.success('已退回草稿重做')
    await loadDrafts()
  } catch (error) {
    message.error(error instanceof Error ? error.message : '退回失败')
  } finally {
    actingDraftId.value = ''
  }
}

async function loadReviews() {
  if (reviewsLoading.value) return
  reviewsLoading.value = true
  try {
    reviews.value = await listKnowledgeReviews('unresolved')
  } catch (error) {
    message.error(error instanceof Error ? error.message : '无法读取审核事项')
  } finally {
    reviewsLoading.value = false
  }
}

async function resolveReview(review: KnowledgeReview) {
  resolvingReviewId.value = review.id
  try {
    await updateKnowledgeReview(review.id, true, 'Resolved in Studio')
    await loadReviews()
  } catch (error) {
    message.error(error instanceof Error ? error.message : '处理审核事项失败')
  } finally {
    resolvingReviewId.value = ''
  }
}

async function resolveAllReviews() {
  const ids = reviews.value.map(review => review.id).filter(Boolean)
  if (!ids.length) return
  try {
    await resolveKnowledgeReviews(ids)
    await loadReviews()
    message.success('已处理全部审核事项')
  } catch (error) {
    message.error(error instanceof Error ? error.message : '批量处理失败')
  }
}

async function searchWiki() {
  const query = trustedQuery.value.trim()
  if (!query) return
  trustedLoading.value = true
  trustedSearched.value = true
  trustedError.value = ''
  try {
    trustedResults.value = await searchTrustedKnowledge(query)
  } catch (error) {
    trustedResults.value = []
    trustedError.value = error instanceof Error ? error.message : '可信 Wiki 检索失败'
  } finally {
    trustedLoading.value = false
  }
}

async function openSearchResult(result: KnowledgeSearchResult) {
  const path = result.id
  if (path.startsWith('wiki/')) await openWikiFile(path)
}

async function loadGraph() {
  graphLoading.value = true
  graphError.value = ''
  try {
    graph.value = await fetchKnowledgeGraph()
  } catch (error) {
    graphError.value = error instanceof Error ? error.message : '无法读取知识图谱'
  } finally {
    graphLoading.value = false
  }
}

async function openGraphNode(node: Record<string, unknown>) {
  const path = graphPath(node)
  if (path.startsWith('wiki/')) await openWikiFile(path)
}

async function loadSkills() {
  try {
    skills.value = await listKnowledgeSkills()
    const available = new Set(skills.value.map(skill => skill.id))
    selectedSkillIds.value = selectedSkillIds.value.filter(id => available.has(id))
  } catch (error) {
    message.error(error instanceof Error ? error.message : '无法读取 Skills')
  }
}

async function loadChatSessions() {
  if (chatSessionsLoading.value) return
  chatSessionsLoading.value = true
  try {
    chatSessions.value = await listKnowledgeChatSessions()
  } catch (error) {
    message.error(error instanceof Error ? error.message : '无法读取对话记录')
  } finally {
    chatSessionsLoading.value = false
  }
}

async function openChatSession(session: KnowledgeChatSession) {
  chatLoading.value = true
  try {
    chatMessages.value = await fetchKnowledgeChatSession(session.id)
    activeChatSessionId.value = session.id
  } catch (error) {
    message.error(error instanceof Error ? error.message : '无法打开对话')
  } finally {
    chatLoading.value = false
  }
}

function newChat() {
  activeChatSessionId.value = ''
  chatMessages.value = []
  chatInput.value = ''
}

async function sendChat() {
  const text = chatInput.value.trim()
  if (!text || chatLoading.value) return
  chatLoading.value = true
  chatMessages.value.push({ role: 'user', content: text, timestamp: Date.now() })
  chatInput.value = ''
  try {
    const response = await sendKnowledgeChat({
      message: text,
      sessionId: activeChatSessionId.value || undefined,
      mode: chatMode.value,
      webSearch: chatMode.value === 'deep' && chatWebSearch.value,
      skills: selectedSkillIds.value,
    })
    activeChatSessionId.value = response.sessionId || activeChatSessionId.value
    chatMessages.value.push({ role: 'assistant', content: response.content, timestamp: Date.now() })
    await loadChatSessions()
  } catch (error) {
    chatMessages.value.push({ role: 'assistant', content: `请求失败：${error instanceof Error ? error.message : '未知错误'}`, timestamp: Date.now() })
  } finally {
    chatLoading.value = false
  }
}

async function runResearch() {
  const topic = researchTopic.value.trim()
  if (!topic || researchLoading.value) return
  researchLoading.value = true
  researchResult.value = ''
  researchReferences.value = []
  try {
    const response = await sendKnowledgeChat({
      message: topic,
      mode: 'deep',
      webSearch: true,
      skills: selectedSkillIds.value,
    })
    researchResult.value = response.content
    researchReferences.value = response.references
    generatedDraftTitle.value = topic.slice(0, 120)
    generatedDraftPath.value = `wiki/synthesis/research-${Date.now()}.md`
  } catch (error) {
    message.error(error instanceof Error ? error.message : '深度研究失败')
  } finally {
    researchLoading.value = false
  }
}

async function stageResearch() {
  if (!researchResult.value.trim() || !generatedDraftTitle.value.trim() || !generatedDraftPath.value.trim()) return
  stagingResearch.value = true
  try {
    await stageGeneratedKnowledgeDraft(generatedDraftTitle.value.trim(), generatedDraftPath.value.trim(), researchResult.value)
    message.success('研究结果已进入严格审核队列，尚未写入正式 Wiki')
    await loadDrafts()
    setActiveView('review')
  } catch (error) {
    message.error(error instanceof Error ? error.message : '提交草稿失败')
  } finally {
    stagingResearch.value = false
  }
}

async function searchCandidates() {
  const query = candidateQuery.value.trim()
  if (!query || candidatesLoading.value) return
  candidatesLoading.value = true
  try {
    candidates.value = await searchReadingCandidates(query)
  } catch (error) {
    message.error(error instanceof Error ? error.message : '搜索待读候选失败')
  } finally {
    candidatesLoading.value = false
  }
}

async function dismissCandidate(candidate: ReadingCandidate) {
  candidateActionId.value = candidate.id
  try {
    await dismissReadingCandidate(candidate.id)
    candidates.value = candidates.value.filter(item => item.id !== candidate.id)
  } catch (error) {
    message.error(error instanceof Error ? error.message : '忽略候选失败')
  } finally {
    candidateActionId.value = ''
  }
}

async function loadLint() {
  if (lintLoading.value) return
  lintLoading.value = true
  try {
    const result = await fetchKnowledgeLint()
    lintPages.value = result.pages
    lintIssues.value = result.issues
  } catch (error) {
    message.error(error instanceof Error ? error.message : '无法执行 Wiki 检查')
  } finally {
    lintLoading.value = false
  }
}

async function loadSettings() {
  if (settingsLoading.value) return
  settingsLoading.value = true
  try {
    settings.value = await fetchKnowledgeSettings()
  } catch (error) {
    message.error(error instanceof Error ? error.message : '无法读取服务设置')
  } finally {
    settingsLoading.value = false
  }
}

async function rescanSources() {
  maintenanceLoading.value = true
  try {
    await rescanKnowledgeSources()
    await loadFiles()
    message.success('已重新扫描来源库')
  } catch (error) {
    message.error(error instanceof Error ? error.message : '重新扫描失败')
  } finally {
    maintenanceLoading.value = false
  }
}

async function rebuildIndex() {
  maintenanceLoading.value = true
  try {
    const result = await rebuildKnowledgeIndex()
    message.success(`已重建索引：${result.pages} 个页面，${result.groups} 个分组`)
  } catch (error) {
    message.error(error instanceof Error ? error.message : '重建索引失败')
  } finally {
    maintenanceLoading.value = false
  }
}

onMounted(async () => {
  await Promise.all([loadWorkspace(), loadFiles(), loadDrafts(), loadSkills()])
  await ensureViewLoaded(activeView.value)
})
</script>

<template>
  <div class="knowledge-studio">
    <header class="knowledge-studio__header">
      <div>
        <h2>LLM Wiki</h2>
        <p>论文、来源和研究结论在 Studio 中统一管理。未审核内容不会进入正式 Wiki 或被检索引用。</p>
      </div>
      <div class="knowledge-studio__header-actions">
        <NSelect
          v-model:value="selectedProjectId"
          :options="projectOptions"
          :loading="workspaceLoading"
          :disabled="switchingProject || !projectOptions.length"
          class="project-select"
          aria-label="切换知识库项目"
        />
        <NButton size="small" :loading="switchingProject" :disabled="!selectedProjectId" @click="switchProject">切换</NButton>
        <NButton size="small" type="primary" @click="newProjectOpen = true">新建项目</NButton>
      </div>
    </header>

    <NAlert v-if="workspaceError" type="error" class="knowledge-studio__alert">
      {{ workspaceError }}
      <NButton size="tiny" text @click="loadWorkspace">重试</NButton>
    </NAlert>

    <div class="knowledge-studio__layout">
      <nav class="knowledge-studio__nav" aria-label="LLM Wiki 功能">
        <button
          v-for="item in viewItems"
          :key="item.key"
          type="button"
          :class="['knowledge-nav-item', { 'is-active': activeView === item.key }]"
          @click="setActiveView(item.key)"
        >
          <span>{{ item.label }}</span>
          <strong v-if="item.key === 'review' && awaitingDrafts.length">{{ awaitingDrafts.length }}</strong>
        </button>
      </nav>

      <main class="knowledge-studio__main">
        <section v-if="activeView === 'overview'" class="knowledge-view">
          <div class="section-heading">
            <div>
              <h3>当前知识库</h3>
              <p>{{ workspace?.currentProject?.name || '尚未选择项目' }}</p>
            </div>
            <NButton size="small" :loading="workspaceLoading" @click="loadWorkspace">刷新状态</NButton>
          </div>
          <div class="overview-grid">
            <button type="button" class="overview-metric" @click="setActiveView('review')">
              <span>待审核论文</span><strong>{{ awaitingDrafts.length }}</strong><small>严格草稿队列</small>
            </button>
            <button type="button" class="overview-metric" @click="setActiveView('wiki')">
              <span>正式 Wiki</span><strong>{{ wikiFiles.length }}</strong><small>仅显示已发布页面</small>
            </button>
            <button type="button" class="overview-metric" @click="setActiveView('sources')">
              <span>来源库</span><strong>{{ sourceFiles.length }}</strong><small>原始来源和摘要</small>
            </button>
            <button type="button" class="overview-metric" @click="setActiveView('settings')">
              <span>服务状态</span><strong>{{ workspace?.service.status === 'running' ? '运行中' : workspace?.service.status || '未知' }}</strong><small>{{ workspace?.service.retrievalMode || 'keyword_graph' }}</small>
            </button>
          </div>
          <section class="overview-band">
            <div>
              <strong>唯一用户入口</strong>
              <p>LLM Wiki 作为本机后台服务由 Studio 管理，不提供独立窗口、托盘或浏览器入口。</p>
            </div>
            <NTag :type="workspace?.service.studioManaged ? 'success' : 'warning'" :bordered="false">
              {{ workspace?.service.studioManaged ? 'Studio 已接管' : '等待接管' }}
            </NTag>
          </section>
          <section class="overview-band">
            <div>
              <strong>论文归纳与审核</strong>
              <p>上传 PDF 后先进入暂存和审核流程；批准后才写入正式 Wiki 并参与关键词检索和知识图谱。</p>
            </div>
            <NButton type="primary" @click="setActiveView('review')">导入论文</NButton>
          </section>
        </section>

        <section v-else-if="activeView === 'wiki'" class="knowledge-view wiki-view">
          <aside class="wiki-pane wiki-pane--tree">
            <div class="pane-heading"><strong>Wiki 页面</strong><NButton size="tiny" text @click="loadFiles">刷新</NButton></div>
            <NSpin :show="filesLoading">
              <NTree
                block-line
                selectable
                :data="wikiTree"
                :selected-keys="selectedWikiPath ? [selectedWikiPath] : []"
                @update:selected-keys="selectWikiTree"
              />
              <NEmpty v-if="!filesLoading && !wikiTree.length" description="暂无已发布 Wiki 页面" size="small" />
            </NSpin>
          </aside>
          <section class="wiki-pane wiki-pane--content">
            <template v-if="selectedWikiPath">
              <div class="pane-heading pane-heading--file">
                <div><strong>{{ selectedWikiFileName }}</strong><code>{{ selectedWikiPath }}</code></div>
                <div class="file-actions">
                  <NButton size="tiny" :disabled="!dirtyFile" type="primary" @click="saveActiveFile">保存</NButton>
                  <NButton size="tiny" @click="editorMode = editorMode === 'edit' ? 'preview' : 'edit'">{{ editorMode === 'edit' ? '预览' : '编辑' }}</NButton>
                  <NButton size="tiny" @click="openHistory">历史</NButton>
                  <NPopconfirm @positive-click="deleteActiveFile"><template #trigger><NButton size="tiny" type="error" secondary>删除</NButton></template>删除后只能从历史快照手动恢复，确认继续？</NPopconfirm>
                </div>
              </div>
              <NSpin :show="activeFileLoading">
                <NInput v-if="editorMode === 'edit'" v-model:value="activeFileContent" type="textarea" :autosize="false" class="wiki-editor" />
                <div v-else class="wiki-preview"><MarkdownRenderer :content="activeFileContent" /></div>
              </NSpin>
            </template>
            <NEmpty v-else description="从左侧选择一个已发布的 Wiki 页面" />
          </section>
          <aside class="wiki-pane wiki-pane--links">
            <div class="pane-heading"><strong>页面关系</strong><NButton size="tiny" text @click="createMissingOpen = true">新建页面</NButton></div>
            <div class="link-group"><span>正向链接</span><button v-for="item in links.outgoing" :key="`${item.path}:${item.title}`" type="button" @click="item.path && openWikiFile(item.path)">{{ item.title }}</button><small v-if="!links.outgoing.length">无</small></div>
            <div class="link-group"><span>反向链接</span><button v-for="item in links.backlinks" :key="`${item.path}:${item.title}`" type="button" @click="item.path && openWikiFile(item.path)">{{ item.title }}</button><small v-if="!links.backlinks.length">无</small></div>
            <div class="link-group"><span>缺失页面</span><button v-for="item in links.missing" :key="item.title" type="button" @click="missingPageTitle = item.title; createMissingOpen = true">{{ item.title }}</button><small v-if="!links.missing.length">无</small></div>
          </aside>
        </section>

        <section v-else-if="activeView === 'sources'" class="knowledge-view source-view">
          <div class="section-heading"><div><h3>来源库</h3><p>已发布来源和可读文本。PDF 通过引用入口按证据页打开。</p></div><NButton size="small" :loading="maintenanceLoading" @click="rescanSources">重新扫描</NButton></div>
          <div v-if="trustedSources.length" class="trusted-source-list"><article v-for="source in trustedSources" :key="source.sourceId" class="trusted-source-row"><div><strong>{{ source.title || source.filename }}</strong><span>{{ source.authors.join('、') }}<template v-if="source.year"> · {{ source.year }}</template></span><small>{{ source.filename }} · 已发布 {{ formatTime(source.trustedAt) }}</small></div><div class="candidate-actions"><NButton v-for="pagePath in source.pagePaths.slice(0, 2)" :key="pagePath" size="tiny" @click="openWikiFile(pagePath)">相关 Wiki</NButton><NButton v-if="source.sourceKind === 'pdf'" tag="a" :href="`/api/knowledge/sources/${encodeURIComponent(source.sourceId)}/pdf?page=1`" target="_blank" rel="noopener noreferrer" size="tiny">打开 PDF</NButton></div></article></div>
          <div class="source-layout">
            <aside class="wiki-pane wiki-pane--tree"><NTree block-line selectable :data="sourceTree" :selected-keys="selectedSourcePath ? [selectedSourcePath] : []" @update:selected-keys="selectSourceTree" /><NEmpty v-if="!sourceTree.length" description="暂无来源文件" size="small" /></aside>
            <section class="wiki-pane wiki-pane--content"><div v-if="selectedSourcePath" class="pane-heading"><strong>{{ selectedSourcePath.split('/').pop() }}</strong><code>{{ selectedSourcePath }}</code></div><div v-if="selectedSourcePath" class="wiki-preview"><MarkdownRenderer :content="activeFileContent" /></div><NEmpty v-else description="选择来源文件以查看内容" /></section>
          </div>
        </section>

        <section v-else-if="activeView === 'search'" class="knowledge-view">
          <div class="section-heading"><div><h3>可信 Wiki 检索</h3><p>只检索已批准的正式 Wiki，不读取草稿暂存区。</p></div></div>
          <div class="query-row"><NInput v-model:value="trustedQuery" placeholder="搜索已学习过的论文和知识页面" @keyup.enter="searchWiki" /><NButton type="primary" :loading="trustedLoading" :disabled="!trustedQuery.trim()" @click="searchWiki">检索</NButton></div>
          <NAlert v-if="trustedError" type="error" class="knowledge-studio__alert">{{ trustedError }}</NAlert>
          <div v-if="trustedResults.length" class="result-list"><article v-for="result in trustedResults" :key="result.id" class="result-row"><button type="button" class="result-main" @click="openSearchResult(result)"><strong>{{ result.title }}</strong><span>{{ result.authors.join('、') }}<template v-if="result.year"> · {{ result.year }}</template></span><p>{{ result.excerpt }}</p></button><a v-if="result.sourceUrl" :href="result.sourceUrl" target="_blank" rel="noopener noreferrer">打开证据</a></article></div>
          <NEmpty v-else-if="trustedSearched && !trustedLoading" description="可信 Wiki 中没有匹配结果" />
          <NEmpty v-else description="输入问题或关键词，优先索引你已阅读并批准的内容" />
        </section>

        <section v-else-if="activeView === 'graph'" class="knowledge-view">
          <div class="section-heading"><div><h3>知识图谱</h3><p>显示正式 Wiki 页之间的关联，暂存草稿不参与图谱。</p></div><NButton size="small" :loading="graphLoading" @click="loadGraph">刷新图谱</NButton></div>
          <NAlert v-if="graphError" type="error" class="knowledge-studio__alert">{{ graphError }}</NAlert>
          <div class="query-row"><NInput v-model:value="graphFilter" placeholder="筛选节点" /><NTag :bordered="false">{{ graph.nodes.length }} 节点 · {{ graph.edges.length }} 关系</NTag></div>
          <NSpin :show="graphLoading"><div v-if="filteredGraphNodes.length" class="graph-board"><button v-for="node in filteredGraphNodes" :key="String(node.id)" type="button" class="graph-node" @click="openGraphNode(node)"><strong>{{ graphLabel(node) }}</strong><span>{{ typeof node.nodeType === 'string' ? node.nodeType : 'page' }}</span></button></div><NEmpty v-else description="暂无知识图谱节点" /></NSpin>
          <div v-if="graph.edges.length" class="edge-list"><span v-for="(edge, index) in graph.edges.slice(0, 120)" :key="index">{{ String(edge.source) }} ↔ {{ String(edge.target) }}</span></div>
        </section>

        <section v-else-if="activeView === 'review'" class="knowledge-view">
          <div class="section-heading"><div><h3>论文归纳与审核</h3><p>PDF 和研究生成内容都先在此处审核；审核前不可检索、不可引用。</p></div><NButton size="small" :loading="draftsLoading" @click="loadDrafts">刷新</NButton></div>
          <section class="upload-strip"><div><strong>导入论文 PDF</strong><span>{{ uploadProgress || '可以一次选择多篇 PDF。文件会先进入暂存和审核队列。' }}</span></div><input ref="fileInput" class="visually-hidden" type="file" accept="application/pdf,.pdf" multiple @change="uploadPdfs" /><NButton type="primary" :loading="uploading" @click="openFilePicker">选择 PDF</NButton></section>
          <div class="subsection-heading"><h4>严格草稿队列</h4><span>{{ drafts.length }} 项</span></div>
          <NSpin :show="draftsLoading"><div v-if="drafts.length" class="draft-list"><article v-for="draft in drafts" :key="draft.id" class="draft-row"><div><strong>{{ draft.title }}</strong><span>{{ draft.fileName }} · {{ formatTime(draft.updatedAt || draft.createdAt) }}</span><p v-if="draft.summary">{{ draft.summary }}</p><small v-if="draft.error" class="error-copy">{{ draft.error }}</small></div><div class="draft-actions"><NTag :type="draftStatusType(draft.status)" :bordered="false">{{ draftStatusLabel(draft.status) }}</NTag><NButton size="tiny" @click="openDraft(draft)">查看</NButton><NButton v-if="draft.status === 'awaiting_review'" size="tiny" type="primary" :loading="actingDraftId === draft.id" @click="approveDraft(draft)">批准</NButton><NButton v-if="draft.status === 'awaiting_review'" size="tiny" @click="reviseDraft = draft; revisionGuidance = ''">退回</NButton><NPopconfirm v-if="draft.status === 'awaiting_review'" @positive-click="rejectDraft(draft)"><template #trigger><NButton size="tiny" type="error" secondary>拒绝</NButton></template>确认拒绝这份草稿？</NPopconfirm></div></article></div><NEmpty v-else description="暂无论文或研究草稿" /></NSpin>
          <div class="subsection-heading"><h4>普通审核事项</h4><NButton size="tiny" text :disabled="!reviews.length" @click="resolveAllReviews">全部处理</NButton></div>
          <NSpin :show="reviewsLoading"><div v-if="reviews.length" class="review-list"><article v-for="review in reviews" :key="review.id" class="review-row"><div><strong>{{ review.title }}</strong><span>{{ review.type }}</span><p v-if="review.description">{{ review.description }}</p></div><NButton size="tiny" :loading="resolvingReviewId === review.id" @click="resolveReview(review)">处理</NButton></article></div><NEmpty v-else description="没有待处理的普通审核事项" /></NSpin>
        </section>

        <section v-else-if="activeView === 'chat'" class="knowledge-view chat-view">
          <aside class="chat-sessions"><div class="pane-heading"><strong>对话</strong><NButton size="tiny" text @click="newChat">新建</NButton></div><NSpin :show="chatSessionsLoading"><button v-for="session in chatSessions" :key="session.id" type="button" :class="['chat-session', { 'is-active': session.id === activeChatSessionId }]" @click="openChatSession(session)"><strong>{{ session.title }}</strong><span>{{ formatTime(session.updatedAt) }}</span></button><NEmpty v-if="!chatSessions.length" description="暂无已保存对话" size="small" /></NSpin></aside>
          <section class="chat-thread"><div class="chat-policy">本对话仅能读取 Wiki、检索和图谱。不会写入 Wiki 或执行终端命令。</div><NSpin :show="chatLoading"><div v-if="chatMessages.length" class="message-list"><article v-for="(item, index) in chatMessages" :key="`${index}:${item.timestamp || ''}`" :class="['wiki-message', `wiki-message--${item.role}`]"><span>{{ item.role === 'user' ? '你' : 'LLM Wiki' }}</span><div v-if="item.role === 'assistant'" class="wiki-message__body"><MarkdownRenderer :content="item.content" /></div><p v-else>{{ item.content }}</p></article></div><NEmpty v-else description="开始一个只读的知识库对话" /></NSpin><div class="chat-composer"><NSelect v-model:value="chatMode" :options="[{ label: '本地优先', value: 'local_first' }, { label: '标准', value: 'standard' }, { label: '深入', value: 'deep' }, { label: '快速', value: 'fast' }]" /><NCheckbox v-model:checked="chatWebSearch" :disabled="chatMode !== 'deep'">深度模式允许外部搜索</NCheckbox><NInput v-model:value="chatInput" type="textarea" :autosize="{ minRows: 2, maxRows: 6 }" placeholder="向已批准 Wiki 提问" @keydown.ctrl.enter.prevent="sendChat" /><NButton type="primary" :loading="chatLoading" :disabled="!chatInput.trim()" @click="sendChat">发送</NButton></div></section>
        </section>

        <section v-else-if="activeView === 'research'" class="knowledge-view">
          <div class="section-heading"><div><h3>深度研究与待读候选</h3><p>外部结果只用于研究和候选箱；不会自动下载或写入正式 Wiki。</p></div></div>
          <div class="research-composer"><NInput v-model:value="researchTopic" type="textarea" :autosize="{ minRows: 2, maxRows: 5 }" placeholder="输入需要补充外部资料的研究问题" /><NButton type="primary" :loading="researchLoading" :disabled="!researchTopic.trim()" @click="runResearch">开始研究</NButton></div>
          <section v-if="researchResult" class="research-result"><div class="subsection-heading"><h4>研究结果</h4><NTag type="warning" :bordered="false">未入库</NTag></div><div class="wiki-preview"><MarkdownRenderer :content="researchResult" /></div><div v-if="researchReferences.length" class="reference-list"><button v-for="reference in researchReferences" :key="`${reference.kind}:${reference.path}`" type="button" @click="reference.path.startsWith('wiki/') && openWikiFile(reference.path)">{{ reference.title }}</button></div><div class="stage-generated"><NInput v-model:value="generatedDraftTitle" placeholder="草稿标题" /><NInput v-model:value="generatedDraftPath" placeholder="wiki/synthesis/research-note.md" /><NButton :loading="stagingResearch" :disabled="!generatedDraftTitle.trim() || !generatedDraftPath.trim()" @click="stageResearch">送审为 Wiki 草稿</NButton></div></section>
          <section class="candidate-section"><div class="subsection-heading"><h4>待读候选箱</h4></div><div class="query-row"><NInput v-model:value="candidateQuery" placeholder="搜索 OpenAlex、Crossref 和 arXiv" @keyup.enter="searchCandidates" /><NButton :loading="candidatesLoading" :disabled="!candidateQuery.trim()" @click="searchCandidates">搜索候选</NButton></div><div v-if="candidates.length" class="result-list"><article v-for="candidate in candidates" :key="candidate.id" class="result-row"><div class="result-main"><strong>{{ candidate.title }}</strong><span>{{ candidate.authors.join('、') }}<template v-if="candidate.year"> · {{ candidate.year }}</template></span><p>{{ candidate.abstract }}</p></div><div class="candidate-actions"><a v-if="candidate.url" :href="candidate.url" target="_blank" rel="noopener noreferrer">查看来源</a><NButton size="tiny" :loading="candidateActionId === candidate.id" @click="dismissCandidate(candidate)">忽略</NButton></div></article></div><NEmpty v-else description="搜索外部题录并加入待读候选" /></section>
        </section>

        <section v-else-if="activeView === 'lint'" class="knowledge-view">
          <div class="section-heading"><div><h3>Wiki 检查</h3><p>检查页面 frontmatter 和未解析的 Wiki 链接，不会修改内容。</p></div><NButton size="small" :loading="lintLoading" @click="loadLint">重新检查</NButton></div>
          <NTag :bordered="false">已检查 {{ lintPages }} 个页面</NTag>
          <div v-if="lintIssues.length" class="lint-list"><article v-for="issue in lintIssues" :key="issue.id" :class="['lint-row', `is-${issue.severity}`]"><div><strong>{{ issue.message }}</strong><code>{{ issue.path }}</code></div><NButton v-if="issue.missingTitle" size="tiny" @click="missingPageTitle = issue.missingTitle || ''; createMissingOpen = true">创建页面</NButton><NButton v-else size="tiny" @click="openWikiFile(issue.path)">打开</NButton></article></div><NEmpty v-else description="没有发现需要处理的页面问题" />
        </section>

        <section v-else-if="activeView === 'skills'" class="knowledge-view">
          <div class="section-heading"><div><h3>Skills</h3><p>选择可用于只读知识库对话和深度研究的已发现 Skills。</p></div><NButton size="small" @click="loadSkills">重新扫描</NButton></div>
          <div v-if="skills.length" class="skill-list"><label v-for="skill in skills" :key="skill.id" class="skill-row"><NCheckbox :checked="selectedSkillIds.includes(skill.id)" @update:checked="(checked) => selectedSkillIds = checked ? [...selectedSkillIds, skill.id] : selectedSkillIds.filter(id => id !== skill.id)" /><div><strong>{{ skill.name }}</strong><span>{{ skill.id }} · {{ skill.source }}</span><p>{{ skill.description || '无描述' }}</p></div></label></div><NEmpty v-else description="未发现可用 Skills" />
        </section>

        <section v-else-if="activeView === 'settings'" class="knowledge-view">
          <div class="section-heading"><div><h3>LLM Wiki 设置</h3><p>本机服务设置由 Studio 统一管理，密钥不会返回到浏览器。</p></div><NButton size="small" :loading="settingsLoading" @click="loadSettings">刷新</NButton></div>
          <div v-if="settings" class="settings-grid"><div><span>检索模式</span><strong>{{ settings.retrievalMode }}</strong><small>{{ settings.embeddingEnabled ? 'Embedding 已启用' : '不使用 Ollama，使用关键词检索和知识图谱' }}</small></div><div><span>Wiki 问答模型</span><strong>{{ settings.llmConfigured ? '已配置' : '未配置' }}</strong><small>检索、审核和图谱不受影响</small></div><div><span>Web Clipper</span><strong>{{ settings.clipServerStatus }}</strong><small>所有导入仍会经过审核门</small></div><div><span>本地 API</span><strong>{{ settings.api.loopbackOnly ? '仅 127.0.0.1' : '需检查绑定' }}</strong><small>{{ settings.api.tokenConfigured ? '已配置服务令牌' : '服务令牌未配置' }}</small></div><div><span>来源监听</span><strong>{{ settings.sourceWatch.enabled ? '已启用' : '未启用' }}</strong><small>{{ settings.sourceWatch.autoIngest ? '新来源将进入审核队列' : '仅手动导入' }}</small></div></div><NEmpty v-else description="正在读取设置" />
          <section class="maintenance-band"><div><strong>项目维护</strong><p>重新扫描来源或重建索引不会绕过审核门，也不会向模型发送公司数据。</p></div><div><NButton :loading="maintenanceLoading" @click="rescanSources">重新扫描来源</NButton><NButton :loading="maintenanceLoading" type="primary" @click="rebuildIndex">重建 Wiki 索引</NButton></div></section>
        </section>
      </main>
    </div>

    <NModal v-model:show="newProjectOpen" preset="dialog" title="新建知识库项目" positive-text="创建" negative-text="取消" :positive-button-props="{ loading: creatingProject, disabled: !newProjectName.trim() }" @positive-click="createProject">
      <NInput v-model:value="newProjectName" placeholder="项目名称" maxlength="80" />
      <p class="modal-copy">项目将创建在 LLM Wiki 的受控本地目录中，并由 Studio 纳入统一备份和管理。</p>
    </NModal>

    <NModal v-model:show="createMissingOpen" preset="dialog" title="创建 Wiki 页面" positive-text="创建" negative-text="取消" :positive-button-props="{ loading: creatingMissingPage, disabled: !missingPageTitle.trim() }" @positive-click="createMissingPage">
      <NInput v-model:value="missingPageTitle" placeholder="页面标题" maxlength="200" />
      <p class="modal-copy">页面会创建在 `wiki/concepts/`，不会覆盖已有页面。</p>
    </NModal>

    <NModal v-model:show="historyOpen" preset="dialog" title="文件历史" style="width: min(860px, calc(100vw - 32px));">
      <NSpin :show="historyLoading"><div v-if="fileHistory.length" class="history-list"><article v-for="entry in fileHistory" :key="entry.id"><header><strong>{{ formatTime(entry.timestamp) }}</strong><span>{{ entry.author }} · {{ entry.tool }}</span><NButton size="tiny" :loading="restoringHistoryId === entry.id" @click="restoreHistory(entry)">恢复此版本</NButton></header><pre>{{ entry.content }}</pre></article></div><NEmpty v-else description="暂无历史版本" /></NSpin>
    </NModal>

    <NModal v-model:show="draftDetailOpen" preset="dialog" title="草稿页面对照" style="width: min(980px, calc(100vw - 32px));">
      <NSpin :show="draftDetailLoading"><template v-if="draftDetail"><div class="draft-detail-title"><strong>{{ draftDetail.draft.title }}</strong><NTag :type="draftStatusType(draftDetail.draft.status)" :bordered="false">{{ draftStatusLabel(draftDetail.draft.status) }}</NTag></div><article v-for="change in draftDetail.changes" :key="`${change.operation}:${change.path}`" class="draft-change"><header><strong>{{ change.title }}</strong><code>{{ change.path }}</code></header><div class="draft-change-grid"><pre v-if="change.operation.toLowerCase() !== 'create'">{{ change.previousContent || '当前页面不存在' }}</pre><pre>{{ change.content }}</pre></div></article></template><NEmpty v-else description="暂无草稿详情" /></NSpin>
    </NModal>

    <NModal :show="!!reviseDraft" preset="dialog" title="退回草稿重做" positive-text="提交" negative-text="取消" :positive-button-props="{ loading: !!actingDraftId }" @update:show="(show) => { if (!show) reviseDraft = null }" @positive-click="submitRevision" @negative-click="reviseDraft = null">
      <NInput v-model:value="revisionGuidance" type="textarea" :autosize="{ minRows: 4, maxRows: 8 }" placeholder="说明需要修正的归纳、页面或证据定位" />
    </NModal>
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.knowledge-studio {
  display: flex;
  min-height: 0;
  flex: 1;
  flex-direction: column;
  padding: 20px;
  gap: 14px;
}

.knowledge-studio__header,
.section-heading,
.pane-heading,
.subsection-heading,
.draft-row,
.review-row,
.result-row,
.maintenance-band,
.upload-strip {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}

.knowledge-studio__header {
  flex-wrap: wrap;

  h2,
  h3,
  h4,
  p { margin: 0; }

  h2 { font-size: 20px; }
  p { margin-top: 5px; color: $text-secondary; font-size: 13px; line-height: 1.55; }
}

.knowledge-studio__header-actions,
.file-actions,
.maintenance-band > div:last-child,
.draft-actions,
.candidate-actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}

.project-select { width: 220px; }
.knowledge-studio__alert { margin: 0; }

.knowledge-studio__layout {
  display: grid;
  min-height: 0;
  flex: 1;
  grid-template-columns: 142px minmax(0, 1fr);
  overflow: hidden;
  border: 1px solid $border-light;
  background: $bg-primary;
}

.knowledge-studio__nav {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 10px;
  overflow-y: auto;
  border-right: 1px solid $border-light;
  background: $bg-secondary;
}

.knowledge-nav-item {
  display: flex;
  min-height: 34px;
  align-items: center;
  justify-content: space-between;
  border: 0;
  border-radius: $radius-sm;
  padding: 0 9px;
  background: transparent;
  color: $text-secondary;
  cursor: pointer;
  font-size: 13px;
  text-align: left;

  &:hover,
  &.is-active { background: $bg-card-hover; color: $accent-primary; }

  strong {
    min-width: 18px;
    color: $warning;
    font-size: 11px;
    text-align: right;
  }
}

.knowledge-studio__main {
  min-width: 0;
  overflow: auto;
}

.knowledge-view {
  display: flex;
  min-height: 100%;
  flex-direction: column;
  gap: 18px;
  padding: 20px;
}

.section-heading {
  align-items: flex-start;
  border-bottom: 1px solid $border-light;
  padding-bottom: 13px;

  h3 { margin: 0; font-size: 16px; }
  p { margin: 5px 0 0; color: $text-secondary; font-size: 13px; line-height: 1.55; }
}

.overview-grid,
.settings-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 10px;
}

.overview-metric,
.settings-grid > div {
  display: grid;
  min-height: 104px;
  gap: 6px;
  border: 1px solid $border-light;
  border-radius: $radius-sm;
  padding: 14px;
  background: $bg-primary;
  color: $text-primary;
  text-align: left;
}

.overview-metric {
  cursor: pointer;

  &:hover { border-color: $accent-primary; background: $bg-card-hover; }
}

.overview-metric span,
.settings-grid span,
.overview-metric small,
.settings-grid small { color: $text-secondary; font-size: 12px; }
.overview-metric strong { font-size: 22px; }
.settings-grid strong { font-size: 14px; }

.overview-band,
.maintenance-band,
.upload-strip {
  border-top: 1px solid $border-light;
  padding-top: 16px;

  strong { font-size: 14px; }
  p,
  span { display: block; margin: 5px 0 0; color: $text-secondary; font-size: 13px; line-height: 1.55; }
}

.wiki-view {
  display: grid;
  height: 100%;
  min-height: 660px;
  grid-template-columns: minmax(190px, 0.75fr) minmax(360px, 2fr) minmax(180px, 0.75fr);
  gap: 0;
  padding: 0;
}

.source-layout { display: grid; min-height: 540px; grid-template-columns: minmax(230px, .8fr) minmax(0, 2fr); }
.source-view { gap: 14px; }
.trusted-source-list { display: grid; border-top: 1px solid $border-light; }
.trusted-source-row { display: flex; align-items: center; justify-content: space-between; gap: 14px; border-bottom: 1px solid $border-light; padding: 10px 0; }
.trusted-source-row > div:first-child { display: grid; min-width: 0; gap: 3px; }
.trusted-source-row span,
.trusted-source-row small { color: $text-secondary; font-size: 12px; }

.wiki-pane {
  min-width: 0;
  overflow: auto;
  border-right: 1px solid $border-light;

  &:last-child { border-right: 0; }
}

.wiki-pane--tree,
.wiki-pane--links { padding: 13px; background: $bg-secondary; }

.wiki-pane--content { display: flex; flex-direction: column; background: $bg-primary; }

.pane-heading {
  min-height: 31px;
  margin-bottom: 10px;
  color: $text-primary;
  font-size: 13px;

  code { display: block; margin-top: 3px; overflow-wrap: anywhere; color: $text-muted; font-size: 10px; }
}

.pane-heading--file { padding: 10px 13px; margin: 0; border-bottom: 1px solid $border-light; }

.wiki-editor {
  flex: 1;
  min-height: 0;
  padding: 13px;

  :deep(textarea) { min-height: 530px !important; font-family: $font-code; font-size: 12px; line-height: 1.65; }
}

.wiki-preview { min-width: 0; padding: 18px; overflow: auto; line-height: 1.65; }

.link-group {
  display: grid;
  gap: 5px;
  padding: 11px 0;
  border-bottom: 1px solid $border-light;

  > span { color: $text-muted; font-size: 11px; }
  button { overflow: hidden; border: 0; padding: 0; background: none; color: $accent-primary; cursor: pointer; font-size: 12px; text-align: left; text-overflow: ellipsis; white-space: nowrap; }
  small { color: $text-muted; font-size: 11px; }
}

.query-row,
.research-composer,
.stage-generated,
.chat-composer { display: flex; align-items: center; gap: 10px; }
.query-row > :first-child,
.research-composer :deep(.n-input),
.stage-generated :deep(.n-input) { flex: 1; }
.research-composer { align-items: flex-end; }

.result-list,
.draft-list,
.review-list,
.lint-list,
.skill-list { display: grid; border-top: 1px solid $border-light; }

.result-row,
.draft-row,
.review-row,
.lint-row,
.skill-row { padding: 13px 0; border-bottom: 1px solid $border-light; }

.result-main { display: grid; min-width: 0; gap: 4px; border: 0; padding: 0; background: none; color: $text-primary; cursor: pointer; text-align: left; }
.result-main strong,
.draft-row strong,
.review-row strong,
.lint-row strong,
.skill-row strong { font-size: 14px; }
.result-main span,
.draft-row span,
.review-row span,
.skill-row span { color: $text-secondary; font-size: 12px; }
.result-main p,
.draft-row p,
.review-row p,
.skill-row p { margin: 2px 0 0; color: $text-secondary; font-size: 12px; line-height: 1.55; }
.result-row > a,
.candidate-actions > a { color: $accent-primary; font-size: 12px; text-decoration: none; }

.graph-board { display: flex; min-height: 290px; align-content: flex-start; flex-wrap: wrap; gap: 9px; border: 1px solid $border-light; padding: 18px; background: $bg-secondary; }
.graph-node { display: grid; min-width: min(180px, 100%); max-width: 250px; gap: 4px; border: 1px solid $border-color; border-radius: $radius-sm; padding: 10px; background: $bg-primary; color: $text-primary; cursor: pointer; text-align: left; }
.graph-node:hover { border-color: $accent-primary; }
.graph-node span { color: $text-secondary; font-size: 11px; }
.edge-list { display: flex; flex-wrap: wrap; gap: 7px; color: $text-secondary; font-family: $font-code; font-size: 11px; }
.edge-list span { max-width: 100%; overflow: hidden; padding: 4px 7px; border: 1px solid $border-light; text-overflow: ellipsis; white-space: nowrap; }

.subsection-heading { padding-top: 5px; border-bottom: 1px solid $border-light; padding-bottom: 8px; }
.subsection-heading h4 { margin: 0; font-size: 14px; }
.subsection-heading span { color: $text-secondary; font-size: 12px; }
.error-copy { color: $error; }

.draft-row > div:first-child,
.review-row > div:first-child { display: grid; min-width: 0; gap: 4px; }
.draft-actions { justify-content: flex-end; }

.chat-view { display: grid; min-height: 650px; grid-template-columns: minmax(190px, .65fr) minmax(0, 2fr); padding: 0; gap: 0; }
.chat-sessions { overflow: auto; border-right: 1px solid $border-light; padding: 13px; background: $bg-secondary; }
.chat-session { display: grid; width: 100%; gap: 4px; border: 0; border-bottom: 1px solid $border-light; padding: 10px 3px; background: transparent; color: $text-primary; cursor: pointer; text-align: left; }
.chat-session:hover,
.chat-session.is-active { color: $accent-primary; }
.chat-session span { color: $text-muted; font-size: 11px; }
.chat-thread { display: flex; min-width: 0; flex-direction: column; }
.chat-policy { padding: 10px 14px; border-bottom: 1px solid $border-light; color: $text-secondary; font-size: 12px; }
.message-list { display: grid; flex: 1; gap: 12px; overflow: auto; padding: 16px; }
.wiki-message { display: grid; gap: 5px; }
.wiki-message > span { color: $text-muted; font-size: 11px; }
.wiki-message > p { margin: 0; white-space: pre-wrap; }
.wiki-message__body { max-width: 900px; border-left: 2px solid $border-color; padding-left: 12px; }
.wiki-message--user { justify-items: end; }
.wiki-message--user > p { max-width: min(80%, 620px); padding: 9px 11px; background: $bg-secondary; }
.chat-composer { display: grid; grid-template-columns: 155px auto minmax(0, 1fr) auto; align-items: end; border-top: 1px solid $border-light; padding: 12px; }
.chat-composer :deep(.n-checkbox) { font-size: 11px; }

.research-result { border: 1px solid $border-light; }
.research-result .wiki-preview { max-height: 500px; }
.reference-list { display: flex; flex-wrap: wrap; gap: 7px; padding: 0 18px 14px; }
.reference-list button { border: 1px solid $border-light; border-radius: $radius-sm; padding: 4px 7px; background: $bg-secondary; color: $accent-primary; cursor: pointer; font-size: 11px; }
.stage-generated { border-top: 1px solid $border-light; padding: 12px; }
.candidate-section { display: grid; gap: 14px; margin-top: 8px; }

.lint-row { display: flex; align-items: center; justify-content: space-between; gap: 14px; }
.lint-row > div { display: grid; min-width: 0; gap: 4px; }
.lint-row code { overflow-wrap: anywhere; color: $text-muted; font-size: 11px; }
.lint-row.is-warning strong { color: $warning; }
.lint-row.is-error strong { color: $error; }

.skill-row { display: grid; grid-template-columns: auto minmax(0, 1fr); align-items: start; gap: 10px; cursor: pointer; }
.skill-row > div { display: grid; gap: 4px; }

.maintenance-band { margin-top: 10px; }
.modal-copy { margin: 12px 0 0; color: $text-secondary; font-size: 12px; line-height: 1.55; }
.history-list { display: grid; max-height: 68vh; overflow: auto; }
.history-list article { padding: 12px 0; border-bottom: 1px solid $border-light; }
.history-list header { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.history-list header span { margin-right: auto; color: $text-secondary; font-size: 12px; }
.history-list pre,
.draft-change pre { max-height: 260px; overflow: auto; margin: 10px 0 0; padding: 10px; background: $bg-secondary; color: $text-secondary; font-family: $font-code; font-size: 11px; line-height: 1.55; white-space: pre-wrap; overflow-wrap: anywhere; }
.draft-detail-title { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding-bottom: 12px; border-bottom: 1px solid $border-light; }
.draft-change { padding: 14px 0; border-bottom: 1px solid $border-light; }
.draft-change header { display: grid; gap: 4px; }
.draft-change code { color: $text-muted; font-size: 11px; }
.draft-change-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }

.visually-hidden { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; }

@media (max-width: 1100px) {
  .overview-grid,
  .settings-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .wiki-view { grid-template-columns: minmax(180px, .7fr) minmax(0, 2fr); }
  .wiki-pane--links { grid-column: 1 / -1; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; border-top: 1px solid $border-light; border-right: 0; }
  .wiki-pane--links .pane-heading { grid-column: 1 / -1; margin-bottom: 0; }
  .link-group { padding: 0; border: 0; }
}

@media (max-width: $breakpoint-mobile) {
  .knowledge-studio { padding: 12px; }
  .knowledge-studio__header { align-items: stretch; }
  .knowledge-studio__header-actions { display: grid; grid-template-columns: minmax(0, 1fr) auto; }
  .project-select { width: auto; }
  .knowledge-studio__header-actions > :last-child { grid-column: 1 / -1; }
  .knowledge-studio__layout { grid-template-columns: minmax(0, 1fr); overflow: visible; }
  .knowledge-studio__nav { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); border-right: 0; border-bottom: 1px solid $border-light; }
  .knowledge-nav-item { justify-content: center; padding: 0 4px; font-size: 12px; }
  .knowledge-studio__main { overflow: visible; }
  .knowledge-view { padding: 14px; }
  .overview-grid,
  .settings-grid { grid-template-columns: minmax(0, 1fr); }
  .wiki-view,
  .source-layout,
  .chat-view { display: flex; min-height: 0; flex-direction: column; }
  .wiki-pane,
  .chat-sessions { min-height: 170px; border-right: 0; border-bottom: 1px solid $border-light; }
  .wiki-pane--content { min-height: 420px; }
  .wiki-pane--links { display: block; }
  .link-group { padding: 10px 0; border-bottom: 1px solid $border-light; }
  .query-row,
  .research-composer,
  .stage-generated { align-items: stretch; flex-direction: column; }
  .query-row :deep(.n-button),
  .research-composer :deep(.n-button),
  .stage-generated :deep(.n-button) { width: 100%; }
  .result-row,
  .draft-row,
  .review-row,
  .trusted-source-row,
  .maintenance-band { align-items: flex-start; flex-direction: column; }
  .draft-actions { justify-content: flex-start; }
  .chat-composer { grid-template-columns: minmax(0, 1fr); }
  .draft-change-grid { grid-template-columns: minmax(0, 1fr); }
}
</style>
