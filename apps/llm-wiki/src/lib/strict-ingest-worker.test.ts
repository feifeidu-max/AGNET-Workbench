import { describe, expect, it } from "vitest"
import {
  compiledPageTitle,
  normalizeStrictIngestFsPath,
  proposalPathsFromWrittenFiles,
} from "./strict-ingest-worker"

describe("strict ingest proposal helpers", () => {
  it("keeps only safe, non-aggregate Markdown pages", () => {
    expect(proposalPathsFromWrittenFiles([
      "wiki/papers/alpha.md",
      "wiki\\concepts\\beta.md",
      "./wiki/sources/paper.md",
      "wiki/index.md",
      "wiki/LOG.md",
      "wiki/overview.md",
      "wiki/../outside.md",
      "raw/sources/paper.md",
      "wiki/assets/image.png",
      "C:/project/wiki/absolute.md",
      "wiki/papers/ALPHA.md",
    ])).toEqual([
      "wiki/papers/alpha.md",
      "wiki/concepts/beta.md",
      "wiki/sources/paper.md",
    ])
  })

  it("takes a structured frontmatter title before headings and filenames", () => {
    expect(compiledPageTitle(
      "wiki/papers/fallback-name.md",
      "---\ntitle: A precise title\ntype: paper\n---\n# Heading title",
    )).toBe("A precise title")
    expect(compiledPageTitle("wiki/concepts/graph-theory.md", "# Graph Theory\n\nBody")).toBe("Graph Theory")
    expect(compiledPageTitle("wiki/concepts/graph-theory.md", "Body only")).toBe("graph theory")
  })

  it("normalizes Windows canonical paths returned by Rust", () => {
    expect(normalizeStrictIngestFsPath("\\\\?\\C:\\wiki\\source.pdf"))
      .toBe("C:/wiki/source.pdf")
    expect(normalizeStrictIngestFsPath("\\\\?\\UNC\\server\\share\\source.pdf"))
      .toBe("//server/share/source.pdf")
  })
})
