import { config as dotenvConfig } from "dotenv";
import { assertNotionTokenPresent } from "./lib/notion-preflight.js";
import { getRuntimeContext } from "./lib/runtime-context.js";

dotenvConfig();

export type PublishingMode = "Conservative" | "Balanced" | "Fully Automatic";

export type ModelProviderType =
  | "deterministic"
  | "local-ollama"
  | "local-lmstudio"
  | "local-vllm"
  | "cloud-openai"
  | "cloud-anthropic"
  | "cloud-azure"
  | "cloud-gemini"
  | "cloud-groq"
  | "bifrost";

export type EmbeddingProviderType = "none" | "local-ollama" | "cloud-openai" | "cloud-anthropic";

export interface ProviderConfig {
  type: ModelProviderType;
  endpoint: string;
  apiKey?: string;
  modelName: string;
  temperature: number;
  timeoutMs: number;
  maxRetries: number;
  fallbackToDeterm: boolean;
}

export interface EmbeddingConfig {
  provider: EmbeddingProviderType;
  endpoint?: string;
  apiKey?: string;
  modelName: string;
  similarityThreshold: number;
  indexPath: string;
}

export interface PublishingConfig {
  mode: "conservative" | "balanced" | "fully_automatic";
  autoPublishThreshold: number;
}

export interface RunnerRuntimeConfig {
  tickIntervalMs: number;
  maxConcurrentTargets: number;
  maxConsecutiveFailures: number;
  circuitResetAfterMs: number;
  perTargetTimeoutMs: number;
}

export interface BaseRuntimeConfig {
  notionToken?: string;
  corsAllowedOrigins: string[];
  stateEncryptionKey: string;
  provider: ProviderConfig;
  embedding: EmbeddingConfig;
  publishing: PublishingConfig;
  runner: RunnerRuntimeConfig;
  defaultPublishingMode: PublishingMode;
  defaultAutoPublishThreshold: number;
}

export interface RuntimeConfig extends BaseRuntimeConfig {
  notionToken: string;
}

export function getOptionalRuntimeConfig(env = process.env): BaseRuntimeConfig {
  const context = getRuntimeContext();
  const scopedNotionToken = context.notionToken?.trim();

  return {
    notionToken: scopedNotionToken && scopedNotionToken.length > 0 ? scopedNotionToken : env.NOTION_TOKEN?.trim() || undefined,
    corsAllowedOrigins: envString("CORS_ALLOWED_ORIGINS", "http://localhost", env)
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
    stateEncryptionKey: envString("STATE_ENCRYPTION_KEY", "auto-doc-mcp-default-dev-key-change-me", env),
    provider: {
      type: envString("AI_PROVIDER_TYPE", "deterministic", env) as ModelProviderType,
      endpoint: envString("AI_ENDPOINT", "http://localhost:11434", env),
      apiKey: env.AI_API_KEY?.trim() || undefined,
      modelName: envString("AI_MODEL_NAME", "llama3.1", env),
      temperature: envFloat("AI_TEMPERATURE", 0.2, env),
      timeoutMs: envInt("AI_TIMEOUT_MS", 45_000, env),
      maxRetries: envInt("AI_MAX_RETRIES", 2, env),
      fallbackToDeterm: envBool("AI_FALLBACK_TO_DETERMINISTIC", true, env),
    },
    embedding: {
      provider: envString("EMBEDDING_PROVIDER", "none", env) as EmbeddingProviderType,
      endpoint: env.EMBEDDING_ENDPOINT?.trim() || undefined,
      apiKey: env.EMBEDDING_API_KEY?.trim() || undefined,
      modelName: envString("EMBEDDING_MODEL", "nomic-embed-text", env),
      similarityThreshold: envFloat("EMBEDDING_SIMILARITY_THRESHOLD", 0.92, env),
      indexPath: envString("EMBEDDING_INDEX_PATH", ".auto-doc-mcp/embeddings.json", env),
    },
    publishing: {
      mode: envString("PUBLISHING_MODE", "balanced", env) as PublishingConfig["mode"],
      autoPublishThreshold: envInt("AUTO_PUBLISH_THRESHOLD", 90, env),
    },
    runner: {
      tickIntervalMs: envInt("RUNNER_TICK_MS", 30_000, env),
      maxConcurrentTargets: envInt("RUNNER_MAX_CONCURRENT", 4, env),
      maxConsecutiveFailures: envInt("RUNNER_MAX_FAILURES", 5, env),
      circuitResetAfterMs: envInt("RUNNER_CIRCUIT_RESET_MS", 300_000, env),
      perTargetTimeoutMs: envInt("RUNNER_TARGET_TIMEOUT_MS", 60_000, env),
    },
    defaultPublishingMode: "Balanced",
    defaultAutoPublishThreshold: 90,
  };
}

export function getRuntimeConfig(env = process.env): RuntimeConfig {
  const runtime = getOptionalRuntimeConfig(env);
  assertNotionTokenPresent(runtime.notionToken);

  return {
    ...runtime,
    notionToken: runtime.notionToken as string,
  };
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
