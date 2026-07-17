[CmdletBinding()]
param(
    [string]$ConfigPath = "",
    [string]$HermesExecutable = "",
    [string]$NodeExecutable = "",
    [string]$McpEntrypoint = "",
    [switch]$Quiet
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version 2.0
. (Join-Path $PSScriptRoot "AGNET.Common.ps1")

function Get-EnvironmentSecret {
    param([Parameter(Mandatory = $true)][string]$Name)
    $value = [Environment]::GetEnvironmentVariable($Name, "Process")
    if ([string]::IsNullOrWhiteSpace($value)) {
        $value = [Environment]::GetEnvironmentVariable($Name, "User")
    }
    return [string]$value
}

function Assert-NoResearchProfileToken {
    param(
        [Parameter(Mandatory = $true)][string]$ProfileDirectory,
        [Parameter(Mandatory = $true)][string[]]$SecretValues
    )

    foreach ($path in @((Join-Path $ProfileDirectory "config.yaml"), (Join-Path $ProfileDirectory ".env"))) {
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { continue }
        $content = [IO.File]::ReadAllText($path)
        foreach ($secret in $SecretValues) {
            if (-not [string]::IsNullOrWhiteSpace($secret) -and $secret.Length -ge 8 -and $content.Contains($secret)) {
                throw "A plaintext LLM Wiki API token was found in the research profile. Remove it from $path and retry."
            }
        }
    }
}

$previousHermesHome = [Environment]::GetEnvironmentVariable("HERMES_HOME", "Process")
try {
    $config = Get-AGNETConfig -ConfigPath $ConfigPath
    $repositoryRoot = Get-AGNETRepositoryRoot
    $hermesHome = Get-AGNETHermesHome -Config $config
    $profileDirectory = Join-Path $hermesHome "profiles\research"
    $helper = Join-Path $PSScriptRoot "configure-research-profile.mjs"

    if ([string]::IsNullOrWhiteSpace($HermesExecutable)) {
        $HermesExecutable = Resolve-AGNETCommand -Name "hermes" -ConfiguredPath ([string]$config.HermesExecutable)
    } else {
        $HermesExecutable = Resolve-AGNETCommand -Name "hermes" -ConfiguredPath $HermesExecutable
    }
    if ([string]::IsNullOrWhiteSpace($NodeExecutable)) {
        $NodeExecutable = Resolve-AGNETCommand -Name "node" -ConfiguredPath ([string]$config.NodeExecutable) -FallbackPaths @(
            "%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
        )
    } else {
        $NodeExecutable = Resolve-AGNETCommand -Name "node" -ConfiguredPath $NodeExecutable
    }
    if ([string]::IsNullOrWhiteSpace($McpEntrypoint)) {
        $configuredEntrypoint = [string]$config.LlmWikiMcpEntrypoint
        $McpEntrypoint = if ([string]::IsNullOrWhiteSpace($configuredEntrypoint)) {
            Join-Path $repositoryRoot "apps\llm-wiki\mcp-server\dist\src\index.js"
        } else {
            Expand-AGNETPath -Path $configuredEntrypoint
        }
    } else {
        $McpEntrypoint = Expand-AGNETPath -Path $McpEntrypoint
    }

    if (-not (Test-Path -LiteralPath $helper -PathType Leaf)) {
        throw "Research profile configuration helper is missing: $helper"
    }
    if (-not (Test-Path -LiteralPath $McpEntrypoint -PathType Leaf)) {
        throw "LLM Wiki MCP build is missing: $McpEntrypoint. Run 'npm run mcp:build' in apps\llm-wiki."
    }

    New-Item -ItemType Directory -Path $hermesHome -Force | Out-Null
    $env:HERMES_HOME = $hermesHome
    if (-not (Test-Path -LiteralPath $profileDirectory -PathType Container)) {
        if (-not $Quiet) { Write-Host "Creating Hermes research profile from the active profile..." }
        $global:LASTEXITCODE = 0
        $null = & $HermesExecutable profile create research --clone --no-alias 2>&1
        $commandSucceeded = $?
        $commandExitCode = $LASTEXITCODE
        if (-not $commandSucceeded -or $commandExitCode -ne 0) {
            throw "Hermes failed to create the research profile (exit code $commandExitCode)."
        }
        if (-not (Test-Path -LiteralPath $profileDirectory -PathType Container)) {
            throw "Hermes reported success but did not create the research profile at $profileDirectory."
        }
    } elseif (-not $Quiet) {
        Write-Host "Hermes research profile already exists; preserving it and reconciling AGNET settings."
    }

    $tokenVariable = [string]$config.LlmWikiTokenEnvironmentVariable
    if ([string]::IsNullOrWhiteSpace($tokenVariable) -or $tokenVariable -notmatch '^[A-Za-z_][A-Za-z0-9_]*$') {
        throw "LlmWikiTokenEnvironmentVariable must be a valid environment variable name."
    }

    $global:LASTEXITCODE = 0
    $result = (& $NodeExecutable $helper `
        --profile-dir $profileDirectory `
        --node $NodeExecutable `
        --mcp-entrypoint $McpEntrypoint `
        --token-env-name $tokenVariable 2>&1 | Out-String).Trim()
    if ($LASTEXITCODE -ne 0) {
        throw "Unable to configure the Hermes research profile: $result"
    }

    $secretValues = @(@(
        (Get-EnvironmentSecret -Name $tokenVariable),
        (Get-EnvironmentSecret -Name "LLM_WIKI_API_TOKEN")
    ) | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) -and ([string]$_).Length -ge 8 } | Select-Object -Unique)
    if ($secretValues.Count -gt 0) {
        Assert-NoResearchProfileToken -ProfileDirectory $profileDirectory -SecretValues $secretValues
    }

    if (-not $Quiet) {
        Write-Host "Research profile ready: read-only LLM Wiki MCP enabled; built-in llm-wiki skill disabled ($result)."
    }
} finally {
    if ($null -eq $previousHermesHome) {
        Remove-Item Env:HERMES_HOME -ErrorAction SilentlyContinue
    } else {
        $env:HERMES_HOME = $previousHermesHome
    }
}
