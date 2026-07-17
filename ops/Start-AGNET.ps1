[CmdletBinding()]
param(
    [string]$ConfigPath = "",
    [switch]$NoBrowser,
    [switch]$SkipVersionCheck
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version 2.0
. (Join-Path $PSScriptRoot "AGNET.Common.ps1")

$ollamaProcess = $null
$llmWikiProcess = $null
$studioStarted = $false
$node = $null
$studioCli = $null

function Get-OptionalHealth {
    param([Parameter(Mandatory = $true)][string]$Uri)
    try {
        return Invoke-RestMethod -Uri $Uri -Method Get -TimeoutSec 2 -UseBasicParsing
    } catch {
        return $null
    }
}

function Assert-VersionText {
    param(
        [Parameter(Mandatory = $true)][string]$ActualText,
        [Parameter(Mandatory = $true)][string]$Expected,
        [Parameter(Mandatory = $true)][string]$Name
    )
    $match = [regex]::Match($ActualText, '(?<!\d)(\d+\.\d+\.\d+)(?!\d)')
    if (-not $match.Success -or $match.Groups[1].Value -ne $Expected) {
        throw "$Name version mismatch. Expected $Expected, got: $($ActualText.Trim())"
    }
}

try {
    if ($PSVersionTable.PSVersion.Major -lt 5) {
        throw "PowerShell 5.1 or later is required."
    }

    $config = Get-AGNETConfig -ConfigPath $ConfigPath
    $versions = Get-AGNETVersionLock
    $repositoryRoot = Get-AGNETRepositoryRoot
    $studioRoot = Join-Path $repositoryRoot "apps\hermes-studio"
    $wikiRoot = Join-Path $repositoryRoot "apps\llm-wiki"
    $studioCli = Join-Path $studioRoot "bin\hermes-web-ui.mjs"
    $studioEntry = Join-Path $studioRoot "dist\server\index.js"

    $nodeFallbacks = @(
        "%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
    )
    $node = Resolve-AGNETCommand -Name "node" -ConfiguredPath ([string]$config.NodeExecutable) -FallbackPaths $nodeFallbacks
    $hermes = Resolve-AGNETCommand -Name "hermes" -ConfiguredPath ([string]$config.HermesExecutable)
    $ollama = Resolve-AGNETCommand -Name "ollama" -ConfiguredPath ([string]$config.OllamaExecutable)

    if (-not (Test-Path -LiteralPath $studioCli -PathType Leaf)) {
        throw "Hermes Studio CLI entry is missing: $studioCli"
    }
    if (-not (Test-Path -LiteralPath $studioEntry -PathType Leaf)) {
        throw "Hermes Studio production build is missing. Run the build steps in docs\SETUP-WINDOWS.md first."
    }

    if (-not $SkipVersionCheck) {
        $nodeText = (& $node --version 2>&1 | Out-String).Trim()
        $nodeMatch = [regex]::Match($nodeText, '(\d+)\.(\d+)\.(\d+)')
        if (-not $nodeMatch.Success -or [int]$nodeMatch.Groups[1].Value -lt 23) {
            throw "Node.js 23 or later is required, got: $nodeText"
        }

        $hermesText = (& $hermes --version 2>&1 | Out-String).Trim()
        if ($LASTEXITCODE -ne 0) { throw "Unable to read Hermes Agent version: $hermesText" }
        Assert-VersionText -ActualText $hermesText -Expected ([string]$versions.hermesAgent.version) -Name "Hermes Agent"

        $studioPackage = Get-Content -LiteralPath (Join-Path $studioRoot "package.json") -Raw -Encoding UTF8 | ConvertFrom-Json
        if ([string]$studioPackage.version -ne [string]$versions.hermesStudio.packageVersion) {
            throw "Hermes Studio package version mismatch. Expected $($versions.hermesStudio.packageVersion), got $($studioPackage.version)."
        }
        $wikiPackage = Get-Content -LiteralPath (Join-Path $wikiRoot "package.json") -Raw -Encoding UTF8 | ConvertFrom-Json
        if ([string]$wikiPackage.version -ne [string]$versions.llmWiki.version) {
            throw "LLM Wiki package version mismatch. Expected $($versions.llmWiki.version), got $($wikiPackage.version)."
        }
    }

    $tokenVariable = [string]$config.LlmWikiTokenEnvironmentVariable
    if ([string]::IsNullOrWhiteSpace($tokenVariable)) {
        throw "LlmWikiTokenEnvironmentVariable must be configured."
    }
    $wikiToken = [Environment]::GetEnvironmentVariable($tokenVariable, "Process")
    if ([string]::IsNullOrWhiteSpace($wikiToken)) {
        $wikiToken = [Environment]::GetEnvironmentVariable($tokenVariable, "User")
    }
    if ([string]::IsNullOrWhiteSpace($wikiToken)) {
        throw "LLM Wiki API token is missing. Set the user environment variable '$tokenVariable'; never put the token in config.local.psd1."
    }

    $studioPort = [int]$config.StudioPort
    $wikiPort = [int]$config.LlmWikiPort
    $ollamaPort = [int]$config.OllamaPort
    $hermesHome = Get-AGNETHermesHome -Config $config
    $studioHome = Get-AGNETStudioDataHome -Config $config
    New-Item -ItemType Directory -Path $hermesHome -Force | Out-Null
    New-Item -ItemType Directory -Path $studioHome -Force | Out-Null

    # These values are inherited by child processes. Do not print them.
    $env:LLM_WIKI_API_TOKEN = $wikiToken
    $env:LLM_WIKI_BIND_HOST = "127.0.0.1"
    $env:LLM_WIKI_BASE_URL = "http://127.0.0.1:$wikiPort/api/v1"
    $env:LLM_WIKI_API_BASE_URL = "http://127.0.0.1:$wikiPort"
    $env:LLM_WIKI_MCP_TOOLSET = "research"
    $env:LLM_WIKI_NATIVE_COMPILE = "1"
    $env:OLLAMA_HOST = "127.0.0.1:$ollamaPort"
    $env:BIND_HOST = "127.0.0.1"
    $env:PORT = [string]$studioPort
    $env:CORS_ORIGINS = "http://127.0.0.1:$studioPort,http://localhost:$studioPort"
    $env:HERMES_LAN_DISCOVERY_ENABLED = "false"
    $env:HERMES_WEB_UI_AUTH_JWT_EXPIRES_IN = "12h"
    $env:HERMES_HOME = $hermesHome
    $env:HERMES_BIN = $hermes
    $env:HERMES_WEB_UI_HOME = $studioHome

    Write-Host "[1/4] Preparing the Hermes research profile..."
    & (Join-Path $PSScriptRoot "Initialize-ResearchProfile.ps1") `
        -ConfigPath ([string]$config.ConfigPath) `
        -HermesExecutable $hermes `
        -NodeExecutable $node `
        -Quiet

    Write-Host "[2/4] Starting Ollama on loopback..."
    $ollamaHealthUri = "http://127.0.0.1:$ollamaPort/api/tags"
    $ollamaHealth = Get-OptionalHealth -Uri $ollamaHealthUri
    if ($null -eq $ollamaHealth) {
        $ollamaProcess = Start-Process -FilePath $ollama -ArgumentList @("serve") -PassThru -WindowStyle Hidden
        $ollamaHealth = Wait-AGNETHttp -Uri $ollamaHealthUri -TimeoutSeconds 45
    }
    Assert-AGNETLoopbackListener -Port $ollamaPort -ServiceName "Ollama"
    $modelNames = @($ollamaHealth.models | ForEach-Object { [string]$_.name })
    $embeddingModel = [string]$config.EmbeddingModel
    $modelFound = @($modelNames | Where-Object { $_ -eq $embeddingModel -or $_.StartsWith($embeddingModel + ":") }).Count -gt 0
    if (-not $modelFound) {
        throw "Ollama model '$embeddingModel' is not installed. Run: ollama pull $embeddingModel"
    }

    Write-Host "[3/4] Starting LLM Wiki on loopback..."
    $wikiHealthUri = "http://127.0.0.1:$wikiPort/api/v1/health"
    $wikiHealth = Get-OptionalHealth -Uri $wikiHealthUri
    if ($null -eq $wikiHealth) {
        $wikiExeFallbacks = @(
            (Join-Path $wikiRoot "src-tauri\target\release\llm-wiki.exe"),
            "%LOCALAPPDATA%\Programs\LLM Wiki\LLM Wiki.exe",
            "%LOCALAPPDATA%\LLM Wiki\LLM Wiki.exe",
            "%ProgramFiles%\LLM Wiki\LLM Wiki.exe"
        )
        $llmWikiExecutable = Resolve-AGNETCommand -Name "llm-wiki" -ConfiguredPath ([string]$config.LlmWikiExecutable) -FallbackPaths $wikiExeFallbacks
        $llmWikiProcess = Start-Process -FilePath $llmWikiExecutable -WorkingDirectory (Split-Path -Parent $llmWikiExecutable) -PassThru -WindowStyle Hidden
        $wikiHealth = Wait-AGNETHttp -Uri $wikiHealthUri -TimeoutSeconds 90
    }
    Assert-AGNETLoopbackListener -Port $wikiPort -ServiceName "LLM Wiki"
    if ([string]$wikiHealth.version -ne [string]$versions.llmWiki.version) {
        throw "Running LLM Wiki version mismatch. Expected $($versions.llmWiki.version), got $($wikiHealth.version)."
    }
    if ($wikiHealth.allowLanAccess -eq $true) {
        throw "LLM Wiki reports allowLanAccess=true. Disable LAN access before continuing."
    }
    if ($wikiHealth.enabled -ne $true) {
        throw "LLM Wiki API is disabled. Enable it in LLM Wiki Settings."
    }
    if ($wikiHealth.authConfigured -ne $true) {
        throw "LLM Wiki API authentication is not configured."
    }
    $wikiHeaders = @{ Authorization = "Bearer $wikiToken" }
    try {
        $wikiProjectsPayload = Invoke-RestMethod -Uri "http://127.0.0.1:$wikiPort/api/v1/projects" -Method Get -Headers $wikiHeaders -TimeoutSec 10 -UseBasicParsing
    } catch {
        throw "LLM Wiki authenticated API probe failed. Confirm that '$tokenVariable' matches the token used by LLM Wiki."
    }
    if ($null -eq $wikiProjectsPayload.currentProject -or [string]::IsNullOrWhiteSpace([string]$wikiProjectsPayload.currentProject.path)) {
        throw "LLM Wiki has no current project. Open LLM Wiki once, create or select the personal knowledge-base project, then retry."
    }
    $currentWikiPath = [IO.Path]::GetFullPath([string]$wikiProjectsPayload.currentProject.path)
    $configuredWikiPaths = @(Get-AGNETWikiProjectPaths -Config $config)
    $currentIsBackedUp = @($configuredWikiPaths | Where-Object { $_.Equals($currentWikiPath, [StringComparison]::OrdinalIgnoreCase) }).Count -gt 0
    if (-not $currentIsBackedUp) {
        throw "The current LLM Wiki project is not listed in WikiProjectPaths and would not be backed up: $currentWikiPath"
    }

    Write-Host "[4/4] Starting Hermes Studio on loopback..."
    $studioHealthUri = "http://127.0.0.1:$studioPort/health"
    $studioHealth = Get-OptionalHealth -Uri $studioHealthUri
    if ($null -eq $studioHealth) {
        & $node $studioCli start --port $studioPort --no-open
        $studioStarted = $true
        if ($LASTEXITCODE -ne 0) { throw "Hermes Studio launcher exited with code $LASTEXITCODE." }
        $studioHealth = Wait-AGNETHttp -Uri $studioHealthUri -TimeoutSeconds 120
    }
    Assert-AGNETLoopbackListener -Port $studioPort -ServiceName "Hermes Studio"
    if ([string]$studioHealth.webui_version -ne [string]$versions.hermesStudio.packageVersion) {
        throw "Running Hermes Studio version mismatch. Expected $($versions.hermesStudio.packageVersion), got $($studioHealth.webui_version)."
    }
    if (-not $SkipVersionCheck -and [string]$studioHealth.version -ne [string]$versions.hermesAgent.version) {
        throw "Studio reports Hermes Agent $($studioHealth.version), expected $($versions.hermesAgent.version)."
    }

    $url = "http://127.0.0.1:$studioPort"
    Write-Host "AGNET is ready: $url"
    if (-not $NoBrowser) {
        Start-Process $url | Out-Null
    }
} catch {
    if ($studioStarted -and $null -ne $node -and $null -ne $studioCli) {
        try { & $node $studioCli stop 2>$null | Out-Null } catch {}
    }
    if ($null -ne $llmWikiProcess) {
        try { Stop-Process -Id $llmWikiProcess.Id -Force -ErrorAction SilentlyContinue } catch {}
    }
    if ($null -ne $ollamaProcess) {
        try { Stop-Process -Id $ollamaProcess.Id -Force -ErrorAction SilentlyContinue } catch {}
    }
    Write-Error -ErrorRecord $_ -ErrorAction Continue
    exit 1
}
