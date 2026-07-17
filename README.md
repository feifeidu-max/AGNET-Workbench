# AGNET 本地智能工作台

这是基于固定上游版本组装的 Windows 单用户、`localhost` 非商用验证原型：

- Hermes Agent `0.18.2`：通用对话与长期记忆运行时。
- Hermes Studio `5be8548`：统一 Web 工作台，访问地址为 `http://127.0.0.1:8648`。
- LLM Wiki `v0.6.4` / `03e46fc4`：独立 GPL-3.0 进程，负责论文知识库与审核门。
- Ollama：仅运行 `bge-m3` embedding，不运行生成模型。

公司指标使用独立 SQLite、确定性规则和模板报告，不注册为 MCP，也不进入 Hermes 或公网 LLM 上下文。

## 目录

```text
apps/hermes-studio/       Hermes Studio fork
apps/llm-wiki/            LLM Wiki fork（独立进程）
ops/                      启动、备份、恢复、任务计划脚本
docs/SETUP-WINDOWS.md      安装与运行手册
docs/LICENSE-BOUNDARIES.md 许可证与部署门禁
docs/DELIVERY-STATUS.md     当前交付、运行与验收状态
```

## 快速入口

完成[首次安装](docs/SETUP-WINDOWS.md)后：

当前机器的实际完成度、构建哈希和未完成验收见[交付状态](docs/DELIVERY-STATUS.md)。

```powershell
.\Start-AGNET.cmd
```

启动器严格按 Ollama -> LLM Wiki -> Hermes Studio 的顺序等待健康检查，通过后才打开浏览器。三个 HTTP 服务均必须只监听 `127.0.0.1`，否则启动失败。

日常备份与开机自启：

```powershell
.\ops\Backup-AGNET.ps1
.\ops\Register-AGNETTasks.ps1
```

默认备份到 `D:\AGNET-Backups`，保留 30 份。密钥不写入配置或备份；LLM Wiki Token 只从用户环境变量读取。

> 当前范围仅限个人、非商用原型。公司正式使用、真实经营数据接入或部门部署前，必须先完成商业授权/法务评估、安全审计和公司批准的模型端点评审。
