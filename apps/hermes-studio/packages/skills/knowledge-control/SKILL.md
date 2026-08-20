---
name: knowledge-control
description: "Full control over the AGNET local LLM Wiki knowledge base via Hermes Studio API (search/chat/import/modify). Use when the user wants to import a WeChat public article link, search or chat over personal knowledge, manage drafts/files, or let Hermes answer from trusted papers. Works on ALL profiles (default & research) through hermes_studio_api_* tools — universal knowledge plane for WeChat-linked Hermes."
version: 1.0.0
author: Hermes
license: MIT
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [knowledge-base, llm-wiki, wechat, import, search, rag, agnet, full-control]
    required: true
    profiles: [default, research]
prerequisites:
  commands: [node]
---

# Knowledge Control

> AGNET 本地知识库全量控制（微信联动 Hermes 专用）
> 用户在微信里发一条 https://mp.weixin.qq.com/s/... 链接，Hermes 就能在本地知识库完成抓取 -> 去重 -> 创建草稿 ->（可选）批准入库，无需打开 LLM Wiki 手动导入；用户按关键词提问时，Hermes 能从已入库的论文与公众号文章中检索并引用回答。

本技能不依赖 llm-wiki MCP（该 MCP 仅在 research profile 可用），而是通过 Hermes Studio 随带 MCP 的 api 工具集：

- hermes_studio_api_openapi_get — 先查接口手册
- hermes_studio_api_request — 统一调用所有 Knowledge 平面接口

因此：无论 Hermes 当前是 default 还是 research profile，微信消息都能触发本技能并真正控制知识库。

---
## 何时使用

- 用户发送或提及 微信公众号文章链接：mp.weixin.qq.com/s/... 典型说法：帮我把这个公众号链接导入知识库 https://mp.weixin.qq.com/s/xxx / 把这个文章收录进去
- 用户想让 Hermes 感知知识库内容并按关键词检索：知识库里有没有关于 数据治理 的文章？帮我找一下 数字电网 相关的论文并总结
- 用户想管理知识库（草稿审核、文件读写、删除）：批准刚才导入的草稿 / 列一下待审核草稿

规则：只要消息中出现 mp.weixin.qq.com 链接，就必须尝试导入。

---
## 能力与对应接口

| 能力 | 方法与路径 | 说明 |
|------|-----------|------|
| 单链微信导入（草稿闸门） | POST /api/knowledge/wechat-import body: {"url": "https://mp.weixin.qq.com/s/..."} | 服务端抓取正文、SSRF 白名单、6 次/分限流、内容哈希去重；成功返回 {draftId, title, url} |
| 批准/驳回/修改草稿 | POST /api/knowledge/drafts/{id}/approve / revise / reject ; GET /api/knowledge/drafts | 批准后才会写入 wiki/sources/<slug>.md 并变为 trusted |
| 彻底删除已入库文章 | POST /api/knowledge/drafts/{id}/remove | 删除 wiki/sources 下已发布页面 + 清理 staging/<id> |
| 关键词检索（可信知识） | GET /api/knowledge/search?q=关键词 | trustedOnly=true，返回 results: [{title, excerpt, score, sourceUrl}] |
| 知识库问答（RAG） | POST /api/knowledge/chat body: {"message":"问题","mode":"local_first"} | local_first 为默认，永不外发公司数据 |
| 图谱浏览 | GET /api/knowledge/graph?limit=500 | 返回 {nodes, edges} |
| 文件全量 | GET /api/knowledge/files?root=wiki&recursive=true | 配合 GET /api/knowledge/files/content?path=... 读取正文 |
| 知识库概览 | GET /api/knowledge/summary | trusted / sources / awaitingReview / drafts 计数 |

所有路径均为相对路径，禁止带域名；用 hermes_studio_api_request 调用时 path 必须以 /api/ 开头。

---
## 标准工作流

### 1) 微信公众号链接 -> 一键入库

输入例：用户在微信里发 请帮我把 https://mp.weixin.qq.com/s/ABC123 导入知识库

1. 抽取 URL：正则 https?://mp\.weixin\.qq\.com/s[^\s"'<>]*。若消息含多个链接，逐一处理。
2. 查手册（可选）：hermes_studio_api_openapi_get { tag: "Knowledge", path: "/api/knowledge/wechat-import" }
3. 调用导入：hermes_studio_api_request { method: "POST", path: "/api/knowledge/wechat-import", body: { url: "https://mp.weixin.qq.com/s/ABC123" } }
   - 400 已导入过 -> 告知去重命中
   - 429 操作过于频繁 -> 告知 6 次/分限流
   - 502 微信返回环境验证页面 -> 提示该号被风控
4. 向用户确认：已抓取《标题》并创建草稿（ID abcd1234），已进入审核队列。是否立即批准入库？回复“批准”“直接入库”即可，无需打开 LLM Wiki。
5. 若用户确认批准（或原始指令已含 直接入库 / 立即发布 / 无需审核）：hermes_studio_api_request { method: "POST", path: "/api/knowledge/drafts/abcd1234/approve", body: {} } 成功后告知已批准入库 wiki/sources/<slug>.md，现已可被关键词检索。
6. 可主动提供 GET /api/knowledge/drafts 列表或 GET /api/knowledge/summary 计数供复核。

### 2) 关键词回应已入库论文/文章（全量感知）

输入例：用户问 知识库里关于 数据湖 和 湖仓 有什么论文？帮我总结

1. 先检索，再回答（绝不凭空编造）：
   hermes_studio_api_request { method: "GET", path: "/api/knowledge/search", query: { q: "数据湖 湖仓" } }
   或 hermes_studio_api_request { method: "POST", path: "/api/knowledge/chat", body: { message: "数据湖和湖仓相关的已入库内容有哪些？", mode: "local_first" } }
2. 阅读与展开：若 search 返回多条且用户想看全文，再用 GET /api/knowledge/files/content?path=wiki/papers/xxx.md 或 GET /api/knowledge/graph
3. 引用回答：用 title + path + sourceUrl 显式标注来源，必须区分可信知识库内容与模型通用知识，未知直说 知识库中未收录。
4. 多跳意图：关键词->相关论文 用 search；总结/对比/问答 用 chat；结构/关联 用 graph

### 3) 完全访问与修改知识库

Hermes 被授权对知识库做完全读写，所有操作均通过 hermes_studio_api_request：

- 列全部文件：GET /api/knowledge/files?root=wiki&recursive=true
- 读单篇：GET /api/knowledge/files/content?path=wiki/sources/xxx.md
- 新建/更新：POST /api/knowledge/files/write body {"path":"wiki/papers/xxx.md","content":"..."}
- 新建缺失页：POST /api/knowledge/files/create-missing body {"title":"标题","content":"正文"}
- 删除：POST /api/knowledge/files/delete body {"path":"wiki/sources/xxx.md"}
- 草稿队列：GET /api/knowledge/drafts -> POST /api/knowledge/drafts/{id}/approve|revise|reject|remove
- 系统健康：GET /api/knowledge/summary + GET /api/knowledge/lint + GET /api/knowledge/settings

---
## profile 差异与兼容

- research profile 同时拥有 llm-wiki MCP 与本技能的 api 通道；优先用本技能的 api 通道以保证与 default 行为一致。
- default profile 无 llm-wiki MCP，但本技能的 api 通道完全等价，微信消息在 default 下也能导入并检索。
- 若用户将微信的 Gateway 绑定在 default，无需切换到 research。

---
## 边界与错误处理

- 导入限流 6 次/分/IP：被限时告知 操作过于频繁，请稍后再试
- SSRF 防护：仅 mp.weixin.qq.com/s/ 允许
- 去重提示：已导入过 时给出已入库标题与 draftId
- 内容过短（<180 字）或验证页：提示 未提取到足够长的文章正文
- LLM Wiki 未连接：提示 LLM Wiki 未连接，请在 127.0.0.1:19828 打开桌面端并确保设置 -> API -> 启用 MCP 已开启

---
## 配合个人工作台

微信与 Gateway 的绑定入口已集成到：http://127.0.0.1:8648/#/hermes/personal-workbench（个人工作台 -> 微信联动 · Gateway 控制）。
- Gateway 卡：显示 运行中/已停止 · profile · PID · 统一网关，提供 启动/停止/重启/刷新/自动启动开关
- 微信卡：扫码登录（iLink 二维码轮询）或手动粘贴 WEIXIN_TOKEN / WEIXIN_ACCOUNT_ID 后保存并自动重启 Gateway
- 三步上手：启动 Gateway -> 扫码绑定 -> 在微信中发话即可联动

教学（Gateway 开关）：
- 页面内：直接点 启动 / 停止 / 重启 按钮；自动启动 开启后 Studio 启动时自动拉起
- 命令行：hermes gateway start / hermes gateway stop / hermes gateway restart / hermes gateway status；指定 profile 用 hermes --profile <name> gateway status

---
## 示例

例 1：微信发来公众号链接  https://mp.weixin.qq.com/s/abc123 帮我收录
-> 1. POST /api/knowledge/wechat-import body {"url":"https://mp.weixin.qq.com/s/abc123"} 2. 回复已创建草稿 draftId 3. 用户：批准 4. POST /api/knowledge/drafts/1a2b3c4d/approve

例 2：关键词提问 知识库里关于 数据治理 的文章有哪些？
-> GET /api/knowledge/search?q=数据治理 或 POST /api/knowledge/chat body {"message":"数据治理相关已入库内容？","mode":"local_first"}

---
## 安全与隐私

- 知识库问答默认 local_first，检索与问答全在本地 127.0.0.1:19828 完成
- 只有当用户显式要求 深度研究 / 联网检索 时才用 mode: deep + webSearch: true
- 所有写入都会留历史快照，可通过 GET /api/knowledge/files/history?path=... + POST /api/knowledge/files/restore 回滚。
