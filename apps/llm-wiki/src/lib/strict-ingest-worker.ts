import {
  claimIngestCompilation,
  failIngestCompilation,
  submitIngestCompilation,
  type StrictIngestChange,
  type StrictIngestCompilationClaim,
} from "@/commands/ingest-gate"
import {
  copyDirectory,
  copyFile,
  createDirectory,
  deleteFile,
  fileExists,
  readFile,
} from "@/commands/fs"
import { parseFrontmatter } from "@/lib/frontmatter"
import { hasUsableLlm } from "@/lib/has-usable-llm"
import { autoIngest } from "@/lib/ingest"
import { getFileName, getFileStem, isAbsolutePath, normalizePath } from "@/lib/path-utils"
import { useWikiStore } from "@/stores/wiki-store"
import type { WikiProject } from "@/types/wiki"

const POLL_INTERVAL_MS = 1_500
const GENERATOR = "llm-wiki:auto-ingest-strict-v1"
const AGGREGATE_PATHS = new Set([
  "wiki/index.md",
  "wiki/log.md",
  "wiki/overview.md",
])

interface ActiveWorker {
  token: symbol
  projectPath: string
  controller: AbortController
}

let activeWorker: ActiveWorker | null = null

class StaleWorkerError extends Error {
  constructor() {
    super("Strict ingest compilation cancelled because the active project changed")
  }
}

export function normalizeStrictIngestFsPath(path: string): string {
  const normalized = normalizePath(path)
  if (/^\/\/\?\/unc\//i.test(normalized)) return `//${normalized.slice(8)}`
  if (normalized.startsWith("//?/")) return normalized.slice(4)
  return normalized
}

function projectJoin(projectPath: string, relativePath: string): string {
  const root = normalizeStrictIngestFsPath(projectPath)
  const separator = root.endsWith("/") ? "" : "/"
  return `${root}${separator}${relativePath.replace(/^\/+/, "")}`
}

function isCurrentWorker(token: symbol, signal: AbortSignal): boolean {
  return !signal.aborted && activeWorker?.token === token
}

function assertCurrentWorker(token: symbol, signal: AbortSignal): void {
  if (!isCurrentWorker(token, signal)) throw new StaleWorkerError()
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message
  const message = String(error).trim()
  return message || "Strict ingest compilation failed"
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    const timeout = globalThis.setTimeout(done, ms)
    signal.addEventListener("abort", done, { once: true })

    function done(): void {
      globalThis.clearTimeout(timeout)
      signal.removeEventListener("abort", done)
      resolve()
    }
  })
}

/** Select safe, reviewable pages from autoIngest's write result. */
export function proposalPathsFromWrittenFiles(writtenPaths: readonly string[]): string[] {
  const selected: string[] = []
  const seen = new Set<string>()

  for (const rawPath of writtenPaths) {
    let path = normalizePath(rawPath.trim())
    while (path.startsWith("./")) path = path.slice(2)
    const parts = path.split("/")
    const key = path.toLowerCase()

    if (
      !path ||
      isAbsolutePath(path) ||
      parts.some((part) => !part || part === "." || part === "..") ||
      !key.startsWith("wiki/") ||
      !key.endsWith(".md") ||
      AGGREGATE_PATHS.has(key) ||
      seen.has(key)
    ) {
      continue
    }

    seen.add(key)
    selected.push(path)
  }

  return selected
}

export function compiledPageTitle(path: string, content: string): string {
  const title = parseFrontmatter(content).frontmatter?.title
  if (typeof title === "string" && title.trim()) return title.trim()

  const heading = content.match(/^\s*#\s+(.+?)\s*#*\s*$/m)?.[1]?.trim()
  if (heading) return heading

  return getFileStem(path).replace(/[-_]+/g, " ").trim() || "Untitled"
}

function claimSourcePath(claim: StrictIngestCompilationClaim): string {
  const sourcePath = claim.sourcePath ?? claim.stagedSourcePath
  if (!sourcePath?.trim()) throw new Error("Strict ingest claim did not include a staged source path")
  return normalizeStrictIngestFsPath(sourcePath)
}

function assertSafeClaim(claim: StrictIngestCompilationClaim): string {
  const { id } = claim.draft
  if (!/^[A-Za-z0-9-]+$/.test(id)) throw new Error("Strict ingest claim has an invalid draft id")

  const sourcePath = claimSourcePath(claim)
  const sourceKey = sourcePath.toLowerCase()
  const stagingMarker = `/.llm-wiki/staging/${id.toLowerCase()}/`
  const markerIndex = sourceKey.lastIndexOf(stagingMarker)
  const sourceName = markerIndex >= 0
    ? sourcePath.slice(markerIndex + stagingMarker.length)
    : ""
  if (!sourceName || sourceName.includes("/")) {
    throw new Error("Strict ingest claim source is outside its staging directory")
  }
  return sourcePath
}

async function readCompiledChanges(
  projectPath: string,
  compileRoot: string,
  writtenPaths: readonly string[],
): Promise<StrictIngestChange[]> {
  const changes: StrictIngestChange[] = []
  for (const path of proposalPathsFromWrittenFiles(writtenPaths)) {
    const content = await readFile(projectJoin(compileRoot, path))
    changes.push({
      path,
      operation: await fileExists(projectJoin(projectPath, path)) ? "update" : "create",
      title: compiledPageTitle(path, content),
      content,
    })
  }
  return changes
}

async function failClaim(
  projectPath: string,
  claim: StrictIngestCompilationClaim,
  error: unknown,
): Promise<void> {
  try {
    await failIngestCompilation({
      projectPath,
      draftId: claim.draft.id,
      revision: claim.draft.revision,
      error: errorMessage(error),
    })
  } catch (failError) {
    console.warn("[strict-ingest] Failed to record compilation failure:", failError)
  }
}

async function compileClaim(
  projectPath: string,
  claim: StrictIngestCompilationClaim,
  token: symbol,
  signal: AbortSignal,
): Promise<void> {
  let compileRoot: string | null = null

  try {
    const sourcePath = assertSafeClaim(claim)
    compileRoot = projectJoin(
      projectPath,
      `.llm-wiki/staging/${claim.draft.id}/compile-project`,
    )
    const llmConfig = { ...useWikiStore.getState().llmConfig }
    if (!hasUsableLlm(llmConfig)) {
      throw new Error("Configure an LLM before compiling strict ingest drafts")
    }

    const extractedText = await readFile(sourcePath, { extractImages: false })
    assertCurrentWorker(token, signal)

    if (await fileExists(compileRoot)) await deleteFile(compileRoot)
    await createDirectory(compileRoot)

    const realWiki = projectJoin(projectPath, "wiki")
    if (await fileExists(realWiki)) {
      await copyDirectory(realWiki, projectJoin(compileRoot, "wiki"))
    } else {
      await createDirectory(projectJoin(compileRoot, "wiki"))
    }

    assertCurrentWorker(token, signal)
    const sourceDirectory = projectJoin(compileRoot, "raw/sources")
    await createDirectory(sourceDirectory)
    const sourceName = getFileName(claim.draft.filename) || getFileName(sourcePath)
    const compileSource = projectJoin(sourceDirectory, sourceName)
    await copyFile(sourcePath, compileSource)

    assertCurrentWorker(token, signal)
    const writtenPaths = await autoIngest(
      compileRoot,
      compileSource,
      llmConfig,
      signal,
      claim.feedback?.trim() || undefined,
    )
    assertCurrentWorker(token, signal)

    const changes = await readCompiledChanges(projectPath, compileRoot, writtenPaths)
    if (changes.length === 0) {
      throw new Error("LLM compilation did not produce any reviewable Wiki pages")
    }

    assertCurrentWorker(token, signal)
    await submitIngestCompilation({
      projectPath,
      draftId: claim.draft.id,
      revision: claim.draft.revision,
      extractedText,
      changes,
      generator: GENERATOR,
    })
  } catch (error) {
    // A project switch or window teardown is an expected cancellation. Leave
    // the CAS claim in `drafting` so the next worker can recover it instead of
    // presenting a user-visible failure for a clean shutdown.
    if (error instanceof StaleWorkerError || signal.aborted) return
    await failClaim(projectPath, claim, error)
  } finally {
    try {
      if (compileRoot && await fileExists(compileRoot)) await deleteFile(compileRoot)
    } catch (error) {
      console.warn(`[strict-ingest] Failed to remove compile project for ${claim.draft.id}:`, error)
    }
  }
}

async function runWorker(
  projectPath: string,
  token: symbol,
  signal: AbortSignal,
): Promise<void> {
  while (isCurrentWorker(token, signal)) {
    // Do not claim a draft until the user has configured a usable provider.
    // This keeps an uploaded paper reviewable while the app is first set up.
    if (!hasUsableLlm(useWikiStore.getState().llmConfig)) {
      await abortableDelay(POLL_INTERVAL_MS, signal)
      continue
    }
    let claim: StrictIngestCompilationClaim | null = null
    try {
      claim = await claimIngestCompilation(projectPath)
    } catch (error) {
      if (!signal.aborted) console.warn("[strict-ingest] Failed to claim a draft:", error)
      await abortableDelay(POLL_INTERVAL_MS, signal)
      continue
    }

    if (!claim) {
      await abortableDelay(POLL_INTERVAL_MS, signal)
      continue
    }
    if (!isCurrentWorker(token, signal)) {
      break
    }

    await compileClaim(projectPath, claim, token, signal)
  }
}

export function startStrictIngestWorker(project: WikiProject): void {
  const projectPath = normalizePath(project.path)
  if (activeWorker?.projectPath === projectPath && !activeWorker.controller.signal.aborted) return

  stopStrictIngestWorker()
  const controller = new AbortController()
  const token = Symbol(project.id)
  activeWorker = { token, projectPath, controller }

  void runWorker(projectPath, token, controller.signal).finally(() => {
    if (activeWorker?.token === token) activeWorker = null
  })
}

export function stopStrictIngestWorker(): void {
  activeWorker?.controller.abort()
  activeWorker = null
}
