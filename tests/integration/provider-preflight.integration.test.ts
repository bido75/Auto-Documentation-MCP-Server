import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";

const envKeys = [
  "AI_PROVIDER_TYPE",
  "AI_ENDPOINT",
  "AI_API_KEY",
  "AI_MODEL_NAME",
  "OPENROUTER_API_KEY",
  "OPENROUTER_ENDPOINT",
  "AI_CLOUD_FALLBACK_MODEL",
  "AI_CLOUD_FALLBACK_MODELS",
  "AI_TIMEOUT_MS",
  "AI_MAX_RETRIES",
] as const;

const previousEnv = new Map<(typeof envKeys)[number], string | undefined>();

type ChatCompletionRequest = {
  model?: string;
};

type FakeOpenAiServer = {
  endpoint: string;
  modelsSeen: string[];
  close(): Promise<void>;
};

async function readJson(req: IncomingMessage): Promise<ChatCompletionRequest> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? (JSON.parse(raw) as ChatCompletionRequest) : {};
}

async function startFakeOpenAiServer(validModels: Set<string>, rateLimitedModels = new Set<string>()): Promise<FakeOpenAiServer> {
  const modelsSeen: string[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      if (req.method !== "POST" || !req.url?.endsWith("/chat/completions")) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "not found" } }));
        return;
      }

      const body = await readJson(req);
      const model = body.model ?? "";
      modelsSeen.push(model);
      if (rateLimitedModels.has(model)) {
        res.writeHead(429, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: `rate limit exceeded for ${model}` } }));
        return;
      }
      if (!validModels.has(model)) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: `${model} is not a valid model ID` } }));
        return;
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: "OK" } }] }));
    })().catch((error: unknown) => {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: error instanceof Error ? error.message : String(error) } }));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Fake OpenAI server did not bind to a TCP port.");
  }

  return {
    endpoint: `http://127.0.0.1:${address.port}/v1`,
    modelsSeen,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

function setEnv(endpoint: string, cloudModel: string) {
  for (const key of envKeys) {
    if (!previousEnv.has(key)) previousEnv.set(key, process.env[key]);
  }
  process.env.AI_PROVIDER_TYPE = "cloud-openai";
  process.env.AI_ENDPOINT = endpoint;
  process.env.AI_API_KEY = "local-key";
  process.env.AI_MODEL_NAME = "local-good-model";
  process.env.OPENROUTER_API_KEY = "secret-cloud";
  process.env.OPENROUTER_ENDPOINT = endpoint;
  process.env.AI_CLOUD_FALLBACK_MODEL = cloudModel;
  delete process.env.AI_CLOUD_FALLBACK_MODELS;
  process.env.AI_TIMEOUT_MS = "90000";
  process.env.AI_MAX_RETRIES = "0";
}

function setEnvWithCloudList(endpoint: string, cloudModels: string) {
  setEnv(endpoint, "");
  delete process.env.AI_CLOUD_FALLBACK_MODEL;
  process.env.AI_CLOUD_FALLBACK_MODELS = cloudModels;
}

afterEach(async () => {
  for (const key of envKeys) {
    const value = previousEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  previousEnv.clear();
  const { resetProvider } = await import("../../src/providers/factory.js");
  resetProvider();
});

describe("provider generation preflight", () => {
  it("passes through the real preflight path when primary and cloud models resolve", async () => {
    const fake = await startFakeOpenAiServer(new Set(["local-good-model", "qwen/qwen3-next-80b-a3b-instruct:free"]));
    try {
      setEnv(fake.endpoint, "qwen/qwen3-next-80b-a3b-instruct:free");
      const { assertProviderStartupPreflight } = await import("../../src/providers/factory.js");

      const result = await assertProviderStartupPreflight();

      expect(fake.modelsSeen).toEqual(["local-good-model", "qwen/qwen3-next-80b-a3b-instruct:free"]);
      expect(result).toEqual([
        expect.objectContaining({ providerId: "cloud-openai", modelName: "local-good-model", healthy: true, resolution: "resolved" }),
        expect.objectContaining({
          providerId: "openrouter",
          modelName: "qwen/qwen3-next-80b-a3b-instruct:free",
          healthy: true,
          resolution: "resolved",
        }),
      ]);
    } finally {
      await fake.close();
    }
  });

  it("preflights each ordered cloud model and treats a rate-limited free rung as non-fatal when another rung is healthy", async () => {
    const fake = await startFakeOpenAiServer(
      new Set(["local-good-model", "paid-instruct-model", "coder-last-resort"]),
      new Set(["free-model"]),
    );
    try {
      setEnvWithCloudList(fake.endpoint, "free-model,paid-instruct-model,coder-last-resort");
      const { assertProviderStartupPreflight } = await import("../../src/providers/factory.js");

      const result = await assertProviderStartupPreflight();

      expect(fake.modelsSeen).toEqual(["local-good-model", "free-model", "paid-instruct-model", "coder-last-resort"]);
      expect(result).toEqual([
        expect.objectContaining({ providerId: "cloud-openai", modelName: "local-good-model", healthy: true, resolution: "resolved" }),
        expect.objectContaining({ providerId: "openrouter", modelName: "free-model", healthy: false, resolution: "unknown" }),
        expect.objectContaining({ providerId: "openrouter", modelName: "paid-instruct-model", healthy: true, resolution: "resolved" }),
        expect.objectContaining({ providerId: "openrouter", modelName: "coder-last-resort", healthy: true, resolution: "resolved" }),
      ]);
    } finally {
      await fake.close();
    }
  });

  it("fails loudly with the configured slug when the cloud fallback model does not resolve", async () => {
    const fake = await startFakeOpenAiServer(new Set(["local-good-model", "qwen/qwen3-next-80b-a3b-instruct:free"]));
    try {
      setEnv(fake.endpoint, "does/not-exist");
      const { assertProviderStartupPreflight } = await import("../../src/providers/factory.js");

      await expect(assertProviderStartupPreflight()).rejects.toThrow(/does\/not-exist.*openrouter.*not a valid model ID/i);
      expect(fake.modelsSeen).toEqual(["local-good-model", "does/not-exist"]);
    } finally {
      await fake.close();
    }
  });

  it("fails loudly with the configured slug when any ordered cloud fallback model does not resolve", async () => {
    const fake = await startFakeOpenAiServer(new Set(["local-good-model", "paid-instruct-model"]));
    try {
      setEnvWithCloudList(fake.endpoint, "paid-instruct-model,does/not-exist");
      const { assertProviderStartupPreflight } = await import("../../src/providers/factory.js");

      await expect(assertProviderStartupPreflight()).rejects.toThrow(/does\/not-exist.*openrouter.*not a valid model ID/i);
      expect(fake.modelsSeen).toEqual(["local-good-model", "paid-instruct-model", "does/not-exist"]);
    } finally {
      await fake.close();
    }
  });
});
