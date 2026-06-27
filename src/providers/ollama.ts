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

export class OllamaProvider implements ModelProvider {
  readonly supportsEmbeddings = true;
  readonly displayName: string;

  constructor(
    public readonly providerId = "local-ollama",
    private readonly options: { endpoint?: string; modelName?: string; timeoutMs?: number; temperature?: number } = {},
  ) {
    this.displayName = `Ollama (${this.resolveModelName()})`;
  }

  get id(): string {
    return this.providerId;
  }

  private resolveEndpoint(): string {
    return this.options.endpoint ?? resolveOptionalRuntimeConfig().provider.endpoint;
  }

  private resolveModelName(): string {
    return this.options.modelName ?? resolveOptionalRuntimeConfig().provider.modelName;
  }

  private resolveTimeoutMs(): number {
    return this.options.timeoutMs ?? resolveOptionalRuntimeConfig().provider.timeoutMs;
  }

  private resolveTemperature(): number {
    return this.options.temperature ?? resolveOptionalRuntimeConfig().provider.temperature;
  }

  async healthCheck(): Promise<boolean> {
    try {
      const response = await fetch(`${this.resolveEndpoint()}/api/tags`, { signal: AbortSignal.timeout(5000) });
      return response.ok;
    } catch {
      return false;
    }
  }

  async preflightGenerate(): Promise<string> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.resolveTimeoutMs());
    try {
      const response = await fetch(`${this.resolveEndpoint()}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          model: this.resolveModelName(),
          prompt: "Reply OK.",
          stream: false,
          options: { temperature: 0, num_predict: 4 },
        }),
      });
      if (!response.ok) {
        throw new Error(`Ollama preflight HTTP ${response.status}: ${await response.text()}`);
      }
      const body = (await response.json()) as { response?: string };
      return body.response?.trim() ?? "";
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async analyze(ev: StructuredEvidence): Promise<ModelAnalysis> {
    const startedAt = Date.now();
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.resolveTimeoutMs());
    try {
      const response = await fetch(`${this.resolveEndpoint()}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          model: this.resolveModelName(),
          prompt: buildSharedPromptContent(ev),
          stream: false,
          format: "json",
          options: { temperature: this.resolveTemperature(), num_predict: 2048 },
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

  async authorManualSection(input: ManualAuthoringProviderInput): Promise<ManualAuthoringProviderResult> {
    const startedAt = Date.now();
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.resolveTimeoutMs());
    try {
      const response = await fetch(`${this.resolveEndpoint()}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          model: this.resolveModelName(),
          prompt: buildManualAuthoringPrompt(input),
          stream: false,
          format: "json",
          options: { temperature: this.resolveTemperature(), num_predict: 4096 },
        }),
      });

      if (!response.ok) {
        throw new Error(`Ollama manual authoring HTTP ${response.status}: ${await response.text()}`);
      }

      const body = (await response.json()) as { response?: string };
      const parsed = JSON.parse(body.response ?? "{}") as { body?: unknown };
      const manualBody = typeof parsed.body === "string" ? parsed.body.trim() : "";
      if (!manualBody) {
        throw new Error(`Provider ${this.id} returned an empty manual body.`);
      }
      return { body: manualBody, providerUsed: this.id, generationMs: Date.now() - startedAt };
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async embed(text: string): Promise<number[]> {
    const runtime = resolveOptionalRuntimeConfig();
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
