import { createServer, type Server } from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";

async function listen(handler: Parameters<typeof createServer>[0]): Promise<{ server: Server; endpoint: string }> {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Could not resolve prompt sync test server address.");
  }
  return { server, endpoint: `http://127.0.0.1:${address.port}` };
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function runPromptSync(args: string[], env: NodeJS.ProcessEnv = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, ["scripts/sync-prompt-repo.mjs", ...args], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      BIFROST_ENDPOINT: "",
      AI_API_KEY: "",
      BIFROST_BASIC_AUTH_USERNAME: "",
      BIFROST_BASIC_AUTH_PASSWORD: "",
      ...env,
    },
    windowsHide: true,
  });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += String(chunk);
  });
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const [code] = (await once(child, "exit")) as [number | null];
  return { code, stdout, stderr };
}

describe("prompt sync resilience", () => {
  const servers: Server[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => close(server)));
  });

  it("skips dry-run cleanly when the prompt repo endpoint is unconfigured", async () => {
    const result = await runPromptSync(["--dry-run"]);

    expect(result.code).toBe(0);
    expect(result.stderr).toContain("Prompt drift guard skipped");
    expect(result.stderr).not.toContain("Unexpected token");
  });

  it("skips dry-run cleanly when the prompt repo endpoint is unreachable", async () => {
    const result = await runPromptSync(["--dry-run", "--endpoint", "http://127.0.0.1:9"]);

    expect(result.code).toBe(0);
    expect(result.stderr).toContain("Prompt drift guard skipped");
    expect(result.stderr).not.toContain("Unexpected token");
  });

  it("reports non-json responses clearly instead of crashing with a JSON parser error", async () => {
    const { server, endpoint } = await listen((_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<!DOCTYPE html><title>login</title>");
    });
    servers.push(server);

    const result = await runPromptSync(["--dry-run", "--required", "--endpoint", endpoint]);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("non-JSON response");
    expect(result.stderr).toContain("/api/prompt-repo/prompts");
    expect(result.stderr).not.toContain("Unexpected token");
  });
});
