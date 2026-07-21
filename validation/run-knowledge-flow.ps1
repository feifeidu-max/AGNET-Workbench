[CmdletBinding()]
param(
    [string]$ProjectPath = "C:\Users\local\Documents\LLM-Wiki",
    [string]$PaperDirectory = "",
    [string]$LlmWikiExecutable = "",
    [string]$ApiToken = ""
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version 2.0

function Invoke-JsonRequest {
    param(
        [Parameter(Mandatory = $true)][string]$Uri,
        [Parameter(Mandatory = $true)][hashtable]$Headers,
        [ValidateSet("Get", "Post")][string]$Method = "Get",
        [object]$Body = $null,
        [string]$ContentType = "application/json"
    )

    $params = @{
        Uri         = $Uri
        Method      = $Method
        Headers     = $Headers
        TimeoutSec  = 120
        ErrorAction = "Stop"
    }
    if ($null -ne $Body) {
        $params.Body = $Body
        $params.ContentType = $ContentType
    }
    $lastError = $null
    for ($attempt = 1; $attempt -le 8; $attempt++) {
        try {
            return Invoke-RestMethod @params
        } catch {
            $lastError = $_
            if ($attempt -lt 8) {
                Start-Sleep -Milliseconds ([Math]::Min(2000, 250 * $attempt))
            }
        }
    }
    throw $lastError
}

function Get-DraftByHash {
    param(
        [Parameter(Mandatory = $true)][AllowEmptyCollection()][object[]]$Drafts,
        [Parameter(Mandatory = $true)][string]$Sha256
    )
    return @($Drafts | Where-Object { [string]$_.sha256 -eq $Sha256 } | Select-Object -First 1)
}

function Get-DraftDetail {
    param(
        [Parameter(Mandatory = $true)][string]$BaseUrl,
        [Parameter(Mandatory = $true)][hashtable]$Headers,
        [Parameter(Mandatory = $true)][string]$DraftId
    )
    return Invoke-JsonRequest -Uri "$BaseUrl/projects/current/ingest-drafts/$DraftId" -Headers $Headers
}

if ([string]::IsNullOrWhiteSpace($PaperDirectory)) {
    $PaperDirectory = Join-Path $PSScriptRoot "knowledge-papers"
}
if ([string]::IsNullOrWhiteSpace($LlmWikiExecutable)) {
    $LlmWikiExecutable = Join-Path $PSScriptRoot "..\apps\llm-wiki\src-tauri\target\release\llm-wiki.exe"
}
if ([string]::IsNullOrWhiteSpace($ApiToken)) {
    $ApiToken = [Environment]::GetEnvironmentVariable("AGNET_LLM_WIKI_API_TOKEN", "Process")
}
if ([string]::IsNullOrWhiteSpace($ApiToken)) {
    $ApiToken = [Environment]::GetEnvironmentVariable("AGNET_LLM_WIKI_API_TOKEN", "User")
}
if ([string]::IsNullOrWhiteSpace($ApiToken)) {
    throw "AGNET_LLM_WIKI_API_TOKEN is required for knowledge-flow validation. Set it in the current process or user environment."
}

$project = [IO.Path]::GetFullPath($ProjectPath)
$paperRoot = [IO.Path]::GetFullPath($PaperDirectory)
$exe = [IO.Path]::GetFullPath($LlmWikiExecutable)
$papers = @(Get-ChildItem -LiteralPath $paperRoot -File -Filter "*.pdf" | Sort-Object Name)
if ($papers.Count -ne 100) {
    throw "Expected exactly 100 validation PDFs in '$paperRoot', found $($papers.Count)."
}
if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) {
    throw "LLM Wiki executable not found: $exe"
}
if (-not (Test-Path -LiteralPath $project -PathType Container)) {
    throw "LLM Wiki project not found: $project"
}

$env:LLM_WIKI_API_TOKEN = $ApiToken
$env:LLM_WIKI_RETRIEVAL_MODE = "keyword_graph"
$env:LLM_WIKI_HEADLESS = "1"
$env:LLM_WIKI_NATIVE_COMPILE = "0"
$env:LLM_WIKI_BIND_HOST = "127.0.0.1"

$baseUrl = "http://127.0.0.1:19828/api/v1"
$authHeaders = @{ Authorization = "Bearer $ApiToken" }
$health = $null
$script:wikiJob = $null
$startedAt = (Get-Date).ToUniversalTime()
$results = New-Object System.Collections.Generic.List[object]

function Start-LocalWiki {
    param(
        [Parameter(Mandatory = $true)][string]$Executable,
        [Parameter(Mandatory = $true)][string]$ProjectRoot,
        [Parameter(Mandatory = $true)][string]$ApiBaseUrl
    )

    if ($null -ne $script:wikiJob) {
        Stop-Job -Job $script:wikiJob -ErrorAction SilentlyContinue
        Remove-Job -Job $script:wikiJob -Force -ErrorAction SilentlyContinue
        $script:wikiJob = $null
    }
    $script:wikiJob = Start-Job -ScriptBlock {
        param($path)
        & $path
    } -ArgumentList $Executable

    $ready = $null
    $healthDeadline = (Get-Date).AddSeconds(45)
    while ((Get-Date) -lt $healthDeadline) {
        try {
            $ready = Invoke-RestMethod -Uri "$ApiBaseUrl/health" -TimeoutSec 2 -ErrorAction Stop
            if ([string]$ready.status -eq "running") { break }
        } catch {
            Start-Sleep -Milliseconds 500
        }
    }
    if ($null -eq $ready -or [string]$ready.status -ne "running") {
        $jobOutput = Receive-Job -Job $script:wikiJob -Keep -ErrorAction SilentlyContinue | Out-String
        throw "LLM Wiki API did not become ready. $jobOutput"
    }
    if ([string]$ready.version -ne "0.6.4") {
        throw "Unexpected LLM Wiki version: $($ready.version)"
    }
    if ([string]$ready.retrievalMode -ne "keyword_graph") {
        throw "LLM Wiki retrieval mode is not keyword_graph: $($ready.retrievalMode)"
    }
    if ($ready.allowLanAccess -eq $true) {
        throw "LLM Wiki is not loopback-only."
    }

    $clipBody = @{ path = $ProjectRoot.Replace("\\", "/") } | ConvertTo-Json -Compress
    Invoke-JsonRequest -Uri "http://127.0.0.1:19827/project" -Headers @{} -Method Post `
        -Body $clipBody -ContentType "application/json" | Out-Null
    return $ready
}

try {
    $health = Start-LocalWiki -Executable $exe -ProjectRoot $project -ApiBaseUrl $baseUrl

    $projects = Invoke-JsonRequest -Uri "$baseUrl/projects" -Headers $authHeaders
    $currentProject = $projects.currentProject
    if ($null -eq $currentProject -or [string]::IsNullOrWhiteSpace([string]$currentProject.path)) {
        throw "LLM Wiki has no current project."
    }
    $currentPath = [IO.Path]::GetFullPath([string]$currentProject.path)
    if (-not $currentPath.Equals($project, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Current project mismatch. Expected '$project', got '$currentPath'."
    }

    $initialDraftPayload = Invoke-JsonRequest -Uri "$baseUrl/projects/current/ingest-drafts" -Headers $authHeaders
    $drafts = @($initialDraftPayload.drafts)
    $uploadCount = 0
    $approvedCount = 0
    $reusedCount = 0
    $failedCount = 0

    foreach ($paper in $papers) {
        $hash = (Get-FileHash -LiteralPath $paper.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
        $existing = @(Get-DraftByHash -Drafts $drafts -Sha256 $hash)
        if ($existing.Count -gt 0) {
            $draft = $existing[0]
            $reusedCount++
        } else {
            $bytes = [IO.File]::ReadAllBytes($paper.FullName)
            $uploadHeaders = @{
                Authorization = "Bearer $ApiToken"
                "X-Filename" = [Uri]::EscapeDataString($paper.Name)
            }
            try {
                $upload = Invoke-JsonRequest -Uri "$baseUrl/projects/current/ingest-drafts" `
                    -Headers $uploadHeaders -Method Post -Body $bytes -ContentType "application/octet-stream"
                if ($null -eq $upload.draft) {
                    throw "Upload did not return a draft for $($paper.Name)."
                }
                $draft = $upload.draft
                $uploadCount++
            } catch {
                # A desktop restart can happen after the server has committed
                # the staged bytes but before PowerShell receives the 202.
                # Re-read by SHA before deciding that the upload failed.
                $drafts = @((Invoke-JsonRequest -Uri "$baseUrl/projects/current/ingest-drafts" -Headers $authHeaders).drafts)
                $committed = @(Get-DraftByHash -Drafts $drafts -Sha256 $hash)
                if ($committed.Count -eq 0) { throw }
                $draft = $committed[0]
                $reusedCount++
            }
        }

        $draftId = [string]$draft.id
        $deadline = (Get-Date).AddSeconds(180)
        $finalDraft = $null
        while ((Get-Date) -lt $deadline) {
            $detail = Get-DraftDetail -BaseUrl $baseUrl -Headers $authHeaders -DraftId $draftId
            $finalDraft = $detail.draft
            $status = [string]$finalDraft.status
            if ($status -eq "awaiting_review") {
                $approved = Invoke-JsonRequest -Uri "$baseUrl/projects/current/ingest-drafts/$draftId/approve" `
                    -Headers $authHeaders -Method Post -Body "{}"
                $finalDraft = $approved.draft
                $approvedCount++
                break
            }
            if ($status -eq "trusted") {
                break
            }
            if ($status -eq "failed" -or $status -eq "rejected") {
                $failedCount++
                throw "Draft $draftId for $($paper.Name) reached ${status}: $($finalDraft.error)"
            }
            Start-Sleep -Milliseconds 350
        }
        if ($null -eq $finalDraft -or ([string]$finalDraft.status -ne "trusted" -and [string]$finalDraft.status -ne "awaiting_review")) {
            throw "Draft $draftId for $($paper.Name) did not finish within 180 seconds."
        }

        # Approve response is followed by a short read-after-write check.
        if ([string]$finalDraft.status -eq "awaiting_review") {
            $trustedDeadline = (Get-Date).AddSeconds(30)
            while ((Get-Date) -lt $trustedDeadline) {
                $finalDraft = (Get-DraftDetail -BaseUrl $baseUrl -Headers $authHeaders -DraftId $draftId).draft
                if ([string]$finalDraft.status -eq "trusted") { break }
                Start-Sleep -Milliseconds 250
            }
        }
        if ([string]$finalDraft.status -ne "trusted") {
            throw "Draft $draftId did not become trusted after approval."
        }
        $drafts = @((Invoke-JsonRequest -Uri "$baseUrl/projects/current/ingest-drafts" -Headers $authHeaders).drafts)
        $results.Add([pscustomobject]@{
            filename = $paper.Name
            draftId = $draftId
            sha256 = $hash
            status = [string]$finalDraft.status
            sourceId = [string]$finalDraft.sourceId
            pageCount = $finalDraft.pageCount
            publishedPages = @($finalDraft.publishedPages).Count
        })
        if (($results.Count % 10) -eq 0) {
            Write-Host "Processed $($results.Count)/$($papers.Count) papers"
            if ($results.Count -lt $papers.Count -and $uploadCount -gt 0) {
                Write-Host "Restarting LLM Wiki after batch boundary"
                $health = Start-LocalWiki -Executable $exe -ProjectRoot $project -ApiBaseUrl $baseUrl
                $drafts = @((Invoke-JsonRequest -Uri "$baseUrl/projects/current/ingest-drafts" -Headers $authHeaders).drafts)
            }
        }
    }

    $finalDraftPayload = Invoke-JsonRequest -Uri "$baseUrl/projects/current/ingest-drafts" -Headers $authHeaders
    $finalDrafts = @($finalDraftPayload.drafts)
    $trustedDrafts = @($finalDrafts | Where-Object { [string]$_.status -eq "trusted" })
    $pendingDrafts = @($finalDrafts | Where-Object { [string]$_.status -ne "trusted" -and [string]$_.status -ne "rejected" })

    $searchBody = '{"query":"photonic transformer accelerator","topK":10,"includeContent":false,"trustedOnly":true}'
    $search = Invoke-JsonRequest -Uri "$baseUrl/projects/current/search" -Headers $authHeaders -Method Post -Body $searchBody
    $graph = Invoke-JsonRequest -Uri "$baseUrl/projects/current/graph?limit=500" -Headers $authHeaders

    $sample = $trustedDrafts | Select-Object -First 1
    $sampleDetail = Get-DraftDetail -BaseUrl $baseUrl -Headers $authHeaders -DraftId ([string]$sample.id)
    $sampleContent = [string]$sampleDetail.proposal.changes[0].content
    $evidenceMarker = $sampleContent.Contains("evidence-locators")
    $pageMarkerCount = ([regex]::Matches($sampleContent, "(?m)^## Page [0-9]+$")).Count

    $sourceId = [string]$sample.sourceId
    $pdfRequest = [Net.HttpWebRequest]::Create("$baseUrl/projects/current/sources/$([Uri]::EscapeDataString($sourceId))/pdf")
    $pdfRequest.Method = "GET"
    $pdfRequest.Headers.Add("Authorization", "Bearer $ApiToken")
    $pdfRequest.AddRange([int64]0, [int64]15)
    $pdfResponse = $pdfRequest.GetResponse()
    $rangeStatus = [int]$pdfResponse.StatusCode
    $rangeHeader = [string]$pdfResponse.Headers["Content-Range"]
    $rangeBytes = 0
    $pdfStream = $pdfResponse.GetResponseStream()
    try {
        $buffer = New-Object byte[] 4096
        while (($read = $pdfStream.Read($buffer, 0, $buffer.Length)) -gt 0) {
            $rangeBytes += $read
        }
    } finally {
        $pdfStream.Dispose()
        $pdfResponse.Dispose()
    }

    $wikiPaperCount = @(Get-ChildItem -LiteralPath (Join-Path $project "wiki\papers") -File -Filter "*.md" -ErrorAction SilentlyContinue).Count
    # The API draft list is the authoritative JSON parser on Windows PowerShell
    # 5; ConvertFrom-Json cannot reliably parse this 100-item UTF-8 file when
    # it contains non-ASCII paper metadata.
    $trustedSourceCount = $trustedDrafts.Count
    $graphNodes = @($graph.nodes).Count
    $graphEdges = @($graph.edges).Count
    $searchResults = @($search.results)
    $vectorHits = [int]$search.vectorHits
    $graphHits = [int]$search.graphHits
    $report = [ordered]@{
        startedAt = $startedAt.ToString("o")
        finishedAt = (Get-Date).ToUniversalTime().ToString("o")
        projectPath = $project
        sourceDirectory = $paperRoot
        sourcePolicy = "Existing local academic PDFs; external download blocked by environment"
        inputPapers = $papers.Count
        inputBytes = [int64](($papers | Measure-Object Length -Sum).Sum)
        health = [ordered]@{
            version = [string]$health.version
            status = [string]$health.status
            retrievalMode = [string]$health.retrievalMode
            authConfigured = [bool]$health.authConfigured
            allowLanAccess = [bool]$health.allowLanAccess
            mcpEnabled = [bool]$health.mcpEnabled
        }
        uploads = $uploadCount
        reusedDrafts = $reusedCount
        approvals = $approvedCount
        failures = $failedCount
        trustedDrafts = $trustedDrafts.Count
        pendingDrafts = $pendingDrafts.Count
        publishedWikiPages = $wikiPaperCount
        trustedSourceRecords = $trustedSourceCount
        search = [ordered]@{
            query = "photonic transformer accelerator"
            resultCount = $searchResults.Count
            mode = [string]$search.mode
            tokenHits = [int]$search.tokenHits
            vectorHits = $vectorHits
            graphHits = $graphHits
            allResultsTrusted = @($searchResults | Where-Object { -not ([string]$_.path).StartsWith("wiki/") }).Count -eq 0
        }
        graph = [ordered]@{
            nodes = $graphNodes
            edges = $graphEdges
        }
        evidence = [ordered]@{
            sampleSourceId = $sourceId
            hasEvidenceLocatorMarker = $evidenceMarker
            pageMarkerCount = $pageMarkerCount
            rangeStatus = $rangeStatus
            contentRange = $rangeHeader
            rangeBytes = $rangeBytes
        }
        ollama = [ordered]@{
            processCount = @(Get-Process -Name ollama -ErrorAction SilentlyContinue).Count
            embeddingsDisabledByMode = ($vectorHits -eq 0 -and [string]$health.retrievalMode -eq "keyword_graph")
        }
        perPaperCount = $results.Count
    }
    $reportPath = Join-Path $PSScriptRoot "knowledge-flow-report.json"
    $reportJson = $report | ConvertTo-Json -Depth 8
    $reportJson | Set-Content -LiteralPath $reportPath -Encoding UTF8
    [pscustomobject]$report | Select-Object inputPapers,uploads,approvals,trustedDrafts,pendingDrafts,publishedWikiPages,search,graph,evidence,ollama | ConvertTo-Json -Depth 6
} finally {
    if ($null -ne $script:wikiJob) {
        Stop-Job -Job $script:wikiJob -ErrorAction SilentlyContinue
        Remove-Job -Job $script:wikiJob -Force -ErrorAction SilentlyContinue
    }
}
