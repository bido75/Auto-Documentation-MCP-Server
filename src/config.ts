import { config as dotenvConfig } from "dotenv";
import { assertNotionTokenPresent } from "./lib/notion-preflight.js";

dotenvConfig();

export type PublishingMode = "Conservative" | "Balanced" | "Fully Automatic";

export interface RuntimeConfig {
  notionToken: string;
  defaultPublishingMode: PublishingMode;
  defaultAutoPublishThreshold: number;
}

export interface OptionalRuntimeConfig {
  notionToken?: string;
  corsAllowedOrigins: string[];
  stateEncryptionKey: string;
  artifactRoot: string;
  bifrostEndpoint: string;
  bifrostVirtualKey: string;
  provider: {
    type: string;
    endpoint: string;
    apiKey?: string;
    modelName: string;
    fallbackModels: string[];
    cloudFallbackModel?: string;
    cloudFallbackEndpoint: string;
    cloudFallbackApiKey?: string;
    temperature: number;
    timeoutMs: number;
    maxRetries: number;
    fallbackToDeterm: boolean;
    bifrostVk: string;
  };
  embedding: {
    provider: string;
    endpoint?: string;
    apiKey?: string;
    modelName: string;
    similarityThreshold: number;
    indexPath: string;
  };
  publishing: {
    mode: string;
    autoPublishThreshold: number;
  };
  runner: {
    tickIntervalMs: number;
    maxConcurrentTargets: number;
    maxConsecutiveFailures: number;
    circuitResetAfterMs: number;
    perTargetTimeoutMs: number;
  };
  prompts: {
    analyzerPromptName: string;
    reviewerPromptName: string;
    gapFillerPromptName: string;
    stalenessUpdaterPromptName: string;
  };
  selfDoc: {
    projectId?: string;
    repoPath?: string;
    mode: string;
  };
  defaultPublishingMode: PublishingMode;
  defaultAutoPublishThreshold: number;
}

function envString(key: string, fallback: string, env: NodeJS.ProcessEnv): string {
  return env[key]?.trim() || fallback;
}

function envFloat(key: string, fallback: number, env: NodeJS.ProcessEnv): number {
  const parsed = Number.parseFloat(env[key] ?? "");
  return Number.isFinite(parsed) ? parsed : fallback;
}

function envInt(key: string, fallback: number, env: NodeJS.ProcessEnv): number {
  const parsed = Number.parseInt(env[key] ?? "", 10);
  return Number.isInteger(parsed) ? parsed : fallback;
}

function envBool(key: string, fallback: boolean, env: NodeJS.ProcessEnv): boolean {
  const value = env[key]?.trim().toLowerCase();
  if (!value) {
    return fallback;
  }

  return value === "true";
}

export const DEFAULT_STATE_ENCRYPTION_KEY = "auto-doc-mcp-default-dev-key-change-me";

const PLACEHOLDER_STATE_ENCRYPTION_KEYS = new Set([
  DEFAULT_STATE_ENCRYPTION_KEY,
  "change-this-for-self-hosted",
  "change-this-to-a-random-32-char-string-in-production",
]);

export class ProductionSecretConfigError extends Error {
  readonly code = "PRODUCTION_SECRET_CONFIG_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "ProductionSecretConfigError";
  }
}

export function assertProductionSecretConfig(env = process.env): void {
  const nodeEnv = env.NODE_ENV?.trim().toLowerCase();
  const runtimeMode = env.AUTO_DOC_RUNTIME_MODE?.trim().toLowerCase();
  const productionLike = nodeEnv === "production" || runtimeMode === "runner" || runtimeMode === "bridge";
  if (!productionLike) {
    return;
  }

  const key = env.STATE_ENCRYPTION_KEY?.trim();
  if (!key || PLACEHOLDER_STATE_ENCRYPTION_KEYS.has(key)) {
    throw new ProductionSecretConfigError(
      "STATE_ENCRYPTION_KEY must be set to a unique high-entropy value before running Auto-Doc in production, runner, or bridge mode.",
    );
  }
}

export function getOptionalRuntimeConfig(env = process.env): OptionalRuntimeConfig {
  const bifrostVk = env.BIFROST_VIRTUAL_KEY?.trim() || "";
  return {
    notionToken: env.NOTION_TOKEN?.trim() || undefined,
    corsAllowedOrigins: envString("CORS_ALLOWED_ORIGINS", "http://localhost", env)
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
    stateEncryptionKey: envString("STATE_ENCRYPTION_KEY", DEFAULT_STATE_ENCRYPTION_KEY, env),
    artifactRoot: envString("AUTO_DOC_ARTIFACT_ROOT", ".auto-doc/artifacts", env),
    bifrostEndpoint: envString("BIFROST_ENDPOINT", "http://bifrost-gateway:8080", env),
    bifrostVirtualKey: bifrostVk,
    provider: {
      type: envString("AI_PROVIDER_TYPE", "bifrost", env),
      endpoint: envString("AI_ENDPOINT", "http://bifrost-gateway:8080/v1", env),
      apiKey: env.AI_API_KEY?.trim() || env.OPENAI_API_KEY?.trim() || env.OPENROUTER_API_KEY?.trim() || undefined,
      modelName: envString("AI_MODEL_NAME", "openai/llama3.2:3b-instruct-q4_K_M", env),
      fallbackModels: [env.AI_FALLBACK_MODEL_1?.trim(), env.AI_FALLBACK_MODEL_2?.trim(), env.AI_FALLBACK_MODEL_3?.trim()].filter(
        (value): value is string => Boolean(value),
      ),
      cloudFallbackModel: env.AI_CLOUD_FALLBACK_MODEL?.trim() || undefined,
      cloudFallbackEndpoint: envString("OPENROUTER_ENDPOINT", "https://openrouter.ai/api/v1", env),
      cloudFallbackApiKey: env.OPENROUTER_API_KEY?.trim() || undefined,
      temperature: envFloat("AI_TEMPERATURE", 0.2, env),
      timeoutMs: envInt("AI_TIMEOUT_MS", 45000, env),
      maxRetries: envInt("AI_MAX_RETRIES", 2, env),
      fallbackToDeterm: envBool("AI_FALLBACK_TO_DETERMINISTIC", true, env),
      bifrostVk,
    },
    embedding: {
      provider: envString("EMBEDDING_PROVIDER", "none", env),
      endpoint: env.EMBEDDING_ENDPOINT?.trim() || undefined,
      apiKey: env.EMBEDDING_API_KEY?.trim() || undefined,
      modelName: envString("EMBEDDING_MODEL", "nomic-embed-text", env),
      similarityThreshold: envFloat("EMBEDDING_SIMILARITY_THRESHOLD", 0.92, env),
      indexPath: envString("EMBEDDING_INDEX_PATH", ".auto-doc-mcp/embeddings.json", env),
    },
    publishing: {
      mode: envString("PUBLISHING_MODE", "balanced", env),
      autoPublishThreshold: envInt("AUTO_PUBLISH_THRESHOLD", 90, env),
    },
    runner: {
      tickIntervalMs: envInt("RUNNER_TICK_MS", 30000, env),
      maxConcurrentTargets: envInt("RUNNER_MAX_CONCURRENT", 4, env),
      maxConsecutiveFailures: envInt("RUNNER_MAX_FAILURES", 5, env),
      circuitResetAfterMs: envInt("RUNNER_CIRCUIT_RESET_MS", 300000, env),
      perTargetTimeoutMs: envInt("RUNNER_TARGET_TIMEOUT_MS", 60000, env),
    },
    prompts: {
      analyzerPromptName: envString("AUTO_DOC_ANALYZER_PROMPT_NAME", "auto-doc-analyzer", env),
      reviewerPromptName: envString("AUTO_DOC_REVIEWER_PROMPT_NAME", "auto-doc-reviewer", env),
      gapFillerPromptName: envString("AUTO_DOC_GAP_FILLER_PROMPT_NAME", "auto-doc-gap-filler", env),
      stalenessUpdaterPromptName: envString("AUTO_DOC_STALENESS_UPDATER_PROMPT_NAME", "auto-doc-staleness-updater", env),
    },
    selfDoc: {
      projectId: env.SELF_DOC_PROJECT_ID?.trim() || undefined,
      repoPath: env.SELF_DOC_REPO_PATH?.trim() || undefined,
      mode: envString("SELF_DOC_RUNNER_MODE", "last_commit", env),
    },
    defaultPublishingMode: "Balanced",
    defaultAutoPublishThreshold: 90,
  };
}

export function getRuntimeConfig(env = process.env): RuntimeConfig {
  assertProductionSecretConfig(env);
  const runtime = getOptionalRuntimeConfig(env);
  assertNotionTokenPresent(runtime.notionToken);
  const resolvedNotionToken = runtime.notionToken as string;

  return {
    notionToken: resolvedNotionToken,
    defaultPublishingMode: runtime.defaultPublishingMode,
    defaultAutoPublishThreshold: runtime.defaultAutoPublishThreshold,
  };
}
