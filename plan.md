基于 Hermes Studio、Hermes Agent 与 LLM Wiki 的本地智能工作台
产品定义
首期定位为 Windows 单用户、localhost 登录、非商用验证原型。保留 Hermes Studio 现有全部页面、接口和功能，只调整导航层级并新增三个相互隔离的业务域：
Hermes Studio 统一 Web 工作台
├─ Hermes 通用对话与长期记忆 -> 公网 DeepSeek v4
├─ 个人知识库 -> LLM Wiki API/MCP -> 公共论文可调用 DeepSeek
└─ 公司指标 -> 官方接口/模拟连接器 -> 本地快照与报告，禁止进入 Agent/LLM
一级导航：个人工作台、Hermes 对话、个人知识库、公司数据、定时报告、记忆管理。
Studio 原有 History、Workflow、Jobs、Skills、MCP、Files、Coding Agents、Logs、Models 等统一放入二级“全部功能”，路由和 API 不删除、不破坏。
登录后进入个人工作台，展示今日论文、待审核数量、知识库规模、公司指标新鲜度、下一次报告和各服务健康状态。
不修改 Hermes Agent 核心循环，通过 Studio Bridge、Session、MCP 和独立业务模块扩展。
个人知识库
基线固定为 nashsu/llm_wiki v0.6.4（提交 03e46fc4），作为独立 GPL-3.0 进程运行；Studio 通过其 127.0.0.1:19828 API 深度接入，Hermes 通过官方 MCP/Skill 只读查询。
复用 LLM Wiki 的 PDFium、两阶段知识编译、持久队列、Markdown Wiki、知识图谱、LanceDB、项目迁移和 Review 基础。
Studio 的知识库页面提供：PDF 批量上传、处理进度、待审核草稿、页面差异、批准/退回重做/拒绝、已入库列表、搜索、Wiki 问答、待读候选箱和图谱入口。
上传状态机固定为：uploaded -> parsing -> drafting -> awaiting_review -> publishing -> trusted；另有 revision_requested、rejected、failed。
原始 PDF、AI 分析、拟新增页面和拟修改页面先放入 .llm-wiki/staging/<draftId>；批准前不得写入正式 wiki/、raw/sources/ 或 LanceDB。
同一时刻只允许一个草稿等待发布，后续论文继续排队，避免多个草稿基于过期 Wiki 并产生覆盖冲突。
批准时在项目锁内原子移动 PDF、应用整组变更、更新 index/log/overview、生成 embedding；失败时整体回滚。
所有 LLM Wiki 输入入口，包括桌面导入、目录监听、定时导入、Web Clipper 和 Deep Research，启用严格模式后都必须经过同一审核门。
PDFium 已提供 ## Page N 页边界；生成页面新增结构化 EvidenceLocator {sourceId, revision, page, section, snippetHash}。Hermes 输出 【作者, 年份, p.N】，点击后打开 PDF 对应页。
本地向量检索沿用 LanceDB，使用本机 Ollama 的 bge-m3 embedding；Ollama 不运行生成模型。
Hermes 创建独立 research Profile，只开放 LLM Wiki 的 search/read/graph 工具，不开放 Wiki 写入、终端或公司数据工具。
查询必须先检索已批准 Wiki；本地证据不足时自动查询 OpenAlex、Crossref 和 arXiv，答案分开标记本地证据与外部摘要证据。
外部论文只保存题录、摘要、链接和推荐理由到“待读候选箱”，不自动下载、不进入 Wiki；用户阅读并手动上传后才进入审核流程。
首期不实现个人笔记。Hermes 内置的 llm-wiki Skill 停用，避免生成第二套 Wiki。
记忆管理
Studio Session 新增 memory_mode: "on" | "clean"，贯穿 Session SQLite、聊天请求、上下文估算、Socket 队列、TypeScript Bridge 和 Python Bridge。
新建会话时通过醒目的开关选择“开启长期记忆”或“关闭长期记忆”；首条消息发出后模式锁定并在顶部持续显示，改变模式需新建会话。
on 使用 Hermes 标准行为；clean 使用 AIAgent(skip_memory=True)，排除 MEMORY.md、USER.md、memory 工具、外部记忆 Provider 和 session_search，但保留用户指定的 SOUL.md、Skills 和当前工作区上下文。
模式切换必须重建 Agent 和系统提示缓存；上下文 Token 估算使用同一模式。
记忆页直接对应当前 Profile 的 MEMORY.md、USER.md、SOUL.md，显示真实路径、更新时间、字符预算、生效状态、Markdown 预览和“打开原始文档”入口。
保存采用 revision/If-Match、原子写、历史版本和恢复；增加密钥及敏感内容扫描。SOUL.md 在两种会话模式下均生效。
页面明确提示：开启记忆会把 MEMORY.md 和 USER.md 发给公网 DeepSeek，只允许写入非敏感偏好和稳定事实。
公司指标与报告
公司域作为 Studio 内独立模块，使用单独的 company-metrics.sqlite、凭据、路由和日志；不注册 MCP，不向 Hermes 或 DeepSeek暴露。
定义统一连接器接口：testConnection()、listMetricDefinitions()、fetchSnapshot(asOf)；禁止通用 SQL、写操作和浏览器抓取。
因真实平台资料尚未取得，原型交付 MockConnector 和 3-5 个可配置指标；真实连接器在提供 API 文档、鉴权方式、指标口径和阈值后替换，预计追加 1-2 周。
每个指标保存名称、单位、方向、口径版本、阈值规则、当前值、源数据时间、请求 ID 和刷新时间。
每周一至周五 09:00（Asia/Shanghai）采集一次并生成站内报告，同时支持手动刷新；首期不处理法定节假日调休。
异常完全由上下限、环比阈值和连续异常规则判定；报告采用确定性模板，包含当前值、上一工作日变化、阈值状态和数据新鲜度，不调用 LLM。
Windows 登录后自动启动；09:00 后首次启动且当天无报告时只补跑一次，使用 reportDate 幂等键防止重复。
采集失败时生成失败记录，不得把旧数据伪装成当天结果。
接口与交付
Studio 新增 /hermes/workbench、/hermes/knowledge、/hermes/company-metrics、/hermes/reports；登录成功默认进入工作台。
LLM Wiki fork 新增 ingest-drafts 的上传、列表、详情、批准、重做、拒绝接口，以及 reading-candidates 搜索和状态接口；PDF 下载接口支持鉴权、Range 和页码跳转。
Studio BFF 代理全部 LLM Wiki 请求并保管 API Token，浏览器不得直接接触 19828 Token 或本地绝对路径。
固定 Hermes Agent 0.18.2、Studio 提交 5be8548、LLM Wiki v0.6.4；三者分别维护上游 remote、版本锁和契约测试。
Windows 一键启动器依次启动 Ollama、LLM Wiki 托盘进程、Hermes Studio，并在健康检查通过后打开 http://127.0.0.1:8648。
所有服务只绑定 127.0.0.1；禁用 wildcard CORS，首次登录强制修改 admin/123456，会话有效期设为 12 小时。
每日备份 Hermes Profile、Session、Wiki 原文/正式页/审核状态和指标数据库，默认保留 30 份；本机默认目标为 D:\AGNET-Backups，不备份明文 API Key。
排期与验收
单人开发预计 14-16 周：2 周完成基线、工作台与记忆模式；5 周完成 LLM Wiki 严格草稿、API 和页码证据；3 周完成 Studio 知识库 UI、Hermes MCP 与外部候选箱；2 周完成公司模拟看板和报告；2 周完成启动器、备份、安全与回归，另留 1-2 周缓冲。
验收采用至少 100 篇中英文原生 PDF 和 50 个研究问题：
PDF 成功进入待审核草稿率不低于 95%，SHA-256 重复识别率 100%。
未批准草稿被正式搜索、向量检索或 Hermes 引用的次数为 0。
批准后 2 分钟内可检索；500 篇规模下本地检索 P95 不高于 2 秒，不含 DeepSeek 生成时间。
已有相关论文时进入 Top 5 的比例不低于 90%；事实性结论引用覆盖率不低于 95%，无虚构 source ID。
引用页码与原文匹配率不低于 95%，点击引用可打开正确 PDF 页。
外部搜索结果进入正式 Wiki 的未审核次数为 0。
clean 会话请求中不存在 MEMORY/USER 哨兵内容和记忆工具，但仍包含 SOUL；进程重启和会话恢复后结果一致。
公司模拟指标计算、阈值和报告内容 100% 与输入一致，重复报告为 0，向 DeepSeek 发送公司数据的请求为 0。
原 Studio 路由、API、聊天、Jobs、Skills、MCP、Files 和登录流程全部通过回归测试。
端口扫描仅本机可达；未授权 API 返回 401/403；日志、Wiki、Memory 和备份中不得出现 API Key。
完成一次全量备份恢复演练，RPO 不高于 24 小时、RTO 不高于 2 小时。
前置门禁
首期仅限个人非商用原型。Hermes Agent 为 MIT；Hermes Studio 是 BSL-1.1，正式公司使用前必须取得 EKKOLearnAI 商业授权或法务书面意见；LLM Wiki 为 GPL-3.0，应保持独立进程、独立源码和许可证，向外分发修改版时按 GPL 提供对应源码。扩大到部门、接入正式经营数据或部署生产环境前，还需完成真实 API 接入、公司批准的模型端点、权限审计和常开主机方案。