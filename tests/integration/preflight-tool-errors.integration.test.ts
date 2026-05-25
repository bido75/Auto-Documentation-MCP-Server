import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { McpToolError } from "../../src/lib/mcp-error.js";
import { StateStore } from "../../src/lib/state-store.js";

const testContext = vi.hoisted(() => {
  return {
    notion: null as unknown,
    store: null as StateStore | null,
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

function assertMcpErrorCode(error: unknown, expectedCode: string) {
  expect(error).toBeInstanceOf(McpToolError);

  const parsed = JSON.parse((error as Error).message) as {
    error?: { code?: string; traceId?: string; tool?: string };
  };

  expect(parsed.error?.code).toBe(expectedCode);
  expect(parsed.error?.traceId).toBeTruthy();
}

describe("preflight error propagation through tool handlers", () => {
  it("surfaces NOTION_TOKEN_INVALID from initialize_project_manual", async () => {
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
      const { registerInitializeProjectManualTool } = await import("../../src/tools/initialize-project-manual.js");
      registerInitializeProjectManualTool(server as never);

      const initialize = server.handlers.get("initialize_project_manual");
      expect(initialize).toBeDefined();

      try {
        await initialize!({
          projectName: "Acme App",
          parentPageId: "parent_page",
        });
        throw new Error("Expected initialize_project_manual to throw McpToolError");
      } catch (error) {
        assertMcpErrorCode(error, "NOTION_TOKEN_INVALID");
      }
    } finally {
      if (previousNotionToken === undefined) {
        delete process.env.NOTION_TOKEN;
      } else {
        process.env.NOTION_TOKEN = previousNotionToken;
      }
    }
  });

  it("surfaces NOTION_DATABASE_FORBIDDEN from package_manual", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "auto-doc-preflight-tools-"));
    testContext.store = new StateStore(join(stateDir, "state.json"));

    await testContext.store.upsertProject({
      projectId: "proj_1",
      projectName: "Acme",
      parentPageId: "parent_1",
      publishingMode: "Balanced",
      autoPublishThreshold: 90,
      projectPageId: "project_page_1",
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

    testContext.notion = {
      users: {
        me: async () => ({}),
      },
      databases: {
        retrieve: async () => {
          throw { status: 403, message: "Forbidden" };
        },
      },
    };

    const server = new FakeServer();
    const { registerPackageManualTool } = await import("../../src/tools/package-manual.js");
    registerPackageManualTool(server as never);

    const pack = server.handlers.get("package_manual");
    expect(pack).toBeDefined();

    try {
      await pack!({
        projectId: "proj_1",
        releaseVersion: "1.0.0",
        audience: "both",
        format: "markdown",
      });
      throw new Error("Expected package_manual to throw McpToolError");
    } catch (error) {
      assertMcpErrorCode(error, "NOTION_DATABASE_FORBIDDEN");
    }
  });

  it("surfaces NOTION_DATABASE_FORBIDDEN from capture_development_event", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "auto-doc-preflight-tools-capture-"));
    testContext.store = new StateStore(join(stateDir, "state.json"));

    await testContext.store.upsertProject({
      projectId: "proj_capture",
      projectName: "Acme",
      parentPageId: "parent_1",
      publishingMode: "Balanced",
      autoPublishThreshold: 90,
      projectPageId: "project_page_capture",
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

    testContext.notion = {
      users: {
        me: async () => ({}),
      },
      databases: {
        retrieve: async () => {
          throw { status: 403, message: "Forbidden" };
        },
      },
    };

    const server = new FakeServer();
    const { registerCaptureDevelopmentEventTool } = await import("../../src/tools/capture-development-event.js");
    registerCaptureDevelopmentEventTool(server as never);

    const capture = server.handlers.get("capture_development_event");
    expect(capture).toBeDefined();

    try {
      await capture!({
        projectId: "proj_capture",
        source: "local_git",
        eventType: "commit",
        summary: "Added profile settings page",
      });
      throw new Error("Expected capture_development_event to throw McpToolError");
    } catch (error) {
      assertMcpErrorCode(error, "NOTION_DATABASE_FORBIDDEN");
    }
  });

  it("surfaces NOTION_DATABASE_FORBIDDEN from upsert_feature_documentation", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "auto-doc-preflight-tools-upsert-"));
    testContext.store = new StateStore(join(stateDir, "state.json"));

    await testContext.store.upsertProject({
      projectId: "proj_upsert",
      projectName: "Acme",
      parentPageId: "parent_1",
      publishingMode: "Balanced",
      autoPublishThreshold: 90,
      projectPageId: "project_page_upsert",
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

    testContext.notion = {
      users: {
        me: async () => ({}),
      },
      databases: {
        retrieve: async () => {
          throw { status: 403, message: "Forbidden" };
        },
      },
    };

    const server = new FakeServer();
    const { registerUpsertFeatureDocumentationTool } = await import("../../src/tools/upsert-feature-documentation.js");
    registerUpsertFeatureDocumentationTool(server as never);

    const upsert = server.handlers.get("upsert_feature_documentation");
    expect(upsert).toBeDefined();

    try {
      await upsert!({
        projectId: "proj_upsert",
        featureKey: "route:profile-settings",
        featureName: "Profile Settings",
        audiences: ["User"],
        manualEntries: [
          {
            entryType: "User Guide",
            title: "Profile Settings",
            userGuide: "Open Settings and update your profile.",
            adminGuide: "N/A",
          },
        ],
        evidenceEventIds: [],
        confidenceScore: 75,
        confidenceReasons: ["User-facing route changed"],
        publishingMode: "balanced",
        autoPublishThreshold: 90,
      });
      throw new Error("Expected upsert_feature_documentation to throw McpToolError");
    } catch (error) {
      assertMcpErrorCode(error, "NOTION_DATABASE_FORBIDDEN");
    }
  });
});
