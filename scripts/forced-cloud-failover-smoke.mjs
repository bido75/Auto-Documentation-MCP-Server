#!/usr/bin/env node

import { OpenAIProvider } from "../build/providers/openai.js";

function getArgValue(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return null;
  return process.argv[index + 1] ?? null;
}

function requireEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function parseIntOrDefault(value, fallback) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isInteger(parsed) ? parsed : fallback;
}

async function main() {
  const endpoint = process.env.AI_ENDPOINT?.trim() || getArgValue("--endpoint") || "http://localhost:8080/v1";
  const bifrostEndpoint = process.env.BIFROST_ENDPOINT?.trim() || getArgValue("--bifrost-endpoint") || "http://localhost:8080";
  const cloudModel = process.env.AI_CLOUD_FALLBACK_MODEL?.trim() || getArgValue("--cloud-model") || "openai/gpt-4o-mini";
  const localApiKey = process.env.AI_API_KEY?.trim() || getArgValue("--local-api-key") || "ollama";
  const cloudApiKey = process.env.OPENROUTER_API_KEY?.trim() || getArgValue("--openrouter-api-key") || "";
  const cloudEndpoint = process.env.OPENROUTER_ENDPOINT?.trim() || getArgValue("--cloud-endpoint") || "https://openrouter.ai/api/v1";
  const timeoutMs = parseIntOrDefault(process.env.AI_TIMEOUT_MS?.trim() || getArgValue("--timeout-ms"), 60000);

  if (!cloudApiKey) {
    throw new Error("Missing OpenRouter key. Set OPENROUTER_API_KEY or pass --openrouter-api-key.");
  }

  // Force all local attempts to fail so success can only come from cloud fallback.
  process.env.AI_ENDPOINT = endpoint;
  process.env.BIFROST_ENDPOINT = bifrostEndpoint;
  process.env.AI_API_KEY = localApiKey;
  process.env.AI_MODEL_NAME = "openai/non-existent-primary";
  process.env.AI_FALLBACK_MODEL_1 = "openai/non-existent-fallback-1";
  process.env.AI_FALLBACK_MODEL_2 = "openai/non-existent-fallback-2";
  process.env.AI_FALLBACK_MODEL_3 = "openai/non-existent-fallback-3";
  process.env.AI_CLOUD_FALLBACK_MODEL = cloudModel;
  process.env.OPENROUTER_API_KEY = cloudApiKey;
  process.env.OPENROUTER_ENDPOINT = cloudEndpoint;
  process.env.AI_TIMEOUT_MS = String(timeoutMs);
  process.env.AI_MAX_RETRIES = "1";

  const provider = new OpenAIProvider();
  const startedAt = Date.now();

  const out = await provider.analyze({
    branch: "main",
    commitMessage: "forced cloud failover smoke test",
    prTitle: null,
    filesChanged: ["scripts/forced-cloud-failover-smoke.mjs"],
    routes: [],
    apiEndpoints: [],
    envVars: [],
    dbMigrations: [],
    uiComponents: [],
    authPatterns: [],
    testStatus: "passed",
    diffSummary: "Validate forced primary failure routes to OpenRouter fallback.",
  });

  const providerUsed = String(out?.providerUsed ?? "");
  const result = {
    providerUsed,
    generationMs: out?.generationMs ?? Date.now() - startedAt,
    featureName: out?.featureName ?? null,
  };

  if (!providerUsed.startsWith("openrouter:")) {
    console.error(JSON.stringify(result, null, 2));
    throw new Error("Failover smoke test failed: providerUsed did not route to OpenRouter.");
  }

  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
