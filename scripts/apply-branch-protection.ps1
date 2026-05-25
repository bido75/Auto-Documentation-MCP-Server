param(
  [Parameter(Mandatory = $true)]
  [string]$Owner,

  [Parameter(Mandatory = $true)]
  [string]$Repo,

  [string]$Branch = "main"
)

$ErrorActionPreference = "Stop"

$token = $env:GITHUB_ADMIN_TOKEN
if (-not $token) {
  Write-Error "Set GITHUB_ADMIN_TOKEN with a token that has repository administration permission."
  exit 1
}

$headers = @{
  Authorization = "Bearer $token"
  Accept = "application/vnd.github+json"
  "X-GitHub-Api-Version" = "2022-11-28"
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

$uri = "https://api.github.com/repos/$Owner/$Repo/branches/$Branch/protection"

try {
  Invoke-RestMethod -Method Put -Uri $uri -Headers $headers -Body $body -ContentType "application/json" -ErrorAction Stop | Out-Null
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
    Write-Error "GitHub API returned 401 Unauthorized. Check GITHUB_ADMIN_TOKEN is valid, not expired, and belongs to the correct account."
  }
  elseif ($statusCode -eq 403) {
    Write-Error "GitHub API returned 403 Forbidden. Ensure the token has repository Administration: Read and write for $Owner/$Repo."
  }
  else {
    Write-Error "Failed to apply branch protection (HTTP $statusCode). $responseMessage"
  }

  exit 1
}

Write-Output "Branch protection applied for $Owner/$Repo on branch '$Branch'."
