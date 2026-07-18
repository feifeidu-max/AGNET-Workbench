[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$BackupPath,
    [string]$ConfigPath = "",
    [switch]$ConfirmRestore,
    [switch]$Overwrite
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version 2.0
. (Join-Path $PSScriptRoot "AGNET.Common.ps1")

$staged = New-Object System.Collections.ArrayList
$applied = New-Object System.Collections.ArrayList
$stamp = Get-Date -Format "yyyyMMddTHHmmss"
$commitCompleted = $false

try {
    if (-not $ConfirmRestore) {
        throw "Restore is destructive. Re-run with -ConfirmRestore after reviewing the backup manifest."
    }

    $config = Get-AGNETConfig -ConfigPath $ConfigPath
    $versions = Get-AGNETVersionLock
    $BackupPath = Expand-AGNETPath -Path $BackupPath
    if (-not (Test-Path -LiteralPath $BackupPath -PathType Container)) {
        throw "Backup directory not found: $BackupPath"
    }
    $BackupPath = [IO.Path]::GetFullPath((Resolve-Path -LiteralPath $BackupPath).Path)
    $manifestPath = Join-Path $BackupPath "manifest.json"
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
        throw "Backup manifest is missing: $manifestPath"
    }
    $manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ([string]$manifest.format -ne "agnet-local-backup" -or [int]$manifest.formatVersion -ne 1) {
        throw "Unsupported backup format."
    }
    if ([string]$manifest.versionPins.hermesAgent.version -ne [string]$versions.hermesAgent.version -or
        [string]$manifest.versionPins.hermesStudio.commit -ne [string]$versions.hermesStudio.commit -or
        [string]$manifest.versionPins.llmWiki.commit -ne [string]$versions.llmWiki.commit) {
        throw "Backup version pins do not match this checkout. Restore with the pinned application versions first."
    }

    Write-Host "Verifying backup hashes and secret policy..."
    Assert-AGNETManifestHashes -BackupRoot $BackupPath -Manifest $manifest
    Assert-AGNETNoPlaintextSecret -Root $BackupPath

    $nodeFallbacks = @(
        "%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
    )
    $node = Resolve-AGNETCommand -Name "node" -ConfiguredPath ([string]$config.NodeExecutable) -FallbackPaths $nodeFallbacks
    $sqliteHelper = Join-Path $PSScriptRoot "sqlite-snapshot.mjs"
    foreach ($mapping in @($manifest.restoreMap | Where-Object { $_.kind -eq "sqlite" })) {
        $source = [IO.Path]::GetFullPath((Join-Path $BackupPath (([string]$mapping.backup).Replace('/', '\'))))
        & $node --no-warnings $sqliteHelper verify $source
        if ($LASTEXITCODE -ne 0) { throw "SQLite verification failed: $($mapping.backup)" }
    }

    $ports = @(
        [pscustomobject]@{ Port = [int]$config.StudioPort; Name = "Hermes Studio" },
        [pscustomobject]@{ Port = [int]$config.LlmWikiPort; Name = "LLM Wiki" },
        [pscustomobject]@{ Port = [int]$config.HermesGatewayPort; Name = "Hermes gateway" }
    )
    foreach ($service in $ports) {
        if (Test-AGNETPortListening -Port $service.Port) {
            throw "$($service.Name) is still listening on port $($service.Port). Stop Studio and LLM Wiki before restore."
        }
    }

    $hermesHome = Get-AGNETHermesHome -Config $config
    $studioHome = Get-AGNETStudioDataHome -Config $config
    $metricsDb = Get-AGNETMetricsDbPath -Config $config
    $managedWikiProjectsRoot = Get-AGNETManagedWikiProjectsRoot -Config $config
    $allowedRoots = @($hermesHome, $studioHome, (Split-Path -Parent $metricsDb), $managedWikiProjectsRoot) + @(Get-AGNETWikiProjectPaths -Config $config)

    $seenDestinations = @{}
    foreach ($mapping in @($manifest.restoreMap)) {
        if ([string]$mapping.kind -notin @("file", "directory", "sqlite")) {
            throw "Restore manifest contains an unsupported artifact kind: $($mapping.kind)"
        }
        $backupRelative = ([string]$mapping.backup).Replace('/', '\')
        $source = [IO.Path]::GetFullPath((Join-Path $BackupPath $backupRelative))
        $destination = [IO.Path]::GetFullPath([string]$mapping.destination)
        if (-not (Test-AGNETPathWithin -Path $source -Root $BackupPath)) {
            throw "Restore map contains a backup path traversal: $backupRelative"
        }
        if (-not (Test-Path -LiteralPath $source)) {
            throw "Restore source is missing: $source"
        }
        if ([string]$mapping.kind -eq "directory" -and -not (Test-Path -LiteralPath $source -PathType Container)) {
            throw "Restore source should be a directory: $source"
        }
        if ([string]$mapping.kind -ne "directory" -and -not (Test-Path -LiteralPath $source -PathType Leaf)) {
            throw "Restore source should be a file: $source"
        }
        $allowed = $false
        foreach ($root in $allowedRoots) {
            if (Test-AGNETPathWithin -Path $destination -Root $root) {
                $allowed = $true
                break
            }
        }
        if (-not $allowed) {
            throw "Restore destination is outside configured data roots: $destination"
        }
        $destinationKey = $destination.ToLowerInvariant()
        if ($seenDestinations.ContainsKey($destinationKey)) {
            throw "Restore manifest contains a duplicate destination: $destination"
        }
        $seenDestinations[$destinationKey] = $true
        if ((Test-Path -LiteralPath $destination) -and -not $Overwrite) {
            throw "Restore destination exists: $destination. Review it, then re-run with -Overwrite."
        }
    }

    Write-Host "Staging restore artifacts..."
    $mappingIndex = 0
    foreach ($mapping in @($manifest.restoreMap)) {
        $mappingIndex++
        $source = [IO.Path]::GetFullPath((Join-Path $BackupPath (([string]$mapping.backup).Replace('/', '\'))))
        $destination = [IO.Path]::GetFullPath([string]$mapping.destination)
        $parent = Split-Path -Parent $destination
        New-Item -ItemType Directory -Path $parent -Force | Out-Null
        $stagePath = Join-Path $parent (".agnet-restore-stage-{0}-{1}-{2}" -f $stamp, $PID, $mappingIndex)
        if (Test-Path -LiteralPath $stagePath) { throw "Restore stage already exists: $stagePath" }
        if ([string]$mapping.kind -eq "directory") {
            Copy-Item -LiteralPath $source -Destination $stagePath -Recurse -Force
        } else {
            Copy-Item -LiteralPath $source -Destination $stagePath -Force
        }
        [void]$staged.Add([pscustomobject]@{
            Source = $source
            Destination = $destination
            Stage = $stagePath
            Rollback = "$destination.agnet-rollback-$stamp-$PID"
        })
    }

    Write-Host "Applying restore transaction..."
    foreach ($item in @($staged)) {
        if (Test-Path -LiteralPath $item.Rollback) {
            throw "Restore rollback path already exists: $($item.Rollback)"
        }
        if (Test-Path -LiteralPath $item.Destination) {
            Move-Item -LiteralPath $item.Destination -Destination $item.Rollback
        }
        try {
            Move-Item -LiteralPath $item.Stage -Destination $item.Destination
            [void]$applied.Add($item)
        } catch {
            if (Test-Path -LiteralPath $item.Rollback) {
                Move-Item -LiteralPath $item.Rollback -Destination $item.Destination
            }
            throw
        }
    }

    $commitCompleted = $true
    foreach ($item in @($applied)) {
        if (Test-Path -LiteralPath $item.Rollback) {
            try {
                Remove-Item -LiteralPath $item.Rollback -Recurse -Force
            } catch {
                Write-Warning "Restore succeeded but an old rollback copy could not be removed: $($item.Rollback)"
            }
        }
    }
    Write-Host "Restore completed. Start AGNET and run the acceptance smoke checks."
} catch {
    if (-not $commitCompleted) {
        foreach ($item in @($applied | Sort-Object Destination -Descending)) {
            try {
                if (Test-Path -LiteralPath $item.Destination) {
                    Remove-Item -LiteralPath $item.Destination -Recurse -Force
                }
                if (Test-Path -LiteralPath $item.Rollback) {
                    Move-Item -LiteralPath $item.Rollback -Destination $item.Destination
                }
            } catch {}
        }
    }
    foreach ($item in @($staged)) {
        try {
            if (Test-Path -LiteralPath $item.Stage) {
                Remove-Item -LiteralPath $item.Stage -Recurse -Force
            }
        } catch {}
    }
    Write-Error -ErrorRecord $_ -ErrorAction Continue
    exit 1
}
