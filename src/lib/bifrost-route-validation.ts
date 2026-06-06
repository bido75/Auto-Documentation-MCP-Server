import { getOptionalRuntimeConfig } from "../config.js";

const BIFROST_PROVIDER_TYPES = new Set(["bifrost", "local-ollama", "local-lmstudio", "local-vllm"]);

export interface BifrostRouteValidationResult {
  valid: boolean;
  warnings: string[];
  bifrostEndpoint: string;
  aiEndpoint: string;
}

function safeUrlParse(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

export function validateBifrostRouteConfig(): BifrostRouteValidationResult {
  const runtime = getOptionalRuntimeConfig();
  const warnings: string[] = [];

  const bifrostRaw = runtime.bifrostEndpoint.trim();
  const aiRaw = runtime.provider.endpoint.trim();
  const providerType = runtime.provider.type.trim().toLowerCase();

  const bifrostUrl = safeUrlParse(bifrostRaw);
  const aiUrl = safeUrlParse(aiRaw);

  if (!bifrostUrl) {
    warnings.push("BIFROST_ENDPOINT is not a valid URL.");
  } else {
    const path = bifrostUrl.pathname.replace(/\/+$/, "");
    if (path.length > 0 && path !== "/") {
      warnings.push("BIFROST_ENDPOINT should be a gateway base URL (no route suffix like /v1).");
    }
  }

  if (!aiUrl) {
    warnings.push("AI_ENDPOINT is not a valid URL.");
  } else if (BIFROST_PROVIDER_TYPES.has(providerType)) {
    const path = aiUrl.pathname.replace(/\/+$/, "");
    if (!path.endsWith("/v1")) {
      warnings.push("AI_ENDPOINT for Bifrost/OpenAI-compatible providers should end with /v1.");
    }
  }

  if (bifrostUrl && aiUrl) {
    if (bifrostUrl.origin !== aiUrl.origin && BIFROST_PROVIDER_TYPES.has(providerType)) {
      warnings.push("BIFROST_ENDPOINT and AI_ENDPOINT use different origins. Verify routing intent.");
    }
  }

  return {
    valid: warnings.length === 0,
    warnings,
    bifrostEndpoint: bifrostRaw,
    aiEndpoint: aiRaw,
  };
}
