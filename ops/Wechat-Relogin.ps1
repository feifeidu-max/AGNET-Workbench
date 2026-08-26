# 微信重新扫码登录（AGNET research profile）
# 用法：双击运行，或在 PowerShell 里执行 .\ops\Wechat-Relogin.ps1
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$env:HERMES_HOME = Join-Path $root ".runtime\hermes-home"
$hermes = Join-Path $root ".runtime\hermes-0.18.2-py313\Scripts\hermes.exe"

Write-Host ""
Write-Host "=== AGNET 微信重新登录 ===" -ForegroundColor Cyan
Write-Host "HERMES_HOME = $env:HERMES_HOME"
Write-Host ""
Write-Host "即将打开腾讯 iLink 二维码登录，请用要绑定的微信扫码并确认。" -ForegroundColor Yellow
Write-Host "向导里其余选项直接回车保持默认即可（当前策略：任何人可私聊，无需配对）。" -ForegroundColor Yellow
Write-Host ""

& $hermes gateway setup

Write-Host ""
Write-Host "扫码完成后，正在重启网关使新登录生效..." -ForegroundColor Cyan
& $hermes gateway stop 2>$null | Out-Null
Start-Sleep 2
& $root\ops\Start-AGNET.ps1 -NoBrowser -SkipVersionCheck

Write-Host ""
Write-Host "完成！现在用微信给机器人发一条消息试试。" -ForegroundColor Green
Read-Host "按回车关闭窗口"
