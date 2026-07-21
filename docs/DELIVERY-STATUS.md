# AGNET 交付与验收状态

更新时间：2026-07-18 14:34（Asia/Shanghai）

## 结论

核心原型代码、Windows 构建产物和本地集成链路已经完成。当前机器上 Hermes Studio、Hermes Agent `0.18.2` Bridge、LLM Wiki `0.6.4` 和正式个人 Wiki 项目已联通；知识库审核门、只读问答和记忆模式均可进入实际界面。Studio 是唯一用户入口，LLM Wiki 只作为 Studio 托管的本机后台服务运行。

当前状态不是生产验收完成：公网 DeepSeek 端点/凭据未配置，50 个研究问题及引用质量指标尚未验收。100 篇本机已有学术 PDF 的摄入、可信发布、关键词检索、知识图谱、页码证据和 Range 下载流程已跑通；受环境网络限制，本次未宣称从互联网下载论文。因此当前可交付范围仍是 Windows 单用户、非商用验证原型。知识库检索已固定为关键词 + 知识图谱，不依赖 Ollama 或 embedding 模型。

本次切换已完成启动器、Rust 检索边界、Studio 知识库管理页和配置文档的源码改动。2026-07-18 已在本机完成新的 Tauri release 构建，并用 release EXE 验证 `studioManaged=true`、`keyword_graph`、认证、回环监听、无用户可见 WebView 和无托盘创建。启动器会拒绝 `target\debug\llm-wiki.exe`，避免其因缺少 Vite 开发服务器 `localhost:1420` 而显示空白/拒绝连接页面。

## 固定版本与产物

| 组件 | 固定基线 | 当前状态 |
| --- | --- | --- |
| Hermes Agent | `0.18.2` | 已安装到 `.runtime/hermes-0.18.2`，Studio 健康检查实际报告 `v0.18.2` |
| Hermes Studio | `0.6.30` / upstream `5be8548` | 生产构建通过，运行于 `127.0.0.1:8648` |
| LLM Wiki | `v0.6.4` / upstream `03e46fc4` | 最新 release EXE 以 `keyword_graph` 运行于 `127.0.0.1:19828`；由 Studio 以无用户可见窗口、无托盘图标模式管理 |

产物：

- `apps/llm-wiki/src-tauri/target/release/llm-wiki.exe`
  - 82,526,720 bytes
  - SHA-256 `F42DC1851B442BB816DEF53F75676CE6812D83D39B80F4B8A0216219DCBFD836`

本次采用 `tauri build --no-bundle` 生成已验证的 EXE；仓库中旧 MSI/NSIS 产物不代表本次源码，不得作为当前版本分发。如需安装包，需在目标 Windows 工具链上重新执行 `npm run tauri build` 并再次验证。

## 当前运行快照

| 服务/数据 | 当前值 |
| --- | --- |
| Studio | `http://127.0.0.1:8648`，状态 `ok` |
| Agent Bridge | `127.0.0.1:18765`，状态 `ready`，Hermes `v0.18.2` |
| Studio 数据目录 | `%USERPROFILE%\.hermes-web-ui` |
| LLM Wiki | `127.0.0.1:19828`，状态 `running`，`studioManaged=true`，`retrievalMode=keyword_graph`，运行 `target/release/llm-wiki.exe` |
| LLM Wiki 项目 | `C:/Users/local/Documents/LLM-Wiki`，100 篇论文页面和 100 条可信源记录，已设为 current project |
| LLM Wiki Token | 已生成到当前 Windows 用户环境变量；未写入仓库、Profile、Wiki、日志或 app-state |
| research Profile | 已用 Hermes `0.18.2` 初始化；内置 `llm-wiki` Skill 禁用，Bridge 工具集固定为 `llm-wiki` |

仓库根部三个 upstream remote 均为 fetch-only，push URL 为 `DISABLED`。根仓库已建立并推送 `main` 基线；上游同步仍应在独立分支完成，不能以最新版直接覆盖固定基线。

## 功能状态

| 业务域 | 状态 | 说明 |
| --- | --- | --- |
| 统一工作台与六个一级入口 | 已完成 | 登录默认进入工作台；Studio 是唯一用户入口，原 Studio 功能保留在高级功能区 |
| Studio 托管知识库服务 | 已完成 | LLM Wiki 只保留独立后台进程和回环 API；无独立窗口、托盘图标或浏览器入口，项目在 Studio 知识库管理页切换 |
| 严格论文摄入 | 已完成代码与验证 | 草稿、单发布锁、批准/重做/拒绝、原子发布、EvidenceLocator 与 PDF Range API 已实现；100 篇本地 PDF 全部达到 `trusted` |
| Wiki 搜索与问答 | 已完成 | Studio BFF 强制本地、无状态、`readOnly=true`；浏览器不能开启写工具或外网工具 |
| research Profile/MCP | 已完成 | 只读 `search/read/graph` 工具集 |
| 记忆模式 | 已完成 | 新空白会话可在 `on/clean` 间选择；首条消息后锁定；`clean` 排除 MEMORY/USER 与记忆工具并保留 SOUL |
| 记忆文档管理 | 已完成 | revision/If-Match、原子写、历史恢复、敏感内容扫描与真实路径展示 |
| 启动、备份与恢复 | 脚本完成 | launcher、计划任务、30 份保留、密钥排除和恢复 smoke 已通过；一键启动不再检查或启动 Ollama |

## 验证结果

- LLM Wiki Rust：`338 passed, 0 failed, 1 ignored`；`cargo fmt --check` 通过。
- LLM Wiki TypeScript typecheck 与 mock tests：通过。
- LLM Wiki MCP：`20/20`。
- Studio 产品聚焦 Vitest：`185/185`。
- Studio 最终 Playwright：单 worker，`40/40`；包含登录、聊天、History、Group Chat、Workflow、Terminal、Voice、原导航，以及 375/390 px 工作台响应式用例。
- 新会话记忆模式聚焦 Vitest：`14/14`。
- Studio 生产构建与 `harness:check`：通过。
- research Profile 初始化、备份/恢复 smoke：通过。
- 100 篇知识库流程：`uploads=0`（SHA-256 复用）、`trustedDrafts=100`、`pendingDrafts=0`、正式论文页 `100`；报告见 `validation/knowledge-flow-report.json`。
- 关键词 + 图谱复验：检索 `photonic transformer accelerator` 返回 `10` 条，向量命中 `0`、图谱命中 `3`；图谱 `103` 节点、`100` 条关系；Ollama 进程 `0`。
- 证据复验：样例页面含 `## Page N` 与 EvidenceLocator，PDF Range 返回 `206`、`bytes 0-15/5464209`，共读取 `16` 字节。
- 实际浏览器复验：工作台显示 `今日论文 100`、`0 篇待审核`、`可信知识库 100`；知识库页面有 `100` 条“已入库”，图谱弹窗显示 `节点 103`、`关系 100`。
- 安全复验：Studio/Wiki/Clip/Bridge 仅监听 `127.0.0.1`；关键未授权接口和 Wiki projects 均返回 `401`；恶意 Origin 无 CORS 放行；Token 扫描无匹配。
- Tauri release 复验：已生成最新 `target/release/llm-wiki.exe`，启动器运行该 EXE 后 `/api/v1/health` 返回 `status=running`、`studioManaged=true`、`enabled=true`、`authConfigured=true`、`allowUnauthenticated=false`、`allowLanAccess=false` 和 `retrievalMode=keyword_graph`；`1420` 未监听，未发现属于 `llm-wiki.exe` 的 WebView 子进程或托盘创建。
- 无窗口严格摄入复验：在隔离临时项目上传已批准 PDF 后，后台队列进入 `awaiting_review`（11 页、1 项拟变更）；批准后状态为 `trusted`，正式 Wiki 页面、原始 PDF 与可信源记录均存在；随后已恢复原 `LLM-Wiki` 项目。
- 当前浏览器会话已过期，登录后知识库管理页的本轮人工视觉验收待重新登录执行；生产构建、Studio BFF 契约测试及真实后台服务验证均已通过。

完整 Studio Vitest 不能声明全量通过。未纳入上述 `185/185` 的上游测试在本 Windows 环境仍受 fixture 路径、symlink 权限和机器上真实系统 Skill 污染影响；这些环境失败应与本产品聚焦回归分开处理。

## 尚未完成的验收

- 用 50 个研究问题验收 Top 5、事实结论引用覆盖率、引用页码匹配率和检索延迟；本次已完成 100 篇流程级验证，但未完成问题集质量验收。
- 在目标 Windows 工具链上重新生成 MSI/NSIS 安装包，并用安装包做一次独立验证；当前已验证的是 release EXE。
- 配置公司批准的公网 DeepSeek 端点与凭据；当前 UI 中的本地模型不是计划中的 DeepSeek 配置。
- 在真实数据规模上完成一次全量备份恢复并测量 RPO/RTO；现有结果为自动化 smoke，不等同于生产演练。
- 正式公司使用前完成 Hermes Studio BSL-1.1 商业授权/法务意见、GPL-3.0 分发义务确认和安全审计。

## 复现入口

当前验收实例：`http://127.0.0.1:8648/#/hermes/workbench`

从仓库根目录运行：

```powershell
.\Start-AGNET.cmd
```

主要说明见 `docs/SETUP-WINDOWS.md`；产品需求基线见 `plan.md`。上游 LLM Wiki README 描述的是通用能力，AGNET 的严格审核与 research 只读边界以根目录需求、启动配置和运行时契约为准。
