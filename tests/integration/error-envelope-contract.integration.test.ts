import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { McpToolError } from "../../src/lib/mcp-error.js";
import { StateStore } from "../../src/lib/state-store.js";
import { registerAnalyzeDocumentationCandidateTool } from "../../src/tools/analyze-documentation-candidate.js";
import { registerCaptureDevelopmentEventTool } from "../../src/tools/capture-development-event.js";
import { registerCaptureFeatureScreenshotTool } from "../../src/tools/capture-feature-screenshot.js";
import { registerExportManualMarkdownTool } from "../../src/tools/export-manual-markdown.js";
import { registerGetDocumentationStatusTool } from "../../src/tools/get-documentation-status.js";
import { registerGetGitDiffSummaryTool } from "../../src/tools/get-git-diff-summary.js";
import { registerInitializeProjectManualTool } from "../../src/tools/initialize-project-manual.js";
import { registerPackageManualTool } from "../../src/tools/package-manual.js";
import { registerPublishOrQueueReviewTool } from "../../src/tools/publish-or-queue-review.js";
import { registerUpsertFeatureDocumentationTool } from "../../src/tools/upsert-feature-documentation.js";

const testContext = vi.hoisted(() => {
  return {
    notion: null as unknown,
    store: null as StateStore | null,
    screenshotFailure: "simulated screenshot failure",
  };
});

vi.mock("../../src/lib/notion-client.js", () => ({
  createNotionClient: () => testContext.notion,
}));

vi.mock("../../src/lib/state-store.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/lib/state-store.js")>("../../src/lib/state-store.js");
  return {
    ...actual,
    getStateStore: () => {
      if (!testContext.store) {
        throw new Error("Test store not initialized");
      }

      return testContext.store;
    },
  };
});

vi.mock("../../src/lib/screenshots.js", () => ({
  captureScreenshot: async () => {
    throw new Error(testContext.screenshotFailure);
  },
}));

type ToolResponse = { content: Array<{ type: string; text: string }> };

class FakeServer {
  handlers = new Map<string, (input: unknown) => Promise<ToolResponse>>();

  tool(name: string, _description: string, _schema: unknown, handler: (input: unknown) => Promise<ToolResponse>) {
    this.handlers.set(name, handler);
  }
}

type ErrorEnvelope = {
  ok: false;
  error: {
    code: string;
    message: string;
    traceId: string;
    tool: string;
    remediation?: string[];
    context?: Record<string, unknown>;
    causeName?: string;
  };
};

function assertEnvelope(error: unknown, input: { tool: string; code: string; expectRemediation?: boolean; expectContext?: boolean }) {
  expect(error).toBeInstanceOf(McpToolError);

  const envelope = JSON.parse((error as Error).message) as ErrorEnvelope;
  expect(envelope.ok).toBe(false);
  expect(envelope.error.tool).toBe(input.tool);
  expect(envelope.error.code).toBe(input.code);
  expect(envelope.error.message).toBeTruthy();
  expect(envelope.error.traceId).toBeTruthy();

  if (input.expectRemediation) {
    expect(Array.isArray(envelope.error.remediation)).toBe(true);
    expect((envelope.error.remediation ?? []).length).toBeGreaterThan(0);
  }

  if (input.expectContext) {
    expect(envelope.error.context).toBeDefined();
  }
}

async function setupProject(projectId: string) {
  const stateDir = await mkdtemp(join(tmpdir(), `auto-doc-envelope-${projectId}-`));
  testContext.store = new StateStore(join(stateDir, "state.json"));

  await testContext.store.upsertProject({
    projectId,
    projectName: "Acme",
    parentPageId: "parent_1",
    publishingMode: "Balanced",
    autoPublishThreshold: 90,
    projectPageId: `project_${projectId}`,
    databases: {
      projectsDatabaseId: "db_projects",
      featuresDatabaseId: "db_features",
      manualEntriesDatabaseId: "db_manual",
      evidenceEventsDatabaseId: "db_evidence",
      releasesDatabaseId: "db_releases",
    },
    featuresByKey: {},
    eventsByExternalId: {},
    eventSnapshots: {},
  });
}

function notionPreflightForbidden() {
  return {
    users: {
      me: async () => ({}),
    },
    databases: {
      retrieve: async () => {
        throw { status: 403, message: "Forbidden" };
      },
    },
  };
}

describe("client-facing MCP error envelope contract", () => {
  it("initialize_project_manual emits envelope with Notion remediation/context", async () => {
    const previousNotionToken = process.env.NOTION_TOKEN;
    process.env.NOTION_TOKEN = "test_token";

    try {
      testContext.notion = {
        users: {
          me: async () => {
            throw { status: 401, code: "unauthorized", message: "Unauthorized" };
          },
        },
      };

      const server = new FakeServer();
      registerInitializeProjectManualTool(server as never);
      const handler = server.handlers.get("initialize_project_manual");
      expect(handler).toBeDefined();

      try {
        await handler!({ projectName: "Acme", parentPageId: "parent" });
        throw new Error("Expected initialize_project_manual to throw");
      } catch (error) {
        assertEnvelope(error, {
          tool: "initialize_project_manual",
          code: "NOTION_TOKEN_INVALID",
          expectRemediation: true,
          expectContext: true,
        });
      }
    } finally {
      if (previousNotionToken === undefined) {
        delete process.env.NOTION_TOKEN;
      } else {
        process.env.NOTION_TOKEN = previousNotionToken;
      }
    }
  });

  it("captures consistent envelopes for capture/upsert/package/status/export failures", async () => {
    await setupProject("proj_contract");
    testContext.notion = notionPreflightForbidden();

    const server = new FakeServer();
    registerCaptureDevelopmentEventTool(server as never);
    registerUpsertFeatureDocumentationTool(server as never);
    registerPackageManualTool(server as never);
    registerGetDocumentationStatusTool(server as never);
    registerExportManualMarkdownTool(server as never);

    const capture = server.handlers.get("capture_development_event");
    const upsert = server.handlers.get("upsert_feature_documentation");
    const pack = server.handlers.get("package_manual");
    const status = server.handlers.get("get_documentation_status");
    const exportMarkdown = server.handlers.get("export_manual_markdown");

    expect(capture).toBeDefined();
    expect(upsert).toBeDefined();
    expect(pack).toBeDefined();
    expect(status).toBeDefined();
    expect(exportMarkdown).toBeDefined();

    const cases: Array<{ name: string; call: () => Promise<unknown> }> = [
      {
        name: "capture_development_event",
        call: () =>
          capture!({
            projectId: "proj_contract",
            source: "local_git",
            eventType: "commit",
            summary: "Added new settings workflow",
          }),
      },
      {
        name: "upsert_feature_documentation",
        call: () =>
          upsert!({
            projectId: "proj_contract",
            featureKey: "route:settings",
            featureName: "Settings",
            audiences: ["User"],
            manualEntries: [
              {
                entryType: "User Guide",
                title: "Settings",
                userGuide: "Open settings and update profile.",
                adminGuide: "N/A",
              },
            ],
            evidenceEventIds: [],
            confidenceScore: 70,
            confidenceReasons: ["contract test"],
            publishingMode: "balanced",
            autoPublishThreshold: 90,
          }),
      },
      {
        name: "package_manual",
        call: () =>
          pack!({
            projectId: "proj_contract",
            releaseVersion: "1.0.0",
            audience: "both",
            format: "markdown",
          }),
      },
      {
        name: "get_documentation_status",
        call: () =>
          status!({
            projectId: "proj_contract",
          }),
      },
      {
        name: "export_manual_markdown",
        call: () =>
          exportMarkdown!({
            projectId: "proj_contract",
            audience: "both",
          }),
      },
    ];

    for (const current of cases) {
      try {
        await current.call();
        throw new Error(`Expected ${current.name} to throw`);
      } catch (error) {
        assertEnvelope(error, {
          tool: current.name,
          code: "NOTION_DATABASE_FORBIDDEN",
          expectRemediation: true,
          expectContext: true,
        });
      }
    }
  });

  it("analyze_documentation_candidate emits generic envelope fields on unknown project", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "auto-doc-envelope-analyze-"));
    testContext.store = new StateStore(join(stateDir, "state.json"));

    const server = new FakeServer();
    registerAnalyzeDocumentationCandidateTool(server as never);
    const analyze = server.handlers.get("analyze_documentation_candidate");
    expect(analyze).toBeDefined();

    try {
      await analyze!({
        projectId: "missing_project",
        evidenceEventIds: ["evt_1"],
      });
      throw new Error("Expected analyze_documentation_candidate to throw");
    } catch (error) {
      assertEnvelope(error, {
        tool: "analyze_documentation_candidate",
        code: "ANALYZE_DOCUMENTATION_CANDIDATE_FAILED",
      });
    }
  });

  it("publish_or_queue_review emits envelope on malformed runtime input", async () => {
    const server = new FakeServer();
    registerPublishOrQueueReviewTool(server as never);
    const publish = server.handlers.get("publish_or_queue_review");
    expect(publish).toBeDefined();

    try {
      await publish!({
        projectId: "proj_1",
        featureId: "feature_1",
        manualEntryIds: ["entry_1"],
        confidenceScore: Symbol("invalid_number"),
        publishingMode: "balanced",
        autoPublishThreshold: 90,
        hasContradiction: false,
      });
      throw new Error("Expected publish_or_queue_review to throw");
    } catch (error) {
      assertEnvelope(error, {
        tool: "publish_or_queue_review",
        code: "PUBLISH_POLICY_FAILED",
      });
    }
  });

  it("get_git_diff_summary emits envelope on repo access failure", async () => {
    const server = new FakeServer();
    registerGetGitDiffSummaryTool(server as never);
    const summary = server.handlers.get("get_git_diff_summary");
    expect(summary).toBeDefined();

    try {
      await summary!({
        repoPath: join(tmpdir(), "repo-that-does-not-exist"),
        mode: "staged",
      });
      throw new Error("Expected get_git_diff_summary to throw");
    } catch (error) {
      assertEnvelope(error, {
        tool: "get_git_diff_summary",
        code: "GIT_DIFF_SUMMARY_FAILED",
      });
    }
  });

  it("capture_feature_screenshot returns non-blocking error payload with envelope shape", async () => {
    testContext.screenshotFailure = "playwright not installed";

    const server = new FakeServer();
    registerCaptureFeatureScreenshotTool(server as never);
    const screenshot = server.handlers.get("capture_feature_screenshot");
    expect(screenshot).toBeDefined();

    const result = await screenshot!({
      url: "https://example.com",
      outputPath: "./tmp.png",
    });

    const parsed = JSON.parse(result.content[0].text) as {
      ok: boolean;
      traceId: string;
      error: { code: string; message: string; traceId: string; tool: string };
    };

    expect(parsed.ok).toBe(false);
    expect(parsed.traceId).toBeTruthy();
    expect(parsed.error.code).toBe("SCREENSHOT_CAPTURE_FAILED");
    expect(parsed.error.message).toContain("playwright not installed");
    expect(parsed.error.traceId).toBe(parsed.traceId);
    expect(parsed.error.tool).toBe("capture_feature_screenshot");
  });
});
