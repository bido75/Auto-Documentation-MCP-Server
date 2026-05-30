import Anthropic from "@anthropic-ai/sdk";
import { getOptionalRuntimeConfig } from "../config.js";
import type { ModelAnalysis, ModelProvider, StructuredEvidence } from "./base.js";
import { buildSharedPromptContent } from "./base.js";

export class AnthropicProvider implements ModelProvider {
  readonly id = "cloud-anthropic";
  readonly displayName: string;
  readonly supportsEmbeddings = false;
  private readonly client: Anthropic;

  constructor() {
    const runtime = getOptionalRuntimeConfig();
    this.displayName = `Claude (${runtime.provider.modelName})`;
    this.client = new Anthropic({
      apiKey: runtime.provider.apiKey,
      baseURL: runtime.provider.endpoint !== "https://api.anthropic.com" ? runtime.provider.endpoint : undefined,
    });
  }

  async healthCheck(): Promise<boolean> {
    const runtime = getOptionalRuntimeConfig();
    try {
      await this.client.messages.create({
        model: runtime.provider.modelName,
        max_tokens: 10,
        messages: [{ role: "user", content: "ping" }],
      });
      return true;
    } catch {
      return false;
    }
  }

  async analyze(ev: StructuredEvidence): Promise<ModelAnalysis> {
    const runtime = getOptionalRuntimeConfig();
    const startedAt = Date.now();
    const response = await this.client.messages.create({
      model: runtime.provider.modelName,
      max_tokens: 2048,
      system:
        "You are an expert technical documentation writer. You produce precise structured JSON documentation and never use vague phrases.",
      messages: [{ role: "user", content: buildSharedPromptContent(ev) }],
    });

    const first = response.content[0];
    const text = first && first.type === "text" ? first.text : "{}";
    const parsed = JSON.parse(text.replace(/```json|```/g, "").trim()) as ModelAnalysis;
    return { ...parsed, providerUsed: this.id, generationMs: Date.now() - startedAt };
  }
}