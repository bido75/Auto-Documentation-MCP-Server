#!/usr/bin/env bash
set -euo pipefail

OLLAMA_URL="${OLLAMA_URL:-http://localhost:11434}"
MODELS=(
  "phi3.5:3.8b-mini-instruct-q4_K_M"
  "qwen2.5:3b-instruct-q4_K_M"
  "gemma2:2b-instruct-q4_K_M"
)

echo "Pre-warming models..."
for MODEL in "${MODELS[@]}"; do
  echo "Warming ${MODEL}"
  curl -sS -X POST "${OLLAMA_URL}/api/generate" \
    -H "Content-Type: application/json" \
    -d "{\"model\":\"${MODEL}\",\"prompt\":\"Warmup ping\",\"stream\":false,\"options\":{\"num_predict\":1}}" >/dev/null
done

echo "Pre-warm complete."
