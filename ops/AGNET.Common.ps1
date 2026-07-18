Set-StrictMode -Version 2.0

$script:AGNETOpsRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$script:AGNETRepositoryRoot = Split-Path -Parent $script:AGNETOpsRoot

function Get-AGNETRepositoryRoot {
    return $script:AGNETRepositoryRoot
}

function Expand-AGNETPath {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [string]$BasePath = $script:AGNETRepositoryRoot
    )

    $expanded = [Environment]::ExpandEnvironmentVariables($Path.Trim())
    if ([string]::IsNullOrWhiteSpace($expanded)) {
        return ""
    }
    if (-not [IO.Path]::IsPathRooted($expanded)) {
        $expanded = Join-Path $BasePath $expanded
    }
    return [IO.Path]::GetFullPath($expanded)
}

function Get-AGNETConfig {
    param([string]$ConfigPath)

    $examplePath = Join-Path $script:AGNETOpsRoot "config.example.psd1"
    $localPath = Join-Path $script:AGNETOpsRoot "config.local.psd1"
    if ([string]::IsNullOrWhiteSpace($ConfigPath)) {
        $ConfigPath = if (Test-Path -LiteralPath $localPath) { $localPath } else { $examplePath }
    } else {
        $ConfigPath = Expand-AGNETPath -Path $ConfigPath
    }

    if (-not (Test-Path -LiteralPath $ConfigPath -PathType Leaf)) {
        throw "AGNET config file not found: $ConfigPath"
    }

    $defaults = Import-PowerShellDataFile -LiteralPath $examplePath
    $configured = Import-PowerShellDataFile -LiteralPath $ConfigPath
    foreach ($key in $configured.Keys) {
        $defaults[$key] = $configured[$key]
    }
    $defaults["ConfigPath"] = [IO.Path]::GetFullPath($ConfigPath)
    return $defaults
}

function Resolve-AGNETCommand {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [string]$ConfiguredPath,
        [string[]]$FallbackPaths = @()
    )

    $candidates = New-Object System.Collections.Generic.List[string]
    if (-not [string]::IsNullOrWhiteSpace($ConfiguredPath)) {
        $candidates.Add([Environment]::ExpandEnvironmentVariables($ConfiguredPath.Trim()))
    }
    foreach ($fallback in $FallbackPaths) {
        if (-not [string]::IsNullOrWhiteSpace($fallback)) {
            $candidates.Add([Environment]::ExpandEnvironmentVariables($fallback))
        }
    }

    foreach ($candidate in $candidates) {
        if ([IO.Path]::IsPathRooted($candidate) -or $candidate.Contains("\") -or $candidate.Contains("/")) {
            $full = Expand-AGNETPath -Path $candidate
            if (Test-Path -LiteralPath $full -PathType Leaf) {
                return $full
            }
        } else {
            $command = Get-Command $candidate -ErrorAction SilentlyContinue | Select-Object -First 1
            if ($null -ne $command) {
                return $command.Source
            }
        }
    }

    $byName = Get-Command $Name -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -ne $byName) {
        return $byName.Source
    }
    throw "Required command '$Name' was not found. Set its absolute path in $($script:AGNETOpsRoot)\config.local.psd1."
}

function Get-AGNETHermesHome {
    param([hashtable]$Config)

    if (-not [string]::IsNullOrWhiteSpace([string]$Config.HermesHome)) {
        return Expand-AGNETPath -Path ([string]$Config.HermesHome)
    }
    $candidates = @()
    if (-not [string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
        $candidates += Join-Path $env:LOCALAPPDATA "hermes"
    }
    if (-not [string]::IsNullOrWhiteSpace($env:APPDATA)) {
        $candidates += Join-Path $env:APPDATA "hermes"
    }
    foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath $candidate -PathType Container) {
            return [IO.Path]::GetFullPath($candidate)
        }
    }
    return [IO.Path]::GetFullPath((Join-Path $env:USERPROFILE ".hermes"))
}

function Get-AGNETStudioDataHome {
    param([hashtable]$Config)
    return Expand-AGNETPath -Path ([string]$Config.StudioDataHome)
}

function Get-AGNETMetricsDbPath {
    param([hashtable]$Config)
    if (-not [string]::IsNullOrWhiteSpace([string]$Config.CompanyMetricsDbPath)) {
        return Expand-AGNETPath -Path ([string]$Config.CompanyMetricsDbPath)
    }
    return Join-Path (Get-AGNETStudioDataHome -Config $Config) "company-metrics.sqlite"
}

function Get-AGNETManagedWikiProjectsRoot {
    param([hashtable]$Config)
    if (-not [string]::IsNullOrWhiteSpace([string]$Config.LlmWikiManagedProjectsHome)) {
        return Expand-AGNETPath -Path ([string]$Config.LlmWikiManagedProjectsHome)
    }
    if (-not [string]::IsNullOrWhiteSpace([string]$env:APPDATA)) {
        return [IO.Path]::GetFullPath((Join-Path $env:APPDATA "com.llmwiki.app\studio-projects"))
    }
    return [IO.Path]::GetFullPath((Join-Path $env:USERPROFILE ".llm-wiki\studio-projects"))
}

function Get-AGNETWikiProjectPaths {
    param([hashtable]$Config)
    $paths = @()
    foreach ($path in @($Config.WikiProjectPaths)) {
        if (-not [string]::IsNullOrWhiteSpace([string]$path)) {
            $paths += Expand-AGNETPath -Path ([string]$path)
        }
    }
    $managedRoot = Get-AGNETManagedWikiProjectsRoot -Config $Config
    if (Test-Path -LiteralPath $managedRoot -PathType Container) {
        foreach ($project in @(Get-ChildItem -LiteralPath $managedRoot -Directory -Force | Sort-Object Name)) {
            if ((Test-Path -LiteralPath (Join-Path $project.FullName "schema.md") -PathType Leaf) -and
                (Test-Path -LiteralPath (Join-Path $project.FullName "wiki") -PathType Container)) {
                $paths += [IO.Path]::GetFullPath($project.FullName)
            }
        }
    }
    return @($paths | Select-Object -Unique)
}

function Get-AGNETVersionLock {
    $path = Join-Path $script:AGNETOpsRoot "versions.lock.json"
    return Get-Content -LiteralPath $path -Raw -Encoding UTF8 | ConvertFrom-Json
}

function Wait-AGNETHttp {
    param(
        [Parameter(Mandatory = $true)][string]$Uri,
        [int]$TimeoutSeconds = 60,
        [hashtable]$Headers = @{}
    )

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    $lastError = $null
    while ((Get-Date) -lt $deadline) {
        try {
            return Invoke-RestMethod -Uri $Uri -Method Get -Headers $Headers -TimeoutSec 5 -UseBasicParsing
        } catch {
            $lastError = $_.Exception.Message
            Start-Sleep -Milliseconds 500
        }
    }
    throw "Timed out waiting for $Uri. Last error: $lastError"
}

function Get-AGNETListeningAddresses {
    param([Parameter(Mandatory = $true)][int]$Port)

    $command = Get-Command Get-NetTCPConnection -ErrorAction SilentlyContinue
    if ($null -ne $command) {
        try {
            return @(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction Stop | Select-Object -ExpandProperty LocalAddress -Unique)
        } catch {
            return @()
        }
    }

    $addresses = @()
    foreach ($line in @(netstat -ano -p tcp 2>$null)) {
        if ($line -notmatch "LISTENING") { continue }
        $parts = $line.Trim() -split "\s+"
        if ($parts.Count -lt 4) { continue }
        $local = $parts[1]
        if ($local -match "^\[([^\]]+)\]:(\d+)$") {
            if ([int]$Matches[2] -eq $Port) { $addresses += $Matches[1] }
        } elseif ($local -match "^(.*):(\d+)$") {
            if ([int]$Matches[2] -eq $Port) { $addresses += $Matches[1] }
        }
    }
    return @($addresses | Select-Object -Unique)
}

function Assert-AGNETLoopbackListener {
    param(
        [Parameter(Mandatory = $true)][int]$Port,
        [Parameter(Mandatory = $true)][string]$ServiceName
    )

    $addresses = @(Get-AGNETListeningAddresses -Port $Port)
    if ($addresses.Count -eq 0) {
        throw "$ServiceName passed HTTP health checks but no TCP listener was found on port $Port."
    }
    $unsafe = @($addresses | Where-Object { $_ -notin @("127.0.0.1", "::1", "[::1]") })
    if ($unsafe.Count -gt 0) {
        throw "$ServiceName is exposed beyond loopback on port ${Port}: $($unsafe -join ', ')"
    }
}

function Test-AGNETPortListening {
    param([Parameter(Mandatory = $true)][int]$Port)
    return @(Get-AGNETListeningAddresses -Port $Port).Count -gt 0
}

function Test-AGNETPathWithin {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Root
    )
    $fullPath = [IO.Path]::GetFullPath($Path).TrimEnd('\')
    $fullRoot = [IO.Path]::GetFullPath($Root).TrimEnd('\')
    if ($fullPath.Equals($fullRoot, [StringComparison]::OrdinalIgnoreCase)) { return $true }
    return $fullPath.StartsWith($fullRoot + "\", [StringComparison]::OrdinalIgnoreCase)
}

function Test-AGNETBackupFileAllowed {
    param([Parameter(Mandatory = $true)][IO.FileInfo]$File)

    $leaf = $File.Name.ToLowerInvariant()
    foreach ($segment in @($File.FullName -split '[\\/]')) {
        $normalized = $segment.ToLowerInvariant()
        if ($normalized -eq ".ssh" -or $normalized -eq ".aws" -or $normalized -eq ".azure") { return $false }
        if ($normalized -eq ".env" -or $normalized.StartsWith(".env.")) { return $false }
        if ($normalized -in @("credential", "credentials", ".credentials", "secret", "secrets", ".secrets", "api-key", "api-keys", "api_key", "api_keys")) { return $false }
    }
    if ($leaf -eq ".env" -or $leaf.StartsWith(".env.")) { return $false }
    if ($leaf -in @(".token", "auth.json", "credentials.json", "secrets.json", "id_rsa", "id_ed25519")) { return $false }
    if ($leaf -match "credential|secret|api[-_]?key") { return $false }
    if ($File.Extension.ToLowerInvariant() -in @(".pem", ".key", ".pfx", ".p12")) { return $false }
    return $true
}

function Get-AGNETIncludedFiles {
    param([Parameter(Mandatory = $true)][string]$Root)

    if (-not (Test-Path -LiteralPath $Root -PathType Container)) { return @() }
    return @(Get-ChildItem -LiteralPath $Root -Recurse -File -Force | Where-Object {
        Test-AGNETBackupFileAllowed -File $_
    } | Sort-Object FullName)
}

function Get-AGNETRelativePath {
    param(
        [Parameter(Mandatory = $true)][string]$Root,
        [Parameter(Mandatory = $true)][string]$Path
    )
    $fullRoot = [IO.Path]::GetFullPath($Root).TrimEnd('\')
    $fullPath = [IO.Path]::GetFullPath($Path)
    if (-not (Test-AGNETPathWithin -Path $fullPath -Root $fullRoot)) {
        throw "Path is outside root: $fullPath"
    }
    return $fullPath.Substring($fullRoot.Length).TrimStart('\')
}

function Get-AGNETInventory {
    param([Parameter(Mandatory = $true)][string]$Root)

    $items = @()
    foreach ($file in @(Get-AGNETIncludedFiles -Root $Root)) {
        $items += [ordered]@{
            path = (Get-AGNETRelativePath -Root $Root -Path $file.FullName).Replace('\', '/')
            length = $file.Length
            sha256 = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
        }
    }
    return @($items)
}

function Test-AGNETInventoryEqual {
    param([object[]]$First, [object[]]$Second)
    $firstJson = ConvertTo-Json -InputObject @($First) -Depth 5 -Compress
    $secondJson = ConvertTo-Json -InputObject @($Second) -Depth 5 -Compress
    return $firstJson -ceq $secondJson
}

function Assert-AGNETNoPlaintextSecret {
    param([Parameter(Mandatory = $true)][string]$Root)

    $textExtensions = @(".md", ".txt", ".json", ".yaml", ".yml", ".toml", ".csv", ".tsv", ".xml")
    $databaseExtensions = @(".db", ".sqlite", ".sqlite3")
    $patterns = @(
        "(?<![A-Za-z0-9/_-])sk-(?:ant-)?[A-Za-z0-9_-]{20,}",
        "(?<![A-Za-z0-9/_-])AIza[A-Za-z0-9_-]{30,}",
        "(?<![A-Za-z0-9/_-])gh[pousr]_[A-Za-z0-9]{20,}",
        "(?<![A-Za-z0-9/_-])xox[baprs]-[A-Za-z0-9-]{20,}",
        "(?<![A-Za-z0-9/_-])AKIA[0-9A-Z]{16}",
        "Bearer\s+[A-Za-z0-9._~+/-]{20,}",
        "(?i)(?:api[-_]?key|access[-_]?token|client[-_]?secret)['`"]?\s*[:=]\s*['`"]?[A-Za-z0-9+/=_-]{20,}"
    )
    foreach ($file in @(Get-ChildItem -LiteralPath $Root -Recurse -File -Force)) {
        $extension = $file.Extension.ToLowerInvariant()
        if ($extension -in $databaseExtensions) {
            # SQLite stores TEXT values as UTF-8 bytes. ASCII decoding keeps
            # credential-shaped values intact without requiring a live DB or
            # risking writes to a snapshot during backup/restore validation.
            $content = [Text.Encoding]::ASCII.GetString([IO.File]::ReadAllBytes($file.FullName))
            foreach ($pattern in $patterns) {
                if ($content -match $pattern) {
                    throw "Plaintext API-key-like content detected in backup database: $($file.FullName)"
                }
            }
            continue
        }
        if ($extension -notin $textExtensions) { continue }
        $reader = New-Object IO.StreamReader($file.FullName, $true)
        try {
            while (-not $reader.EndOfStream) {
                $line = $reader.ReadLine()
                foreach ($pattern in $patterns) {
                    if ($line -match $pattern) {
                        throw "Plaintext API-key-like content detected in backup candidate: $($file.FullName)"
                    }
                }
            }
        } finally {
            $reader.Dispose()
        }
    }
}

function Copy-AGNETStableTree {
    param(
        [Parameter(Mandatory = $true)][string]$Source,
        [Parameter(Mandatory = $true)][string]$Destination,
        [int]$Attempts = 3
    )

    for ($attempt = 1; $attempt -le $Attempts; $attempt++) {
        if (Test-Path -LiteralPath $Destination) {
            Remove-Item -LiteralPath $Destination -Recurse -Force
        }
        New-Item -ItemType Directory -Path $Destination -Force | Out-Null
        $before = @(Get-AGNETInventory -Root $Source)
        foreach ($file in @(Get-AGNETIncludedFiles -Root $Source)) {
            $relative = Get-AGNETRelativePath -Root $Source -Path $file.FullName
            $target = Join-Path $Destination $relative
            New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force | Out-Null
            Copy-Item -LiteralPath $file.FullName -Destination $target -Force
        }
        $after = @(Get-AGNETInventory -Root $Source)
        $copied = @(Get-AGNETInventory -Root $Destination)
        if ((Test-AGNETInventoryEqual -First $before -Second $after) -and
            (Test-AGNETInventoryEqual -First $before -Second $copied)) {
            Assert-AGNETNoPlaintextSecret -Root $Destination
            return
        }
        Start-Sleep -Milliseconds (250 * $attempt)
    }
    throw "Source changed during all $Attempts backup attempts: $Source"
}

function Get-AGNETSafeName {
    param([Parameter(Mandatory = $true)][string]$Name)
    $safe = $Name -replace '[^A-Za-z0-9._-]', '_'
    if ([string]::IsNullOrWhiteSpace($safe)) { return "item" }
    return $safe
}

function Get-AGNETManifestHashes {
    param([Parameter(Mandatory = $true)][string]$BackupRoot)

    $hashes = @()
    foreach ($file in @(Get-ChildItem -LiteralPath $BackupRoot -Recurse -File -Force | Where-Object { $_.Name -ne "manifest.json" } | Sort-Object FullName)) {
        $hashes += [ordered]@{
            path = (Get-AGNETRelativePath -Root $BackupRoot -Path $file.FullName).Replace('\', '/')
            length = $file.Length
            sha256 = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
        }
    }
    return @($hashes)
}

function Assert-AGNETManifestHashes {
    param(
        [Parameter(Mandatory = $true)][string]$BackupRoot,
        [Parameter(Mandatory = $true)]$Manifest
    )

    $expectedPaths = @{}
    foreach ($entry in @($Manifest.files)) {
        $expectedPaths[([string]$entry.path).ToLowerInvariant()] = $true
        $relative = ([string]$entry.path).Replace('/', '\')
        $path = [IO.Path]::GetFullPath((Join-Path $BackupRoot $relative))
        if (-not (Test-AGNETPathWithin -Path $path -Root $BackupRoot)) {
            throw "Backup manifest contains a path traversal: $($entry.path)"
        }
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
            throw "Backup file is missing: $($entry.path)"
        }
        $file = Get-Item -LiteralPath $path
        if ([int64]$entry.length -ne $file.Length) {
            throw "Backup file length mismatch: $($entry.path)"
        }
        $hash = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($hash -cne ([string]$entry.sha256).ToLowerInvariant()) {
            throw "Backup file hash mismatch: $($entry.path)"
        }
    }

    foreach ($file in @(Get-ChildItem -LiteralPath $BackupRoot -Recurse -File -Force | Where-Object { $_.Name -ne "manifest.json" })) {
        $relative = (Get-AGNETRelativePath -Root $BackupRoot -Path $file.FullName).Replace('\', '/').ToLowerInvariant()
        if (-not $expectedPaths.ContainsKey($relative)) {
            throw "Backup contains an unmanifested file: $relative"
        }
    }
}
