import { getOptionalRuntimeConfig, type EmbeddingProviderType } from "../config.js";
import { logToolEvent, resolveTraceId } from "../lib/logger.js";
import { DeterministicProvider } from "./deterministic.js";
import { AnthropicProvider } from "./anthropic.js";
import { BifrostProvider } from "./bifrost.js";
import type { ModelAnalysis, ModelProvider, StructuredEvidence } from "./base.js";
import { OllamaProvider } from "./ollama.js";
import { OpenAIProvider } from "./openai.js";

let activeProvider: ModelProvider | null = null;
const fallbackProvider = new DeterministicProvider();

export function resetProvider(): void {
  activeProvider = null;
}

export function buildCandidate(): ModelProvider {
  const runtime = getOptionalRuntimeConfig();
  switch (runtime.provider.type) {
    case "local-ollama":
      return new OllamaProvider("local-ollama");
    case "local-lmstudio":
      return new OllamaProvider("local-lmstudio");
    case "local-vllm":
      return new OllamaProvider("local-vllm");
    case "cloud-anthropic":
      return new AnthropicProvider();
    case "cloud-openai":
    case "cloud-azure":
    case "cloud-gemini":
    case "cloud-groq":
      return new OpenAIProvider();
    case "bifrost":
      return new BifrostProvider();
    default:
      return fallbackProvider;
  }
}

export async function getProvider(): Promise<ModelProvider> {
  if (activeProvider) {
    return activeProvider;
  }

  const candidate = buildCandidate();
  const healthy = await candidate.healthCheck().catch((error) => {
    logToolEvent({
      level: "warn",
      tool: "provider_factory",
      stage: "candidate_healthcheck_error",
      traceId: resolveTraceId(),
      message: "Provider candidate health check threw; falling back to deterministic provider.",
      data: {
        candidateId: candidate.id,
        error: error instanceof Error ? error.message : String(error),
      },
    });
    return false;
  });
  if (!healthy) {
    logToolEvent({
      level: "warn",
      tool: "provider_factory",
      stage: "fallback_to_deterministic_unhealthy_candidate",
      traceId: resolveTraceId(),
      message: "Provider candidate is unhealthy; using deterministic fallback provider.",
      data: {
        candidateId: candidate.id,
        fallbackId: fallbackProvider.id,
      },
    });
    return fallbackProvider;
  }

  activeProvider = candidate;
  return activeProvider;
}

export async function analyzeWithFallback(evidence: StructuredEvidence): Promise<ModelAnalysis> {
  const runtime = getOptionalRuntimeConfig();
  const provider = await getProvider();
  try {
    return await provider.analyze(evidence);
  } catch (error) {
    if (!runtime.provider.fallbackToDeterm || provider.id === fallbackProvider.id) {
      throw error;
    }

    logToolEvent({
      level: "warn",
      tool: "provider_factory",
      stage: "fallback_to_deterministic_after_analyze_error",
      traceId: resolveTraceId(),
      message: "Provider analysis failed; retrying with deterministic fallback provider.",
      data: {
        providerId: provider.id,
        fallbackId: fallbackProvider.id,
        error: error instanceof Error ? error.message : String(error),
      },
    });

    return fallbackProvider.analyze(evidence);
  }
}

export async function embedText(text: string): Promise<number[] | null> {
  const runtime = getOptionalRuntimeConfig();
  if (runtime.embedding.provider === "none") {
    return null;
  }

  const provider = await getEmbeddingProvider(runtime.embedding.provider);
  if (!provider?.embed) {
    return null;
  }

  return provider.embed(text);
}

async function getEmbeddingProvider(type: EmbeddingProviderType): Promise<ModelProvider | null> {
  switch (type) {
    case "local-ollama":
      return new OllamaProvider("local-ollama");
    case "cloud-openai":
      return new OpenAIProvider();
    default:
      return null;
  }
}