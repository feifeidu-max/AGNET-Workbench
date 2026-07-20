# 公司数据导入与运行手册

本文说明 AGNET 当前版本的公司数据边界、日常操作、数据存储、定时报告，以及接入真实公司平台前必须完成的开发工作。

## 先看结论

当前仓库交付的是公司指标原型，不是生产数据导入工具：

- 当前唯一连接器是 `MockMetricsConnector`，生成脱敏的确定性模拟数据。
- “公司数据”页面目前没有 CSV、Excel、数据库文件或 HTTP API 的上传入口。
- 不能把 Excel/CSV 直接复制到 `company-metrics.sqlite`，也不应手工修改 SQLite 表来伪造快照。
- 手动刷新和定时报告都只会调用当前连接器；当前连接器不会访问真实公司平台。
- 公司指标数据库独立于 Hermes Profile，不会注册为 MCP，也不会发送给 Hermes、DeepSeek 或其他 LLM。

因此，使用者现在可以直接查看和刷新模拟数据；要导入真实经营数据，必须先实现并验收一个正式 `MetricsConnector`，而不是仅修改本地配置文件。

## 一、当前功能能做什么

### 1. 当前演示指标

当前模拟连接器提供 5 个指标：

| 指标 ID | 页面名称 | 单位 | 越高/越低 | 当前阈值 |
| --- | --- | --- | --- | --- |
| `business_volume` | 业务处理量 | 笔 | 越高越好 | 日变化超过 35% 预警 |
| `completion_rate` | 任务完成率 | `%` | 越高越好 | 低于 92% 预警，低于 88% 严重 |
| `exception_count` | 异常数量 | 项 | 越低越好 | 高于 5 预警，高于 10 严重；连续 2 次异常升级 |
| `average_duration` | 平均处理时长 | 分钟 | 越低越好 | 高于 45 预警，高于 60 严重 |
| `availability` | 平台可用率 | `%` | 越高越好 | 低于 99.5% 预警，低于 99% 严重 |

模拟值根据日期生成稳定种子。同一天重复刷新时，指标值具有可重复性，但它们不代表真实生产经营数据。

### 2. 手动查看和刷新

1. 启动 AGNET：

   ```powershell
   .\Start-AGNET.cmd
   ```

2. 打开 [http://127.0.0.1:8648](http://127.0.0.1:8648)，登录 Studio。
3. 在左侧一级导航打开“公司数据”。
4. 查看当前指标、状态、上一工作日变化、源数据时间和口径版本。
5. 点击右上角“立即采集”。该操作会强制重新获取当前连接器快照，并重新生成当天日报。
6. 打开“定时报告”，查看日报正文、异常摘要以及采集成功/失败记录。

手动刷新不会调用 LLM；报告由本地阈值和确定性模板生成。

### 3. 本地 API 检查

以下 API 由 Hermes Studio 提供，实际调用需要 Studio 的登录会话。最稳妥的方式是在浏览器中使用页面按钮；不要把 Hermes 上游模型 Key 或公司 API Key 放进 URL。

```text
GET  /api/company-metrics/summary
POST /api/company-metrics/refresh
GET  /api/company-metrics/reports?limit=30
GET  /api/company-metrics/reports/YYYY-MM-DD
```

返回内容重点如下：

- `connector`: 连接器健康状态、连接器 ID 和检查时间。
- `metrics`: 最新日报中的指标评估结果。
- `snapshot`: 最近一次原始快照及其 `sourceTimestamp`、`requestId`。
- `status`: `not_run`、`success` 或 `failed`。
- `nextRun`: 下一次工作日定时报告时间。

如果直接用 PowerShell 调 API，应先从浏览器开发者工具或 Studio 登录状态获得合法的本地会话，不要自行关闭鉴权。

## 二、定时采集和报告

### 1. 定时规则

系统使用 `Asia/Shanghai` 口径：

- 周一至周五 09:00 后执行当天报告。
- Studio 启动后会立即检查当天报告是否存在。
- 09:00 后启动且当天没有报告时，会补跑一次。
- 同一个 `reportDate` 已有报告时，普通调度不会重复生成。
- 页面上的“立即采集”使用强制刷新，会覆盖当天报告记录。

### 2. 注册 Windows 任务

需要登录后自动启动和执行每日备份时，在仓库根目录运行：

```powershell
.\ops\Register-AGNETTasks.ps1
```

注册前确认 Windows 时区为 `China Standard Time`。取消注册：

```powershell
.\ops\Register-AGNETTasks.ps1 -Unregister
```

任务注册只负责启动/备份；公司指标本身的 09:00 判断由 Studio 内置 scheduler 执行。

## 三、数据保存在哪里

### 1. 数据库路径

默认情况下，数据库文件名为：

```text
company-metrics.sqlite
```

在本仓库的本地配置中，`StudioDataHome` 是 `.runtime\studio-data`，所以实际路径通常是：

```text
<仓库根目录>\.runtime\studio-data\company-metrics.sqlite
```

也可以在 `ops\config.local.psd1` 中指定 `CompanyMetricsDbPath`。配置修改后必须重启 Studio 才会生效。

### 2. 数据表

数据库由 Studio 启动时自动创建两张表：

- `metric_snapshots`: 原始快照，包含连接器 ID、指标定义、指标值、采集时间和请求 ID。
- `metric_reports`: 按 `report_date` 唯一保存的日报，包含评估结果、异常数量、Markdown 报告和失败原因。

数据库使用 SQLite WAL 模式。停止 Studio 后才能进行复制、恢复或迁移；运行中不要直接编辑数据库文件。

### 3. 备份和恢复

手动备份：

```powershell
.\ops\Backup-AGNET.ps1
```

恢复前先停止 Studio 和后台服务，再按照 [Windows 安装与运行手册](SETUP-WINDOWS.md) 的恢复步骤操作。备份会把公司指标数据库作为独立组件保存，并排除 `.env`、Token、认证 JSON、私钥和其他凭据类文件。

## 四、真实公司数据应该怎样接入

### 1. 不能采用的方式

以下方式都不属于受支持的导入流程：

- 把 Excel 或 CSV 改名为 `company-metrics.sqlite`。
- 直接向 `metric_snapshots` 或 `metric_reports` 写一行数据。
- 把公司 API Key 写入 `config.local.psd1`、`.env`、README、日志或 Wiki。
- 把公司经营数据粘贴到 Hermes 对话、LLM Wiki 对话或模型提示词中。
- 仅修改前端页面，把模拟数据替换成真实数字。

这些做法会绕过时间、来源、口径、阈值和审计边界，页面可能显示数字，但不能证明数据已经正确导入。

### 2. 正式接入所需的输入资料

在开发连接器前，先准备一份经过审批的接口说明，至少包括：

| 类别 | 必须明确的内容 |
| --- | --- |
| API 地址 | 测试/生产地址、接口版本、超时、重试和限流规则 |
| 鉴权 | OAuth、签名、Bearer、服务账号或内网认证方式；密钥存储位置和轮换责任人 |
| 指标目录 | 指标 ID、中文名称、单位、精度、业务定义、统计周期 |
| 时间口径 | `asOf`、源数据时间、时区、工作日/自然日和补数规则 |
| 变化口径 | 上一工作日如何定义，环比缺失时如何处理 |
| 阈值规则 | 预警、严重、连续异常和恢复条件 |
| 权限边界 | 只读权限、允许访问的组织/项目范围和数据字段 |
| 脱敏要求 | 禁止写入日志、备份、LLM 上下文和错误消息的字段 |
| 审计要求 | 请求 ID、操作者、采集时间、源系统时间和失败记录 |

没有这些资料时，不要直接把真实 API 接入当前原型。

### 3. 连接器接口契约

正式连接器需要实现 `MetricsConnector` 接口：

```text
testConnection() -> ConnectorHealth
listMetricDefinitions() -> MetricDefinition[]
fetchSnapshot(asOf) -> MetricValue[]
```

每个指标定义必须提供：

```text
id                   稳定的机器 ID，例如 completion_rate
name                 页面显示名称
unit                 单位，例如 %、笔、分钟
decimals             页面保留的小数位
betterDirection      higher、lower 或 neutral
definitionVersion    指标口径版本
description          人类可读的指标定义
threshold            上下限、日变化和连续异常规则
```

每个快照值必须提供：

```text
metricId             必须能匹配一个已注册定义
value                数值，不能使用格式化字符串冒充数值
asOf                 本次业务统计时间
sourceTimestamp      源系统实际产生/更新时间
requestId            源 API 请求 ID 或本地生成的可追踪 ID
```

### 4. 推荐接入步骤

1. 在 `apps\hermes-studio\packages\server\src\services\company-metrics\` 新增正式连接器文件，例如 `company-platform-connector.ts`。
2. 在连接器中实现只读鉴权、超时、有限重试和响应字段校验。
3. 把源系统字段转换为上述 `MetricDefinition` 与 `MetricValue`，不要让页面直接消费源系统 JSON。
4. 在 `service.ts` 中通过明确的连接器工厂替换 `MockMetricsConnector`；不要保留“生产环境自动猜测 API”的逻辑。
5. 使用环境变量或组织批准的秘密管理器提供 Key。进程环境中只保留必要的 Key，不把 Key 写入数据库 payload、日志或报表 Markdown。
6. 为每个指标补充正常、预警、严重、缺失值、源系统超时和重复采集测试。
7. 用脱敏测试环境跑连续多天快照，验证上一工作日、跨周末、补数、重复 `reportDate` 和阈值连续异常。
8. 完成权限、脱敏、审计、备份恢复和许可证评审后，再在本地 Studio 页面验收。

### 5. CSV/Excel 数据的推荐落地方式

如果公司暂时只能提供 CSV 或 Excel，不要让浏览器直接上传到数据库。建议增加一个受控离线导入器：

1. 在隔离目录读取 CSV/Excel。
2. 校验表头、数据类型、单位、时间范围、重复行和必填指标。
3. 将每一行转换成 `MetricValue`，保留文件名、文件哈希、导入批次号和源数据时间作为审计信息。
4. 对缺失指标、重复时间点和无法解析的数值直接失败，不用 `0` 或历史值填充。
5. 先写入临时批次，全部指标通过校验后再交给连接器/服务保存快照。
6. 生成失败报告和导入摘要，人工确认后才允许进入日报。

当前仓库尚未提供这个离线导入器；在它实现前，CSV/Excel 只能作为开发测试输入，不能声称已接入公司数据。

## 五、验收清单

正式连接器交付前，逐项确认：

- [ ] 页面不再显示“只读模拟连接器”。
- [ ] `connectorId` 和 `definitionVersion` 能追溯到正式接口版本。
- [ ] 每个定义都有单位、精度、方向和阈值。
- [ ] API 超时、401/403、429、5xx、空响应和字段缺失都会形成失败记录。
- [ ] 源数据时间与采集时间分开保存，时区转换经过测试。
- [ ] 同一天重复运行不会重复创建不一致的报告。
- [ ] 缺少上一工作日数据时，变化率显示为空而不是伪造 0%。
- [ ] 报告正文不包含 API Key、Cookie、账号、客户明细或不必要的原始响应。
- [ ] 公司数据不会通过 MCP、Hermes 记忆、Wiki 对话或公网模型发送出去。
- [ ] 备份、恢复、权限和审计演练已经完成。
- [ ] 真实数据接入前已完成 Hermes Studio 商业授权和组织法务评审。

## 六、常见问题

### 点击“立即采集”后仍显示模拟数据

这是当前版本的预期行为，因为服务实例仍然使用 `MockMetricsConnector`。修改 `ops\config.local.psd1` 不会自动替换连接器；必须完成服务端连接器实现并重新构建 Studio。

### 为什么数据库里没有我导入的 Excel

当前版本没有文件导入接口。数据库只接收连接器生成的结构化快照，不会扫描任意目录，也不会自动读取 Excel/CSV。

### 报告采集失败后会不会沿用旧数据

不会。失败日报会保留失败状态和错误原因，不会把旧快照伪装成当天数据。

### 公司数据会不会被 Hermes 发送给模型

按当前实现不会。公司指标使用独立 SQLite、独立路由和本地确定性报告，不注册 MCP，也不进入 Hermes 上下文。接入真实平台后仍必须重新进行权限和数据流审计。

## 相关文件

- [根目录 README](../README.md)
- [Windows 安装与运行手册](SETUP-WINDOWS.md)
- [交付与验收状态](DELIVERY-STATUS.md)
- [许可证边界与部署门禁](LICENSE-BOUNDARIES.md)
- `apps\hermes-studio\packages\server\src\services\company-metrics\types.ts`
- `apps\hermes-studio\packages\server\src\services\company-metrics\mock-connector.ts`
- `apps\hermes-studio\packages\server\src\services\company-metrics\service.ts`
