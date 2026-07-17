[CmdletBinding()]
param(
    [string]$ConfigPath = "",
    [string]$BackupRoot = "",
    [int]$RetentionCount = 0
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version 2.0
. (Join-Path $PSScriptRoot "AGNET.Common.ps1")

$partialPath = $null

try {
    $config = Get-AGNETConfig -ConfigPath $ConfigPath
    $versions = Get-AGNETVersionLock
    $nodeFallbacks = @(
        "%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
    )
    $node = Resolve-AGNETCommand -Name "node" -ConfiguredPath ([string]$config.NodeExecutable) -FallbackPaths $nodeFallbacks
    $sqliteHelper = Join-Path $PSScriptRoot "sqlite-snapshot.mjs"

    if ([string]::IsNullOrWhiteSpace($BackupRoot)) {
        $BackupRoot = [string]$config.BackupRoot
    }
    $BackupRoot = Expand-AGNETPath -Path $BackupRoot
    if ($RetentionCount -le 0) {
        $RetentionCount = [int]$config.RetentionCount
    }
    if ($RetentionCount -lt 1) { throw "RetentionCount must be at least 1." }

    New-Item -ItemType Directory -Path $BackupRoot -Force | Out-Null
    $BackupRoot = [IO.Path]::GetFullPath((Resolve-Path -LiteralPath $BackupRoot).Path)
    $stamp = Get-Date -Format "yyyyMMddTHHmmss"
    $finalPath = Join-Path $BackupRoot $stamp
    $partialPath = Join-Path $BackupRoot (".partial-{0}-{1}" -f $stamp, $PID)
    if ((Test-Path -LiteralPath $finalPath) -or (Test-Path -LiteralPath $partialPath)) {
        throw "Backup destination already exists for timestamp $stamp."
    }
    New-Item -ItemType Directory -Path $partialPath | Out-Null

    $mappings = New-Object System.Collections.ArrayList
    $warnings = New-Object System.Collections.ArrayList

    function Add-BackupMapping {
        param([string]$Component, [string]$Kind, [string]$BackupRelativePath, [string]$Destination)
        [void]$mappings.Add([ordered]@{
            component = $Component
            kind = $Kind
            backup = $BackupRelativePath.Replace('\', '/')
            destination = [IO.Path]::GetFullPath($Destination)
        })
    }

    function Add-BackupWarning {
        param([string]$Message)
        [void]$warnings.Add($Message)
        Write-Warning $Message
    }

    function Add-StableFile {
        param(
            [string]$Source,
            [string]$BackupRelativePath,
            [string]$Component,
            [string]$Destination
        )
        if (-not (Test-Path -LiteralPath $Source -PathType Leaf)) { return }
        $sourceFile = Get-Item -LiteralPath $Source
        if (-not (Test-AGNETBackupFileAllowed -File $sourceFile)) {
            Add-BackupWarning "Excluded credential-like file: $Source"
            return
        }
        $target = Join-Path $partialPath $BackupRelativePath
        New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force | Out-Null
        $copied = $false
        for ($attempt = 1; $attempt -le 3; $attempt++) {
            $before = Get-FileHash -LiteralPath $Source -Algorithm SHA256
            $beforeLength = (Get-Item -LiteralPath $Source).Length
            Copy-Item -LiteralPath $Source -Destination $target -Force
            $after = Get-FileHash -LiteralPath $Source -Algorithm SHA256
            $targetHash = Get-FileHash -LiteralPath $target -Algorithm SHA256
            $targetLength = (Get-Item -LiteralPath $target).Length
            if ($before.Hash -ceq $after.Hash -and $before.Hash -ceq $targetHash.Hash -and $beforeLength -eq $targetLength) {
                $copied = $true
                break
            }
            Start-Sleep -Milliseconds (250 * $attempt)
        }
        if (-not $copied) { throw "Source file changed during all backup attempts: $Source" }
        Assert-AGNETNoPlaintextSecret -Root (Split-Path -Parent $target)
        Add-BackupMapping -Component $Component -Kind "file" -BackupRelativePath $BackupRelativePath -Destination $Destination
    }

    function Add-StableTree {
        param(
            [string]$Source,
            [string]$BackupRelativePath,
            [string]$Component,
            [string]$Destination
        )
        if (-not (Test-Path -LiteralPath $Source -PathType Container)) { return }
        $target = Join-Path $partialPath $BackupRelativePath
        Copy-AGNETStableTree -Source $Source -Destination $target
        Add-BackupMapping -Component $Component -Kind "directory" -BackupRelativePath $BackupRelativePath -Destination $Destination
    }

    function Add-SqliteSnapshot {
        param(
            [string]$Source,
            [string]$BackupRelativePath,
            [string]$Component,
            [string]$Destination
        )
        if (-not (Test-Path -LiteralPath $Source -PathType Leaf)) { return }
        $target = Join-Path $partialPath $BackupRelativePath
        New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force | Out-Null
        & $node --no-warnings $sqliteHelper snapshot $Source $target
        if ($LASTEXITCODE -ne 0) {
            throw "SQLite snapshot failed for $Source. The backup was not published."
        }
        Add-BackupMapping -Component $Component -Kind "sqlite" -BackupRelativePath $BackupRelativePath -Destination $Destination
    }

    $hermesHome = Get-AGNETHermesHome -Config $config
    $studioHome = Get-AGNETStudioDataHome -Config $config
    $metricsDb = Get-AGNETMetricsDbPath -Config $config
    $wikiProjects = @(Get-AGNETWikiProjectPaths -Config $config)

    $sourceRoots = @($hermesHome, $studioHome) + $wikiProjects
    foreach ($sourceRoot in $sourceRoots) {
        if (Test-AGNETPathWithin -Path $BackupRoot -Root $sourceRoot) {
            throw "BackupRoot cannot be inside a backed-up source: $sourceRoot"
        }
    }

    Write-Host "Backing up Hermes profiles and sessions..."
    if (-not (Test-Path -LiteralPath $hermesHome -PathType Container)) {
        Add-BackupWarning "Hermes home does not exist yet: $hermesHome"
    } else {
        $profiles = @([pscustomobject]@{ Name = "default"; Path = $hermesHome })
        $profilesRoot = Join-Path $hermesHome "profiles"
        if (Test-Path -LiteralPath $profilesRoot -PathType Container) {
            foreach ($directory in @(Get-ChildItem -LiteralPath $profilesRoot -Directory -Force | Sort-Object Name)) {
                $profiles += [pscustomobject]@{ Name = $directory.Name; Path = $directory.FullName }
            }
        }

        $profileIndex = 0
        foreach ($profile in $profiles) {
            $safeProfile = Get-AGNETSafeName -Name ([string]$profile.Name)
            $base = "hermes/profiles/{0:D2}-{1}" -f $profileIndex, $safeProfile
            $profileIndex++
            $profilePath = [string]$profile.Path
            Add-SqliteSnapshot -Source (Join-Path $profilePath "state.db") -BackupRelativePath "$base/state.db" -Component "hermes-session" -Destination (Join-Path $profilePath "state.db")
            Add-StableFile -Source (Join-Path $profilePath "config.yaml") -BackupRelativePath "$base/config.yaml" -Component "hermes-profile" -Destination (Join-Path $profilePath "config.yaml")
            Add-StableFile -Source (Join-Path $profilePath "SOUL.md") -BackupRelativePath "$base/SOUL.md" -Component "hermes-profile" -Destination (Join-Path $profilePath "SOUL.md")
            Add-StableFile -Source (Join-Path $profilePath ".memory-revisions.json") -BackupRelativePath "$base/.memory-revisions.json" -Component "hermes-memory" -Destination (Join-Path $profilePath ".memory-revisions.json")
            Add-StableTree -Source (Join-Path $profilePath "memories") -BackupRelativePath "$base/memories" -Component "hermes-memory" -Destination (Join-Path $profilePath "memories")
            Add-StableTree -Source (Join-Path $profilePath ".memory-history") -BackupRelativePath "$base/.memory-history" -Component "hermes-memory" -Destination (Join-Path $profilePath ".memory-history")
            Add-StableTree -Source (Join-Path $profilePath "skills") -BackupRelativePath "$base/skills" -Component "hermes-profile" -Destination (Join-Path $profilePath "skills")
        }
        Add-StableFile -Source (Join-Path $hermesHome "active_profile") -BackupRelativePath "hermes/active_profile" -Component "hermes-profile" -Destination (Join-Path $hermesHome "active_profile")
    }

    Write-Host "Backing up Hermes Studio sessions..."
    $studioDb = Join-Path $studioHome "hermes-web-ui.db"
    if (Test-Path -LiteralPath $studioDb -PathType Leaf) {
        Add-SqliteSnapshot -Source $studioDb -BackupRelativePath "studio/hermes-web-ui.db" -Component "hermes-studio" -Destination $studioDb
    } else {
        Add-BackupWarning "Hermes Studio database does not exist yet: $studioDb"
    }

    Write-Host "Backing up company metrics..."
    if (Test-Path -LiteralPath $metricsDb -PathType Leaf) {
        Add-SqliteSnapshot -Source $metricsDb -BackupRelativePath "company/company-metrics.sqlite" -Component "company-metrics" -Destination $metricsDb
    } else {
        Add-BackupWarning "Company metrics database does not exist yet: $metricsDb"
    }

    Write-Host "Backing up LLM Wiki projects..."
    $wikiIndex = 0
    foreach ($projectPath in $wikiProjects) {
        $wikiIndex++
        if (-not (Test-Path -LiteralPath $projectPath -PathType Container)) {
            Add-BackupWarning "LLM Wiki project does not exist: $projectPath"
            continue
        }
        $safeName = Get-AGNETSafeName -Name (Split-Path -Leaf $projectPath)
        $base = "wiki/{0:D2}-{1}" -f $wikiIndex, $safeName
        Add-StableTree -Source (Join-Path $projectPath "raw") -BackupRelativePath "$base/raw" -Component "llm-wiki-raw" -Destination (Join-Path $projectPath "raw")
        Add-StableTree -Source (Join-Path $projectPath "wiki") -BackupRelativePath "$base/wiki" -Component "llm-wiki-pages" -Destination (Join-Path $projectPath "wiki")
        Add-StableTree -Source (Join-Path $projectPath ".llm-wiki\staging") -BackupRelativePath "$base/.llm-wiki/staging" -Component "llm-wiki-review" -Destination (Join-Path $projectPath ".llm-wiki\staging")

        $stateRoot = Join-Path $projectPath ".llm-wiki"
        if (Test-Path -LiteralPath $stateRoot -PathType Container) {
            foreach ($stateFile in @(Get-ChildItem -LiteralPath $stateRoot -File -Force -Filter "*.json" | Sort-Object Name)) {
                if (-not (Test-AGNETBackupFileAllowed -File $stateFile)) {
                    Add-BackupWarning "Excluded credential-like LLM Wiki state file: $($stateFile.FullName)"
                    continue
                }
                Add-StableFile -Source $stateFile.FullName -BackupRelativePath "$base/.llm-wiki/$($stateFile.Name)" -Component "llm-wiki-review" -Destination $stateFile.FullName
            }
        }
    }

    if ($mappings.Count -eq 0) {
        throw "No backup artifacts were found. Check config.local.psd1 paths."
    }

    Assert-AGNETNoPlaintextSecret -Root $partialPath
    $manifest = [ordered]@{
        format = "agnet-local-backup"
        formatVersion = 1
        createdAt = (Get-Date).ToUniversalTime().ToString("o")
        machine = $env:COMPUTERNAME
        versionPins = $versions
        excluded = @(".env*", ".token", "auth.json", "credentials/secrets", "*.pem", "*.key", "*.pfx", "*.p12")
        warnings = @($warnings)
        restoreMap = @($mappings)
        files = @(Get-AGNETManifestHashes -BackupRoot $partialPath)
    }
    $manifestPath = Join-Path $partialPath "manifest.json"
    $manifest | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $manifestPath -Encoding UTF8

    Move-Item -LiteralPath $partialPath -Destination $finalPath
    $partialPath = $null
    $completedBackups = @(Get-ChildItem -LiteralPath $BackupRoot -Directory -Force | Where-Object { $_.Name -match '^\d{8}T\d{6}$' } | Sort-Object Name -Descending)
    foreach ($oldBackup in @($completedBackups | Select-Object -Skip $RetentionCount)) {
        if (-not (Test-AGNETPathWithin -Path $oldBackup.FullName -Root $BackupRoot)) {
            throw "Retention target escaped BackupRoot: $($oldBackup.FullName)"
        }
        Remove-Item -LiteralPath $oldBackup.FullName -Recurse -Force
    }

    Write-Host "Backup completed: $finalPath"
} catch {
    if ($null -ne $partialPath -and (Test-Path -LiteralPath $partialPath)) {
        try {
            $root = Split-Path -Parent $partialPath
            if ((Split-Path -Leaf $partialPath).StartsWith(".partial-") -and (Test-AGNETPathWithin -Path $partialPath -Root $root)) {
                Remove-Item -LiteralPath $partialPath -Recurse -Force
            }
        } catch {}
    }
    Write-Error -ErrorRecord $_ -ErrorAction Continue
    exit 1
}
