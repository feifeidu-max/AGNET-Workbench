[CmdletBinding()]
param(
    [string]$ConfigPath = "",
    [switch]$Unregister
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version 2.0
. (Join-Path $PSScriptRoot "AGNET.Common.ps1")

$startupTaskName = "AGNET Local Workbench"
$backupTaskName = "AGNET Daily Backup"

try {
    $scheduledTasks = Get-Module -ListAvailable -Name ScheduledTasks | Select-Object -First 1
    if ($null -eq $scheduledTasks) {
        throw "The Windows ScheduledTasks PowerShell module is unavailable."
    }
    Import-Module ScheduledTasks

    if ($Unregister) {
        foreach ($taskName in @($startupTaskName, $backupTaskName)) {
            if ($null -ne (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue)) {
                Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
                Write-Host "Removed scheduled task: $taskName"
            }
        }
        exit 0
    }

    $config = Get-AGNETConfig -ConfigPath $ConfigPath
    $resolvedConfigPath = [string]$config.ConfigPath
    $startScript = Join-Path $PSScriptRoot "Start-AGNET.ps1"
    $backupScript = Join-Path $PSScriptRoot "Backup-AGNET.ps1"
    $powerShellExe = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()

    $startupArguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{0}" -ConfigPath "{1}"' -f $startScript, $resolvedConfigPath
    $backupArguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{0}" -ConfigPath "{1}"' -f $backupScript, $resolvedConfigPath
    $startupAction = New-ScheduledTaskAction -Execute $powerShellExe -Argument $startupArguments -WorkingDirectory (Get-AGNETRepositoryRoot)
    $backupAction = New-ScheduledTaskAction -Execute $powerShellExe -Argument $backupArguments -WorkingDirectory (Get-AGNETRepositoryRoot)

    $startupTrigger = New-ScheduledTaskTrigger -AtLogOn -User $identity.Name
    $backupAt = [datetime]::ParseExact([string]$config.DailyBackupTime, "HH:mm", [Globalization.CultureInfo]::InvariantCulture)
    $backupTrigger = New-ScheduledTaskTrigger -Daily -At $backupAt
    $principal = New-ScheduledTaskPrincipal -UserId $identity.Name -LogonType Interactive -RunLevel Limited
    $startupSettings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 10)
    $backupSettings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Hours 6)

    Register-ScheduledTask -TaskName $startupTaskName -Action $startupAction -Trigger $startupTrigger -Principal $principal -Settings $startupSettings -Description "Start loopback-only AGNET services after this user signs in." -Force | Out-Null
    Register-ScheduledTask -TaskName $backupTaskName -Action $backupAction -Trigger $backupTrigger -Principal $principal -Settings $backupSettings -Description "Create a verified daily AGNET backup and retain the configured number of copies." -Force | Out-Null

    Write-Host "Registered: $startupTaskName"
    Write-Host "Registered: $backupTaskName at $($config.DailyBackupTime)"
    Write-Host "Tasks run only while $($identity.Name) has an interactive logon token."
} catch {
    Write-Error -ErrorRecord $_ -ErrorAction Continue
    exit 1
}
