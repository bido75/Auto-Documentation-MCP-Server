import { resolveOptionalRuntimeConfig } from "../lib/runtime-context.js";
import { logToolEvent, resolveTraceId } from "../lib/logger.js";
import { DeterministicProvider } from "./deterministic.js";
import { AnthropicProvider } from "./anthropic.js";
import { BifrostProvider } from "./bifrost.js";
import { LMStudioProvider } from "./lmstudio.js";
import { OllamaProvider } from "./ollama.js";
import { OpenAIProvider } from "./openai.js";
import { VllmProvider } from "./vllm.js";
import type {
  ManualAuthoringProviderInput,
  ManualAuthoringProviderResult,
  ModelAnalysis,
  ModelProvider,
  StructuredEvidence,
} from "./base.js";

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
    logProviderFallback({
      from: candidate.id,
      to: fallbackProvider.id,
      reason: "Primary provider health check failed.",
    });
    return fallbackProvider;
  }

  activeProvider = candidate;
  activeProviderKey = cacheKey;
  return activeProvider;
}

function buildOpenRouterFallback(): ModelProvider | null {
  const runtime = resolveOptionalRuntimeConfig();
  if (!runtime.provider.cloudFallbackApiKey) {
    return null;
  }

  return new OpenAIProvider({
    id: "openrouter",
    displayName: `OpenRouter (${runtime.provider.cloudFallbackModel ?? runtime.provider.modelName})`,
    endpoint: runtime.provider.cloudFallbackEndpoint,
    apiKey: runtime.provider.cloudFallbackApiKey,
    modelName: runtime.provider.cloudFallbackModel ?? runtime.provider.modelName,
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function logProviderFallback(input: { from: string; to: string; reason: string; error?: unknown }): void {
  logToolEvent({
    level: "warn",
    tool: "provider_factory",
    stage: "provider_fallback",
    traceId: resolveTraceId(),
    message: `Provider fallback ${input.from} -> ${input.to}: ${input.reason}`,
    data: {
      from: input.from,
      to: input.to,
      reason: input.reason,
      ...(input.error === undefined ? {} : { error: errorMessage(input.error) }),
    },
  });
}

async function tryAnalyzeWithProvider(provider: ModelProvider, evidence: StructuredEvidence): Promise<ModelAnalysis> {
  const healthy = await provider.healthCheck().catch((error) => {
    logProviderFallback({
      from: provider.id,
      to: "next-tier",
      reason: "Provider health check threw.",
      error,
    });
    return false;
  });
  if (!healthy) {
    throw new Error(`Provider ${provider.id} failed health check.`);
  }
  return provider.analyze(evidence);
}

async function tryAuthorWithProvider(
  provider: ModelProvider,
  input: ManualAuthoringProviderInput,
): Promise<ManualAuthoringProviderResult> {
  const healthy = await provider.healthCheck().catch((error) => {
    logProviderFallback({
      from: provider.id,
      to: "next-tier",
      reason: "Provider health check threw.",
      error,
    });
    return false;
  });
  if (!healthy) {
    throw new Error(`Provider ${provider.id} failed health check.`);
  }
  if (!provider.authorManualSection) {
    throw new Error(`Provider ${provider.id} does not support dedicated manual authoring.`);
  }
  const result = await provider.authorManualSection(input);
  if (!result.body.trim()) {
    throw new Error(`Provider ${provider.id} returned an empty manual body.`);
  }
  return result;
}

export async function analyzeWithFallback(evidence: StructuredEvidence): Promise<ModelAnalysis> {
  const runtime = resolveOptionalRuntimeConfig();
  const provider = buildCandidate();
  const openRouter = buildOpenRouterFallback();
  let primaryError: unknown;

  try {
    return await tryAnalyzeWithProvider(provider, evidence);
  } catch (error) {
    primaryError = error;
  }

  if (openRouter && provider.id !== openRouter.id) {
    logProviderFallback({
      from: provider.id,
      to: openRouter.id,
      reason: "Primary provider failed; trying cloud fallback.",
      error: primaryError,
    });
    try {
      return await tryAnalyzeWithProvider(openRouter, evidence);
    } catch (cloudError) {
      logProviderFallback({
        from: openRouter.id,
        to: fallbackProvider.id,
        reason: "Cloud fallback failed; trying deterministic fallback.",
        error: cloudError,
      });
      primaryError = new Error(`${errorMessage(primaryError)}; ${errorMessage(cloudError)}`);
    }
  }

  if (!runtime.provider.fallbackToDeterm || provider.id === fallbackProvider.id) {
    if (primaryError instanceof Error) {
      throw primaryError;
    }
    throw new Error(errorMessage(primaryError));
  }

  if (!openRouter) {
    logProviderFallback({
      from: provider.id,
      to: fallbackProvider.id,
      reason: "Primary provider failed and no cloud fallback is configured.",
      error: primaryError,
    });
  } else {
    logProviderFallback({
      from: provider.id,
      to: fallbackProvider.id,
      reason: "All provider tiers failed; using deterministic fallback.",
      error: primaryError,
    });
  }

  return fallbackProvider.analyze(evidence);
}

export async function authorManualWithFallback(input: ManualAuthoringProviderInput): Promise<ManualAuthoringProviderResult> {
  const provider = buildCandidate();
  const openRouter = buildOpenRouterFallback();
  let primaryError: unknown;

  try {
    return await tryAuthorWithProvider(provider, input);
  } catch (error) {
    primaryError = error;
  }

  if (openRouter && provider.id !== openRouter.id) {
    logProviderFallback({
      from: provider.id,
      to: openRouter.id,
      reason: "Primary provider failed during manual authoring; trying cloud fallback.",
      error: primaryError,
    });
    try {
      return await tryAuthorWithProvider(openRouter, input);
    } catch (cloudError) {
      logProviderFallback({
        from: openRouter.id,
        to: fallbackProvider.id,
        reason: "Cloud fallback failed during manual authoring; falling back to local authoring tiers.",
        error: cloudError,
      });
      primaryError = new Error(`${errorMessage(primaryError)}; ${errorMessage(cloudError)}`);
    }
  } else {
    logProviderFallback({
      from: provider.id,
      to: fallbackProvider.id,
      reason: "Primary provider failed during manual authoring and no cloud fallback is configured.",
      error: primaryError,
    });
  }

  if (primaryError instanceof Error) {
    throw primaryError;
  }
  throw new Error(errorMessage(primaryError));
}

export async function embedText(text: string): Promise<number[]> {
  const provider = await getProvider();
  if (!provider.supportsEmbeddings || !provider.embed) {
    throw new Error(`Provider ${provider.id} does not support embeddings.`);
  }

  return provider.embed(text);
}
