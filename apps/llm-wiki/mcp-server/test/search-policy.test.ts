import assert from "node:assert/strict"
import { test } from "node:test"
import type { ApiCandidateSearchResponse, ApiSearchResponse } from "../src/api-client.js"
import { formatLocalFirstSearch, localEvidenceIsSufficient } from "../src/search-policy.js"

const local: ApiSearchResponse = {
  mode: "hybrid",
  results: [
    {
      path: "wiki/papers/a.md",
      title: "Trusted paper",
      snippet: "local fact",
      score: 0.8,
      evidenceLocator: {
        sourceId: "paper:abc",
        revision: 1,
        page: 7,
        authors: ["Zhang Wei", "Li Ming"],
        year: 2025,
      },
    },
  ],
}

test("local evidence requires both the configured count and a useful score", () => {
  assert.equal(localEvidenceIsSufficient(local, 5, { minResults: 3, minScore: 0.15 }), false)
  assert.equal(localEvidenceIsSufficient(local, 1, { minResults: 3, minScore: 0.15 }), true)
  assert.equal(
    localEvidenceIsSufficient(
      { results: [{ ...local.results[0], score: 0.01 }] },
      1,
      { minResults: 3, minScore: 0.15 },
    ),
    false,
  )
})

test("formatter separates trusted local evidence from external abstracts", () => {
  const external: ApiCandidateSearchResponse = {
    candidates: [{
      id: "candidate-1",
      provider: "openalex",
      externalId: "W1",
      title: "External paper",
      authors: ["A. Author"],
      year: 2026,
      abstract: "abstract only",
      url: "https://example.test/paper",
      query: "question",
      recommendedReason: "Related external paper from OpenAlex",
      status: "unread",
    }],
    providerErrors: [],
  }
  const output = formatLocalFirstSearch("question", local, external)
  assert.match(output, /Local evidence \(approved Wiki\)/)
  assert.match(output, /【Zhang Wei et al\., 2025, p\.7】/)
  assert.match(output, /\/api\/knowledge\/sources\/paper%3Aabc\/pdf\?page=7/)
  assert.match(output, /External abstract evidence \(reading candidates, not trusted Wiki evidence\)/)
  assert.match(output, /were not downloaded, embedded, or published to the Wiki/)
})

test("formatter records when strong local evidence avoids external search", () => {
  const output = formatLocalFirstSearch("question", local)
  assert.match(output, /Not requested because approved local evidence was sufficient/)
  assert.doesNotMatch(output, /External paper/)
})
