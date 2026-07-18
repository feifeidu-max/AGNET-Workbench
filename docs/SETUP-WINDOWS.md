# Windows 安装与运维

## 1. 前置条件

- Windows 10/11 x64，PowerShell 5.1 或更高版本。
- Node.js 23+（推荐 24 LTS）与 pnpm。
- Hermes Agent `0.18.2`，执行 `hermes --version` 必须返回该版本。
- LLM Wiki 的 Embedding 设置保持关闭；本项目使用关键词检索与知识图谱，不需要 Ollama 或 embedding 模型。
- 构建 LLM Wiki 时需要 Rust stable、Tauri 2 所需的 Visual Studio C++ Build Tools 和 WebView2。
- DeepSeek 等公网模型密钥仅配置在 Hermes/LLM Wiki 的凭据入口，不写入本仓库。

版本基线记录在 `ops/versions.lock.json`。Studio 和 Wiki 是已修改的 fork，锁定的 commit 表示上游基线，不表示当前工作树必须与上游逐字节相同。

建议把锁定版 Hermes 安装到仓库内的专用虚拟环境，避免覆盖机器上已有的旧版 Hermes：

```powershell
$hermesVenv = Join-Path $PWD ".runtime\hermes-0.18.2"
py -m venv $hermesVenv
& "$hermesVenv\Scripts\python.exe" -m pip install --upgrade "hermes-agent==0.18.2"
& "$hermesVenv\Scripts\hermes.exe" --version
```

随后把 `ops/config.local.psd1` 的 `HermesExecutable` 设置为上述 `hermes.exe` 的路径。若仓库目录包含中文，建议使用相对仓库根目录的路径（例如 `.runtime\hermes-0.18.2\Scripts\hermes.exe`），避免 Windows PowerShell 5 读取 UTF-8 数据文件时误解码；启动器会再次核验版本，检测到旧版或其他 Python 环境时会拒绝继续启动。

## 2. 构建固定源码

在仓库根目录运行：

```powershell
Set-Location .\apps\hermes-studio
pnpm install --frozen-lockfile
pnpm run build

Set-Location ..\llm-wiki
npm ci
npm run tauri build
```

将生成的 `llm-wiki.exe` 绝对路径写入本地配置；不要把本地配置提交到 Git：

```powershell
Set-Location ..\..
Copy-Item .\ops\config.example.psd1 .\ops\config.local.psd1
notepad .\ops\config.local.psd1
```

至少确认 `LlmWikiExecutable`、`WikiProjectPaths` 和备份盘符。`HermesHome` 留空时会按 Studio 的 Windows 规则自动发现。`LlmWikiMcpEntrypoint` 默认使用本仓库的 MCP 构建产物，只有 MCP 单独安装在其他位置时才需要覆盖。

## 3. 创建本地 API Token

生成 32 字节随机令牌并保存为当前用户环境变量。令牌不会显示在命令输出中，也不能填进 `config.local.psd1`：

```powershell
$bytes = New-Object byte[] 32
$rng = [Security.Cryptography.RandomNumberGenerator]::Create()
$rng.GetBytes($bytes)
$rng.Dispose()
$token = [Convert]::ToBase64String($bytes)
[Environment]::SetEnvironmentVariable("AGNET_LLM_WIKI_API_TOKEN", $token, "User")
$env:AGNET_LLM_WIKI_API_TOKEN = $token
Remove-Variable token, bytes
```

启动器把该值注入 LLM Wiki 与 Studio 进程环境。Hermes 的 MCP 环境过滤默认不会向子进程传递 Token；`research` Profile 只保存 `${LLM_WIKI_API_TOKEN}` 占位符，由启动器在运行时解析并仅传给 LLM Wiki MCP。任何 `config.yaml`、`.env` 或 `config.local.psd1` 都不得保存真实 Token。LLM Wiki 必须保持：API 开启、匿名访问关闭、LAN 访问关闭。首次使用时创建知识库项目，并保证路径与 `WikiProjectPaths` 一致；当配置中恰好有一个存在的 Wiki 路径时，启动器会自动把它选为当前项目，其他情况仍需在 LLM Wiki 中手动选择。

## 4. 初始化 research Profile

首次启动会自动执行等价于下面的幂等初始化；也可以提前手动运行：

```powershell
.\ops\Initialize-ResearchProfile.ps1
```

Profile 不存在时，脚本调用 `hermes profile create research --clone --no-alias`，即按 Hermes 0.18.2 的正式参数从当前活动 Profile 克隆配置、SOUL 和 Skills，但不会切换当前活动 Profile，也不会创建额外命令别名。Profile 已存在时不会重新克隆或清空用户配置，只会合并以下 AGNET 约束：

- 配置本仓库 LLM Wiki MCP 构建产物，强制 `LLM_WIKI_MCP_TOOLSET=research`，将 `platform_toolsets.cli` 固定为仅允许 `llm-wiki`，并通过 Profile `.env` 的 `HERMES_BRIDGE_TOOLSETS=llm-wiki` 覆盖 Bridge 默认工具恢复；Studio research 会话只能看到 `search/read/graph` 三个只读工具，终端、文件写入及其他 MCP 不会启用。
- `skills.disabled` 增加内置 `llm-wiki` Skill，避免维护第二套 Wiki。
- MCP Token 只保留环境变量占位符；若克隆来源的 `.env` 曾误存 Wiki Token，对应项会从 `research` 副本移除。
- Hermes 会自动恢复的 `kanban/context_engine` 在 research Profile 中显式禁用。其他 MCP 定义、非 CLI 平台、模型、SOUL、Skills 和用户自定义键保持原值；其他 MCP 虽仍在配置中，但不进入 research 的 Studio/CLI 工具白名单。

## 5. 首次启动

```powershell
.\Start-AGNET.cmd
```

启动器会执行以下门禁：

1. 校验 Hermes Agent、Studio 和 Wiki 版本。
2. 幂等初始化或校验 `research` Profile、只读 MCP 和禁用 Skill。
3. 确认 LLM Wiki 采用关键词 + 知识图谱检索模式；启动器会自动设置该运行时边界。
4. 检查 LLM Wiki 健康状态及带 Token 的 `/projects` 请求。
5. 检查 Studio `/health`，并确认启动服务没有监听 LAN 地址。
6. 打开 `http://127.0.0.1:8648`。

首次登录使用 `admin / 123456`，必须立即按界面要求修改默认账号和密码。登录会话有效期由启动器固定为 12 小时。

## 6. 自动启动与每日备份

```powershell
PowerShell -ExecutionPolicy Bypass -File .\ops\Register-AGNETTasks.ps1
```

该命令以当前 Windows 用户、`Limited` 权限注册两个任务：登录后启动工作台，以及每天按 `DailyBackupTime` 备份。默认备份目录为 `D:\AGNET-Backups`，保留最新 30 份。取消注册：

Windows 系统时区应设为 `China Standard Time`（Asia/Shanghai），否则 09:00 指标任务和每日备份会按错误的本地时区触发。

```powershell
.\ops\Register-AGNETTasks.ps1 -Unregister
```

手动备份：

```powershell
.\ops\Backup-AGNET.ps1
```

备份包含 Hermes Profile 的 `state.db`、Studio 的 `hermes-web-ui.db`、记忆/技能的非凭据文件、Wiki 原文/正式页/草稿审核状态和公司指标数据库。SQLite 使用一致性快照；目录在复制前后做 SHA-256 对比。若会话或文本中检出常见明文 API Key，整次备份失败并删除临时目录。`.env`、Token、认证 JSON 和私钥类文件始终排除。

## 7. 恢复演练

先退出 LLM Wiki 托盘程序并停止 Studio，确认 `8648`、`19828`、`8642` 均无监听。Studio 可用以下命令停止：

```powershell
node .\apps\hermes-studio\bin\hermes-web-ui.mjs stop
```

检查目标备份中的 `manifest.json`，然后执行：

```powershell
.\ops\Restore-AGNET.ps1 `
  -BackupPath "D:\AGNET-Backups\20260716T180000" `
  -ConfirmRestore `
  -Overwrite
```

恢复会先验证全部文件哈希、SQLite 完整性、版本锁和目标目录边界，再暂存并替换；中途失败会恢复原文件。恢复后用启动器重新启动，并抽查一次会话、记忆、论文引用、待审核草稿和公司报告。完整演练目标为 RTO 不高于 2 小时。

## 8. 故障定位

- Studio 健康检查：`Invoke-RestMethod http://127.0.0.1:8648/health`
- Wiki 健康检查：`Invoke-RestMethod http://127.0.0.1:19828/api/v1/health`
- Studio 日志：`%USERPROFILE%\.hermes-web-ui\server.log`，或本地配置中的 `StudioDataHome`。
- Research Profile 配置：`hermes -p research config path`；MCP 列表：`hermes -p research mcp list`。
- 端口暴露检查：`Get-NetTCPConnection -State Listen | Where-Object LocalPort -in 8648,19828,8642`

不要把 Token 粘贴到故障日志、Wiki、Memory、聊天会话或备份目录。脚本不会备份 LLM Wiki 的 LanceDB；批准后的原文与 Markdown 是恢复源。本项目的关键词 + 图谱模式不使用向量索引，恢复后无需重建 embedding。
