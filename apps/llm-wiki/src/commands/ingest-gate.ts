import { invoke } from "@tauri-apps/api/core"

export type IngestDraftStatus =
  | "uploaded"
  | "parsing"
  | "drafting"
  | "awaiting_review"
  | "publishing"
  | "trusted"
  | "revision_requested"
  | "rejected"
  | "failed"

export interface StrictIngestDraft {
  id: string
  filename: string
  sourceId: string
  sha256: string
  sizeBytes: number
  status: IngestDraftStatus
  revision: number
  sourceKind: string
  paperTitle?: string
  paperAuthors: string[]
  publicationYear?: number
  publishedPages: string[]
  sourcePath?: string
  embeddingStatus?: string
}

export interface StrictIngestCompilationClaim {
  draft: StrictIngestDraft
  /** Current Rust contract. */
  sourcePath?: string
  /** Compatibility with early strict-ingest builds. */
  stagedSourcePath?: string
  feedback?: string | null
}

export interface StrictIngestChange {
  path: string
  operation: "create" | "update"
  title: string
  content: string
}

export async function stageIngestSource(
  projectPath: string,
  sourcePath: string,
): Promise<StrictIngestDraft> {
  return invoke<StrictIngestDraft>("stage_ingest_source", { projectPath, sourcePath })
}

export async function stageGeneratedWikiPage(input: {
  projectPath: string
  title: string
  targetPath: string
  content: string
  origin: string
}): Promise<StrictIngestDraft> {
  return invoke<StrictIngestDraft>("stage_generated_wiki_page", input)
}

export async function pendingIngestPublications(
  projectPath: string,
): Promise<StrictIngestDraft[]> {
  return invoke<StrictIngestDraft[]>("pending_ingest_publications", { projectPath })
}

export async function setIngestEmbeddingStatus(
  projectPath: string,
  draftId: string,
  status: "queued" | "indexing" | "indexed" | "disabled" | "failed",
  error?: string,
): Promise<StrictIngestDraft> {
  return invoke<StrictIngestDraft>("set_ingest_embedding_status", {
    projectPath,
    draftId,
    status,
    error,
  })
}

export async function claimIngestCompilation(
  projectPath: string,
): Promise<StrictIngestCompilationClaim | null> {
  return invoke<StrictIngestCompilationClaim | null>("claim_ingest_compilation", {
    projectPath,
  })
}

export async function submitIngestCompilation(input: {
  projectPath: string
  draftId: string
  revision: number
  extractedText: string
  changes: StrictIngestChange[]
  generator: string
}): Promise<StrictIngestDraft> {
  return invoke<StrictIngestDraft>("submit_ingest_compilation", input)
}

export async function failIngestCompilation(input: {
  projectPath: string
  draftId: string
  revision: number
  error: string
}): Promise<StrictIngestDraft> {
  return invoke<StrictIngestDraft>("fail_ingest_compilation", input)
}
