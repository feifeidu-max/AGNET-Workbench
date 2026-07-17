---
date: 2026-07-16
commit: local
feature: Per-session Hermes memory mode
impact: New sessions lock either normal long-term memory or clean mode, and the selected mode is preserved across queueing, Bridge context estimation, restart, and session recovery.
---

`memory_mode=on` keeps Hermes Agent's standard memory behavior. `memory_mode=clean`
rebuilds the Agent with `skip_memory=True`, excludes `MEMORY.md`, `USER.md`,
memory providers and memory/session-search tools, while retaining `SOUL.md`, selected
Skills, and current workspace context. Bridge status and context-estimate calls carry
the same mode so cached Agents and token counts cannot cross the mode boundary.

The mode can only change before the first user message. Existing sessions without a
stored value migrate to `on`, including partial or legacy session-detail responses.
