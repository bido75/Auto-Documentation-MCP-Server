import { afterEach, describe, expect, it, vi } from "vitest";

const providerState = vi.hoisted(() => ({
  localHealthy: false,
  localAnalyzeFails: false,
  cloudHealthy: true,
  cloudAnalyzeFails: false,
  calls: [] as string[],
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
    constructor(options?: { id?: string; displayName?: string }) {
      this.id = options?.id ?? "cloud-openai";
      this.displayName = options?.displayName ?? "OpenAI";
    }
    async healthCheck() {
      providerState.calls.push(`${this.id}-health`);
      return providerState.cloudHealthy;
    }
    async analyze() {
      providerState.calls.push(`${this.id}-analyze`);
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
        providerUsed: "openrouter:test-cloud-model",
        generationMs: 1,
      };
    }
  },
}));

const envKeys = ["AI_PROVIDER_TYPE", "AI_ENDPOINT", "AI_API_KEY", "AI_MODEL_NAME", "OPENROUTER_API_KEY", "AI_CLOUD_FALLBACK_MODEL", "OPENROUTER_ENDPOINT", "AUTO_DOC_LOG_LEVEL"] as const;
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
  process.env.OPENROUTER_ENDPOINT = "https://openrouter.ai/api/v1";
  process.env.AUTO_DOC_LOG_LEVEL = "info";
}

afterEach(async () => {
  vi.restoreAllMocks();
  providerState.localHealthy = false;
  providerState.localAnalyzeFails = false;
  providerState.cloudHealthy = true;
  providerState.cloudAnalyzeFails = false;
  providerState.calls = [];
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
    expect(providerState.calls).toEqual(["local-health", "openrouter-health", "openrouter-analyze"]);
    const logs = warnSpy.mock.calls.map((call) => String(call[0])).join("\n");
    expect(logs).toContain("provider_fallback");
    expect(logs).toContain("local-ollama");
    expect(logs).toContain("openrouter");
    expect(logs).not.toContain("secret-cloud");
  });

  it("both provider tiers failing logs deterministic fallback with the reason", async () => {
    configureProviderEnv();
    providerState.localHealthy = true;
    providerState.localAnalyzeFails = true;
    providerState.cloudHealthy = true;
    providerState.cloudAnalyzeFails = true;
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { analyzeWithFallback } = await import("../../src/providers/factory.js");

    const result = await analyzeWithFallback(evidence);

    expect(result.providerUsed).toBe("deterministic");
    expect(providerState.calls).toEqual(["local-health", "local-analyze", "openrouter-health", "openrouter-analyze"]);
    const logs = warnSpy.mock.calls.map((call) => String(call[0])).join("\n");
    expect(logs).toContain("deterministic");
    expect(logs).toContain("local exploded");
    expect(logs).toContain("openrouter exploded");
    expect(logs).not.toContain("secret-local");
    expect(logs).not.toContain("secret-cloud");
  });
});
