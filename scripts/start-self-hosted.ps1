[CmdletBinding()]
param(
  [int]$DockerReadyTimeoutSeconds = 180
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $projectRoot ".env"
$dockerDesktop = Join-Path $env:ProgramFiles "Docker\Docker\Docker Desktop.exe"

function Test-DockerReady {
  try {
    docker info --format "{{.ServerVersion}}" *> $null
    return $LASTEXITCODE -eq 0
  } catch {
    return $false
  }
}

function Test-EnvValue {
  param([string]$Name)

  if (-not (Test-Path -LiteralPath $envFile)) {
    return $false
  }

  $match = Get-Content -LiteralPath $envFile |
    Where-Object { $_ -match "^$([regex]::Escape($Name))=(.+)$" } |
    Select-Object -First 1
  return $null -ne $match -and -not [string]::IsNullOrWhiteSpace(($match -split "=", 2)[1])
}

function Wait-ForContainerState {
  param(
    [string]$ContainerName,
    [ValidateSet("running", "healthy")]
    [string]$ExpectedState,
    [int]$TimeoutSeconds
  )

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  do {
    $format = if ($ExpectedState -eq "healthy") {
      "{{if .State.Health}}{{.State.Health.Status}}{{else}}missing-healthcheck{{end}}"
    } else {
      "{{.State.Status}}"
    }
    $state = docker inspect $ContainerName --format $format 2>$null
    if ($LASTEXITCODE -eq 0 -and $state.Trim() -eq $ExpectedState) {
      return
    }
    Start-Sleep -Seconds 5
  } while ((Get-Date) -lt $deadline)

  throw "$ContainerName did not reach $ExpectedState within $TimeoutSeconds seconds."
}

if (-not (Test-EnvValue -Name "CLOUDFLARE_TUNNEL_TOKEN")) {
  throw "CLOUDFLARE_TUNNEL_TOKEN is missing or empty in $envFile."
}

if (-not (Test-DockerReady)) {
  if (-not (Test-Path -LiteralPath $dockerDesktop)) {
    throw "Docker is not ready and Docker Desktop was not found at $dockerDesktop."
  }

  Start-Process -FilePath $dockerDesktop -WindowStyle Hidden
  $deadline = (Get-Date).AddSeconds($DockerReadyTimeoutSeconds)
  while ((Get-Date) -lt $deadline -and -not (Test-DockerReady)) {
    Start-Sleep -Seconds 5
  }
}

if (-not (Test-DockerReady)) {
  throw "Docker did not become ready within $DockerReadyTimeoutSeconds seconds."
}

Push-Location $projectRoot
try {
  docker compose --profile self-hosted up -d --remove-orphans
  if ($LASTEXITCODE -ne 0) {
    throw "docker compose failed with exit code $LASTEXITCODE."
  }

  Wait-ForContainerState -ContainerName "notion-auto-doc" -ExpectedState "healthy" -TimeoutSeconds 120
  Wait-ForContainerState -ContainerName "bifrost-gateway" -ExpectedState "healthy" -TimeoutSeconds 180
  Wait-ForContainerState -ContainerName "nginx-proxy" -ExpectedState "running" -TimeoutSeconds 60
  Wait-ForContainerState -ContainerName "cloudflared" -ExpectedState "running" -TimeoutSeconds 60

  Write-Output "Auto-Doc origins are healthy; nginx and cloudflared are running."
} finally {
  Pop-Location
}
