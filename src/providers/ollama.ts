import { getOptionalRuntimeConfig } from "../config.js";
import { buildSharedPromptContent, type ModelAnalysis, type ModelProvider, type StructuredEvidence } from "./base.js";

export class OllamaProvider implements ModelProvider {
  readonly supportsEmbeddings = true;
  readonly displayName: string;

  constructor(public readonly providerId = "local-ollama") {
    this.displayName = `Ollama (${getOptionalRuntimeConfig().provider.modelName})`;
  }

  get id(): string {
    return this.providerId;
  }

  async healthCheck(): Promise<boolean> {
    const runtime = getOptionalRuntimeConfig();
    try {
      const response = await fetch(`${runtime.provider.endpoint}/api/tags`, { signal: AbortSignal.timeout(5000) });
      return response.ok;
    } catch {
      return false;
    }
  }

  async analyze(ev: StructuredEvidence): Promise<ModelAnalysis> {
    const runtime = getOptionalRuntimeConfig();
    const startedAt = Date.now();
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), runtime.provider.timeoutMs);
    try {
      const response = await fetch(`${runtime.provider.endpoint}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          model: runtime.provider.modelName,
          prompt: buildSharedPromptContent(ev),
          stream: false,
          format: "json",
          options: { temperature: runtime.provider.temperature, num_predict: 2048 },
        }),
      });

      if (!response.ok) {
        throw new Error(`Ollama HTTP ${response.status}: ${await response.text()}`);
      }

      const body = (await response.json()) as { response: string };
      const parsed = JSON.parse(body.response) as ModelAnalysis;
      return { ...parsed, providerUsed: this.id, generationMs: Date.now() - startedAt };
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async embed(text: string): Promise<number[]> {
    const runtime = getOptionalRuntimeConfig();
    const response = await fetch(`${runtime.embedding.endpoint ?? runtime.provider.endpoint}/api/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: runtime.embedding.modelName, prompt: text }),
    });

    if (!response.ok) {
      throw new Error(`Ollama embeddings HTTP ${response.status}: ${await response.text()}`);
    }

    const body = (await response.json()) as { embedding: number[] };
    return body.embedding;
  }
}