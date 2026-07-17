[CmdletBinding()]
param([string]$NodeExecutable = "")

$ErrorActionPreference = "Stop"
Set-StrictMode -Version 2.0
$opsRoot = Split-Path -Parent $PSScriptRoot
. (Join-Path $opsRoot "AGNET.Common.ps1")

if ([string]::IsNullOrWhiteSpace($NodeExecutable)) {
    $NodeExecutable = Resolve-AGNETCommand -Name "node" -ConfiguredPath "" -FallbackPaths @(
        "%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
    )
}

foreach ($script in @(
    (Join-Path $opsRoot "AGNET.Common.ps1"),
    (Join-Path $opsRoot "Initialize-ResearchProfile.ps1"),
    (Join-Path $opsRoot "Start-AGNET.ps1"),
    $PSCommandPath
)) {
    $tokens = $null
    $errors = $null
    [void][Management.Automation.Language.Parser]::ParseFile($script, [ref]$tokens, [ref]$errors)
    if ($errors.Count -gt 0) {
        throw "PowerShell AST validation failed for $script`: $($errors[0].Message)"
    }
}

$testRoot = Join-Path $opsRoot (".test-runtime-research-{0}" -f $PID)
$previousHermesHome = [Environment]::GetEnvironmentVariable("HERMES_HOME", "Process")
$previousTestToken = [Environment]::GetEnvironmentVariable("AGNET_TEST_WIKI_TOKEN", "Process")
$previousCanonicalToken = [Environment]::GetEnvironmentVariable("LLM_WIKI_API_TOKEN", "Process")

try {
    New-Item -ItemType Directory -Path $testRoot | Out-Null
    $hermesHome = Join-Path $testRoot "hermes"
    $profileDirectory = Join-Path $hermesHome "profiles\research"
    $fakeHermes = Join-Path $testRoot "fake-hermes.ps1"
    $fakeMcp = Join-Path $testRoot "mcp-entrypoint.js"
    $invocationLog = Join-Path $testRoot "hermes-invocations.txt"
    $configPath = Join-Path $testRoot "config.psd1"
    $secret = "AGNET-RESEARCH-SMOKE-SECRET-123456789"

    New-Item -ItemType Directory -Path $hermesHome -Force | Out-Null
    [IO.File]::WriteAllText((Join-Path $hermesHome "config.yaml"), @"
custom_root:
  keep: keep-me
mcp_servers:
  user-server:
    command: user-command.exe
  llm-wiki:
    url: http://unsafe.example.invalid
    env:
      AGNET_TEST_WIKI_TOKEN: $secret
      KEEP_ME: preserved
platform_toolsets:
  cli:
    - terminal
  telegram:
    - hermes-telegram
skills:
  disabled:
    - existing-skill
agent:
  disabled_toolsets:
    - existing-toolset
"@)
    [IO.File]::WriteAllText((Join-Path $hermesHome ".env"), "KEEP_THIS=1`r`nAGNET_TEST_WIKI_TOKEN=$secret`r`nLLM_WIKI_API_TOKEN=$secret`r`n")
    [IO.File]::WriteAllText($fakeMcp, "// fixture")
    [IO.File]::WriteAllText($fakeHermes, @'
param([Parameter(ValueFromRemainingArguments = $true)][string[]]$CliArgs)
$expected = "profile create research --clone --no-alias"
$actual = $CliArgs -join " "
if ($actual -ne $expected) { throw "Unexpected Hermes CLI arguments: $actual" }
[IO.File]::AppendAllText($env:AGNET_TEST_HERMES_LOG, ($CliArgs -join "|") + [Environment]::NewLine)
$target = Join-Path $env:HERMES_HOME "profiles\research"
New-Item -ItemType Directory -Path $target -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $env:HERMES_HOME "config.yaml") -Destination (Join-Path $target "config.yaml")
Copy-Item -LiteralPath (Join-Path $env:HERMES_HOME ".env") -Destination (Join-Path $target ".env")
'@)
    [IO.File]::WriteAllText($configPath, @"
@{
    NodeExecutable       = '%AGNET_TEST_NODE%'
    HermesExecutable     = '%AGNET_TEST_HERMES%'
    HermesHome           = '%AGNET_TEST_HERMES_HOME%'
    LlmWikiMcpEntrypoint = '%AGNET_TEST_MCP%'
    LlmWikiTokenEnvironmentVariable = 'AGNET_TEST_WIKI_TOKEN'
}
"@)

    $env:AGNET_TEST_NODE = $NodeExecutable
    $env:AGNET_TEST_HERMES = $fakeHermes
    $env:AGNET_TEST_HERMES_HOME = $hermesHome
    $env:AGNET_TEST_MCP = $fakeMcp
    $env:AGNET_TEST_HERMES_LOG = $invocationLog
    $env:AGNET_TEST_WIKI_TOKEN = $secret
    $env:LLM_WIKI_API_TOKEN = $secret
    $env:HERMES_HOME = "sentinel-before-research-smoke"

    & (Join-Path $opsRoot "Initialize-ResearchProfile.ps1") -ConfigPath $configPath -Quiet
    if ($env:HERMES_HOME -ne "sentinel-before-research-smoke") {
        throw "Initialize-ResearchProfile.ps1 did not restore HERMES_HOME."
    }
    if (-not [IO.File]::ReadAllText((Join-Path $hermesHome "config.yaml")).Contains($secret) -or
        -not [IO.File]::ReadAllText((Join-Path $hermesHome ".env")).Contains($secret)) {
        throw "Research profile initialization modified the clone source."
    }
    if (Test-Path -LiteralPath (Join-Path $hermesHome "active_profile")) {
        throw "Research profile initialization changed the active Hermes profile."
    }

    $researchConfig = Join-Path $profileDirectory "config.yaml"
    $researchEnv = Join-Path $profileDirectory ".env"
    $configText = [IO.File]::ReadAllText($researchConfig)
    $envText = [IO.File]::ReadAllText($researchEnv)
    if ($configText.Contains($secret) -or $envText.Contains($secret)) {
        throw "The smoke token was persisted in the research profile."
    }
    if ($envText -notmatch '(?m)^KEEP_THIS=1\r?$' -or $envText -notmatch '(?m)^HERMES_BRIDGE_TOOLSETS=llm-wiki\r?$' -or $envText -match 'LLM_WIKI_API_TOKEN|AGNET_TEST_WIKI_TOKEN') {
        throw "Research profile .env token cleanup did not preserve non-token settings."
    }

    $assertCode = @'
const fs = require('node:fs');
const { createRequire } = require('node:module');
const yaml = createRequire(process.argv[1])('js-yaml');
const config = yaml.load(fs.readFileSync(process.argv[2], 'utf8'));
const server = config.mcp_servers?.['llm-wiki'];
if (config.custom_root?.keep !== 'keep-me') throw new Error('custom config was lost');
if (config.mcp_servers?.['user-server']?.command !== 'user-command.exe') throw new Error('user MCP was lost');
if (server.command !== process.argv[3]) throw new Error('node command mismatch');
if (server.args?.length !== 1 || server.args[0] !== process.argv[4]) throw new Error('MCP entrypoint mismatch');
if (server.url !== undefined || server.headers !== undefined || server.transport !== undefined) throw new Error('non-stdio transport survived');
if (server.env?.LLM_WIKI_API_TOKEN !== '${LLM_WIKI_API_TOKEN}') throw new Error('token placeholder mismatch');
if (server.env?.LLM_WIKI_API_BASE_URL !== '${LLM_WIKI_API_BASE_URL}') throw new Error('base URL placeholder mismatch');
if (server.env?.LLM_WIKI_MCP_TOOLSET !== 'research') throw new Error('research toolset is not forced');
if (server.env?.KEEP_ME !== 'preserved') throw new Error('custom MCP env was lost');
if (JSON.stringify(config.platform_toolsets?.cli) !== JSON.stringify(['llm-wiki'])) throw new Error('research CLI toolset is not isolated');
if (JSON.stringify(config.platform_toolsets?.telegram) !== JSON.stringify(['hermes-telegram'])) throw new Error('non-CLI platform config was lost');
if (!config.agent?.disabled_toolsets?.includes('existing-toolset') || !config.agent.disabled_toolsets.includes('kanban') || !config.agent.disabled_toolsets.includes('context_engine')) throw new Error('runtime-only toolsets were not disabled');
if (!config.skills?.disabled?.includes('existing-skill') || !config.skills.disabled.includes('llm-wiki')) throw new Error('disabled skills were not merged');
'@
    & $NodeExecutable -e $assertCode (Join-Path (Get-AGNETRepositoryRoot) "apps\hermes-studio\package.json") $researchConfig $NodeExecutable $fakeMcp
    if ($LASTEXITCODE -ne 0) { throw "Research profile YAML assertions failed." }

    $firstHash = (Get-FileHash -LiteralPath $researchConfig -Algorithm SHA256).Hash
    $firstWrite = (Get-Item -LiteralPath $researchConfig).LastWriteTimeUtc.Ticks
    Start-Sleep -Milliseconds 50
    & (Join-Path $opsRoot "Initialize-ResearchProfile.ps1") -ConfigPath $configPath -Quiet
    $secondHash = (Get-FileHash -LiteralPath $researchConfig -Algorithm SHA256).Hash
    $secondWrite = (Get-Item -LiteralPath $researchConfig).LastWriteTimeUtc.Ticks
    if ($firstHash -ne $secondHash -or $firstWrite -ne $secondWrite) {
        throw "Research profile initialization rewrote an already-correct config."
    }

    $invocations = @(Get-Content -LiteralPath $invocationLog)
    if ($invocations.Count -ne 1 -or $invocations[0] -ne "profile|create|research|--clone|--no-alias") {
        throw "Hermes profile creation was not one-time and idempotent: $($invocations -join ', ')"
    }

    Write-Host "Research profile AST and smoke tests passed."
} finally {
    if ($null -eq $previousHermesHome) { Remove-Item Env:HERMES_HOME -ErrorAction SilentlyContinue } else { $env:HERMES_HOME = $previousHermesHome }
    if ($null -eq $previousTestToken) { Remove-Item Env:AGNET_TEST_WIKI_TOKEN -ErrorAction SilentlyContinue } else { $env:AGNET_TEST_WIKI_TOKEN = $previousTestToken }
    if ($null -eq $previousCanonicalToken) { Remove-Item Env:LLM_WIKI_API_TOKEN -ErrorAction SilentlyContinue } else { $env:LLM_WIKI_API_TOKEN = $previousCanonicalToken }
    foreach ($name in @("AGNET_TEST_NODE", "AGNET_TEST_HERMES", "AGNET_TEST_HERMES_HOME", "AGNET_TEST_MCP", "AGNET_TEST_HERMES_LOG")) {
        Remove-Item "Env:$name" -ErrorAction SilentlyContinue
    }
    if (Test-Path -LiteralPath $testRoot) {
        $resolved = [IO.Path]::GetFullPath($testRoot)
        $allowed = [IO.Path]::GetFullPath($opsRoot).TrimEnd('\') + '\'
        if ($resolved.StartsWith($allowed, [StringComparison]::OrdinalIgnoreCase) -and (Split-Path -Leaf $resolved).StartsWith(".test-runtime-research-")) {
            Remove-Item -LiteralPath $resolved -Recurse -Force
        }
    }
}
