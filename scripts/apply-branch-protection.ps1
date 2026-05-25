param(
  [Parameter(Mandatory = $true)]
  [string]$Owner,

  [Parameter(Mandatory = $true)]
  [string]$Repo,

  [string]$Branch = "main",

  [switch]$VerifyOnly
)

$ErrorActionPreference = "Stop"

$token = $env:GITHUB_ADMIN_TOKEN
if (-not $token) {
  $token = $env:GITHUB_TOKEN
}

if (-not $token) {
  Write-Error "Set GITHUB_ADMIN_TOKEN (or GITHUB_TOKEN for verify-only) before running this script."
  exit 1
}

$headers = @{
  Authorization = "Bearer $token"
  Accept = "application/vnd.github+json"
  "X-GitHub-Api-Version" = "2022-11-28"
}

$uri = "https://api.github.com/repos/$Owner/$Repo/branches/$Branch/protection"

function Invoke-WithDetailedErrors {
  param(
    [scriptblock]$Operation
  )

  try {
    & $Operation
  }
  catch {
    $statusCode = $null
    $responseMessage = ""

    if ($_.Exception.Response) {
      try {
        $statusCode = [int]$_.Exception.Response.StatusCode
      }
      catch {
        $statusCode = $null
      }

      try {
        $stream = $_.Exception.Response.GetResponseStream()
        if ($stream) {
          $reader = New-Object System.IO.StreamReader($stream)
          $responseMessage = $reader.ReadToEnd()
          $reader.Dispose()
        }
      }
      catch {
        $responseMessage = ""
      }
    }

    if ($statusCode -eq 401) {
      Write-Error "GitHub API returned 401 Unauthorized. Check token validity/expiry and account ownership."
    }
    elseif ($statusCode -eq 403) {
      Write-Error "GitHub API returned 403 Forbidden. Ensure Administration: Read and write permission on $Owner/$Repo."
    }
    else {
      Write-Error "GitHub API call failed (HTTP $statusCode). $responseMessage"
    }

    exit 1
  }
}

function Get-BranchProtection {
  return Invoke-WithDetailedErrors {
    Invoke-RestMethod -Method Get -Uri $uri -Headers $headers -ErrorAction Stop
  }
}

function Build-VerificationSummary {
  param(
    [object]$Protection
  )

  $contexts = @()
  if ($Protection.required_status_checks -and $Protection.required_status_checks.contexts) {
    $contexts = @($Protection.required_status_checks.contexts)
  }

  $hasConversationResolution = $false
  if ($Protection.required_conversation_resolution -and $Protection.required_conversation_resolution.enabled -eq $true) {
    $hasConversationResolution = $true
  }

  return [ordered]@{
    owner = $Owner
    repo = $Repo
    branch = $Branch
    strictStatusChecks = [bool]$Protection.required_status_checks.strict
    requiredStatusCheckContexts = $contexts
    requiredApprovingReviews = [int]$Protection.required_pull_request_reviews.required_approving_review_count
    enforceAdmins = [bool]$Protection.enforce_admins.enabled
    requiredConversationResolution = $hasConversationResolution
    allowsForcePushes = [bool]$Protection.allow_force_pushes.enabled
    allowsDeletions = [bool]$Protection.allow_deletions.enabled
  }
}

function Assert-ExpectedPolicy {
  param(
    [hashtable]$Summary
  )

  if (-not $Summary.strictStatusChecks) {
    Write-Error "Verification failed: strict status checks are not enabled."
    exit 1
  }

  if (-not ($Summary.requiredStatusCheckContexts -contains "test-build")) {
    Write-Error "Verification failed: required status check context 'test-build' is missing."
    exit 1
  }

  if ($Summary.requiredApprovingReviews -lt 1) {
    Write-Error "Verification failed: required approving reviews must be at least 1."
    exit 1
  }

  if (-not $Summary.requiredConversationResolution) {
    Write-Error "Verification failed: required conversation resolution is not enabled."
    exit 1
  }
}

if ($VerifyOnly) {
  $protection = Get-BranchProtection
  $summary = Build-VerificationSummary -Protection $protection
  Assert-ExpectedPolicy -Summary $summary

  Write-Output "Branch protection verification passed for $Owner/$Repo on branch '$Branch'."
  $summary | ConvertTo-Json -Depth 6
  exit 0
}

$body = @{
  required_status_checks = @{
    strict = $true
    contexts = @("test-build")
  }
  enforce_admins = $true
  required_pull_request_reviews = @{
    dismiss_stale_reviews = $true
    require_code_owner_reviews = $false
    required_approving_review_count = 1
  }
  restrictions = $null
  required_linear_history = $true
  allow_force_pushes = $false
  allow_deletions = $false
  block_creations = $false
  required_conversation_resolution = $true
  lock_branch = $false
  allow_fork_syncing = $true
} | ConvertTo-Json -Depth 8

Invoke-WithDetailedErrors {
  Invoke-RestMethod -Method Put -Uri $uri -Headers $headers -Body $body -ContentType "application/json" -ErrorAction Stop | Out-Null
}

$protection = Get-BranchProtection
$summary = Build-VerificationSummary -Protection $protection
Assert-ExpectedPolicy -Summary $summary

Write-Output "Branch protection applied for $Owner/$Repo on branch '$Branch'."
$summary | ConvertTo-Json -Depth 6
