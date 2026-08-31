# AGNET: build the llm-wiki release binary (apps/llm-wiki/src-tauri).
#
# Why this script exists (two environment traps hit on 2026-08-31):
#   1. rustc resolves a bare `link.exe` through PATH; in Git Bash sessions the
#      coreutils `link` shadows the MSVC linker ("link: extra operand"), and in
#      plain shells LIB/INCLUDE are missing (LNK1181 advapi32.lib). We therefore
#      pin the MSVC bin dir on PATH and set INCLUDE/LIB explicitly.
#   2. lance-encoding's build script needs `protoc`; it is not installed system
#      wide. Download a release zip from
#      https://github.com/protocolbuffers/protobuf/releases and unzip so that
#      %USERPROFILE%\.protoc\bin\protoc.exe and %USERPROFILE%\.protoc\include\ exist.
#
# NOTE: stop a running llm-wiki.exe first — Windows locks the exe and the final
# copy step of cargo fails with "os error 5" (the fresh binary still lands in
# target\release\deps\llm_wiki.exe).

param([switch]$SkipTests)

$ErrorActionPreference = 'Stop'

$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
$vsRoot = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (-not $vsRoot) { throw "Visual Studio C++ build tools not found (vswhere)." }
$msvcVersion = Get-ChildItem "$vsRoot\VC\Tools\MSVC" | Sort-Object Name -Descending | Select-Object -First 1
$msvc = $msvcVersion.FullName
$sdk = "${env:ProgramFiles(x86)}\Windows Kits\10"
$sdkVersion = Get-ChildItem "$sdk\Lib" | Sort-Object Name -Descending | Select-Object -First 1

$env:PATH = "$msvc\bin\Hostx64\x64;$sdk\bin\$($sdkVersion.Name)\x64;$env:PATH"
$env:INCLUDE = "$msvc\include;$sdk\Include\$($sdkVersion.Name)\ucrt;$sdk\Include\$($sdkVersion.Name)\um;$sdk\Include\$($sdkVersion.Name)\shared;$sdk\Include\$($sdkVersion.Name)\winrt"
$env:LIB = "$msvc\lib\x64;$sdk\Lib\$($sdkVersion.Name)\ucrt\x64;$sdk\Lib\$($sdkVersion.Name)\um\x64"

$protoc = "$env:USERPROFILE\.protoc\bin\protoc.exe"
if (Test-Path $protoc) { $env:PROTOC = $protoc }
else { Write-Warning "protoc not found at $protoc - lance-encoding build will fail. See header comments." }

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location (Join-Path $repoRoot "apps\llm-wiki\src-tauri")

if (-not $SkipTests) {
    cargo test --lib
    if ($LASTEXITCODE -ne 0) { throw "cargo test failed" }
}

cargo build --release
if ($LASTEXITCODE -ne 0) { throw "cargo build --release failed" }
Write-Host "OK: target\release\llm-wiki.exe built. Restart AGNET (ops\Start-AGNET.ps1) to load it."
