#!/usr/bin/env bash
set -euo pipefail

SKIP_BUILD="${SKIP_BUILD:-0}"

pull_with_fallback() {
  local model="$1"
  shift
  local tags=("$@")

  for tag in "${tags[@]}"; do
    echo "Trying: ${model}:${tag}"
    if docker exec ollama ollama pull "${model}:${tag}"; then
      echo "Pulled: ${model}:${tag}"
      return 0
    fi

    echo "Tag unavailable: ${model}:${tag}" >&2
  done

  echo "Failed to pull any tags for ${model}" >&2
  return 1
}

echo "Starting self-hosted stack..."
if [[ "$SKIP_BUILD" == "1" ]]; then
  docker compose --profile self-hosted up -d
else
  docker compose --profile self-hosted up -d --build
fi

echo "Pulling CPU-friendly quantized models..."
pull_with_fallback "llama3.1" "8b-instruct-q4_K_M" "8b-instruct-q4_0" "8b-instruct-q5_K_M"
docker exec ollama ollama pull "nomic-embed-text"
pull_with_fallback "qwen2.5-coder" "7b-instruct-q4_K_M" "7b-instruct-q4_0" "7b-instruct-q5_K_M"

echo "Verifying services and models..."
docker compose ps
docker exec ollama ollama list

if command -v curl >/dev/null 2>&1; then
  code="$(curl -s -o /dev/null -w "%{http_code}" http://localhost:11434/api/tags || true)"
  echo "Ollama API status: ${code}"
fi

echo "Configuring Bifrost runtime (Ollama provider + key defaults)..."
node ./scripts/configure-bifrost.mjs

echo "Bootstrap complete."
