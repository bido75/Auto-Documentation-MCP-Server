import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { buildCandidate, resetProvider } from "../providers/factory.js";
import { logToolEvent, resolveTraceId } from "../lib/logger.js";
import { throwAsMcpToolError } from "../lib/mcp-error.js";
import { storeApiKey } from "../installer/token-store.js";

type ConfigureAiProviderInput = {
    providerType: string;
    endpoint?: string;
    apiKey?: string;
    modelName?: string;
    runHealthCheck?: boolean;
    traceId?: string;
};

function upsertEnvContents(existing: string, updates: Record<string, string | undefined>): string {
    const lines = existing.length > 0 ? existing.split(/\r?\n/) : [];
    const next = new Map<string, string>();
    for (const line of lines) {
        const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
        if (match) {
            next.set(match[1], match[2]);
        }
    }
    for (const [key, value] of Object.entries(updates)) {
        if (value !== undefined) {
            next.set(key, value);
        }
    }
    return `${Array.from(next.entries())
        .map(([key, value]) => `${key}=${value}`)
        .join("\n")}\n`;
}
export function registerConfigureAiProviderTool(server: McpServer): void {
    server.tool("configure_ai_provider", "Set the AI model provider for documentation generation. Supports local Ollama, cloud Claude/GPT-4, Bifrost gateway, or deterministic mode.", {
        providerType: z.enum([
            "deterministic",
            "local-ollama",
            "local-lmstudio",
            "local-vllm",
            "cloud-openai",
            "cloud-anthropic",
            "cloud-azure",
            "cloud-gemini",
            "cloud-groq",
            "bifrost",
        ]),
        endpoint: z.string().optional(),
        apiKey: z.string().optional(),
        modelName: z.string().optional(),
        runHealthCheck: z.boolean().default(true),
        traceId: z.string().optional(),
    }, async ({ providerType, endpoint, apiKey, modelName, runHealthCheck = true, traceId: incomingTraceId }: ConfigureAiProviderInput) => {
        const traceId = resolveTraceId(incomingTraceId);
        const startedAt = Date.now();
        try {
            const envPath = join(process.cwd(), ".env");
            const existing = await readFile(envPath, "utf8").catch(() => "");
            const content = upsertEnvContents(existing, {
                AI_PROVIDER_TYPE: providerType,
                AI_ENDPOINT: endpoint,
                AI_MODEL_NAME: modelName,
            });
            await writeFile(envPath, content, "utf8");
            process.env.AI_PROVIDER_TYPE = providerType;
            if (endpoint) {
                process.env.AI_ENDPOINT = endpoint;
            }
            if (modelName) {
                process.env.AI_MODEL_NAME = modelName;
            }
            if (apiKey) {
                process.env.AI_API_KEY = apiKey;
                await storeApiKey(providerType, apiKey);
            }
            resetProvider();
            const candidate = buildCandidate();
            const healthy = runHealthCheck ? await candidate.healthCheck().catch(() => false) : true;
            logToolEvent({
                level: healthy ? "info" : "warn",
                tool: "configure_ai_provider",
                stage: healthy ? "success" : "health_check_failed",
                traceId,
                message: healthy ? "Configured AI provider" : "Configured AI provider but health check failed",
                data: { providerType, endpoint, modelName, durationMs: Date.now() - startedAt },
            });
            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify({
                            traceId,
                            providerType,
                            endpoint: endpoint ?? null,
                            modelName: modelName ?? null,
                            healthy,
                            message: healthy
                                ? `Provider ${providerType} is configured and ready.`
                                : `Provider ${providerType} failed health check. Deterministic fallback will remain available.`,
                        }, null, 2),
                    },
                ],
            };
        }
        catch (error) {
            logToolEvent({
                level: "error",
                tool: "configure_ai_provider",
                stage: "failure",
                traceId,
                message: "Failed to configure AI provider",
                data: { providerType, error: error instanceof Error ? error.message : String(error), durationMs: Date.now() - startedAt },
            });
            throwAsMcpToolError({
                tool: "configure_ai_provider",
                traceId,
                error,
                defaultCode: "CONFIGURE_AI_PROVIDER_FAILED",
            });
        }
    });
}
