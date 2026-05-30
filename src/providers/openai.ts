import OpenAI from "openai";
import { getOptionalRuntimeConfig } from "../config.js";
import type { ModelAnalysis, ModelProvider, StructuredEvidence } from "./base.js";
import { buildSharedPromptContent } from "./base.js";

export class OpenAIProvider implements ModelProvider {
  readonly id: string = "cloud-openai";
  readonly supportsEmbeddings = true;
  readonly displayName: string;
  private readonly client: OpenAI;

  constructor() {
    const runtime = getOptionalRuntimeConfig();
    this.displayName = `OpenAI (${runtime.provider.modelName})`;
    this.client = new OpenAI({
      apiKey: runtime.provider.apiKey,
      baseURL: runtime.provider.endpoint,
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
    const runtime = getOptionalRuntimeConfig();
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
    return { ...parsed, providerUsed: this.id, generationMs: Date.now() - startedAt };
  }

  async embed(text: string): Promise<number[]> {
    const runtime = getOptionalRuntimeConfig();
    const response = await this.client.embeddings.create({
      model: runtime.embedding.modelName || "text-embedding-3-small",
      input: text,
    });

    return response.data[0]?.embedding ?? [];
  }
}