import { createServer, type Server } from "node:http";
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

describe("HTTP bridge auth", () => {
  const previousToken = process.env.NOTION_TOKEN;
  const previousUnauthenticatedSse = process.env.AUTO_DOC_ALLOW_UNAUTHENTICATED_SSE;
  const previousEnvFallback = process.env.AUTO_DOC_ENABLE_ENV_TOKEN_FALLBACK;

  beforeEach(() => {
    process.env.NOTION_TOKEN = "env_token_must_not_be_used_by_default";
    delete process.env.AUTO_DOC_ALLOW_UNAUTHENTICATED_SSE;
    delete process.env.AUTO_DOC_ENABLE_ENV_TOKEN_FALLBACK;
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
});
