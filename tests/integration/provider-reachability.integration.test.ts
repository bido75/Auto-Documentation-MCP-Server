import { afterEach, describe, expect, it, vi } from "vitest";
import { resetProvider } from "../../src/providers/factory.js";

const envKeys = ["AI_PROVIDER_TYPE", "AI_ENDPOINT", "AI_API_KEY", "AI_MODEL_NAME"] as const;
const previousEnv = new Map<(typeof envKeys)[number], string | undefined>();
const originalFetch = globalThis.fetch;

function setEnv(key: (typeof envKeys)[number], value: string): void {
  if (!previousEnv.has(key)) previousEnv.set(key, process.env[key]);
  process.env[key] = value;
}

afterEach(() => {
  vi.restoreAllMocks();
  globalThis.fetch = originalFetch;
  resetProvider();
  for (const key of envKeys) {
    const value = previousEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  previousEnv.clear();
});

describe("provider-reachability", () => {
  it("configured local Ollama endpoint reaches the model boundary and reports a non-deterministic provider", async () => {
    setEnv("AI_PROVIDER_TYPE", "local-ollama");
    setEnv("AI_ENDPOINT", "http://ollama:11434");
    setEnv("AI_API_KEY", "ollama");
    setEnv("AI_MODEL_NAME", "llama3.2:3b-instruct-q4_K_M");

    const fetchSpy = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === "http://ollama:11434/api/tags") {
        return new Response(JSON.stringify({ models: [{ name: "llama3.2:3b-instruct-q4_K_M" }] }), { status: 200 });
      }
      if (url === "http://ollama:11434/api/generate") {
        return new Response(
          JSON.stringify({
            response: JSON.stringify({
              featureName: "Reachable Local Model",
              featureKey: "local:reachable-model",
              shouldDocument: true,
              audiences: ["User"],
              userGuide: {
                summary: "The local model generated this user summary.",
                steps: ["Call the local model"],
                expectedOutcome: "The provider response is used.",
                possibleErrors: [],
              },
              adminGuide: {
                configRequired: [],
                endpointsAffected: [],
                envVarsRequired: [],
                verificationSteps: ["Confirm /api/tags responds."],
                troubleshooting: [],
              },
              confidenceScore: 90,
              confidenceReasons: ["Local model reached."],
              reviewQuestions: [],
              providerUsed: "local-ollama",
              generationMs: 1,
            }),
          }),
          { status: 200 },
        );
      }
      return new Response("not found", { status: 404 });
    });
    globalThis.fetch = fetchSpy;

    const { analyzeWithFallback } = await import("../../src/providers/factory.js");
    const result = await analyzeWithFallback({
      diffSummary: "Added a reachable local provider test.",
      filesChanged: ["src/providers/ollama.ts"],
      routes: [],
      apiEndpoints: [],
      envVars: [],
      dbMigrations: [],
      uiComponents: [],
      authPatterns: [],
      branch: "test",
      commitMessage: "test local model reachability",
      testStatus: "passed",
    });

    expect(result.providerUsed).toBe("local-ollama");
    expect(fetchSpy).toHaveBeenCalledWith("http://ollama:11434/api/tags", expect.any(Object));
    expect(fetchSpy).toHaveBeenCalledWith("http://ollama:11434/api/generate", expect.objectContaining({ method: "POST" }));
  });
});
