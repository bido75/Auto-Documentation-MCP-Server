import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
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

function parseToolResult<T>(value: { content: Array<{ type: string; text: string }> }): T {
  return JSON.parse(value.content[0].text) as T;
}

describe("upsert_feature_documentation dedupe review policy", () => {
  it("queues low-confidence duplicate candidates for review during upsert", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "auto-doc-upsert-dedupe-review-"));
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

    await testContext.store.setFeature("proj_1", "route:billing-settings:invoice-export-action", "feature_1");

    const featurePage = {
      id: "feature_1",
      properties: {
        Status: { status: { name: "Captured" } },
      },
    };

    let createdManualPayload: Record<string, unknown> | null = null;

    testContext.notion = {
      users: {
        me: vi.fn(async () => ({ object: "user" })),
      },
      databases: {
        retrieve: vi.fn(async () => ({ object: "database" })),
      },
      pages: {
        create: vi.fn(async (input: Record<string, unknown>) => {
          createdManualPayload = input;
          return { id: "manual_1", url: "https://notion.local/manual_1" };
        }),
        update: vi.fn(async (input: { page_id: string; properties: Record<string, unknown> }) => {
          if (input.page_id !== "feature_1") {
            throw new Error(`Unexpected page update ${input.page_id}`);
          }

          featurePage.properties = {
            ...featurePage.properties,
            ...input.properties,
          };

          return { id: input.page_id, url: `https://notion.local/${input.page_id}` };
        }),
      },
    };

    const server = new FakeServer();
    const { registerUpsertFeatureDocumentationTool } = await import("../../src/tools/upsert-feature-documentation.js");
    registerUpsertFeatureDocumentationTool(server as never);

    const upsert = server.handlers.get("upsert_feature_documentation");
    expect(upsert).toBeDefined();

    const result = parseToolResult<{
      publishing: { status: string; decision: string };
      featureId: string;
      manualEntries: Array<{ pageId: string }>;
    }>(
      await upsert!({
        projectId: "proj_1",
        featureKey: "route:billing-settings:invoice-export-action",
        featureName: "Invoice Export Action",
        audiences: ["User", "Admin"],
        manualEntries: [
          {
            entryType: "User Guide",
            title: "Use Invoice Export",
            userGuide: "Open Billing settings and run invoice export.",
            adminGuide: "Confirm billing export permissions are enabled.",
          },
        ],
        evidenceEventIds: [],
        confidenceScore: 70,
        confidenceReasons: ["dedupe collision"],
        dedupeDecision: "disambiguated_route_collision",
        matchedExistingFeatureKey: "route:billing-settings",
        publishingMode: "fully_automatic",
        autoPublishThreshold: 90,
      }),
    );

    expect(result.featureId).toBe("feature_1");
    expect(result.manualEntries.length).toBe(1);
    expect(result.publishing.status).toBe("Needs Review");
    expect(result.publishing.decision).toBe("Queued Review");

    expect(featurePage.properties.Status).toEqual({ status: { name: "Needs Review" } });

    expect(createdManualPayload).not.toBeNull();
    const manualProperties = (createdManualPayload?.properties ?? {}) as Record<string, unknown>;
    expect(manualProperties.Status).toEqual({ status: { name: "Needs Review" } });
    expect(manualProperties["Publishing Decision"]).toEqual({ select: { name: "Queued Review" } });
    expect(manualProperties["Reviewer Notes"]).toEqual({
      rich_text: [
        {
          text: {
            content:
              "Forced queue review: low-confidence dedupe match (disambiguated_route_collision against route:billing-settings).",
          },
        },
      ],
    });
  });
});
