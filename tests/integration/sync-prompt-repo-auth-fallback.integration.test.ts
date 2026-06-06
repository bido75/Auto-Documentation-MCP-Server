import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";

const PROMPT_NAMES = [
  "auto-doc-analyzer",
  "auto-doc-reviewer",
  "auto-doc-gap-filler",
  "auto-doc-staleness-updater",
];

describe("sync-prompt-repo auth fallback", () => {
  it("falls back to bearer auth when basic auth returns a non-JSON response", async () => {
    const basicAuth = "Basic " + Buffer.from("ci-user:ci-pass", "utf8").toString("base64");
    const bearerAuth = "Bearer " + "ci-token";

    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const authHeader = req.headers.authorization ?? "";

      if (url.pathname === "/api/prompt-repo/prompts") {
        if (authHeader === basicAuth) {
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end("<!DOCTYPE html><html><body>login</body></html>");
          return;
        }

        if (authHeader === bearerAuth) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              prompts: PROMPT_NAMES.map((name, index) => ({ id: String(index + 1), name })),
            }),
          );
          return;
        }
      }

      if (/^\/api\/prompt-repo\/prompts\/\d+\/versions$/.test(url.pathname) && authHeader === bearerAuth) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ versions: [] }));
        return;
      }

      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
    });

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });

    const address = server.address();
    if (!address || typeof address === "string") {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      throw new Error("Failed to allocate test server address");
    }

    const endpoint = `http://127.0.0.1:${address.port}`;
    const result = await runScript(endpoint);

    await new Promise<void>((resolve) => server.close(() => resolve()));

    expect(result.status).toBe(0);
    expect(result.stderr).toContain("prompt repo auth mode 'basic' failed");
    expect(result.stdout).toContain("[auth] using bearer");
    expect(result.stdout).toContain("summary: updated=4 unchanged=0 missing=0 dry_run=true");
  });
});

function runScript(endpoint: string): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", ["scripts/sync-prompt-repo.mjs", "--dry-run", "--endpoint", endpoint], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        AI_API_KEY: "ci-token",
        BIFROST_BASIC_AUTH_USERNAME: "ci-user",
        BIFROST_BASIC_AUTH_PASSWORD: "ci-pass",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}
