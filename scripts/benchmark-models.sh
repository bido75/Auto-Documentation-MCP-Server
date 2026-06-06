#!/usr/bin/env bash
set -euo pipefail

BIFROST_URL="${BIFROST_URL:-http://localhost:8080}"

MODELS=(
  "openai/phi3.5:3.8b-mini-instruct-q4_K_M"
  "openai/qwen2.5:3b-instruct-q4_K_M"
  "openai/gemma2:2b-instruct-q4_K_M"
  "openai/llama3.2:3b-instruct-q4_K_M"
  "openai/qwen2.5:7b-instruct-q4_K_M"
  "openai/llama3.1:8b-instruct-q4_K_M"
)

PROMPT='Reply with JSON only: {"featureName":"Latency Check","featureKey":"latency-check","shouldDocument":true,"audiences":["User"],"userGuide":{"summary":"ok","steps":["ok"],"expectedOutcome":"ok","possibleErrors":[]},"adminGuide":{"configRequired":[],"endpointsAffected":[],"envVarsRequired":[],"verificationSteps":[],"troubleshooting":[]},"developerNotes":"ok","confidenceScore":99,"confidenceReasons":["ok"],"reviewQuestions":[]}'

echo "Benchmarking models via ${BIFROST_URL}/v1/chat/completions"

declare -a RESULTS=()
for MODEL in "${MODELS[@]}"; do
  START_MS=$(date +%s%3N)
  BODY=$(cat <<JSON
{
  "model": "${MODEL}",
  "messages": [{"role":"user","content":"${PROMPT}"}],
  "temperature": 0.1,
  "max_tokens": 300
}
JSON
)

  RESPONSE=$(curl -sS -X POST "${BIFROST_URL}/v1/chat/completions" \
    -H "Content-Type: application/json" \
    -d "${BODY}" || true)
  END_MS=$(date +%s%3N)
  ELAPSED_MS=$((END_MS - START_MS))

  if echo "${RESPONSE}" | grep -q '"choices"'; then
    RESULTS+=("${ELAPSED_MS}|PASS|${MODEL}")
    echo "PASS ${MODEL} ${ELAPSED_MS}ms"
  else
    RESULTS+=("${ELAPSED_MS}|FAIL|${MODEL}")
    echo "FAIL ${MODEL} ${ELAPSED_MS}ms"
  fi
done

echo
echo "Sorted results:"
printf '%s\n' "${RESULTS[@]}" | sort -n | awk -F'|' '{ printf "%8sms  %-4s  %s\n", $1, $2, $3 }'
