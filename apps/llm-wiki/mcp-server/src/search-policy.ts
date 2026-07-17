import type {
  ApiCandidateSearchResponse,
  ApiReadingCandidate,
  ApiSearchResponse,
  ApiSearchResult,
} from "./api-client.js"

const DEFAULT_MIN_LOCAL_RESULTS = 3
const DEFAULT_MIN_LOCAL_SCORE = 0.15

export interface LocalFirstThresholds {
  minResults: number
  minScore: number
}

export function localFirstThresholds(env: NodeJS.ProcessEnv = process.env): LocalFirstThresholds {
  return {
    minResults: positiveInteger(env.LLM_WIKI_LOCAL_MIN_RESULTS, DEFAULT_MIN_LOCAL_RESULTS),
    minScore: nonNegativeNumber(env.LLM_WIKI_LOCAL_MIN_SCORE, DEFAULT_MIN_LOCAL_SCORE),
  }
}

export function localEvidenceIsSufficient(
  search: ApiSearchResponse,
  requestedTopK?: number,
  thresholds: LocalFirstThresholds = localFirstThresholds(),
): boolean {
  const expected = Math.min(
    thresholds.minResults,
    positiveInteger(requestedTopK, thresholds.minResults),
  )
  if (search.results.length < expected) return false
  return search.results.slice(0, expected).some((result) => result.score >= thresholds.minScore)
}

export function formatLocalFirstSearch(
  query: string,
  local: ApiSearchResponse,
  external?: ApiCandidateSearchResponse,
  externalError?: string,
): string {
  const lines = [`# Search evidence for "${query}"`, "", "## Local evidence (approved Wiki)", ""]
  const meta = [
    local.mode ? `Mode: ${local.mode}` : null,
    typeof local.tokenHits === "number" ? `Token hits: ${local.tokenHits}` : null,
    typeof local.vectorHits === "number" ? `Vector hits: ${local.vectorHits}` : null,
  ].filter(Boolean)
  if (meta.length > 0) lines.push(meta.join(" | "), "")

  if (local.results.length === 0) {
    lines.push("No approved local evidence matched this query.", "")
  } else {
    local.results.forEach((result, index) => appendLocalResult(lines, result, index))
  }

  if (external || externalError) {
    lines.push("## External abstract evidence (reading candidates, not trusted Wiki evidence)", "")
    lines.push(
      "These records contain only external metadata/abstracts. They were saved to the reading-candidates inbox and were not downloaded, embedded, or published to the Wiki.",
      "",
    )
    if (externalError) {
      lines.push(`External search unavailable: ${externalError}`, "")
    } else if (!external || external.candidates.length === 0) {
      lines.push("No external paper candidates were found.", "")
    } else {
      external.candidates.forEach((candidate, index) => appendExternalCandidate(lines, candidate, index))
    }
    if (external && external.providerErrors.length > 0) {
      lines.push("### Provider warnings", "")
      external.providerErrors.forEach((warning) => lines.push(`- ${warning}`))
      lines.push("")
    }
  } else {
    lines.push("## External abstract evidence", "", "Not requested because approved local evidence was sufficient.", "")
  }

  return lines.join("\n")
}

function appendLocalResult(lines: string[], result: ApiSearchResult, index: number): void {
  lines.push(`### L${index + 1}. ${result.title}`)
  lines.push(`Path: ${result.path}`)
  lines.push(
    `Score: ${result.score.toFixed(6)}${typeof result.vectorScore === "number" ? ` | Vector score: ${result.vectorScore.toFixed(6)}` : ""}`,
  )
  if (result.evidenceLocator) {
    const locator = result.evidenceLocator
    const citation = citationLabel(locator)
    const pdfPath = `/api/knowledge/sources/${encodeURIComponent(locator.sourceId)}/pdf?page=${Math.max(1, locator.page)}`
    lines.push(`Citation: [${citation}](${pdfPath})`)
    lines.push(
      `EvidenceLocator: source=${locator.sourceId} revision=${locator.revision} page=${locator.page}${locator.section ? ` section=${locator.section}` : ""}${locator.snippetHash ? ` snippetHash=${locator.snippetHash}` : ""}`,
    )
  }
  if (result.snippet) lines.push(`Snippet: ${result.snippet}`)
  if (result.images && result.images.length > 0) {
    lines.push(`Images: ${result.images.map((image) => image.url).join(", ")}`)
  }
  lines.push("")
}

function appendExternalCandidate(lines: string[], candidate: ApiReadingCandidate, index: number): void {
  lines.push(`### E${index + 1}. ${candidate.title || candidate.externalId}`)
  lines.push(`Provider: ${candidate.provider}`)
  if (candidate.authors.length > 0) lines.push(`Authors: ${candidate.authors.join(", ")}`)
  if (typeof candidate.year === "number") lines.push(`Year: ${candidate.year}`)
  if (candidate.doi) lines.push(`DOI: ${candidate.doi}`)
  if (candidate.url) lines.push(`URL: ${candidate.url}`)
  if (candidate.abstract) lines.push(`Abstract: ${candidate.abstract}`)
  if (candidate.recommendedReason) lines.push(`Recommendation: ${candidate.recommendedReason}`)
  lines.push(`Candidate ID: ${candidate.id}`, "")
}

function citationLabel(locator: NonNullable<ApiSearchResult["evidenceLocator"]>): string {
  const author = locator.authors?.[0]?.trim()
  const authorLabel = author
    ? `${author}${(locator.authors?.length ?? 0) > 1 ? " et al." : ""}`
    : locator.sourceId
  return `【${authorLabel}, ${locator.year ?? "n.d."}, p.${locator.page}】`
}

function positiveInteger(value: string | number | undefined, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback
}

function nonNegativeNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}
