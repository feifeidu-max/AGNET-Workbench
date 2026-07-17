# Strict ingest contract

LLM Wiki's AGNET integration uses the review-first ingest gate for every
first-party input path. A source is not considered trusted until its draft is
approved.

| Entry point | Gate action | Trusted write before approval |
| --- | --- | --- |
| Desktop Sources file/folder import | `stage_ingest_source` | None |
| Scheduled Import | `stage_ingest_source` | None |
| `raw/sources` watcher | Stage a created/modified ingestable file, then remove the untrusted copy | None |
| Web Clipper | `create_generated_page_draft` with `origin=web-clipper` | None |
| Deep Research | `create_generated_page_draft` with `origin=deep-research` | None |
| Chat “Save to Wiki” | `create_generated_page_draft` with `origin=chat-save-to-wiki` | None |
| Review “Save/Create page” | `create_generated_page_draft` with `origin=review-*` | None |
| HTTP API PDF upload | `POST /api/v1/projects/:id/ingest-drafts` | None |
| Hermes research MCP | Read-only search/read/graph; no ingest capability | None |

The watcher deliberately ignores legacy Web Clipper payloads that do not carry
a draft id. Restart the bundled clip server after upgrading so its `/clip`
handler submits directly to the gate.

Approved publications are committed under the project transaction lock. The
API then updates the file-sync snapshot and emits
`strict-ingest://published`; the desktop indexes each published page and
persists `embeddingStatus` (`indexing`, `indexed`, `disabled`, or `failed`).
Pending `queued`/`failed` publications are retried when the project opens.

PDF locators are generated from PDFium `## Page N` boundaries. Author and year
metadata comes from PDF document info first, then first-page/filename
heuristics, with PDF creation year explicitly marked as a last-resort fallback.
When no metadata is reliable, citations use the stable source id and `n.d.`.

External reading candidates contain title, authors, year, abstract, and URL
only. They are never downloaded, embedded, or written to `wiki/`; a user must
manually upload the paper to start a new review draft.
