import { resolveOptionalRuntimeConfig } from "../lib/runtime-context.js";
import { logToolEvent, resolveTraceId } from "../lib/logger.js";
import { DeterministicProvider } from "./deterministic.js";
import { AnthropicProvider } from "./anthropic.js";
import { BifrostProvider } from "./bifrost.js";
import { LMStudioProvider } from "./lmstudio.js";
import { OllamaProvider } from "./ollama.js";
import { OpenAIProvider } from "./openai.js";
import { VllmProvider } from "./vllm.js";
import type { ModelAnalysis, ModelProvider, StructuredEvidence } from "./base.js";

let activeProvider: ModelProvider | null = null;
let activeProviderKey: string | null = null;
const fallbackProvider = new DeterministicProvider();

export function resetProvider(): void {
  activeProvider = null;
  activeProviderKey = null;
}

function providerCacheKey(): string {
  const runtime = resolveOptionalRuntimeConfig();
  return JSON.stringify({
    type: runtime.provider.type,
    endpoint: runtime.provider.endpoint,
    modelName: runtime.provider.modelName,
    apiKeyPresent: Boolean(runtime.provider.apiKey),
  });
}

export function buildCandidate(): ModelProvider {
  const runtime = resolveOptionalRuntimeConfig();
  switch (runtime.provider.type) {
    case "local-ollama":
      return new OllamaProvider();
    case "local-lmstudio":
      return new LMStudioProvider();
    case "local-vllm":
      return new VllmProvider();
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
  const cacheKey = providerCacheKey();
  if (activeProvider && activeProviderKey === cacheKey) {
    return activeProvider;
  }

  const candidate = buildCandidate();
  const healthy = await candidate.healthCheck().catch(() => false);
  if (!healthy) {
    return fallbackProvider;
  }

  activeProvider = candidate;
  activeProviderKey = cacheKey;
  return activeProvider;
}

export async function analyzeWithFallback(evidence: StructuredEvidence): Promise<ModelAnalysis> {
  const runtime = resolveOptionalRuntimeConfig();
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

export async function embedText(text: string): Promise<number[]> {
  const provider = await getProvider();
  if (!provider.supportsEmbeddings || !provider.embed) {
    throw new Error(`Provider ${provider.id} does not support embeddings.`);
  }

  return provider.embed(text);
}
