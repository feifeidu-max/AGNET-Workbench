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

$testRoot = Join-Path $opsRoot (".test-runtime-{0}" -f $PID)
$env:AGNET_TEST_ROOT = $testRoot
$env:AGNET_TEST_NODE = $NodeExecutable
$configPath = Join-Path $PSScriptRoot "config.smoke.psd1"
$powerShellExe = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"

function New-TestDatabase {
    param([string]$Path, [string]$TableName)
    New-Item -ItemType Directory -Path (Split-Path -Parent $Path) -Force | Out-Null
    $code = "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(process.argv[1]);d.exec('CREATE TABLE " + $TableName + " (v TEXT);');d.prepare('INSERT INTO " + $TableName + " VALUES (?)').run('fixture');d.close()"
    & $NodeExecutable -e $code $Path
    if ($LASTEXITCODE -ne 0) { throw "Failed to create fixture database: $Path" }
}

try {
    New-Item -ItemType Directory -Path $testRoot | Out-Null

    $scannerFixture = Join-Path $testRoot "secret-scanner"
    New-Item -ItemType Directory -Path $scannerFixture | Out-Null
    $fakeKey = "sk-" + ("T" * 32)
    [IO.File]::WriteAllBytes(
        (Join-Path $scannerFixture "secret.sqlite"),
        [Text.Encoding]::UTF8.GetBytes("api_key = $fakeKey")
    )
    $secretDetected = $false
    try {
        Assert-AGNETNoPlaintextSecret -Root $scannerFixture
    } catch {
        $secretDetected = $true
    }
    if (-not $secretDetected) { throw "SQLite plaintext-secret scanner did not reject a credential fixture." }

    Remove-Item -LiteralPath (Join-Path $scannerFixture "secret.sqlite") -Force
    [IO.File]::WriteAllBytes(
        (Join-Path $scannerFixture "benign.sqlite"),
        [Text.Encoding]::UTF8.GetBytes("https://example.invalid/docs/sk-this-is-a-long-url-slug-not-a-key")
    )
    Assert-AGNETNoPlaintextSecret -Root $scannerFixture
    Remove-Item -LiteralPath $scannerFixture -Recurse -Force

    $hermes = Join-Path $testRoot "hermes"
    $wiki = Join-Path $testRoot "wiki-project"
    $studio = Join-Path $testRoot "studio"

    New-TestDatabase -Path (Join-Path $hermes "state.db") -TableName "sessions"
    New-TestDatabase -Path (Join-Path $hermes "profiles\research\state.db") -TableName "sessions"
    New-TestDatabase -Path (Join-Path $studio "hermes-web-ui.db") -TableName "sessions"
    New-TestDatabase -Path (Join-Path $studio "company-metrics.sqlite") -TableName "metrics"

    New-Item -ItemType Directory -Path (Join-Path $hermes "memories") -Force | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $hermes "skills\fixture") -Force | Out-Null
    [IO.File]::WriteAllText((Join-Path $hermes "SOUL.md"), "soul fixture")
    [IO.File]::WriteAllText((Join-Path $hermes "memories\MEMORY.md"), "memory fixture")
    [IO.File]::WriteAllText((Join-Path $hermes "skills\fixture\SKILL.md"), "skill fixture")
    [IO.File]::WriteAllText((Join-Path $hermes "skills\fixture\.env"), "SHOULD_NOT_BACK_UP=1")

    New-Item -ItemType Directory -Path (Join-Path $wiki "raw\sources") -Force | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $wiki "wiki") -Force | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $wiki ".llm-wiki\staging\draft-1") -Force | Out-Null
    [IO.File]::WriteAllBytes((Join-Path $wiki "raw\sources\paper.pdf"), [byte[]](1, 2, 3, 4))
    [IO.File]::WriteAllText((Join-Path $wiki "wiki\paper.md"), "# Paper")
    [IO.File]::WriteAllText((Join-Path $wiki ".llm-wiki\staging\draft-1\draft.json"), '{"status":"awaiting_review"}')
    [IO.File]::WriteAllText((Join-Path $wiki ".llm-wiki\project.json"), '{"id":"fixture"}')

    & $powerShellExe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $opsRoot "Backup-AGNET.ps1") -ConfigPath $configPath
    if ($LASTEXITCODE -ne 0) { throw "Backup smoke command failed." }
    $backup = Get-ChildItem -LiteralPath (Join-Path $testRoot "backups") -Directory | Where-Object Name -Match '^\d{8}T\d{6}$' | Select-Object -First 1
    if ($null -eq $backup) { throw "Backup smoke command did not publish a backup." }
    if (Get-ChildItem -LiteralPath $backup.FullName -Recurse -File -Force | Where-Object Name -eq ".env") {
        throw "Credential-like fixture file entered the backup."
    }

    [IO.File]::WriteAllText((Join-Path $hermes "SOUL.md"), "changed")
    [IO.File]::WriteAllText((Join-Path $studio "studio-sentinel.txt"), "not-backed-up")
    [IO.File]::WriteAllText((Join-Path $wiki "wiki\paper.md"), "changed")
    & $powerShellExe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $opsRoot "Restore-AGNET.ps1") -BackupPath $backup.FullName -ConfigPath $configPath -ConfirmRestore -Overwrite
    if ($LASTEXITCODE -ne 0) { throw "Restore smoke command failed." }

    if ([IO.File]::ReadAllText((Join-Path $hermes "SOUL.md")) -ne "soul fixture") { throw "Hermes file was not restored." }
    if ([IO.File]::ReadAllText((Join-Path $wiki "wiki\paper.md")) -ne "# Paper") { throw "Wiki file was not restored." }
    & $NodeExecutable --no-warnings (Join-Path $opsRoot "sqlite-snapshot.mjs") verify (Join-Path $hermes "state.db")
    if ($LASTEXITCODE -ne 0) { throw "Restored Hermes database failed verification." }
    & $NodeExecutable --no-warnings (Join-Path $opsRoot "sqlite-snapshot.mjs") verify (Join-Path $studio "hermes-web-ui.db")
    if ($LASTEXITCODE -ne 0) { throw "Restored Studio database failed verification." }

    Write-Host "Backup/restore smoke test passed."
} finally {
    if (Test-Path -LiteralPath $testRoot) {
        $resolved = [IO.Path]::GetFullPath($testRoot)
        $allowed = [IO.Path]::GetFullPath($opsRoot).TrimEnd('\') + '\'
        if ($resolved.StartsWith($allowed, [StringComparison]::OrdinalIgnoreCase) -and (Split-Path -Leaf $resolved).StartsWith(".test-runtime-")) {
            Remove-Item -LiteralPath $resolved -Recurse -Force
        }
    }
}
