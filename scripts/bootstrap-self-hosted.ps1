param(
  [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"

function Invoke-OllamaPullWithFallback {
  param(
    [Parameter(Mandatory = $true)][string]$Model,
    [Parameter(Mandatory = $true)][string[]]$Tags
  )

  foreach ($tag in $Tags) {
    Write-Host "Trying: $Model`:$tag"
    docker exec ollama ollama pull "$Model`:$tag"
    if ($LASTEXITCODE -eq 0) {
      Write-Host "Pulled: $Model`:$tag"
      return
    }

    Write-Warning "Tag unavailable: $Model`:$tag"
  }

  throw "Failed to pull any tags for $Model"
}

Write-Host "Starting self-hosted stack..."
if ($SkipBuild) {
  docker compose --profile self-hosted up -d
} else {
  docker compose --profile self-hosted up -d --build
}

if ($LASTEXITCODE -ne 0) {
  throw "Failed to start self-hosted stack"
}

Write-Host "Pulling CPU-friendly quantized models..."
Invoke-OllamaPullWithFallback -Model "llama3.1" -Tags @("8b-instruct-q4_K_M", "8b-instruct-q4_0", "8b-instruct-q5_K_M")
docker exec ollama ollama pull "nomic-embed-text"
if ($LASTEXITCODE -ne 0) {
  throw "Failed to pull nomic-embed-text"
}
Invoke-OllamaPullWithFallback -Model "qwen2.5-coder" -Tags @("7b-instruct-q4_K_M", "7b-instruct-q4_0", "7b-instruct-q5_K_M")

Write-Host "Verifying services and models..."
docker compose ps
docker exec ollama ollama list

try {
  $status = (Invoke-WebRequest -UseBasicParsing "http://localhost:11434/api/tags").StatusCode
  Write-Host "Ollama API status: $status"
} catch {
  Write-Warning "Unable to verify Ollama API endpoint: $_"
}

Write-Host "Configuring Bifrost runtime (Ollama provider + key defaults)..."
node ./scripts/configure-bifrost.mjs
if ($LASTEXITCODE -ne 0) {
  throw "Failed to configure Bifrost runtime"
}

Write-Host "Bootstrap complete."
