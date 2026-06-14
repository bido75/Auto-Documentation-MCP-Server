import OpenAI from "openai";
import { resolveOptionalRuntimeConfig } from "../lib/runtime-context.js";
import { buildSharedPromptContent, type ModelAnalysis, type ModelProvider, type StructuredEvidence } from "./base.js";

export class OpenAIProvider implements ModelProvider {
  readonly id: string = "cloud-openai";
  readonly supportsEmbeddings = true;
  readonly displayName: string;
  private readonly client: OpenAI;

  constructor() {
    const runtime = resolveOptionalRuntimeConfig();
    this.displayName = `OpenAI (${runtime.provider.modelName})`;
    const maybeBifrostHeaders = runtime.provider.endpoint.includes("bifrost")
      ? {
          ...(runtime.provider.bifrostVk ? { "x-bf-vk": runtime.provider.bifrostVk } : {}),
          "x-bf-eh-client-id": "auto-doc-mcp",
        }
      : undefined;
    this.client = new OpenAI({
      apiKey: runtime.provider.apiKey,
      baseURL: runtime.provider.endpoint,
      timeout: runtime.provider.timeoutMs,
      maxRetries: runtime.provider.maxRetries,
      ...(maybeBifrostHeaders ? { defaultHeaders: maybeBifrostHeaders } : {}),
    });
  }

  async healthCheck(): Promise<boolean> {
    try {
      await this.client.models.list();
      return true;
    } catch {
      return false;
    }
  }

  async analyze(ev: StructuredEvidence): Promise<ModelAnalysis> {
    const runtime = resolveOptionalRuntimeConfig();
    const startedAt = Date.now();
    const response = await this.client.chat.completions.create({
      model: runtime.provider.modelName,
      temperature: runtime.provider.temperature,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: "You are a technical documentation writer. Respond only with valid JSON." },
        { role: "user", content: buildSharedPromptContent(ev) },
      ],
    });
    const content = response.choices[0]?.message?.content ?? "{}";
    const parsed = JSON.parse(content) as ModelAnalysis;
    return { ...parsed, providerUsed: `${this.id}:${runtime.provider.modelName}`, generationMs: Date.now() - startedAt };
  }

  async embed(text: string): Promise<number[]> {
    const runtime = resolveOptionalRuntimeConfig();
    const response = await this.client.embeddings.create({
      model: runtime.embedding.modelName || "text-embedding-3-small",
      input: text,
    });
    return response.data[0]?.embedding ?? [];
  }
}
