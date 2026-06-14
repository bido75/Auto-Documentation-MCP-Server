import { describe, expect, it, vi } from "vitest";

const constructorOptions = vi.hoisted(() => [] as Array<Record<string, unknown>>);

vi.mock("openai", () => {
  class MockOpenAI {
    readonly models = { list: vi.fn() };
    readonly chat = { completions: { create: vi.fn() } };
    readonly embeddings = { create: vi.fn() };

    constructor(options: Record<string, unknown>) {
      constructorOptions.push(options);
    }
  }

  return {
    default: MockOpenAI,
  };
});

const envKeys = ["AI_ENDPOINT", "AI_PROVIDER_TYPE", "BIFROST_VIRTUAL_KEY", "AI_API_KEY", "OPENROUTER_API_KEY"] as const;

function withEnv(values: Record<(typeof envKeys)[number], string | undefined>): void {
  for (const key of envKeys) {
    const value = values[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

describe("OpenAIProvider", () => {
  it("adds Bifrost headers when the endpoint is Bifrost-backed", async () => {
    constructorOptions.length = 0;
    withEnv({
      AI_ENDPOINT: "http://bifrost-gateway:8080/v1",
      AI_PROVIDER_TYPE: "bifrost",
      BIFROST_VIRTUAL_KEY: "sk-bf-test-virtual-key",
      AI_API_KEY: "ollama",
      OPENROUTER_API_KEY: undefined,
    });

    const { OpenAIProvider } = await import("../../src/providers/openai.js");
    new OpenAIProvider();

    expect(constructorOptions).toHaveLength(1);
    expect(constructorOptions[0]).toMatchObject({
      baseURL: "http://bifrost-gateway:8080/v1",
      defaultHeaders: {
        "x-bf-vk": "sk-bf-test-virtual-key",
        "x-bf-eh-client-id": "auto-doc-mcp",
      },
    });
  });

  it("omits Bifrost headers when the endpoint is not Bifrost-backed", async () => {
    constructorOptions.length = 0;
    withEnv({
      AI_ENDPOINT: "https://api.openai.com/v1",
      AI_PROVIDER_TYPE: "openai",
      BIFROST_VIRTUAL_KEY: "sk-bf-test-virtual-key",
      AI_API_KEY: "openai-key",
      OPENROUTER_API_KEY: undefined,
    });

    const { OpenAIProvider } = await import("../../src/providers/openai.js");
    new OpenAIProvider();

    expect(constructorOptions).toHaveLength(1);
    expect(constructorOptions[0]).not.toHaveProperty("defaultHeaders");
  });
});