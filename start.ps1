# AGNET 一行指令部署（Windows）：自动准备 .env 并拉起完整栈（WebUI + 知识库）
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Definition
Set-Location $root

# 1. 缺少 .env 时，复制模板并把占位令牌替换为随机值
if (-not (Test-Path .env)) {
    Copy-Item .env.example .env
    $bytes = New-Object byte[] 24
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    $rng.GetBytes($bytes)
    $rng.Dispose()
    $token = [BitConverter]::ToString($bytes) -replace '-', ''
    (Get-Content .env) -replace '^LLM_WIKI_API_TOKEN=.*', "LLM_WIKI_API_TOKEN=$token" | Set-Content .env
    Write-Host "[ok] 已生成 .env（含随机 LLM_WIKI_API_TOKEN）"
}

# 2. 读取端口用于提示
$port = '6060'; $wikiPort = '19828'
if (Test-Path .env) {
    $portLine = Get-Content .env | Where-Object { $_ -match '^PORT=' } | Select-Object -First 1
    $wikiLine = Get-Content .env | Where-Object { $_ -match '^WIKI_PORT=' } | Select-Object -First 1
    if ($portLine) { $port = $portLine -replace 'PORT=', '' }
    if ($wikiLine) { $wikiPort = $wikiLine -replace 'WIKI_PORT=', '' }
}

Write-Host "==> 拉起完整栈（含知识库；首次会自动构建镜像，含 Rust 编译，可能耗时数分钟）"
docker compose --profile kb up -d

Write-Host ""
Write-Host "部署完成："
Write-Host "  Hermes Studio : http://localhost:$port"
Write-Host "  知识库 API    : http://localhost:$wikiPort/api/v1"
Write-Host "查看日志      : docker compose --profile kb logs -f"
Write-Host "停止服务      : docker compose --profile kb down"
