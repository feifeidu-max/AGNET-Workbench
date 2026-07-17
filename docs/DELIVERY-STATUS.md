# AGNET 交付与验收状态

更新时间：2026-07-17 04:48（Asia/Shanghai）

## 结论

核心原型代码、Windows 构建产物和本地集成链路已经完成。当前机器上 Hermes Studio、Hermes Agent `0.18.2` Bridge、LLM Wiki `0.6.4` 和一个空的正式个人 Wiki 项目已联通；知识库审核门、只读问答、记忆模式、公司模拟指标与确定性报告均可进入实际界面。

当前状态不是生产验收完成：Ollama 与 `bge-m3` 尚未安装，公网 DeepSeek 端点/凭据未配置，真实公司连接器未提供，100 篇 PDF 与 50 个研究问题的规模验收未执行。因此当前可交付范围仍是 Windows 单用户、非商用验证原型。

## 固定版本与产物

| 组件 | 固定基线 | 当前状态 |
| --- | --- | --- |
| Hermes Agent | `0.18.2` | 已安装到 `.runtime/hermes-0.18.2`，Studio 健康检查实际报告 `v0.18.2` |
| Hermes Studio | `0.6.30` / upstream `5be8548` | 生产构建通过，运行于 `127.0.0.1:8648` |
| LLM Wiki | `v0.6.4` / upstream `03e46fc4` | EXE/MSI 已构建，API 运行于 `127.0.0.1:19828` |

产物：

- `apps/llm-wiki/src-tauri/target/release/llm-wiki.exe`
  - 82,649,088 bytes
  - SHA-256 `94ED29E7F1C7042C398F8248F47212D250252EBFC4C96C906E1DEBD54EBFBFE3`
- `apps/llm-wiki/src-tauri/target/release/bundle/msi/LLM Wiki_0.6.4_x64_en-US.msi`
  - 42,246,725 bytes
  - SHA-256 `7AC7FE6D0F27EA14CDF1395E5188E11F2D5F5F3B4B56EC1FF39369CD987AAB22`

额外 NSIS 安装包未生成：依赖下载发生网络全局超时，系统也未安装 `makensis.exe`。MSI 不受影响。

## 当前运行快照

| 服务/数据 | 当前值 |
| --- | --- |
| Studio | `http://127.0.0.1:8648`，PID `40600`，状态 `ok` |
| Agent Bridge | `127.0.0.1:18765`，状态 `ready`，Hermes `v0.18.2` |
| Studio 数据目录 | `ops/.test-runtime-browser/studio`（当前验收实例） |
| LLM Wiki | `127.0.0.1:19828`，PID `29252`，版本 `0.6.4` |
| LLM Wiki 项目 | `C:/Users/13129/Documents/LLM-Wiki`，空可信库骨架，已设为 current project |
| LLM Wiki Token | 已生成到当前 Windows 用户环境变量；未写入仓库、Profile、Wiki、日志或 app-state |
| research Profile | 已用 Hermes `0.18.2` 初始化；内置 `llm-wiki` Skill 禁用，Bridge 工具集固定为 `llm-wiki` |
| 公司数据 | `MockConnector`，5 个模拟指标；不代表真实公司经营数据 |
| Ollama | 当前未安装/未运行，`bge-m3` 尚不可用 |

仓库根部三个 upstream remote 均为 fetch-only，push URL 为 `DISABLED`。当前根工作树尚未建立首个 commit，文件基本为 untracked；交付前应由维护者审阅后创建基线提交。

## 功能状态

| 业务域 | 状态 | 说明 |
| --- | --- | --- |
| 统一工作台与六个一级入口 | 已完成 | 登录默认进入工作台，原 Studio 功能保留在高级功能区 |
| 严格论文摄入 | 已完成代码与契约测试 | 草稿、单发布锁、批准/重做/拒绝、原子发布、EvidenceLocator 与 PDF Range API 已实现；尚未用真实 100 篇论文验收 |
| Wiki 搜索与问答 | 已完成 | Studio BFF 强制本地、无状态、`readOnly=true`；浏览器不能开启写工具或外网工具 |
| research Profile/MCP | 已完成 | 只读 `search/read/graph` 工具集；公司域未注册 MCP |
| 记忆模式 | 已完成 | 新空白会话可在 `on/clean` 间选择；首条消息后锁定；`clean` 排除 MEMORY/USER 与记忆工具并保留 SOUL |
| 记忆文档管理 | 已完成 | revision/If-Match、原子写、历史恢复、敏感内容扫描与真实路径展示 |
| 公司指标与报告 | 模拟原型完成 | 独立 SQLite、确定性阈值、工作日 09:00、幂等补跑与失败记录；真实连接器待 API 文档 |
| 启动、备份与恢复 | 脚本完成 | launcher、计划任务、30 份保留、密钥排除和恢复 smoke 已通过；当前一键启动仍会在缺少 Ollama 时停止 |

## 验证结果

- LLM Wiki Rust：`338 passed, 0 failed, 1 ignored`；`cargo fmt --check` 通过。
- LLM Wiki TypeScript typecheck 与 mock tests：通过。
- LLM Wiki MCP：`20/20`。
- Studio 产品聚焦 Vitest：`185/185`。
- Studio 最终 Playwright：单 worker，`40/40`；包含登录、聊天、History、Group Chat、Workflow、Terminal、Voice、原导航，以及 375/390 px 工作台响应式用例。
- 新会话记忆模式聚焦 Vitest：`14/14`。
- Studio 生产构建与 `harness:check`：通过。
- research Profile 初始化、备份/恢复 smoke：通过。
- 实际浏览器复验：工作台显示 Wiki 已连接；知识库队列为空且可打开四个页签；空白会话可切换“开启记忆/干净上下文”。
- 安全复验：Studio/Wiki/Clip/Bridge 仅监听 `127.0.0.1`；关键未授权接口和 Wiki projects 均返回 `401`；恶意 Origin 无 CORS 放行；Token 扫描无匹配。

完整 Studio Vitest 不能声明全量通过。未纳入上述 `185/185` 的上游测试在本 Windows 环境仍受 fixture 路径、symlink 权限和机器上真实系统 Skill 污染影响；这些环境失败应与本产品聚焦回归分开处理。

## 尚未完成的验收

- 安装 Ollama，并执行 `ollama pull bge-m3`；随后验证批准后 embedding 和 500 篇规模检索 P95。
- 配置公司批准的公网 DeepSeek 端点与凭据；当前 UI 中的本地模型不是计划中的 DeepSeek 配置。
- 用至少 100 篇中英文原生 PDF 和 50 个研究问题测量草稿成功率、Top 5、引用覆盖率及页码匹配率。
- 提供公司平台 API 文档、鉴权、指标口径和阈值，替换 `MockConnector` 后再做真实数据验收。
- 在真实数据规模上完成一次全量备份恢复并测量 RPO/RTO；现有结果为自动化 smoke，不等同于生产演练。
- 正式公司使用前完成 Hermes Studio BSL-1.1 商业授权/法务意见、GPL-3.0 分发义务确认和安全审计。

## 复现入口

当前验收实例：`http://127.0.0.1:8648/#/hermes/workbench`

安装 Ollama 与 `bge-m3` 后，从仓库根目录运行：

```powershell
.\Start-AGNET.cmd
```

主要说明见 `docs/SETUP-WINDOWS.md`；产品需求基线见 `plan.md`。上游 LLM Wiki README 描述的是通用能力，AGNET 的严格审核与 research 只读边界以根目录需求、启动配置和运行时契约为准。
