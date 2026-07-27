---
name: llm-wiki-graph
description: "Query the LLM Wiki project knowledge graph through the llm-wiki MCP server (mcp__llm_wiki__llm_wiki_graph). Use when the user wants to explore entities, relations, concepts, or the structured graph of their personal/wiki knowledge base. This is a required skill for the research profile."
version: 1.0.0
author: Hermes
license: MIT
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [llm-wiki, knowledge-graph, entities, relations, research]
    required: true
    profiles: [research]
prerequisites:
  commands: [node]
---

# LLM Wiki Graph

Use this skill whenever the active Hermes profile is `research` and the user wants to explore the structured knowledge graph of their LLM Wiki project — entities, concepts, relations, or how topics connect. The underlying capability is the `mcp__llm_wiki__llm_wiki_graph` tool exposed by the `llm-wiki` MCP server.

## When to use

- The user asks "知识库里 X 和 Y 有什么关系", "帮我看看知识图谱里关于 Z 的节点", "这个项目里都涵盖了哪些概念".
- You have search hits (from `llm-wiki-search`) and want to expand their connections or discover related entities.
- You need to map the structure of the user's knowledge base rather than retrieve a single page.

## Tool

Call the MCP tool directly (it is provided by the running `llm-wiki` MCP server):

```
mcp__llm_wiki__llm_wiki_graph
```

Parameters (inputSchema):

| Parameter | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `project_id` | string | no | `current` | Project UUID, project path, or the literal `current` (active project). |
| `q` | string | no | — | Optional free-text filter applied to node labels/content. |
| `node_type` | string | no | — | Optional node type filter (e.g. `concept`, `entity`, `document`). |
| `limit` | number | no | (API clamp) | Maximum number of nodes to return. |

Example call (pseudo, as the model invokes the MCP tool):

```json
{
  "project_id": "current",
  "q": "长上下文",
  "node_type": "concept",
  "limit": 20
}
```

## Workflow

1. Confirm the active profile is `research`. The `llm-wiki` MCP server is connected only there; on other profiles the tool is unavailable.
2. Start broad: call `mcp__llm_wiki__llm_wiki_graph` with just `project_id: "current"` to see the top nodes, or add `q`/`node_type` to narrow.
3. Use the returned nodes to orient the user: list the key entities/concepts and how they relate.
4. To go deeper on a node, combine with `mcp__llm_wiki__llm_wiki_search` (find the source page) or `mcp__llm_wiki__llm_wiki_read_file` (read its content).
5. Present the graph findings as a short structured summary (entities + relations), optionally offering a diagram if the user wants a visual.

## Notes

- `project_id` defaults to `current`; you rarely need to override it.
- Errors such as `401 Unauthorized` or `MCP access is disabled` mean the LLM Wiki desktop app's local API is not reachable/authenticated or `apiConfig.mcpEnabled` is false. Report this and ask the user to open the desktop app with MCP access enabled — do not retry in a loop.
- This skill is bundled and auto-installed for the `research` profile. It is intentionally the only required knowledge-graph skill.
