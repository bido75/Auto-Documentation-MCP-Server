import { afterEach, describe, expect, it } from "vitest";
import { BifrostProvider } from "../../src/providers/bifrost.js";
import { buildCandidate, resetProvider } from "../../src/providers/factory.js";
import { LMStudioProvider } from "../../src/providers/lmstudio.js";
import { OllamaProvider } from "../../src/providers/ollama.js";
import { OpenAIProvider } from "../../src/providers/openai.js";
import { VllmProvider } from "../../src/providers/vllm.js";

const keys = ["AI_PROVIDER_TYPE", "AI_ENDPOINT", "AI_API_KEY", "AI_MODEL_NAME", "BIFROST_VIRTUAL_KEY"] as const;
const previous = new Map<(typeof keys)[number], string | undefined>();

function setProvider(type: string): void {
  for (const key of keys) {
    if (!previous.has(key)) previous.set(key, process.env[key]);
  }
  process.env.AI_PROVIDER_TYPE = type;
  process.env.AI_ENDPOINT = type === "local-ollama" ? "http://127.0.0.1:11434" : "http://127.0.0.1:1234/v1";
  process.env.AI_API_KEY = "test-key";
  process.env.AI_MODEL_NAME = "test-model";
}

afterEach(() => {
  resetProvider();
  for (const key of keys) {
    const value = previous.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  previous.clear();
});

describe("fix-provider-factory-local-routing", () => {
  it("constructs OllamaProvider for local-ollama without mocking the factory", () => {
    setProvider("local-ollama");
    expect(buildCandidate()).toBeInstanceOf(OllamaProvider);
  });

  it("constructs LMStudioProvider for local-lmstudio without falling back to Bifrost", () => {
    setProvider("local-lmstudio");
    const candidate = buildCandidate();
    expect(candidate).toBeInstanceOf(LMStudioProvider);
    expect(candidate).not.toBeInstanceOf(BifrostProvider);
  });

  it("constructs VllmProvider for local-vllm without falling back to Bifrost", () => {
    setProvider("local-vllm");
    const candidate = buildCandidate();
    expect(candidate).toBeInstanceOf(VllmProvider);
    expect(candidate).not.toBeInstanceOf(BifrostProvider);
  });

  it("constructs OpenAIProvider for cloud-openai", () => {
    setProvider("cloud-openai");
    expect(buildCandidate()).toBeInstanceOf(OpenAIProvider);
  });

  it("constructs BifrostProvider for bifrost", () => {
    setProvider("bifrost");
    expect(buildCandidate()).toBeInstanceOf(BifrostProvider);
  });
});
