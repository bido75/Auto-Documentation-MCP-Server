import { createServer, request, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHttpBridgeApp } from "../../src/http-bridge/server.js";

async function listen(app: ReturnType<typeof createHttpBridgeApp>): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer(app);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Could not resolve test server address.");
  }

  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

async function requestStatus(url: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(url, { headers }, (res) => {
      const status = res.statusCode ?? 0;
      res.destroy();
      resolve(status);
    });
    req.on("error", reject);
    req.end();
  });
}

describe("HTTP bridge auth", () => {
  const previousToken = process.env.NOTION_TOKEN;
  const previousUnauthenticatedSse = process.env.AUTO_DOC_ALLOW_UNAUTHENTICATED_SSE;
  const previousEnvFallback = process.env.AUTO_DOC_ENABLE_ENV_TOKEN_FALLBACK;
  const previousBridgeKey = process.env.AUTO_DOC_BRIDGE_API_KEY;
  const previousCorsAllowedOrigins = process.env.CORS_ALLOWED_ORIGINS;

  beforeEach(() => {
    process.env.NOTION_TOKEN = "env_token_must_not_be_used_by_default";
    delete process.env.AUTO_DOC_ALLOW_UNAUTHENTICATED_SSE;
    delete process.env.AUTO_DOC_ENABLE_ENV_TOKEN_FALLBACK;
    delete process.env.AUTO_DOC_BRIDGE_API_KEY;
    delete process.env.CORS_ALLOWED_ORIGINS;
  });

  afterEach(() => {
    if (previousToken === undefined) {
      delete process.env.NOTION_TOKEN;
    } else {
      process.env.NOTION_TOKEN = previousToken;
    }

    if (previousUnauthenticatedSse === undefined) {
      delete process.env.AUTO_DOC_ALLOW_UNAUTHENTICATED_SSE;
    } else {
      process.env.AUTO_DOC_ALLOW_UNAUTHENTICATED_SSE = previousUnauthenticatedSse;
    }

    if (previousEnvFallback === undefined) {
      delete process.env.AUTO_DOC_ENABLE_ENV_TOKEN_FALLBACK;
    } else {
      process.env.AUTO_DOC_ENABLE_ENV_TOKEN_FALLBACK = previousEnvFallback;
    }

    if (previousBridgeKey === undefined) {
      delete process.env.AUTO_DOC_BRIDGE_API_KEY;
    } else {
      process.env.AUTO_DOC_BRIDGE_API_KEY = previousBridgeKey;
    }

    if (previousCorsAllowedOrigins === undefined) {
      delete process.env.CORS_ALLOWED_ORIGINS;
    } else {
      process.env.CORS_ALLOWED_ORIGINS = previousCorsAllowedOrigins;
    }
  });

  it("rejects SSE and runner trigger requests without an explicit request token", async () => {
    const { server, baseUrl } = await listen(createHttpBridgeApp({ port: 0, host: "127.0.0.1" }));

    try {
      const sse = await fetch(`${baseUrl}/sse`);
      expect(sse.status).toBe(401);

      const trigger = await fetch(`${baseUrl}/runner/trigger`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId: "project_1", repoPath: "C:/repo", mode: "last_commit" }),
      });
      expect(trigger.status).toBe(401);
    } finally {
      await close(server);
    }
  });

  it("rejects a dummy nonempty Notion token when the required bridge key is missing or wrong", async () => {
    process.env.AUTO_DOC_BRIDGE_API_KEY = "ok";
    const { server, baseUrl } = await listen(createHttpBridgeApp({ port: 0, host: "127.0.0.1" }));

    try {
      const noBridgeKey = await fetch(`${baseUrl}/sse`, {
        headers: { "x-notion-token": "dummy-notion-token" },
      });
      expect(noBridgeKey.status).toBe(401);

      const wrongBridgeKey = await fetch(`${baseUrl}/sse`, {
        headers: {
          authorization: "Bearer no",
          "x-notion-token": "dummy-notion-token",
        },
      });
      expect(wrongBridgeKey.status).toBe(401);
    } finally {
      await close(server);
    }
  });

  it("opens an SSE session only when the dedicated bridge key is correct", async () => {
    process.env.AUTO_DOC_BRIDGE_API_KEY = "ok";
    const { server, baseUrl } = await listen(createHttpBridgeApp({ port: 0, host: "127.0.0.1" }));

    try {
      const status = await requestStatus(`${baseUrl}/sse`, {
          authorization: "Bearer ok",
          "x-notion-token": "dummy-notion-token",
      });
      expect(status).toBe(200);
    } finally {
      await close(server);
    }
  });

  it("requires the bridge key before opening an env-token-fallback SSE session", async () => {
    process.env.NOTION_TOKEN = "env-token-used-only-after-bridge-auth";
    process.env.AUTO_DOC_ENABLE_ENV_TOKEN_FALLBACK = "true";

    const noConfiguredBridgeKey = await listen(createHttpBridgeApp({ port: 0, host: "127.0.0.1" }));
    try {
      const sideDoor = await requestStatus(`${noConfiguredBridgeKey.baseUrl}/sse`, {});
      expect(sideDoor).toBe(401);
    } finally {
      await close(noConfiguredBridgeKey.server);
    }

    process.env.AUTO_DOC_BRIDGE_API_KEY = "ok";
    const { server, baseUrl } = await listen(createHttpBridgeApp({ port: 0, host: "127.0.0.1" }));

    try {
      const missingBridgeKey = await fetch(`${baseUrl}/sse`);
      expect(missingBridgeKey.status).toBe(401);

      const wrongBridgeKey = await fetch(`${baseUrl}/sse`, {
        headers: { authorization: "Bearer no" },
      });
      expect(wrongBridgeKey.status).toBe(401);

      const correctBridgeKey = await requestStatus(`${baseUrl}/sse`, {
        authorization: "Bearer ok",
      });
      expect(correctBridgeKey).toBe(200);
    } finally {
      await close(server);
    }
  });

  it("rejects the documented placeholder bridge key as an unsafe default", () => {
    process.env.AUTO_DOC_BRIDGE_API_KEY = "replace-with-a-random-bridge-key";

    expect(() => createHttpBridgeApp({ port: 0, host: "127.0.0.1" })).toThrow(/AUTO_DOC_BRIDGE_API_KEY/);
  });

  it("refuses to create a publicly bound bridge without a dedicated bridge key", () => {
    expect(() => createHttpBridgeApp({ port: 0, host: "0.0.0.0" })).toThrow(/AUTO_DOC_BRIDGE_API_KEY/);
  });

  it("uses exact CORS origin matching instead of prefix matching", async () => {
    process.env.AUTO_DOC_BRIDGE_API_KEY = "ok";
    process.env.CORS_ALLOWED_ORIGINS = "http://localhost";
    const { server, baseUrl } = await listen(createHttpBridgeApp({ port: 0, host: "127.0.0.1" }));

    try {
      const rejected = await fetch(`${baseUrl}/info`, {
        headers: { origin: "http://localhost.evil.example" },
      });
      expect(rejected.headers.get("access-control-allow-origin")).toBeNull();

      const accepted = await fetch(`${baseUrl}/info`, {
        headers: { origin: "http://localhost" },
      });
      expect(accepted.headers.get("access-control-allow-origin")).toBe("http://localhost");
    } finally {
      await close(server);
    }
  });
});
