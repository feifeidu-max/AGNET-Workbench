# Docker 部署指南（Hermes Studio + LLM Wiki）

本文档说明如何把本项目一键打包为 Docker 容器，方便后续维护者快速拉起整套服务。

## 1. 架构说明

- **hermes-webui**：Hermes Studio 前端 + 服务端（基于官方基础镜像 `nousresearch/hermes-agent:latest`），对外暴露 Web 端口（默认 6060）。
- **llm-wiki**（知识库，可选）：本地知识库 / 检索服务，以无界面（headless）模式运行在 19828 端口，为「知识图谱」「论文推荐」等功能提供数据。

两个服务通过 Docker 内部网络互联。WebUI 通过 `LLM_WIKI_BASE_URL=http://llm-wiki:19828/api/v1` 访问知识库；为了允许跨容器访问，WebUI 端设置了 `LLM_WIKI_ALLOW_REMOTE=1`（默认仍强制 loopback，仅此开关放开，不影响本地部署的安全性）。

> 注意：LLM Wiki 是 Tauri 应用，即使在 headless 模式也会链接 WebKit，因此其镜像构建较重（含 Rust 编译）。若该服务构建失败，不会影响 hermes-webui 的单独部署（见下方「排错」）。

## 2. 前置条件

- 已安装 Docker Engine 或 Docker Desktop（Linux 需 Docker Compose v2）。
- 在本项目根目录执行命令。

## 3. 一行指令部署（推荐）

```bash
# 方式 A：脚本自动准备 .env（随机令牌）+ 拉起完整栈
./start.sh            # Linux / macOS / WSL
# 或
.\start.ps1           # Windows PowerShell

# 方式 B：零配置文件，直接用默认令牌拉起完整栈（仅本机）
docker compose --profile kb up -d
```

脚本会在缺少 `.env` 时自动复制 `.env.example` 并把占位令牌替换为随机值；之后
自动构建（首次）并启动 WebUI 与 LLM Wiki。首次构建含 Rust 编译，可能耗时数分钟。
代码更新后需重建镜像时执行： `docker compose --profile kb build`。

启动后访问：

- Hermes Studio： http://localhost:6060
- LLM Wiki API： http://localhost:19828/api/v1 （仅启用 kb 时）

查看日志：

```bash
docker compose logs -f hermes-webui
docker compose --profile kb logs -f llm-wiki
```

## 4. 配置项（.env）

| 变量 | 说明 | 默认 |
|---|---|---|
| PORT | WebUI 暴露端口 | 6060 |
| PREVIEW_FRONTEND_PORT | 预览前端端口 | 8651 |
| XAI_OAUTH_PORT | XAI OAuth 回调端口 | 56121 |
| HERMES_DATA_DIR | WebUI 数据卷（持久化对话/配置） | ./hermes_data |
| HERMES_WEB_UI_AUTH_JWT_EXPIRES_IN | 登录 JWT 有效期 | 30d |
| WIKI_PORT | 知识库暴露端口 | 19828 |
| WIKI_DATA_DIR | 知识库数据卷（挂载到容器 HOME） | ./wiki_data |
| LLM_WIKI_API_TOKEN | WebUI 与知识库共享令牌（**务必修改**） | change-me-in-prod |
| LLM_WIKI_LLM_PROVIDER | 知识库富化模型提供方 | custom |
| LLM_WIKI_LLM_MODEL | 富化/重排模型 | mimo-v2.5 |
| LLM_WIKI_LLM_API_KEY | 富化模型 Key | — |
| LLM_WIKI_LLM_CUSTOM_ENDPOINT | 富化模型 endpoint | https://opencode.ai/zen/go/v1 |
| LLM_WIKI_LLM_MAX_TOKENS | 富化单次最大 tokens | 65536 |
| LLM_WIKI_INGEST_ENRICHMENT | 微信/生成类草稿批准入库前的离线语义增强开关（0 关闭） | 1（开启） |
| OPENCODE_GO_API_KEY | Hermes 对话模型 Key（与富化共用） | — |
| HTTP_PROXY / HTTPS_PROXY | 需代理访问外网时（如 Clash 7897） | — |
| NO_PROXY | 本机直连白名单 | 127.0.0.1,localhost,::1 |
| WEBUI_IMAGE / WIKI_IMAGE | 自定义镜像名 | — |

## 5. 数据持久化

- `HERMES_DATA_DIR`（默认 `./hermes_data`）挂载到容器内 `/home/agent/.hermes` 与 `/home/agent/.hermes-web-ui`，保存账号、对话、配置。
- `WIKI_DATA_DIR`（默认 `./wiki_data`）挂载到知识库容器的 HOME，保存知识库项目 / 论文。

删除容器不会丢失数据；删除对应的卷才会。

## 6. 初始化知识库（kb 模式）

LLM Wiki 首次启动为空，需要创建一个知识库项目并导入论文（wiki/papers）：

1. 通过 WebUI「知识库管理」页面上传 PDF / Markdown；
2. 或使用 LLM Wiki 的 `/api/v1` 接口（需带 `Authorization: Bearer <LLM_WIKI_API_TOKEN>`）导入。

数据会写入挂载的 `WIKI_DATA_DIR` 卷中。

## 7. 已知限制与排错

- **Docker 守护进程需先启动**：本机若未启动 Docker Desktop / Docker Engine，`docker compose` 会报错。
- **llm-wiki 镜像构建**：基于 Tauri，需 WebKit/GTK 依赖与 Rust 编译。若基础发行版与 `apps/llm-wiki/Dockerfile.llm-wiki` 假设的 Debian bookworm 不同，可能需要调整 apt 包名；构建失败时不影响 `hermes-webui` 单独运行（可先 `docker compose up -d` 验证 WebUI）。
- **知识库网络连通**：WebUI 通过服务名 `llm-wiki` 访问；若未启用 kb profile，WebUI 会显示「知识库不可用」但其余功能正常。
- **生产环境建议**：修改默认 `LLM_WIKI_API_TOKEN`；在 WebUI 前加反向代理并启用 HTTPS；按需开启账号登录（`HERMES_WEB_UI_ENABLE_AUTH=true`）。

## 8. 仅构建单个镜像

```bash
docker build -t hermes-web-ui:local ./apps/hermes-studio
docker build -t llm-wiki:local -f apps/llm-wiki/Dockerfile.llm-wiki ./apps/llm-wiki
```
