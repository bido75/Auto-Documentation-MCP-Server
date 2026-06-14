import { createServer, type Server } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { StateStore } from "../../src/lib/state-store.js";
import { createHttpBridgeApp } from "../../src/http-bridge/server.js";

async function listen(): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer(createHttpBridgeApp({ port: 0, host: "127.0.0.1" }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not resolve server address.");
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

const previousEnv = new Map<string, string | undefined>();
function setEnv(key: string, value: string | undefined): void {
  if (!previousEnv.has(key)) previousEnv.set(key, process.env[key]);
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

afterEach(() => {
  for (const [key, value] of previousEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  previousEnv.clear();
});

describe("secure-runner-status-exposure", () => {
  it("rejects anonymous runner status but returns full status for authenticated callers", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "auto-doc-runner-status-"));
    setEnv("AUTO_DOC_STATE_FILE", join(stateDir, "state.json"));
    setEnv("AUTO_DOC_RUNNER_PROJECT_ID", "project_1");
    setEnv("AUTO_DOC_RUNNER_REPO_PATH", "C:/repo");
    setEnv("AUTO_DOC_ENABLE_ENV_TOKEN_FALLBACK", undefined);
    setEnv("NOTION_TOKEN", "env_token_must_not_authenticate_anonymous_status");
    const store = new StateStore(process.env.AUTO_DOC_STATE_FILE);
    await store.upsertProject({
      projectId: "project_1",
      projectName: "Acme",
      parentPageId: "parent_1",
      publishingMode: "Balanced",
      autoPublishThreshold: 90,
      projectPageId: "project_page_1",
      databases: {
        projectsDatabaseId: "projects",
        featuresDatabaseId: "features",
        manualEntriesDatabaseId: "manual",
        evidenceEventsDatabaseId: "events",
        releasesDatabaseId: "releases",
      },
      featuresByKey: {},
      eventsByExternalId: {},
      eventSnapshots: {},
    });

    const { server, baseUrl } = await listen();
    try {
      const anonymous = await fetch(`${baseUrl}/runner/status`);
      expect(anonymous.status).toBe(401);

      const authed = await fetch(`${baseUrl}/runner/status`, { headers: { "x-notion-token": "request_token" } });
      expect(authed.status).toBe(200);
      const payload = (await authed.json()) as { targetCount: number; targets: Array<{ projectId: string; repoPath: string }> };
      expect(payload.targetCount).toBe(1);
      expect(payload.targets[0]).toMatchObject({ projectId: "project_1", repoPath: "C:/repo" });
    } finally {
      await close(server);
    }
  });
});
