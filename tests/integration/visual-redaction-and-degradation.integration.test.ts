/**
 * Acceptance: Visual feature criteria 8 + 9 + 10 - redaction, graceful degradation, concurrency
 * DO NOT DELETE/SKIP.
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { StateStore } from "../../src/lib/state-store.js";

vi.mock("playwright", () => ({
  chromium: {
    launch: vi.fn(async () => ({
      newPage: async () => ({
        goto: async (url: string) => {
          throw new Error(`navigation failed for ${url}`);
        },
        screenshot: async () => undefined,
      }),
      close: async () => undefined,
    })),
  },
}));

type ToolResult = { content: Array<{ type: string; text: string }> };

class FakeServer {
  readonly handlers = new Map<string, (input: unknown) => Promise<ToolResult>>();
  tool(name: string, _description: string, _schema: unknown, handler: (input: unknown) => Promise<ToolResult>) {
    this.handlers.set(name, handler);
  }
}

beforeEach(() => {
  delete process.env.AUTO_DOC_CAPTURE_ALLOWLIST;
  delete process.env.AUTO_DOC_ARTIFACT_ROOT;
  delete process.env.AUTO_DOC_STATE_FILE;
});

describe("visual-redaction-and-degradation", () => {
  it("a capture failure whose error/URL contains an auth token serializes only the redacted form", async () => {
    process.env.AUTO_DOC_CAPTURE_ALLOWLIST = "docs.example.test";
    const { registerCaptureFeatureScreenshotTool } = await import("../../src/tools/capture-feature-screenshot.js");
    const server = new FakeServer();
    registerCaptureFeatureScreenshotTool(server as never);

    const result = JSON.parse(
      (
        await server.handlers.get("capture_feature_screenshot")!({
          url: "https://docs.example.test/page?access_token=super-secret-token",
          outputPath: "screens/page.png",
        })
      ).content[0].text,
    ) as { ok: false; error: { message: string } };

    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain("super-secret-token");
    expect(result.error.message).toContain("[REDACTED]");
  });

  it("no headless capability + no provided artifact: pipeline completes without crash (entry w/o figure or labeled diagram)", async () => {
    const { createIllustrativeDiagramFallback, attachVisualEvidence } = await import("../../src/lib/visual-evidence.js");

    await expect(attachVisualEvidence({ projectId: "project_1", caption: "Missing capture" })).rejects.toMatchObject({
      code: "VISUAL_EVIDENCE_SOURCE_REQUIRED",
    });
    expect(createIllustrativeDiagramFallback({ title: "Fallback", description: "No capture available" }).caption).toContain(
      "Illustrative diagram, not a screenshot",
    );
  });

  it("parallel figure associations on the same project preserve ALL writes (serialized state-store path)", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "auto-doc-visual-state-"));
    const statePath = join(stateDir, "state.json");
    process.env.AUTO_DOC_STATE_FILE = statePath;
    process.env.AUTO_DOC_ARTIFACT_ROOT = join(stateDir, "artifacts");
    const store = new StateStore(statePath);
    await store.upsertProject({
      projectId: "project_1",
      projectName: "Acme",
      parentPageId: "parent_1",
      publishingMode: "Balanced",
      autoPublishThreshold: 90,
      databases: {
        projectsDatabaseId: "projects_db",
        featuresDatabaseId: "features_db",
        manualEntriesDatabaseId: "manual_db",
        evidenceEventsDatabaseId: "events_db",
        releasesDatabaseId: "releases_db",
      },
      featuresByKey: {},
      eventsByExternalId: {},
      eventSnapshots: {},
    });

    const visuals = Array.from({ length: 8 }, (_, index) => ({
      visualId: `vis_${index}`,
      projectId: "project_1",
      artifactPath: join(process.env.AUTO_DOC_ARTIFACT_ROOT!, `figure-${index}.png`),
      mediaType: "image/png",
      caption: `Figure ${index}`,
      createdAt: new Date().toISOString(),
    }));

    await Promise.all(visuals.map((visual) => store.setVisualEvidence("project_1", visual)));
    await Promise.all(visuals.map(async (visual) => expect(await store.getVisualEvidence("project_1", visual.visualId)).toMatchObject(visual)));
  });

  it("capture URL with embedded credentials is never logged in raw form", async () => {
    process.env.AUTO_DOC_CAPTURE_ALLOWLIST = "docs.example.test";
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { registerCaptureFeatureScreenshotTool } = await import("../../src/tools/capture-feature-screenshot.js");
    const server = new FakeServer();
    registerCaptureFeatureScreenshotTool(server as never);

    await server.handlers.get("capture_feature_screenshot")!({
      url: "https://user:super-secret-token@docs.example.test/page",
      outputPath: "screens/page.png",
    });

    expect(errorSpy.mock.calls.map((call) => call.join(" ")).join("\n")).not.toContain("super-secret-token");
    errorSpy.mockRestore();
  });
});
