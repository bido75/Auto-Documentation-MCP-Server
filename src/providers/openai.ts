import OpenAI from "openai";
import { resolveOptionalRuntimeConfig } from "../lib/runtime-context.js";
import {
  buildManualAuthoringPrompt,
  buildSharedPromptContent,
  type ManualAuthoringProviderInput,
  type ManualAuthoringProviderResult,
  type ModelAnalysis,
  type ModelProvider,
  type StructuredEvidence,
} from "./base.js";

export type OpenAIProviderOptions = {
  id?: string;
  displayName?: string;
  endpoint?: string;
  apiKey?: string;
  modelName?: string;
};

export class OpenAIProvider implements ModelProvider {
  readonly id: string;
  readonly supportsEmbeddings = true;
  readonly displayName: string;
  private readonly client: OpenAI;
  private readonly endpoint: string;
  private readonly apiKey?: string;
  private readonly modelName?: string;

  constructor(options: OpenAIProviderOptions = {}) {
    const runtime = resolveOptionalRuntimeConfig();
    this.id = options.id ?? "cloud-openai";
    this.endpoint = options.endpoint ?? runtime.provider.endpoint;
    this.apiKey = options.apiKey ?? runtime.provider.apiKey;
    this.modelName = options.modelName ?? runtime.provider.modelName;
    this.displayName = options.displayName ?? `OpenAI (${this.modelName})`;
    const maybeBifrostHeaders = this.endpoint.includes("bifrost")
      ? {
          ...(runtime.provider.bifrostVk ? { "x-bf-vk": runtime.provider.bifrostVk } : {}),
          "x-bf-eh-client-id": "auto-doc-mcp",
        }
      : undefined;
    this.client = new OpenAI({
      apiKey: this.apiKey,
      baseURL: this.endpoint,
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
      model: this.modelName ?? runtime.provider.modelName,
      temperature: runtime.provider.temperature,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: "You are a technical documentation writer. Respond only with valid JSON." },
        { role: "user", content: buildSharedPromptContent(ev) },
      ],
    });
    const content = response.choices[0]?.message?.content ?? "{}";
    const parsed = JSON.parse(content) as ModelAnalysis;
    return { ...parsed, providerUsed: `${this.id}:${this.modelName ?? runtime.provider.modelName}`, generationMs: Date.now() - startedAt };
  }

  async authorManualSection(input: ManualAuthoringProviderInput): Promise<ManualAuthoringProviderResult> {
    const runtime = resolveOptionalRuntimeConfig();
    const model = this.modelName ?? runtime.provider.modelName;
    const startedAt = Date.now();
    const response = await this.client.chat.completions.create({
      model,
      temperature: runtime.provider.temperature,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "You are a senior technical manual writer. Produce concrete, novice-readable markdown inside valid JSON only.",
        },
        { role: "user", content: buildManualAuthoringPrompt(input) },
      ],
    });
    const content = response.choices[0]?.message?.content ?? "{}";
    const parsed = JSON.parse(content) as { body?: unknown };
    const body = typeof parsed.body === "string" ? parsed.body.trim() : "";
    if (!body) {
      throw new Error(`Provider ${this.id} returned an empty manual body.`);
    }
    return { body, providerUsed: `${this.id}:${model}`, generationMs: Date.now() - startedAt };
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
