/**
 * 论文标签分类（固定中文大类）
 *
 * 设计约定（与 llm-wiki 的 domain_tags 体系保持一致）：
 * - 知识库论文的标签来自 LLM Wiki 的 `domain_tags`（入库时按固定中文体系归纳，
 *   缺失时由 llm-wiki 按 wiki 页面正文关键词推断），本模块只做“白名单归一化”，
 *   绝不凭空造新标签。
 * - 推荐论文（外部候选）的标签由服务端按 LLM-Wiki 同款关键词规则
 *   （inferDomainTags）从标题/摘要提取，只输出固定中文域标签；
 *   英文会议名永远不作为标签展示。
 * - 无论论文数量多少，标签集合都封闭在这两个固定中文体系内，不会“一篇论文
 *   就多一个标签”。
 */

/** LLM Wiki 的固定中文领域标签体系（与 ingest 提示词 / Rust 推断规则一致）。 */
export const WIKI_DOMAIN_TAGS = [
  '数据采集',
  '数据存储',
  '数据计算',
  '数据传输',
  '数据治理',
  '数据质量',
  '数据安全',
  '数据智能',
] as const

export type WikiDomainTag = (typeof WIKI_DOMAIN_TAGS)[number]

/** 推断不出任何领域标签时的兜底中文标签（与 llm-wiki 一致）。 */
export const WIKI_FALLBACK_TAG = '数据技术'

/**
 * 关键词规则：与 LLM-Wiki（src-tauri/api_server.rs infer_data_domain_tags）完全一致。
 * 标签集合固定，只输出中文，不随论文数量增长。
 */
export const DOMAIN_TAG_RULES: Array<[string, string[]]> = [
  ['数据采集', ['采集', 'ingestion', '采样', 'sensor', '埋点', 'cdc']],
  ['数据存储', ['存储', 'database', 'storage', 'lakehouse', 'warehouse', '数据库', '数据湖']],
  ['数据计算', ['计算', 'compute', 'spark', 'flink', '查询', 'query', '引擎']],
  ['数据治理', ['治理', 'governance', 'metadata', '元数据', '血缘', 'catalog']],
  ['数据质量', ['质量', 'quality', '清洗', 'validation', '异常检测']],
  ['数据安全', ['安全', 'security', 'privacy', '隐私', '脱敏', '权限']],
  ['数据传输', ['传输', 'stream', '流式', '消息队列', 'kafka', '同步']],
  ['数据智能', ['机器学习', 'machine learning', 'llm', 'ai', '智能', 'rag', 'agent']],
]

/** 与 LLM-Wiki 同款的关键词提取，最多 3 个中文标签。 */
export function inferDomainTags(text: string): string[] {
  const lower = String(text || '').toLowerCase()
  const tags = DOMAIN_TAG_RULES
    .filter(([, words]) => words.some((word) => lower.includes(word)))
    .map(([label]) => label)
    .slice(0, 3)
  return tags.length > 0 ? tags : [WIKI_FALLBACK_TAG]
}

/** 固定中文域标签配色（不随标签哈希，避免“随机分类做做样子”的观感）。 */
const DOMAIN_TAG_COLORS: Record<string, { bg: string; fg: string }> = {
  数据采集: { bg: '#E8F5E9', fg: '#1B5E20' },
  数据存储: { bg: '#E3F2FD', fg: '#0D47A1' },
  数据计算: { bg: '#FFF3E0', fg: '#E65100' },
  数据治理: { bg: '#F3E5F5', fg: '#6A1B9A' },
  数据质量: { bg: '#FFF8E1', fg: '#F57F17' },
  数据安全: { bg: '#FCE4EC', fg: '#880E4F' },
  数据传输: { bg: '#E0F7FA', fg: '#006064' },
  数据智能: { bg: '#E8EAF6', fg: '#283593' },
  数据技术: { bg: '#E8EFF4', fg: '#003B5C' },
}

export function domainTagColor(tag: string): { bg: string; fg: string } {
  return DOMAIN_TAG_COLORS[tag] ?? DOMAIN_TAG_COLORS[WIKI_FALLBACK_TAG]
}

/**
 * 取论文的中文标签（推荐论文用服务端提取的 tags；KB 论文用白名单归一化后的 tags）。
 * 无有效标签时用关键词规则从标题/摘要补全，仍无则回退「数据技术」。
 */
export function paperCategory(tags: string[] | undefined | null, fallbackText = ''): string {
  const valid = (WIKI_DOMAIN_TAGS as readonly string[])
  if (Array.isArray(tags) && tags.some((t) => typeof t === 'string' && valid.includes(t.trim()))) {
    return normalizeWikiTags(tags)[0]
  }
  const inferred = inferDomainTags(fallbackText)
  return inferred[0] || WIKI_FALLBACK_TAG
}

/** 推荐论文按会议/期刊名映射到的中文大类（固定、封闭）。 */
export const VENUE_CATEGORY_LABELS = {
  ml: '机器学习',
  cv: '计算机视觉',
  db: '数据库与数据挖掘',
  de: '数据工程',
  arch: '体系结构与硬件',
  sys: '系统与网络',
  sec: '安全与隐私',
  nlp: '自然语言处理',
  default: '顶会论文',
} as const

export type VenueCategoryKey = keyof typeof VENUE_CATEGORY_LABELS

export const VENUE_CATEGORY_PALETTE: Record<VenueCategoryKey, { bg: string; fg: string }> = {
  ml: { bg: '#F3E5F5', fg: '#6A1B9A' },
  cv: { bg: '#E0F7FA', fg: '#006064' },
  db: { bg: '#FFF8E1', fg: '#F57F17' },
  de: { bg: '#E8F5E9', fg: '#1B5E20' },
  arch: { bg: '#FFF3E0', fg: '#E65100' },
  sys: { bg: '#E3F2FD', fg: '#0D47A1' },
  sec: { bg: '#FCE4EC', fg: '#880E4F' },
  nlp: { bg: '#E8EAF6', fg: '#283593' },
  default: { bg: '#E8EFF4', fg: '#003B5C' },
}

const VENUE_RULES: Array<{ key: VenueCategoryKey; pattern: RegExp }> = [
  { key: 'ml', pattern: /(neurips|nips|icml|iclr|aaai|ijcai|uai|aistats|colt|jmlr|journal of machine learning research)/i },
  { key: 'cv', pattern: /(cvpr|iccv|eccv|wacv|bmvc|3dv|computer vision)/i },
  { key: 'nlp', pattern: /(acl |emnlp|naacl|coling|tacl|computational linguistics)/i },
  { key: 'db', pattern: /(sigmod|vldb|icde|edbt|pods|cidr|icdt|dasfaa|ssdbm|kdd|www|tkde|tods|data mining and knowledge discovery|information systems)/i },
  { key: 'de', pattern: /(data lake|data warehouse|lakehouse|big data|data engineering|data & knowledge|data and knowledge|data intelligence|stream processing|data platform)/i },
  { key: 'arch', pattern: /(isca|micro|hpca|asplos|dac|iccad|fpga|fpl|fpt|fccm|date|case|iscas|nocs|pact|cgo|esweek|rtas|rtss|ispass|iiswc|asap|codes|isss|samos|supercomputing|hotchips|architecture)/i },
  { key: 'sec', pattern: /(usenix security|ccs|oakland|ndss|acsac|raid|security and privacy|cryptology)/i },
  { key: 'sys', pattern: /(osdi|sosp|nsdi|atc|eurosys|fast|socc|middleware|sigcomm|mobicom|infocom|conext|imc|operating systems|networking)/i },
]

/** 会议/期刊名 → 中文大类（未命中回退「顶会论文」）。 */
export function categoryKeyForVenue(venue: string | null | undefined): VenueCategoryKey {
  const text = (venue || '').trim()
  if (!text) return 'default'
  for (const rule of VENUE_RULES) {
    if (rule.pattern.test(text)) return rule.key
  }
  return 'default'
}

export function chineseCategoryForVenue(venue: string | null | undefined): string {
  return VENUE_CATEGORY_LABELS[categoryKeyForVenue(venue)]
}

export function categoryColorForVenue(venue: string | null | undefined): { bg: string; fg: string } {
  return VENUE_CATEGORY_PALETTE[categoryKeyForVenue(venue)]
}

/** 是否包含中文字符（用于过滤英文标签）。 */
export function isChineseText(text: string): boolean {
  return /[\u4e00-\u9fff]/.test(text)
}

/**
 * 知识库论文标签白名单归一化：
 * 只保留 LLM Wiki 固定中文体系内的标签，丢弃英文/生造标签；
 * 全被过滤时回退到「数据技术」。
 */
export function normalizeWikiTags(tags: unknown[] | undefined | null, max = 3): string[] {
  if (!Array.isArray(tags)) return [WIKI_FALLBACK_TAG]
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of tags) {
    if (typeof raw !== 'string') continue
    const tag = raw.trim()
    if (!tag || seen.has(tag)) continue
    // 只认固定中文体系；带中文但不在体系内的标签（例如 LLM 生造的“评测方法”）也丢弃。
    if (!(WIKI_DOMAIN_TAGS as readonly string[]).includes(tag)) continue
    seen.add(tag)
    out.push(tag)
    if (out.length >= max) break
  }
  return out.length > 0 ? out : [WIKI_FALLBACK_TAG]
}

/** 稳定的标签配色（按标签名哈希取色，全部用于中文标签）。 */
export function colorForLabel(label: string): { bg: string; fg: string } {
  const key = label.trim()
  if (!key) return { bg: '#E8EFF4', fg: '#003B5C' }
  let hash = 0
  for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) >>> 0
  const palette = [
    { bg: '#E8EFF4', fg: '#003B5C' },
    { bg: '#E3F2FD', fg: '#0D47A1' },
    { bg: '#F3E5F5', fg: '#6A1B9A' },
    { bg: '#FFF3E0', fg: '#E65100' },
    { bg: '#E0F7FA', fg: '#006064' },
    { bg: '#FFF8E1', fg: '#F57F17' },
    { bg: '#E8F5E9', fg: '#1B5E20' },
    { bg: '#FCE4EC', fg: '#880E4F' },
  ]
  return palette[hash % palette.length]
}
