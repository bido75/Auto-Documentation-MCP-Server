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
const CLOUD_FALLBACK_MODEL_ENV = "AI_CLOUD_FALLBACK_MODEL";
const CLOUD_FALLBACK_MODELS_ENV = "AI_CLOUD_FALLBACK_MODELS";

type ProviderTier = {
  provider: ModelProvider;
  modelName?: string;
};

export type ProviderTierPreflightResult = {
  providerId: string;
  displayName: string;
  modelName?: string;
  resolution: "resolved" | "unresolved" | "unknown";
  healthy: boolean;
  latencyMs: number;
  responsePreview?: string;
  error?: string;
};

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

export function buildCandidate(env = process.env): ModelProvider {
  const runtime = resolveOptionalRuntimeConfig(env);
  switch (runtime.provider.type) {
    case "local-ollama":
      return new OllamaProvider("local-ollama", {
        endpoint: runtime.provider.endpoint,
        modelName: runtime.provider.modelName,
        timeoutMs: runtime.provider.timeoutMs,
        temperature: runtime.provider.temperature,
      });
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
      return new OpenAIProvider({
        endpoint: runtime.provider.endpoint,
        apiKey: runtime.provider.apiKey,
        modelName: runtime.provider.modelName,
        timeoutMs: runtime.provider.timeoutMs,
      });
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

function buildOpenRouterFallbackForModel(modelName: string, env = process.env): ModelProvider | null {
  const runtime = resolveOptionalRuntimeConfig(env);
  if (!runtime.provider.cloudFallbackApiKey || !modelName) {
    return null;
  }

  return new OpenAIProvider({
    id: "openrouter",
    displayName: `OpenRouter (${modelName})`,
    endpoint: runtime.provider.cloudFallbackEndpoint,
    apiKey: runtime.provider.cloudFallbackApiKey,
    modelName,
    timeoutMs: runtime.provider.timeoutMs,
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isModelResolutionFailure(message: string): boolean {
  return (
    /not a valid model id/i.test(message) ||
    /model[^.:\n]*(not found|not available|does not exist|doesn't exist|invalid|unrecognized)/i.test(message) ||
    /\b(400|404)\b.*\bmodel\b/i.test(message)
  );
}

function logProviderFallback(input: { from: string; to: string; reason: string; error?: unknown; fromModel?: string; toModel?: string }): void {
  const from = input.fromModel ? `${input.from}(${input.fromModel})` : input.from;
  const to = input.toModel ? `${input.to}(${input.toModel})` : input.to;
  logToolEvent({
    level: "warn",
    tool: "provider_factory",
    stage: "provider_fallback",
    traceId: resolveTraceId(),
    message: `Provider fallback ${from} -> ${to}: ${input.reason}`,
    data: {
      from: input.from,
      to: input.to,
      ...(input.fromModel ? { fromModel: input.fromModel } : {}),
      ...(input.toModel ? { toModel: input.toModel } : {}),
      reason: input.reason,
      ...(input.error === undefined ? {} : { error: errorMessage(input.error) }),
    },
  });
}

function logCloudFallbackTransition(input: { fromModel?: string; toModel?: string; reason: string; error?: unknown }): void {
  logToolEvent({
    level: "warn",
    tool: "provider_factory",
    stage: "provider_fallback",
    traceId: resolveTraceId(),
    message: `cloud fallback: ${input.fromModel ?? "unknown"} -> ${input.toModel ?? "unknown"} (reason: ${input.reason})`,
    data: {
      from: "openrouter",
      to: "openrouter",
      ...(input.fromModel ? { fromModel: input.fromModel } : {}),
      ...(input.toModel ? { toModel: input.toModel } : {}),
      reason: input.reason,
      ...(input.error === undefined ? {} : { error: errorMessage(input.error) }),
    },
  });
}

function buildPrimaryTier(env = process.env): ProviderTier {
  const runtime = resolveOptionalRuntimeConfig(env);
  return { provider: buildCandidate(env), modelName: runtime.provider.type === "deterministic" ? undefined : runtime.provider.modelName };
}

function buildOpenRouterFallbackTiers(env = process.env): ProviderTier[] {
  const runtime = resolveOptionalRuntimeConfig(env);
  return runtime.provider.cloudFallbackModels
    .map((modelName): ProviderTier | null => {
      const provider = buildOpenRouterFallbackForModel(modelName, env);
      return provider ? { provider, modelName } : null;
    })
    .filter((tier): tier is ProviderTier => tier !== null);
}

function buildConfiguredTiers(env = process.env): ProviderTier[] {
  const primaryTier = buildPrimaryTier(env);
  const openRouterTiers = buildOpenRouterFallbackTiers(env).filter((tier) => {
    return primaryTier.provider.id !== tier.provider.id || primaryTier.modelName !== tier.modelName;
  });
  return [primaryTier, ...openRouterTiers];
}

async function preflightTier(tier: ProviderTier): Promise<ProviderTierPreflightResult> {
  const startedAt = Date.now();
  try {
    const response = tier.provider.preflightGenerate
      ? await tier.provider.preflightGenerate()
      : (await tier.provider.healthCheck())
        ? "health-check-ok"
        : "";
    const healthy = response.trim().length > 0;
    return {
      providerId: tier.provider.id,
      displayName: tier.provider.displayName,
      ...(tier.modelName ? { modelName: tier.modelName } : {}),
      resolution: healthy ? "resolved" : "unknown",
      healthy,
      latencyMs: Date.now() - startedAt,
      responsePreview: response.slice(0, 80),
      ...(healthy ? {} : { error: "Provider returned an empty preflight completion." }),
    };
  } catch (error) {
    const message = errorMessage(error);
    return {
      providerId: tier.provider.id,
      displayName: tier.provider.displayName,
      ...(tier.modelName ? { modelName: tier.modelName } : {}),
      resolution: isModelResolutionFailure(message) ? "unresolved" : "unknown",
      healthy: false,
      latencyMs: Date.now() - startedAt,
      error: message,
    };
  }
}

export async function preflightProviderTiers(env = process.env): Promise<ProviderTierPreflightResult[]> {
  const results = await Promise.all(buildConfiguredTiers(env).map(preflightTier));
  for (const result of results) {
    logToolEvent({
      level: result.healthy ? "info" : "warn",
      tool: "provider_factory",
      stage: "provider_preflight",
      traceId: resolveTraceId(),
      message: `Provider preflight ${result.providerId}${result.modelName ? `(${result.modelName})` : ""}: ${
        result.healthy ? "healthy" : "failed"
      } (${result.resolution})`,
      data: result,
    });
  }
  return results;
}

export async function assertProviderStartupPreflight(env = process.env): Promise<ProviderTierPreflightResult[]> {
  const results = await preflightProviderTiers(env);
  const unresolvedTier = results.find((result) => result.resolution === "unresolved");
  if (unresolvedTier) {
    const envHint = unresolvedTier.providerId === "openrouter" ? ` from ${CLOUD_FALLBACK_MODELS_ENV}/${CLOUD_FALLBACK_MODEL_ENV}` : "";
    throw new Error(
      `Provider preflight failed: configured model slug ${unresolvedTier.modelName ?? "(unknown)"}${envHint} for ${unresolvedTier.providerId} did not resolve: ${
        unresolvedTier.error ?? "unknown provider error"
      }`,
    );
  }

  if (!results.some((result) => result.healthy)) {
    throw new Error(
      `Provider preflight failed: no configured provider tier completed generation. ${results
        .map((result) => `${result.providerId}${result.modelName ? `(${result.modelName})` : ""}: ${result.error ?? "unhealthy"}`)
        .join("; ")}`,
    );
  }

  return results;
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
  const primaryTier = buildPrimaryTier();
  const provider = primaryTier.provider;
  const openRouterTiers = buildOpenRouterFallbackTiers().filter((tier) => {
    return provider.id !== tier.provider.id || primaryTier.modelName !== tier.modelName;
  });
  let primaryError: unknown;
  const tierErrors: string[] = [];

  try {
    return await tryAnalyzeWithProvider(provider, evidence);
  } catch (error) {
    primaryError = error;
    tierErrors.push(`${provider.id}${primaryTier.modelName ? `(${primaryTier.modelName})` : ""}: ${errorMessage(error)}`);
  }

  let previousCloudTier: ProviderTier | null = null;
  let previousCloudError: unknown;
  for (const openRouterTier of openRouterTiers) {
    if (previousCloudTier) {
      logCloudFallbackTransition({
        fromModel: previousCloudTier.modelName,
        toModel: openRouterTier.modelName,
        reason: errorMessage(previousCloudError),
        error: previousCloudError,
      });
    } else {
      logProviderFallback({
        from: provider.id,
        to: openRouterTier.provider.id,
        fromModel: primaryTier.modelName,
        toModel: openRouterTier.modelName,
        reason: "Primary provider failed; trying cloud fallback.",
        error: primaryError,
      });
    }

    try {
      return await tryAnalyzeWithProvider(openRouterTier.provider, evidence);
    } catch (cloudError) {
      previousCloudTier = openRouterTier;
      previousCloudError = cloudError;
      tierErrors.push(`openrouter${openRouterTier.modelName ? `(${openRouterTier.modelName})` : ""}: ${errorMessage(cloudError)}`);
    }
  }

  if (!runtime.provider.fallbackToDeterm || provider.id === fallbackProvider.id) {
    throw new Error(tierErrors.join("; ") || errorMessage(primaryError));
  }

  const aggregateError = new Error(tierErrors.join("; ") || errorMessage(primaryError));
  if (openRouterTiers.length === 0) {
    logProviderFallback({
      from: provider.id,
      to: fallbackProvider.id,
      reason: "Primary provider failed and no cloud fallback is configured.",
      error: aggregateError,
    });
  } else {
    logProviderFallback({
      from: previousCloudTier?.provider.id ?? provider.id,
      to: fallbackProvider.id,
      fromModel: previousCloudTier?.modelName,
      reason: "All provider tiers failed; using deterministic fallback.",
      error: aggregateError,
    });
  }

  return fallbackProvider.analyze(evidence);
}

export async function authorManualWithFallback(input: ManualAuthoringProviderInput): Promise<ManualAuthoringProviderResult> {
  const primaryTier = buildPrimaryTier();
  const provider = primaryTier.provider;
  let primaryError: unknown;
  const tierErrors: string[] = [];
  const openRouterTiers = buildOpenRouterFallbackTiers().filter((tier) => {
    return provider.id !== tier.provider.id || primaryTier.modelName !== tier.modelName;
  });

  try {
    return await tryAuthorWithProvider(provider, input);
  } catch (error) {
    primaryError = error;
    tierErrors.push(`${provider.id}${primaryTier.modelName ? `(${primaryTier.modelName})` : ""}: ${errorMessage(error)}`);
  }

  let previousCloudTier: ProviderTier | null = null;
  let previousCloudError: unknown;
  for (const openRouterTier of openRouterTiers) {
    if (previousCloudTier) {
      logCloudFallbackTransition({
        fromModel: previousCloudTier.modelName,
        toModel: openRouterTier.modelName,
        reason: errorMessage(previousCloudError),
        error: previousCloudError,
      });
    } else {
      logProviderFallback({
        from: provider.id,
        to: openRouterTier.provider.id,
        fromModel: primaryTier.modelName,
        toModel: openRouterTier.modelName,
        reason: "Primary provider failed during manual authoring; trying cloud fallback.",
        error: primaryError,
      });
    }

    try {
      return await tryAuthorWithProvider(openRouterTier.provider, input);
    } catch (cloudError) {
      previousCloudTier = openRouterTier;
      previousCloudError = cloudError;
      tierErrors.push(`openrouter${openRouterTier.modelName ? `(${openRouterTier.modelName})` : ""}: ${errorMessage(cloudError)}`);
    }
  }

  if (openRouterTiers.length === 0) {
    logProviderFallback({
      from: provider.id,
      to: fallbackProvider.id,
      reason: "Primary provider failed during manual authoring and no cloud fallback is configured.",
      error: primaryError,
    });
  } else {
    logProviderFallback({
      from: previousCloudTier?.provider.id ?? provider.id,
      to: fallbackProvider.id,
      fromModel: previousCloudTier?.modelName,
      reason: "All provider tiers failed during manual authoring; falling back to local authoring tiers.",
      error: new Error(tierErrors.join("; ") || errorMessage(primaryError)),
    });
  }

  throw new Error(tierErrors.join("; ") || errorMessage(primaryError));
}

export async function embedText(text: string): Promise<number[]> {
  const provider = await getProvider();
  if (!provider.supportsEmbeddings || !provider.embed) {
    throw new Error(`Provider ${provider.id} does not support embeddings.`);
  }

  return provider.embed(text);
}
