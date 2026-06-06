import { getOptionalRuntimeConfig } from "../config.js";
import { logToolEvent, resolveTraceId } from "../lib/logger.js";
import { DeterministicProvider } from "./deterministic.js";
import { AnthropicProvider } from "./anthropic.js";
import { BifrostProvider } from "./bifrost.js";
import { OllamaProvider } from "./ollama.js";
import { OpenAIProvider } from "./openai.js";
import type { ModelAnalysis, ModelProvider, StructuredEvidence } from "./base.js";

let activeProvider: ModelProvider | null = null;
const fallbackProvider = new DeterministicProvider();

export function resetProvider(): void {
  activeProvider = null;
}

export function buildCandidate(): ModelProvider {
  const runtime = getOptionalRuntimeConfig();
  switch (runtime.provider.type) {
    case "local-ollama":
      return new BifrostProvider();
    case "local-lmstudio":
      return new BifrostProvider();
    case "local-vllm":
      return new BifrostProvider();
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
  const healthy = await candidate.healthCheck().catch(() => false);
  if (!healthy) {
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
      stage: "fallback",
      traceId: resolveTraceId(),
      message: `Provider ${provider.id} failed; falling back to deterministic.`,
      data: { error: error instanceof Error ? error.message : String(error) },
    });

    return fallbackProvider.analyze(evidence);
  }
}