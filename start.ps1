# AGNET 一行指令部署（Windows）：自动准备 .env 并拉起完整栈（WebUI + 知识库）
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Definition
Set-Location $root

# 0. 预检：Docker 引擎必须可用（Docker Desktop 需先启动，否则 compose 会静默失败）
Write-Host "==> 检查 Docker 引擎..."
cmd /c "docker info >nul 2>&1"
if ($LASTEXITCODE -ne 0) {
    Write-Host "[错误] 无法连接 Docker 引擎。请先启动 Docker Desktop，待其显示 ""Engine running"" 后重新运行本脚本。" -ForegroundColor Red
    exit 1
}
Write-Host "[ok] Docker 引擎已就绪"

# 1. 缺少 .env 时，复制模板并把占位令牌替换为随机值
if (-not (Test-Path .env)) {
    Copy-Item .env.example .env
    $bytes = New-Object byte[] 24
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    $rng.GetBytes($bytes)
    $rng.Dispose()
    $token = [BitConverter]::ToString($bytes) -replace '-', ''
    $envLines = Get-Content .env -Encoding UTF8 | ForEach-Object {
        $_ -replace '^LLM_WIKI_API_TOKEN=.*', "LLM_WIKI_API_TOKEN=$token"
    }
    # 以 UTF-8（无 BOM）写回，保持与 .env.example 一致，避免 PS 5.1 按 ANSI 写坏中文注释
    [System.IO.File]::WriteAllLines(
        (Join-Path $PWD '.env'),
        $envLines,
        (New-Object -TypeName System.Text.UTF8Encoding -ArgumentList $false)
    )
    Write-Host "[ok] 已生成 .env（含随机 LLM_WIKI_API_TOKEN）"
}

# 2. 读取端口用于提示
$port = '6060'; $wikiPort = '19828'
if (Test-Path .env) {
    $portLine = Get-Content .env -Encoding UTF8 | Where-Object { $_ -match '^PORT=' } | Select-Object -First 1
    $wikiLine = Get-Content .env -Encoding UTF8 | Where-Object { $_ -match '^WIKI_PORT=' } | Select-Object -First 1
    if ($portLine) { $port = $portLine -replace 'PORT=', '' }
    if ($wikiLine) { $wikiPort = $wikiLine -replace 'WIKI_PORT=', '' }
}

Write-Host "==> 拉起完整栈（含知识库；首次会自动构建镜像，含 Rust 编译，可能耗时数分钟）"
cmd /c "docker compose --profile kb up -d 2>&1"
if ($LASTEXITCODE -ne 0) {
    Write-Host "[错误] docker compose 启动失败，请检查上方日志。" -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "部署完成："
Write-Host "  Hermes Studio : http://localhost:$port"
Write-Host "  知识库 API    : http://localhost:$wikiPort/api/v1"
Write-Host "查看日志      : docker compose --profile kb logs -f"
Write-Host "停止服务      : docker compose --profile kb down"
