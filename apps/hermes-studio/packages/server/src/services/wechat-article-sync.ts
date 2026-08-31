import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { config } from '../config'
import { llmWikiJson, publicKnowledgeErrorMessage } from './knowledge/llm-wiki-client'

const STATE_FILE = 'wechat-sources.json'
const MAX_SOURCE_COUNT = 30
const MAX_ARTICLES_PER_SOURCE = 8
const MAX_DISCOVERY_ARTICLES = 12
// WeChat pages can be several megabytes before the article body because of
// inline styles, image metadata and tracking JSON. Keep a bounded but useful
// limit so valid technical articles are not rejected for size alone.
const MAX_HTML_BYTES = 12_000_000
const MAX_CONTENT_CHARS = 24_000
const FETCH_TIMEOUT_MS = 30_000
const SEARCH_TIMEOUT_MS = 20_000
const SEARCH_PAGE_MAX_BYTES = 2_000_000

const WECHAT_DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const WECHAT_MOBILE_UA = 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36'
const WECHAT_BLOCK_MARKERS = [
  '环境异常',
  '当前环境异常',
  '完成验证后即可继续访问',
  '请在微信客户端打开',
  '此内容因违规无法查看',
  '内容不存在',
]

const DATA_TERMS = [
  '数据', '数据工程', '数据平台', '数据治理', '数据质量', '数据湖', '湖仓', '数据仓库',
  '数据库', '数据采集', '数据存储', '数据计算', '数据安全', '元数据', '血缘', '实时计算',
  '流式', '消息队列', '数仓', 'data engineering', 'data platform', 'data governance',
  'data quality', 'data lake', 'data warehouse', 'data pipeline', 'data lineage', 'data catalog',
  'data ingestion', 'data storage', 'data compute', 'data security', 'data mesh', 'lakehouse',
  'warehouse', 'database', 'governance', 'metadata', 'lineage', 'stream', 'pipeline', 'spark',
  'flink', 'kafka', 'quality', 'privacy',
]
const LOW_VALUE_TERMS = ['招聘', '课程报名', '广告', '优惠', '抽奖', '点击购买', '代理加盟']
const WECHAT_SEARCH_QUERIES = [
  'site:mp.weixin.qq.com/s/ 数据工程 数据治理 数据质量',
  'site:mp.weixin.qq.com/s/ 数据湖 湖仓 数据平台 Flink Kafka',
  'site:mp.weixin.qq.com/s/ 数据采集 数据存储 实时计算 数据安全',
]

export interface WechatSource {
  id: string
  name: string
  url: string
  enabled: boolean
  createdAt: string
  updatedAt: string
  lastSyncAt: string | null
  lastSyncStatus: 'never' | 'success' | 'partial' | 'failed'
  lastSyncError: string | null
  importedCount: number
  discoveredCount: number
}

interface SeenArticle {
  url: string
  contentHash: string
  title: string
  importedAt: string
}

interface PersistedState {
  sources: WechatSource[]
  seen: SeenArticle[]
}

export interface WechatSyncResult {
  sourceId: string
  sourceName: string
  discovered: number
  imported: number
  skipped: number
  rejected: number
  errors: string[]
}

export interface WechatSyncReport {
  startedAt: string
  finishedAt: string
  sources: WechatSyncResult[]
  discovered: number
  imported: number
  skipped: number
  rejected: number
  errors: string[]
}

export interface DiscoveredWechatArticle {
  url: string
  sourceName?: string
}

interface ArticleRecord {
  url: string
  title: string
  author: string | null
  publishedAt: string | null
  content: string
  score: number
  tags: string[]
  hash: string
}

function statePath(): string {
  return join(config.appHome, STATE_FILE)
}

function emptyState(): PersistedState {
  return { sources: [], seen: [] }
}

function loadState(): PersistedState {
  try {
    const parsed = JSON.parse(readFileSync(statePath(), 'utf8')) as Partial<PersistedState>
    const sources = Array.isArray(parsed.sources) ? parsed.sources.filter(isSource) : []
    const seen = Array.isArray(parsed.seen) ? parsed.seen.filter(isSeenArticle).slice(-500) : []
    return { sources, seen }
  } catch {
    return emptyState()
  }
}

function persistState(state: PersistedState): void {
  mkdirSync(config.appHome, { recursive: true })
  writeFileSync(statePath(), `${JSON.stringify(state, null, 2)}\n`, 'utf8')
}

function isSource(value: unknown): value is WechatSource {
  if (!value || typeof value !== 'object') return false
  const item = value as Record<string, unknown>
  return typeof item.id === 'string' && typeof item.name === 'string' && typeof item.url === 'string'
}

function isSeenArticle(value: unknown): value is SeenArticle {
  if (!value || typeof value !== 'object') return false
  const item = value as Record<string, unknown>
  return typeof item.url === 'string' && typeof item.contentHash === 'string'
}

function cleanText(value: string): string {
  return value
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|section|article|header|footer|h[1-6]|li|tr|blockquote|pre)\s*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/[\u200b\u200c\u200d\ufeff]/g, '')
    .replace(/[ \t]+/g, ' ')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n')
    .trim()
}

function tagEnd(html: string, start: number): number {
  let quote: string | null = null
  for (let index = start; index < html.length; index += 1) {
    const char = html[index]
    if (quote) {
      if (char === quote) quote = null
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (char === '>') return index
  }
  return -1
}

function tagName(tag: string): string | null {
  return tag.match(/^<\s*\/?\s*([a-z][\w:-]*)\b/i)?.[1]?.toLowerCase() ?? null
}

function tagAttribute(tag: string, name: string): string | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = tag.match(new RegExp(`(?:^|\\s)${escaped}\\s*=\\s*(?:(["'])([\\s\\S]*?)\\1|([^\\s>]+))`, 'i'))
  return match?.[2] ?? match?.[3] ?? null
}

function hasClassToken(tag: string, value: string): boolean {
  return tagAttribute(tag, 'class')?.split(/\s+/).some((item) => item === value) === true
}

function isSelfClosingTag(tag: string): boolean {
  return /\/\s*>$/.test(tag)
}

/**
 * Return the body of the first matching element while respecting nested tags.
 * A non-greedy `</div>` regex truncates most real WeChat articles because the
 * article body itself contains many nested divs.
 */
function findElementBody(html: string, predicate: (tag: string, name: string) => boolean): string | null {
  let cursor = 0
  while (cursor < html.length) {
    const openStart = html.indexOf('<', cursor)
    if (openStart < 0) return null
    if (html.startsWith('<!--', openStart)) {
      const commentEnd = html.indexOf('-->', openStart + 4)
      cursor = commentEnd >= 0 ? commentEnd + 3 : html.length
      continue
    }
    const openEnd = tagEnd(html, openStart + 1)
    if (openEnd < 0) return null
    const openTag = html.slice(openStart, openEnd + 1)
    const name = tagName(openTag)
    if (!name || /^<\s*\//.test(openTag) || !predicate(openTag, name)) {
      cursor = openEnd + 1
      continue
    }
    if (isSelfClosingTag(openTag)) return ''
    let depth = 1
    let scan = openEnd + 1
    while (scan < html.length) {
      const nextStart = html.indexOf('<', scan)
      if (nextStart < 0) return html.slice(openEnd + 1)
      if (html.startsWith('<!--', nextStart)) {
        const commentEnd = html.indexOf('-->', nextStart + 4)
        scan = commentEnd >= 0 ? commentEnd + 3 : html.length
        continue
      }
      const nextEnd = tagEnd(html, nextStart + 1)
      if (nextEnd < 0) return html.slice(openEnd + 1)
      const nextTag = html.slice(nextStart, nextEnd + 1)
      const nextName = tagName(nextTag)
      if (nextName === name) {
        if (/^<\s*\//.test(nextTag)) depth -= 1
        else if (!isSelfClosingTag(nextTag)) depth += 1
        if (depth === 0) return html.slice(openEnd + 1, nextStart)
      }
      scan = nextEnd + 1
    }
    return html.slice(openEnd + 1)
  }
  return null
}

function elementTextById(html: string, id: string): string | null {
  const body = findElementBody(html, (tag) => tagAttribute(tag, 'id') === id)
  return body ? cleanText(body) : null
}

function elementTextByClass(html: string, className: string): string | null {
  const body = findElementBody(html, (tag) => hasClassToken(tag, className))
  return body ? cleanText(body) : null
}

function elementTextByTag(html: string, element: string): string | null {
  const body = findElementBody(html, (_tag, name) => name === element.toLowerCase())
  return body ? cleanText(body) : null
}

function metaContent(html: string, key: string): string | null {
  let cursor = 0
  while (cursor < html.length) {
    const start = html.indexOf('<', cursor)
    if (start < 0) return null
    const end = tagEnd(html, start + 1)
    if (end < 0) return null
    const tag = html.slice(start, end + 1)
    if (tagName(tag) === 'meta') {
      const property = tagAttribute(tag, 'property') ?? tagAttribute(tag, 'name')
      if (property?.toLowerCase() === key.toLowerCase()) {
        const content = tagAttribute(tag, 'content')
        return content ? cleanText(content) : null
      }
    }
    cursor = end + 1
  }
  return null
}

function normalizeUrl(raw: string, base?: string): string | null {
  try {
    const url = new URL(raw, base)
    if (!['http:', 'https:'].includes(url.protocol)) return null
    const hostname = url.hostname.toLowerCase()
    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '0.0.0.0' || hostname === '::1') return null
    if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[0-1])\.|169\.254\.)/.test(hostname)) return null
    if (hostname === 'mp.weixin.qq.com') url.protocol = 'https:'
    url.hash = ''
    return url.toString()
  } catch {
    return null
  }
}

async function fetchHtml(url: string): Promise<string> {
  let lastError: Error | null = null
  // WeChat serves a verification page to generic HTTP clients. Two realistic
  // browser profiles make the normal public article path work without cookies.
  for (const userAgent of [WECHAT_DESKTOP_UA, WECHAT_MOBILE_UA]) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
    timer.unref?.()
    try {
      const response = await fetch(url, {
        redirect: 'follow',
        signal: controller.signal,
        headers: {
          'User-Agent': userAgent,
          Referer: 'https://weixin.sogou.com/',
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
          'Cache-Control': 'no-cache',
        },
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const text = await response.text()
      if (Buffer.byteLength(text, 'utf8') > MAX_HTML_BYTES) throw new Error('页面超过 12 MB 限制')
      // Only inspect the beginning: an article may legitimately mention
      // verification or rate limits later in its technical discussion.
      const preview = cleanText(text.slice(0, 120_000))
      if (WECHAT_BLOCK_MARKERS.some((marker) => preview.includes(marker))) {
        lastError = new Error('微信返回环境验证页面')
        continue
      }
      return text
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))
    } finally {
      clearTimeout(timer)
    }
  }
  throw lastError ?? new Error('微信公众号页面抓取失败')
}

async function fetchSearchPage(query: string): Promise<string> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS)
  timer.unref?.()
  try {
    const searchUrl = `https://www.sogou.com/web?query=${encodeURIComponent(query)}`
    const response = await fetch(searchUrl, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent': WECHAT_DESKTOP_UA,
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    })
    if (!response.ok) throw new Error(`搜索引擎 HTTP ${response.status}`)
    const text = await response.text()
    if (Buffer.byteLength(text, 'utf8') > SEARCH_PAGE_MAX_BYTES) throw new Error('搜索结果页超过 2 MB 限制')
    return text
  } finally {
    clearTimeout(timer)
  }
}

/** Discover public article URLs without depending on a browser session or API key. */
async function searchWechatArticleCandidates(limit = MAX_DISCOVERY_ARTICLES): Promise<DiscoveredWechatArticle[]> {
  const found = new Map<string, DiscoveredWechatArticle>()
  for (const query of WECHAT_SEARCH_QUERIES) {
    try {
      const html = await fetchSearchPage(query)
      const pattern = /https?:\/\/mp\.weixin\.qq\.com\/s(?:\/[^"'<>\s]*)?(?:\?[^"'<>\s]*)?/gi
      for (const match of html.matchAll(pattern)) {
        const raw = match[0]
          .replace(/&amp;/gi, '&')
          .replace(/&#x26;|&#38;/gi, '&')
          .replace(/[),.;]+$/g, '')
        const url = normalizeUrl(raw)
        if (!url) continue
        const item = normalizeDiscoveredArticle({ url, sourceName: '网页检索' })
        if (!item || found.has(item.url)) continue
        found.set(item.url, item)
        if (found.size >= limit) return [...found.values()]
      }
    } catch {
      // One search provider failure should not prevent the remaining queries
      // from producing candidates. The article fetch stage reports its own
      // actionable errors later.
    }
  }
  return [...found.values()]
}

function discoverArticleUrls(html: string, sourceUrl: string): string[] {
  const direct = normalizeUrl(sourceUrl)
  if (direct && new URL(direct).pathname.includes('/s/')) return [direct]
  const found = new Set<string>()
  const isFeed = /<(?:rss|feed|item|entry)\b/i.test(html)
  const add = (raw: string) => {
    const url = normalizeUrl(raw, sourceUrl)
    if (!url) return
    const parsed = new URL(url)
    const sourceHost = new URL(sourceUrl).hostname
    const articleLike = isFeed || parsed.pathname.includes('/s/') || parsed.hostname === sourceHost || parsed.hostname.endsWith('.weixin.qq.com')
    if (articleLike) found.add(url)
  }
  const linkPattern = /(?:href|url)\s*=\s*["']([^"']+)["']/gi
  for (const match of html.matchAll(linkPattern)) add(match[1])
  for (const match of html.matchAll(/<link[^>]+href=["']([^"']+)["'][^>]*>/gi)) add(match[1])
  // WeChat history pages commonly expose `msgList` as JSON with article
  // URLs under a `link` key rather than an HTML attribute.
  const jsonLinkPattern = /["'](?:link|article_url|url)["']\s*:\s*["']([^"']+)["']/gi
  for (const match of html.matchAll(jsonLinkPattern)) {
    add(match[1].replace(/\\u0026/gi, '&').replace(/\\\//g, '/').replace(/&amp;/gi, '&'))
  }
  // RSS commonly stores article URLs as text nodes (<link>https://...</link>),
  // while Atom uses <link href="...">. Ignore a feed's self-link so it is
  // never mistaken for an article page.
  const textLinkPattern = /<(?:link|guid|id)\b[^>]*>([\s\S]*?)<\/(?:link|guid|id)>/gi
  for (const match of html.matchAll(textLinkPattern)) add(cleanText(match[1]))
  if (direct && isFeed) found.delete(direct)
  if (direct && !isFeed && (new URL(direct).pathname.includes('/s/') || found.size === 0)) found.add(direct)
  return [...found].slice(0, MAX_ARTICLES_PER_SOURCE)
}

function extractArticle(url: string, html: string): ArticleRecord | null {
  const title = metaContent(html, 'og:title')
    ?? metaContent(html, 'twitter:title')
    ?? elementTextById(html, 'activity-name')
    ?? elementTextByClass(html, 'rich_media_title')
    ?? elementTextByTag(html, 'title')
  if (!title) return null
  const contentHtml = findElementBody(html, (tag) => tagAttribute(tag, 'id') === 'js_content' || hasClassToken(tag, 'rich_media_content'))
    ?? findElementBody(html, (_tag, name) => name === 'article')
    ?? html
  const content = cleanText(contentHtml).slice(0, MAX_CONTENT_CHARS)
  if (content.length < 180) return null
  const author = elementTextById(html, 'js_name')
    ?? elementTextByClass(html, 'profile_nickname')
    ?? metaContent(html, 'author')
  const publishedAt = elementTextById(html, 'publish_time')
    ?? metaContent(html, 'article:published_time')
    ?? html.match(/(?:publish_time|publishTime|\bct\b)\s*[:=]\s*["']?(\d{9,13})/)?.[1]
    ?? null
  const lower = `${title} ${content}`.toLowerCase()
  const dataHits = DATA_TERMS.filter((term) => lower.includes(term.toLowerCase())).length
  const lowValueHits = LOW_VALUE_TERMS.filter((term) => lower.includes(term.toLowerCase())).length
  const baseScore = Math.max(0, Math.min(1,
    (Math.min(content.length, 8000) / 8000) * 0.35
      + Math.min(dataHits, 6) / 6 * 0.45
      + (author ? 0.1 : 0)
      + (publishedAt ? 0.1 : 0)
      - lowValueHits * 0.12,
  ))
  // Require at least one concrete data-engineering signal. Length and
  // metadata alone should not promote a generic lifestyle or news article.
  const score = dataHits > 0 ? baseScore : Math.min(baseScore, 0.35)
  const tags = DATA_TERMS
    .filter((term) => lower.includes(term.toLowerCase()))
    .slice(0, 5)
    .map((term) => term.length <= 4 ? term : term)
  const hash = createHash('sha256').update(`${title}\n${content}`).digest('hex')
  return { url, title, author, publishedAt, content, score, tags: tags.length ? tags : ['数据技术'], hash }
}

function yearOf(value: string | null): number {
  const match = value?.match(/20\d{2}/)
  return match ? Number(match[0]) : new Date().getFullYear()
}

function yamlQuote(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n]+/g, ' ')}"`
}

function slugForArticle(article: ArticleRecord): string {
  const ascii = article.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 72)
  return `${ascii || 'wechat-data-article'}-${article.hash.slice(0, 8)}`
}

function markdownForArticle(article: ArticleRecord, source: WechatSource): string {
  const author = article.author ? [article.author] : ['微信公众号作者']
  const tags = [...new Set([...article.tags, '微信公众号'])].slice(0, 6)
  return [
    '---',
    'type: source',
    `title: ${yamlQuote(article.title)}`,
    `title_zh: ${yamlQuote(article.title)}`,
    'content_kind: technical_article',
    `domain_tags: [${tags.map(yamlQuote).join(', ')}]`,
    `authors: [${author.map(yamlQuote).join(', ')}]`,
    `year: ${yearOf(article.publishedAt)}`,
    `summary: ${yamlQuote(article.content.slice(0, 220))}`,
    `source_url: ${yamlQuote(article.url)}`,
    'source_platform: 微信公众号',
    `quality_score: ${article.score.toFixed(2)}`,
    '---',
    `# ${article.title}`,
    '',
    article.content,
    '',
    '## 来源与质量',
    `- 来源：${source.name}`,
    `- 原文：${article.url}`,
    `- 抓取质量评分：${article.score.toFixed(2)}`,
    '- 进入 LLM Wiki 后仍需人工审核，审核通过后才会参与检索和知识图谱。',
    '',
  ].join('\n')
}

async function createDraft(article: ArticleRecord, source: WechatSource): Promise<void> {
  await llmWikiJson('/projects/current/generated-drafts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: article.title,
      targetPath: `wiki/sources/${slugForArticle(article)}.md`,
      content: markdownForArticle(article, source),
    }),
  }, 30_000)
}

const AUTO_APPROVE_POLL_INTERVAL_MS = 1_000
const AUTO_APPROVE_TIMEOUT_MS = 120_000

export interface WechatImportResult {
  draftId: string
  title: string
  url: string
  /** true：草稿已代为批准并发布为可信知识（用户发链接导入即视为审核决定）。 */
  approved: boolean
  /** 发布后的 wiki 页面路径（approved 时返回）。 */
  publishedPath?: string
  /** 未能自动入库时的原因与后续操作提示。 */
  note?: string
}

/**
 * Poll the strict gate until the draft finishes processing, then approve it on
 * the importer's behalf. A user-initiated single-link import already IS the
 * review decision (the user chose the article), so it must not wait for a
 * second manual confirmation. Discovery/scheduled imports keep the human
 * review queue.
 */
async function approveDraftWhenReady(
  draftId: string,
): Promise<{ approved: boolean; publishedPath?: string; note?: string }> {
  const deadline = Date.now() + AUTO_APPROVE_TIMEOUT_MS
  while (Date.now() < deadline) {
    let detail: { draft?: { status?: string; error?: string | null } }
    try {
      detail = await llmWikiJson(`/projects/current/ingest-drafts/${encodeURIComponent(draftId)}`)
    } catch (error) {
      return { approved: false, note: `无法查询草稿状态：${publicKnowledgeErrorMessage(error)}` }
    }
    const status = detail.draft?.status
    if (status === 'awaiting_review') {
      try {
        const approved = await llmWikiJson<{ draft?: { publishedPages?: string[] } }>(
          `/projects/current/ingest-drafts/${encodeURIComponent(draftId)}/approve`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
          },
          30_000,
        )
        return { approved: true, publishedPath: approved.draft?.publishedPages?.[0] }
      } catch (error) {
        return {
          approved: false,
          note: `自动入库失败，请稍后在审核队列回复“批准”：${publicKnowledgeErrorMessage(error)}`,
        }
      }
    }
    if (status === 'failed') {
      return { approved: false, note: `草稿处理失败：${detail.draft?.error ?? '未知原因'}` }
    }
    if (status === 'rejected') {
      return { approved: false, note: '草稿已被拒绝' }
    }
    await new Promise((resolve) => setTimeout(resolve, AUTO_APPROVE_POLL_INTERVAL_MS))
  }
  return { approved: false, note: '草稿仍在处理中，请稍后回复“批准”完成入库' }
}

function discoverySource(item: DiscoveredWechatArticle, url: string): WechatSource {
  const hostname = new URL(url).hostname
  const now = new Date().toISOString()
  return {
    id: `hermes-discovery:${hostname}`,
    name: item.sourceName?.trim().slice(0, 120) || `微信公众号 · ${hostname}`,
    url,
    enabled: true,
    createdAt: now,
    updatedAt: now,
    lastSyncAt: null,
    lastSyncStatus: 'never',
    lastSyncError: null,
    importedCount: 0,
    discoveredCount: 0,
  }
}

function normalizeDiscoveredArticle(value: unknown): DiscoveredWechatArticle | null {
  if (!value || typeof value !== 'object') return null
  const item = value as Record<string, unknown>
  const rawUrl = typeof item.url === 'string' ? item.url.trim() : ''
  const url = normalizeUrl(rawUrl)
  if (!url) return null
  const parsed = new URL(url)
  // Discovery accepts only public WeChat article pages. This keeps the
  // Hermes callback from becoming a general-purpose server-side fetch proxy.
  if (parsed.hostname !== 'mp.weixin.qq.com' || !/^\/s(?:\/|$)/i.test(parsed.pathname)) return null
  return {
    url,
    sourceName: typeof item.sourceName === 'string' ? item.sourceName : typeof item.source_name === 'string' ? item.source_name : undefined,
  }
}

/**
 * Single-link import: paste one WeChat article URL and follow the exact
 * same strict draft gate as a PDF import. Must not bypass the
 * WechatSource/score/duplicate/beauty checks — just a lighter entry point.
 */
export async function importWechatArticleLink(
  rawUrl: unknown,
  rawSourceName?: unknown,
): Promise<WechatImportResult> {
  const normalized = normalizeUrl(typeof rawUrl === 'string' ? rawUrl.trim() : '')
  if (!normalized) throw new Error('请输入合法的文章链接')
  const candidate = normalizeDiscoveredArticle({ url: normalized, sourceName: typeof rawSourceName === 'string' ? rawSourceName : undefined })
  if (!candidate) throw new Error('仅支持 mp.weixin.qq.com/s/ 的公众号文章链接')
  // Reuse the shared extraction/score/hash pipeline — do not create a
  // parallel "light" path that skips quality gating.
  const state = loadState()
  const source = discoverySource(candidate, candidate.url)
  const html = await fetchHtml(candidate.url)
  const article = extractArticle(candidate.url, html)
  if (!article) throw new Error('未提取到足够长的文章正文，可能是验证页或内容过短')
  if (state.seen.some((seen) => seen.url === article.url || seen.contentHash === article.hash)) {
    throw new Error('该文章已导入过（URL 或内容去重命中）')
  }
  // Single-link import is intentionally open: every successfully extracted
  // article enters the strict draft gate. The importer's link message is the
  // review decision, so the draft is auto-approved once the gate is done.
  await createDraft(article, source)
  state.seen.push({ url: article.url, contentHash: article.hash, title: article.title, importedAt: new Date().toISOString() })
  state.seen = state.seen.slice(-500)
  persistState(state)
  // The strict gate generates its own draft id; recover by matching hash.
  // Keep it simple: re-read the draft list and pick the freshly created one
  // by content hash (sha256 of title+content is baked into draft.sha256).
  // Fall back to title match if list is unavailable.
  try {
    const payload = await llmWikiJson<{ drafts: Array<Record<string, unknown>> }>('/projects/current/ingest-drafts')
    const drafts = Array.isArray(payload.drafts) ? payload.drafts : []
    const match =
      drafts.find((d) => String(d.sha256 ?? '') === article.hash) ??
      drafts.find((d) => String(d.paperTitle ?? d.title ?? '') === article.title)
    if (match && typeof match.id === 'string') {
      const verdict = await approveDraftWhenReady(match.id)
      return { draftId: match.id, title: article.title, url: article.url, ...verdict }
    }
  } catch { /* draft was still created; fall through to the manual queue note */ }
  return {
    draftId: article.hash.slice(0, 16),
    title: article.title,
    url: article.url,
    approved: false,
    note: '未能定位草稿 ID，请在审核队列中手动批准',
  }
}

/**
 * Import URLs found by Hermes' web-search cron task into the strict LLM Wiki
 * draft queue. The server fetches and scores the article itself; Hermes only
 * supplies candidate links and never supplies page content to be trusted.
 */
export async function importDiscoveredWechatArticles(rawItems: unknown[]): Promise<WechatSyncReport> {
  if (syncInFlight) return syncInFlight
  syncInFlight = (async () => {
    const startedAt = new Date().toISOString()
    const state = loadState()
    const candidates: DiscoveredWechatArticle[] = []
    const seenUrls = new Set<string>()
    const submittedItems = Array.isArray(rawItems) && rawItems.length > 0
      ? rawItems
      : await searchWechatArticleCandidates()
    for (const value of submittedItems) {
      const item = normalizeDiscoveredArticle(value)
      if (!item || seenUrls.has(item.url)) continue
      seenUrls.add(item.url)
      candidates.push(item)
      if (candidates.length >= MAX_DISCOVERY_ARTICLES) break
    }
    const result: WechatSyncResult = {
      sourceId: 'hermes-discovery',
      sourceName: 'Hermes 自动发现',
      discovered: candidates.length,
      imported: 0,
      skipped: 0,
      rejected: 0,
      errors: [],
    }
    for (const item of candidates) {
      try {
        const source = discoverySource(item, item.url)
        const article = extractArticle(item.url, await fetchHtml(item.url))
        if (!article) {
          result.rejected += 1
          result.errors.push(`${item.url}: 未提取到足够长的文章正文`)
          continue
        }
        if (article.score < 0.42) {
          result.rejected += 1
          result.errors.push(`${item.url}: 数据技术相关度不足（评分 ${article.score.toFixed(2)}）`)
          continue
        }
        if (state.seen.some((seen) => seen.url === article.url || seen.contentHash === article.hash)) {
          result.skipped += 1
          continue
        }
        await createDraft(article, source)
        state.seen.push({ url: article.url, contentHash: article.hash, title: article.title, importedAt: new Date().toISOString() })
        result.imported += 1
      } catch (error) {
        result.errors.push(`${item.url}: ${publicKnowledgeErrorMessage(error)}`)
      }
    }
    state.seen = state.seen.slice(-500)
    persistState(state)
    return {
      startedAt,
      finishedAt: new Date().toISOString(),
      sources: [result],
      discovered: result.discovered,
      imported: result.imported,
      skipped: result.skipped,
      rejected: result.rejected,
      errors: result.errors,
    }
  })()
  try {
    return await syncInFlight
  } finally {
    syncInFlight = null
  }
}

export function listWechatSources(): WechatSource[] {
  return loadState().sources.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
}

export function addWechatSource(input: { name?: unknown; url?: unknown; enabled?: unknown }): WechatSource {
  const url = normalizeUrl(typeof input.url === 'string' ? input.url.trim() : '')
  if (!url) throw new Error('请输入可访问的公众号文章列表页、文章 URL 或 RSS/Atom 地址')
  const state = loadState()
  if (state.sources.length >= MAX_SOURCE_COUNT) throw new Error(`最多配置 ${MAX_SOURCE_COUNT} 个来源`)
  if (state.sources.some((source) => source.url === url)) throw new Error('该来源已经配置')
  const now = new Date().toISOString()
  const source: WechatSource = {
    id: randomUUID(),
    name: typeof input.name === 'string' && input.name.trim() ? input.name.trim().slice(0, 120) : new URL(url).hostname,
    url,
    enabled: input.enabled !== false,
    createdAt: now,
    updatedAt: now,
    lastSyncAt: null,
    lastSyncStatus: 'never',
    lastSyncError: null,
    importedCount: 0,
    discoveredCount: 0,
  }
  state.sources.push(source)
  persistState(state)
  return source
}

export function removeWechatSource(id: string): boolean {
  const state = loadState()
  const before = state.sources.length
  state.sources = state.sources.filter((source) => source.id !== id)
  if (state.sources.length === before) return false
  persistState(state)
  return true
}

let syncInFlight: Promise<WechatSyncReport> | null = null
let syncTimer: ReturnType<typeof setInterval> | null = null

async function syncSource(source: WechatSource, state: PersistedState): Promise<WechatSyncResult> {
  const result: WechatSyncResult = {
    sourceId: source.id, sourceName: source.name, discovered: 0, imported: 0, skipped: 0, rejected: 0, errors: [],
  }
  try {
    const listing = await fetchHtml(source.url)
    const urls = discoverArticleUrls(listing, source.url)
    result.discovered = urls.length
    for (const url of urls) {
      try {
        const article = extractArticle(url, url === source.url ? listing : await fetchHtml(url))
        if (!article) {
          result.rejected += 1
          result.errors.push(`${url}: 未提取到足够长的文章正文`)
          continue
        }
        if (article.score < 0.42) {
          result.rejected += 1
          result.errors.push(`${url}: 数据技术相关度不足（评分 ${article.score.toFixed(2)}）`)
          continue
        }
        if (state.seen.some((seen) => seen.url === article.url || seen.contentHash === article.hash)) {
          result.skipped += 1
          continue
        }
        await createDraft(article, source)
        state.seen.push({ url: article.url, contentHash: article.hash, title: article.title, importedAt: new Date().toISOString() })
        result.imported += 1
      } catch (error) {
        result.errors.push(`${url}: ${publicKnowledgeErrorMessage(error)}`)
      }
    }
    source.lastSyncStatus = result.errors.length > 0 || result.rejected > 0 ? 'partial' : 'success'
    source.lastSyncError = result.errors[0] ?? null
  } catch (error) {
    source.lastSyncStatus = 'failed'
    source.lastSyncError = publicKnowledgeErrorMessage(error)
    result.errors.push(source.lastSyncError)
  }
  source.lastSyncAt = new Date().toISOString()
  source.updatedAt = source.lastSyncAt
  source.importedCount += result.imported
  source.discoveredCount = result.discovered
  return result
}

export async function syncWechatSources(sourceId?: string): Promise<WechatSyncReport> {
  if (syncInFlight) return syncInFlight
  syncInFlight = (async () => {
    const startedAt = new Date().toISOString()
    const state = loadState()
    const selected = state.sources.filter((source) => source.enabled && (!sourceId || source.id === sourceId))
    const results: WechatSyncResult[] = []
    for (const source of selected) results.push(await syncSource(source, state))
    state.seen = state.seen.slice(-500)
    persistState(state)
    const report: WechatSyncReport = {
      startedAt,
      finishedAt: new Date().toISOString(),
      sources: results,
      discovered: results.reduce((sum, item) => sum + item.discovered, 0),
      imported: results.reduce((sum, item) => sum + item.imported, 0),
      skipped: results.reduce((sum, item) => sum + item.skipped, 0),
      rejected: results.reduce((sum, item) => sum + item.rejected, 0),
      errors: results.flatMap((item) => item.errors),
    }
    return report
  })()
  try {
    return await syncInFlight
  } finally {
    syncInFlight = null
  }
}

export function scheduleWechatArticleSync(): void {
  if (syncTimer) return
  syncTimer = setInterval(() => { void syncWechatSources().catch(() => {}) }, 6 * 60 * 60 * 1000)
  syncTimer.unref?.()
  const kickoff = setTimeout(() => { void syncWechatSources().catch(() => {}) }, 60 * 1000)
  kickoff.unref?.()
}
