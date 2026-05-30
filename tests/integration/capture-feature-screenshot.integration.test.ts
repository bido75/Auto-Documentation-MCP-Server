import { describe, expect, it, vi } from "vitest";

const testContext = vi.hoisted(() => {
  return {
    notion: null as unknown,
  };
});

vi.mock("../../src/lib/notion-client.js", () => ({
  createNotionClient: () => testContext.notion,
}));

vi.mock("../../src/lib/screenshots.js", () => ({
  captureScreenshot: async (_url: string, outputPath: string) => outputPath,
}));

vi.mock("../../src/lib/screenshot-publisher.js", () => ({
  publishScreenshotAsset: async (_localPath: string) => ({
    publicImageUrl: "https://cdn.example.com/uploaded/settings.png",
    storagePath: "C:/public/settings.png",
  }),
}));

class FakeServer {
  handlers = new Map<string, (input: unknown) => Promise<{ content: Array<{ type: string; text: string }> }>>();

  tool(
    name: string,
    _description: string,
    _schema: unknown,
    handler: (input: unknown) => Promise<{ content: Array<{ type: string; text: string }> }>,
  ) {
    this.handlers.set(name, handler);
  }
}

function parseToolResult<T>(value: { content: Array<{ type: string; text: string }> }): T {
  return JSON.parse(value.content[0].text) as T;
}

describe("capture_feature_screenshot enrichment", () => {
  it("appends an external image evidence block when manualEntryPageId and publicImageUrl are provided", async () => {
    const append = vi.fn(async () => ({ results: [] }));

    testContext.notion = {
      blocks: {
        children: {
          append,
        },
      },
    };

    const server = new FakeServer();
    const { registerCaptureFeatureScreenshotTool } = await import("../../src/tools/capture-feature-screenshot.js");
    registerCaptureFeatureScreenshotTool(server as never);

    const screenshot = server.handlers.get("capture_feature_screenshot");
    expect(screenshot).toBeDefined();

    const result = parseToolResult<{
      ok: boolean;
      savedPath: string;
      enrichment: {
        attempted: boolean;
        manualEntryPageId: string | null;
        status: string;
        attachedBlockCount: number;
      };
    }>(
      await screenshot!({
        url: "https://example.com/settings",
        outputPath: "./tmp/settings.png",
        manualEntryPageId: "entry_page_123",
        publicImageUrl: "https://cdn.example.com/settings.png",
        caption: "Settings page screenshot",
      }),
    );

    expect(result.ok).toBe(true);
    expect(result.savedPath).toBe("./tmp/settings.png");
    expect(result.enrichment.attempted).toBe(true);
    expect(result.enrichment.manualEntryPageId).toBe("entry_page_123");
    expect(result.enrichment.status).toBe("attached_external_image");
    expect(result.enrichment.attachedBlockCount).toBeGreaterThan(0);

    expect(append).toHaveBeenCalledTimes(1);
    expect(append).toHaveBeenCalledWith(
      expect.objectContaining({
        block_id: "entry_page_123",
      }),
    );
  });

  it("stays non-blocking and returns attach_failed enrichment status when Notion append fails", async () => {
    testContext.notion = {
      blocks: {
        children: {
          append: vi.fn(async () => {
            throw new Error("forbidden");
          }),
        },
      },
    };

    const server = new FakeServer();
    const { registerCaptureFeatureScreenshotTool } = await import("../../src/tools/capture-feature-screenshot.js");
    registerCaptureFeatureScreenshotTool(server as never);

    const screenshot = server.handlers.get("capture_feature_screenshot");
    expect(screenshot).toBeDefined();

    const result = parseToolResult<{
      ok: boolean;
      savedPath: string;
      enrichment: {
        attempted: boolean;
        status: string;
        error?: { code: string; tool: string; message: string };
      };
    }>(
      await screenshot!({
        url: "https://example.com/settings",
        outputPath: "./tmp/settings.png",
        manualEntryPageId: "entry_page_123",
      }),
    );

    expect(result.ok).toBe(true);
    expect(result.savedPath).toBe("./tmp/settings.png");
    expect(result.enrichment.attempted).toBe(true);
    expect(result.enrichment.status).toBe("attach_failed");
    expect(result.enrichment.error?.code).toBe("SCREENSHOT_ENRICHMENT_FAILED");
    expect(result.enrichment.error?.tool).toBe("capture_feature_screenshot");
    expect(result.enrichment.error?.message).toContain("forbidden");
  });

  it("automatically uploads and attaches screenshot when publicImageUrl is omitted", async () => {
    const append = vi.fn(async () => ({ results: [] }));

    testContext.notion = {
      blocks: {
        children: {
          append,
        },
      },
    };

    const server = new FakeServer();
    const { registerCaptureFeatureScreenshotTool } = await import("../../src/tools/capture-feature-screenshot.js");
    registerCaptureFeatureScreenshotTool(server as never);

    const screenshot = server.handlers.get("capture_feature_screenshot");
    expect(screenshot).toBeDefined();

    const result = parseToolResult<{
      ok: boolean;
      enrichment: {
        status: string;
        autoUpload?: {
          attempted: boolean;
          uploaded: boolean;
          publicImageUrl?: string;
          storagePath?: string;
        };
      };
    }>(
      await screenshot!({
        url: "https://example.com/settings",
        outputPath: "./tmp/settings.png",
        manualEntryPageId: "entry_page_123",
      }),
    );

    expect(result.ok).toBe(true);
    expect(result.enrichment.status).toBe("attached_auto_uploaded_image");
    expect(result.enrichment.autoUpload?.attempted).toBe(true);
    expect(result.enrichment.autoUpload?.uploaded).toBe(true);
    expect(result.enrichment.autoUpload?.publicImageUrl).toContain("cdn.example.com");
    expect(result.enrichment.autoUpload?.storagePath).toContain("settings.png");
    expect(append).toHaveBeenCalledTimes(1);
  });
});
