import { afterEach, describe, expect, it, vi } from "vitest";

const providerState = vi.hoisted(() => ({
  localHealthy: false,
  localAnalyzeFails: false,
  cloudHealthy: true,
  cloudAnalyzeFails: false,
  cloudFailuresByModel: new Map<string, string>(),
  calls: [] as string[],
  openAiOptions: [] as Array<{
    id?: string;
    displayName?: string;
    endpoint?: string;
    apiKey?: string;
    modelName?: string;
    timeoutMs?: number;
  }>,
}));

vi.mock("../../src/providers/ollama.js", () => ({
  OllamaProvider: class {
    readonly id = "local-ollama";
    readonly displayName = "Local Ollama";
    readonly supportsEmbeddings = false;
    async healthCheck() {
      providerState.calls.push("local-health");
      return providerState.localHealthy;
    }
    async analyze() {
      providerState.calls.push("local-analyze");
      if (providerState.localAnalyzeFails) throw new Error("local exploded with OPENROUTER_API_KEY=secret-local");
      return {
        featureName: "Local Result",
        featureKey: "local:result",
        shouldDocument: true,
        audiences: ["User"],
        userGuide: { summary: "local", steps: ["local"], expectedOutcome: "local", possibleErrors: [] },
        adminGuide: { configRequired: [], endpointsAffected: [], envVarsRequired: [], verificationSteps: [], troubleshooting: [] },
        confidenceScore: 90,
        confidenceReasons: [],
        reviewQuestions: [],
        providerUsed: "local-ollama:test-model",
        generationMs: 1,
      };
    }
  },
}));

vi.mock("../../src/providers/openai.js", () => ({
  OpenAIProvider: class {
    readonly id: string;
    readonly displayName: string;
    readonly supportsEmbeddings = true;
    readonly modelName?: string;
    constructor(options?: { id?: string; displayName?: string; modelName?: string }) {
      providerState.openAiOptions.push(options ?? {});
      this.id = options?.id ?? "cloud-openai";
      this.displayName = options?.displayName ?? "OpenAI";
      this.modelName = options?.modelName;
    }
    async healthCheck() {
      providerState.calls.push(`${this.id}-health`);
      return providerState.cloudHealthy;
    }
    async analyze() {
      providerState.calls.push(`${this.id}-analyze`);
      providerState.calls.push(`${this.id}-analyze:${this.modelName ?? "missing-model"}`);
      const modelFailure = this.modelName ? providerState.cloudFailuresByModel.get(this.modelName) : undefined;
      if (modelFailure) throw new Error(modelFailure);
      if (providerState.cloudAnalyzeFails) throw new Error("openrouter exploded with OPENROUTER_API_KEY=secret-cloud");
      return {
        featureName: "OpenRouter Result",
        featureKey: "openrouter:result",
        shouldDocument: true,
        audiences: ["Admin"],
        userGuide: { summary: "cloud", steps: ["cloud"], expectedOutcome: "cloud", possibleErrors: [] },
        adminGuide: { configRequired: [], endpointsAffected: [], envVarsRequired: [], verificationSteps: ["cloud"], troubleshooting: [] },
        confidenceScore: 88,
        confidenceReasons: [],
        reviewQuestions: [],
        providerUsed: `openrouter:${this.modelName ?? "missing-model"}`,
        generationMs: 1,
      };
    }
  },
}));

const envKeys = [
  "AI_PROVIDER_TYPE",
  "AI_ENDPOINT",
  "AI_API_KEY",
  "AI_MODEL_NAME",
  "OPENROUTER_API_KEY",
  "AI_CLOUD_FALLBACK_MODEL",
  "AI_CLOUD_FALLBACK_MODELS",
  "OPENROUTER_ENDPOINT",
  "AUTO_DOC_LOG_LEVEL",
] as const;
const previousEnv = new Map<(typeof envKeys)[number], string | undefined>();

function configureProviderEnv() {
  for (const key of envKeys) {
    if (!previousEnv.has(key)) previousEnv.set(key, process.env[key]);
  }
  process.env.AI_PROVIDER_TYPE = "local-ollama";
  process.env.AI_ENDPOINT = "http://ollama:11434";
  process.env.AI_API_KEY = "local-key";
  process.env.AI_MODEL_NAME = "test-model";
  process.env.OPENROUTER_API_KEY = "secret-cloud";
  process.env.AI_CLOUD_FALLBACK_MODEL = "test-cloud-model";
  delete process.env.AI_CLOUD_FALLBACK_MODELS;
  process.env.OPENROUTER_ENDPOINT = "https://openrouter.ai/api/v1";
  process.env.AUTO_DOC_LOG_LEVEL = "info";
}

afterEach(async () => {
  vi.restoreAllMocks();
  providerState.localHealthy = false;
  providerState.localAnalyzeFails = false;
  providerState.cloudHealthy = true;
  providerState.cloudAnalyzeFails = false;
  providerState.cloudFailuresByModel = new Map();
  providerState.calls = [];
  providerState.openAiOptions = [];
  for (const key of envKeys) {
    const value = previousEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  previousEnv.clear();
  const { resetProvider } = await import("../../src/providers/factory.js");
  resetProvider();
  vi.resetModules();
});

const evidence = {
  diffSummary: "Added billing export",
  filesChanged: ["src/routes/billing/export.ts"],
  routes: ["/billing/export"],
  apiEndpoints: ["POST /api/billing/export"],
  envVars: [],
  dbMigrations: [],
  uiComponents: [],
  authPatterns: [],
  branch: "feature/billing-export",
  commitMessage: "Added billing export",
  testStatus: "passed" as const,
};

describe("provider-tiering-logged", () => {
  it("local failure uses OpenRouter fallback and logs the tier change without leaking keys", async () => {
    configureProviderEnv();
    providerState.localHealthy = false;
    providerState.cloudHealthy = true;
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { analyzeWithFallback } = await import("../../src/providers/factory.js");

    const result = await analyzeWithFallback(evidence);

    expect(result.providerUsed).toBe("openrouter:test-cloud-model");
    expect(providerState.openAiOptions).toEqual([
      expect.objectContaining({
        id: "openrouter",
        endpoint: "https://openrouter.ai/api/v1",
        apiKey: "secret-cloud",
        modelName: "test-cloud-model",
      }),
    ]);
    expect(providerState.openAiOptions[0]?.modelName).not.toBe("test-model");
    expect(providerState.calls).toEqual(["local-health", "openrouter-health", "openrouter-analyze", "openrouter-analyze:test-cloud-model"]);
    const logs = warnSpy.mock.calls.map((call) => String(call[0])).join("\n");
    expect(logs).toContain("provider_fallback");
    expect(logs).toContain("local-ollama");
    expect(logs).toContain("local-ollama(test-model)");
    expect(logs).toContain("openrouter");
    expect(logs).toContain("openrouter(test-cloud-model)");
    expect(logs).not.toContain("secret-cloud");
  });

  it("continues through the ordered OpenRouter cloud list when the first cloud model is rate limited", async () => {
    configureProviderEnv();
    process.env.AI_CLOUD_FALLBACK_MODELS = "free-model,paid-instruct-model,coder-last-resort";
    providerState.localHealthy = false;
    providerState.cloudHealthy = true;
    providerState.cloudFailuresByModel.set("free-model", "429 rate limit from OpenRouter for free-model");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { analyzeWithFallback } = await import("../../src/providers/factory.js");

    const result = await analyzeWithFallback(evidence);

    expect(result.providerUsed).toBe("openrouter:paid-instruct-model");
    expect(providerState.openAiOptions.map((options) => options.modelName)).toEqual([
      "free-model",
      "paid-instruct-model",
      "coder-last-resort",
    ]);
    expect(providerState.calls).toEqual([
      "local-health",
      "openrouter-health",
      "openrouter-analyze",
      "openrouter-analyze:free-model",
      "openrouter-health",
      "openrouter-analyze",
      "openrouter-analyze:paid-instruct-model",
    ]);
    const logs = warnSpy.mock.calls.map((call) => String(call[0])).join("\n");
    expect(logs).toContain("cloud fallback: free-model -> paid-instruct-model");
    expect(logs).toContain("429 rate limit");
    expect(logs).not.toContain("coder-last-resort -> deterministic");
  });

  it("both provider tiers failing logs deterministic fallback with the reason", async () => {
    configureProviderEnv();
    process.env.AI_CLOUD_FALLBACK_MODELS = "free-model,paid-instruct-model,coder-last-resort";
    providerState.localHealthy = true;
    providerState.localAnalyzeFails = true;
    providerState.cloudHealthy = true;
    providerState.cloudFailuresByModel.set("free-model", "429 rate limit from OpenRouter for free-model");
    providerState.cloudFailuresByModel.set("paid-instruct-model", "503 provider unavailable");
    providerState.cloudFailuresByModel.set("coder-last-resort", "500 provider unavailable");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { analyzeWithFallback } = await import("../../src/providers/factory.js");

    const result = await analyzeWithFallback(evidence);

    expect(result.providerUsed).toBe("deterministic");
    expect(providerState.calls).toEqual([
      "local-health",
      "local-analyze",
      "openrouter-health",
      "openrouter-analyze",
      "openrouter-analyze:free-model",
      "openrouter-health",
      "openrouter-analyze",
      "openrouter-analyze:paid-instruct-model",
      "openrouter-health",
      "openrouter-analyze",
      "openrouter-analyze:coder-last-resort",
    ]);
    const logs = warnSpy.mock.calls.map((call) => String(call[0])).join("\n");
    expect(logs).toContain("deterministic");
    expect(logs).toContain("local exploded");
    expect(logs).toContain("429 rate limit");
    expect(logs).toContain("503 provider unavailable");
    expect(logs).toContain("500 provider unavailable");
    expect(logs).not.toContain("secret-local");
    expect(logs).not.toContain("secret-cloud");
  });
});
