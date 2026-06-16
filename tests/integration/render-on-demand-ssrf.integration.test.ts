/**
 * Acceptance: Visual feature criterion 6 + 7 - render-on-demand SSRF guard + bridge auth
 * Capture targets restricted to an explicit allowlist; internal/metadata addresses rejected.
 * Render-on-demand not triggerable unauthenticated via bridge. DO NOT DELETE/SKIP.
 */
import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHttpBridgeApp } from "../../src/http-bridge/server.js";

vi.mock("playwright", () => ({
  chromium: {
    launch: vi.fn(async () => ({
      newPage: async () => ({
        goto: async () => undefined,
        screenshot: async () => undefined,
      }),
      close: async () => undefined,
    })),
  },
}));

async function listen(app: ReturnType<typeof createHttpBridgeApp>): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not resolve test server address.");
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

beforeEach(() => {
  delete process.env.AUTO_DOC_CAPTURE_ALLOWLIST;
  delete process.env.AUTO_DOC_CAPTURE_DEV_ALLOW_PRIVATE;
  delete process.env.AUTO_DOC_ALLOW_UNAUTHENTICATED_SSE;
  delete process.env.AUTO_DOC_ENABLE_ENV_TOKEN_FALLBACK;
  process.env.NOTION_TOKEN = "env_token_must_not_auth_bridge";
});

afterEach(() => {
  delete process.env.AUTO_DOC_CAPTURE_ALLOWLIST;
  delete process.env.AUTO_DOC_CAPTURE_DEV_ALLOW_PRIVATE;
  delete process.env.AUTO_DOC_ALLOW_UNAUTHENTICATED_SSE;
  delete process.env.AUTO_DOC_ENABLE_ENV_TOKEN_FALLBACK;
  delete process.env.NOTION_TOKEN;
});

describe("render-on-demand-ssrf", () => {
  it("capture request to a non-allowlisted host returns a typed error (rejected)", async () => {
    process.env.AUTO_DOC_CAPTURE_ALLOWLIST = "docs.example.test";
    const { captureScreenshot } = await import("../../src/lib/screenshots.js");

    await expect(captureScreenshot("https://evil.example.test/page", "screens/page.png")).rejects.toMatchObject({
      code: "SCREENSHOT_TARGET_NOT_ALLOWLISTED",
    });
  });

  it("capture request to localhost/169.254/private/metadata IP is rejected unless explicitly dev-allowlisted", async () => {
    process.env.AUTO_DOC_CAPTURE_ALLOWLIST = "localhost,169.254.169.254,10.0.0.1";
    const { captureScreenshot } = await import("../../src/lib/screenshots.js");

    await expect(captureScreenshot("http://localhost/page", "screens/a.png")).rejects.toMatchObject({ code: "SCREENSHOT_TARGET_FORBIDDEN" });
    await expect(captureScreenshot("http://169.254.169.254/latest/meta-data", "screens/b.png")).rejects.toMatchObject({
      code: "SCREENSHOT_TARGET_FORBIDDEN",
    });
    await expect(captureScreenshot("http://10.0.0.1/admin", "screens/c.png")).rejects.toMatchObject({ code: "SCREENSHOT_TARGET_FORBIDDEN" });
  });

  it("capture request to an allowlisted host is permitted", async () => {
    process.env.AUTO_DOC_CAPTURE_ALLOWLIST = "docs.example.test";
    const { captureScreenshot } = await import("../../src/lib/screenshots.js");

    await expect(captureScreenshot("https://docs.example.test/page", "screens/page.png")).resolves.toContain("screens");
  });

  it("render-on-demand is NOT triggerable unauthenticated via the HTTP bridge", async () => {
    const { server, baseUrl } = await listen(createHttpBridgeApp({ port: 0, host: "127.0.0.1" }));
    try {
      const response = await fetch(`${baseUrl}/sse`);
      expect(response.status).toBe(401);
    } finally {
      await close(server);
    }
  });

  it("off by default: with no capture config, render-on-demand is unavailable and pipeline continues", async () => {
    const { registerCaptureFeatureScreenshotTool } = await import("../../src/tools/capture-feature-screenshot.js");
    const handlers = new Map<string, (input: unknown) => Promise<{ content: Array<{ text: string; type: string }> }>>();
    registerCaptureFeatureScreenshotTool({ tool: (name: string, _description: string, _schema: unknown, handler: (input: unknown) => Promise<{ content: Array<{ text: string; type: string }> }>) => handlers.set(name, handler) } as never);

    const result = JSON.parse(
      (
        await handlers.get("capture_feature_screenshot")!({
          url: "https://docs.example.test/page",
          outputPath: "screens/page.png",
        })
      ).content[0].text,
    ) as { ok: boolean; error: { code: string } };

    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("SCREENSHOT_CAPTURE_UNAVAILABLE");
  });
});
