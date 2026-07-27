[CmdletBinding()]
param(
    [int]$Port = 8648,
    [int]$TimeoutSec = 120
)

<#
  .SYNOPSIS
    Trigger the Hermes Studio paper-recommender refresh.

  .DESCRIPTION
    POSTs to the loopback Studio endpoint that regenerates the
    top-conference ("顶会") paper recommendations derived from the
    local knowledge-base wiki. Intended to be invoked by the
    "AGNET Paper Recommender" guarded scheduled task.
#>

$ErrorActionPreference = "Stop"
$uri = "http://127.0.0.1:$Port/api/workbench/paper-recommendations/refresh"
try {
    $response = Invoke-RestMethod -Uri $uri -Method Post -TimeoutSec $TimeoutSec -UseBasicParsing
    $count = if ($null -ne $response.count) { $response.count } else { 0 }
    $status = if ($null -ne $response.status) { $response.status } else { "unknown" }
    Write-Host ("AGNET paper recommender refresh: status={0} count={1}" -f $status, $count)
    exit 0
} catch {
    Write-Error ("AGNET paper recommender refresh failed: {0}" -f $_.Exception.Message)
    exit 1
}
