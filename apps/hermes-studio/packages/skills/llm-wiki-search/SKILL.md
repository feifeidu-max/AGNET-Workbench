---
name: llm-wiki-search
description: "Search the LLM Wiki local knowledge base through the llm-wiki MCP server (mcp__llm_wiki__llm_wiki_search). Use when the user asks to look up, retrieve, or find information inside their personal/wiki knowledge base, papers, or indexed documents. This is a required skill for the research profile."
version: 1.0.0
author: Hermes
license: MIT
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [llm-wiki, knowledge-base, retrieval, search, research]
    required: true
    profiles: [research]
prerequisites:
  commands: [node]
---

# LLM Wiki Search

Use this skill whenever the active Hermes profile is `research` and the user wants to search their local LLM Wiki knowledge base (papers, wiki pages, indexed documents). The underlying capability is the `mcp__llm_wiki__llm_wiki_search` tool exposed by the `llm-wiki` MCP server.

It uses the same backend keyword/vector retrieval as the LLM Wiki desktop app, so results are consistent with what the desktop UI returns.

## When to use

- The user asks "在我们的知识库里找一下…", "检索一下已录入的论文", "知识库里有没有关于 X 的内容".
- The user wants to ground an answer in their own indexed documents rather than the model's training data.
- You are about to answer a factual question that is likely covered by the user's wiki/papers.

## Tool

Call the MCP tool directly (do not shell out; it is provided by the running `llm-wiki` MCP server):

```
mcp__llm_wiki__llm_wiki_search
```

Parameters (inputSchema):

| Parameter | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `project_id` | string | no | `current` | Project UUID, project path, or the literal `current` (active project). |
| `query` | string | **yes** | — | The search query. |
| `top_k` | number | no | (API clamp) | Maximum number of results to return. |
| `include_content` | boolean | no | (API default) | Include the full page content in each result when supported. |

Example call (pseudo, as the model invokes the MCP tool):

```json
{
  "project_id": "current",
  "query": "transformer 模型的长上下文推理方法",
  "top_k": 8,
  "include_content": false
}
```

## Workflow

1. Confirm the active profile is `research` (the `llm-wiki` MCP server is only connected there). If it is `default` or another profile, switch to `research` first or tell the user this tool is research-only.
2. Translate the user's intent into a concise `query`. Use domain language from their question.
3. Call `mcp__llm_wiki__llm_wiki_search` with `project_id: "current"` unless the user named a specific project.
4. Read the returned hits (titles, snippets, scores). If a hit looks relevant, you may follow up with `mcp__llm_wiki__llm_wiki_read_file` (to fetch the page body) or `mcp__llm_wiki__llm_wiki_graph` (to explore related entities).
5. Answer using the retrieved evidence. Cite the source title/path so the user can verify in the desktop app.

## Notes

- `project_id` defaults to `current`, which resolves to whatever project is active in the LLM Wiki desktop app. You rarely need to override it.
- If the tool returns an error such as `401 Unauthorized` or `MCP access is disabled`, the LLM Wiki desktop app's local API is either not running, not authenticated, or `apiConfig.mcpEnabled` is false. Report this to the user and ask them to open the LLM Wiki desktop app and ensure MCP access is enabled — do not retry in a loop.
- This skill is bundled and auto-installed for the `research` profile. It is intentionally the only required knowledge-base retrieval skill.
