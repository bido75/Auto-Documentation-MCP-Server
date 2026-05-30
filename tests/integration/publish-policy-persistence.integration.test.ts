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

type FakePage = {
  id: string;
  properties: Record<string, unknown>;
};

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

describe("publish_or_queue_review persistence", () => {
  it("persists feature and manual entry status updates in Notion", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "auto-doc-publish-persist-"));
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

    const pages = new Map<string, FakePage>([
      [
        "feature_1",
        {
          id: "feature_1",
          properties: {
            Status: { status: { name: "Captured" } },
          },
        },
      ],
      [
        "manual_1",
        {
          id: "manual_1",
          properties: {
            Status: { status: { name: "Captured" } },
            "Publishing Decision": { select: { name: "Queued Review" } },
          },
        },
      ],
    ]);

    testContext.notion = {
      users: {
        me: vi.fn(async () => ({ object: "user" })),
      },
      databases: {
        retrieve: vi.fn(async () => ({ object: "database" })),
      },
      pages: {
        update: vi.fn(async (input: { page_id: string; properties: Record<string, unknown> }) => {
          const page = pages.get(input.page_id);
          if (!page) {
            throw new Error(`Missing page ${input.page_id}`);
          }

          page.properties = {
            ...page.properties,
            ...input.properties,
          };

          return { id: input.page_id, url: `https://notion.local/${input.page_id}` };
        }),
      },
    };

    const server = new FakeServer();
    const { registerPublishOrQueueReviewTool } = await import("../../src/tools/publish-or-queue-review.js");
    registerPublishOrQueueReviewTool(server as never);

    const publish = server.handlers.get("publish_or_queue_review");
    expect(publish).toBeDefined();

    const result = parseToolResult<{ finalStatus: string; publishingDecision: string; manualEntryIds: string[] }>(
      await publish!({
        projectId: "proj_1",
        featureId: "feature_1",
        manualEntryIds: ["manual_1"],
        confidenceScore: 95,
        publishingMode: "balanced",
        autoPublishThreshold: 90,
      }),
    );

    expect(result.finalStatus).toBe("Published");
    expect(result.publishingDecision).toBe("Agent Published");
    expect(result.manualEntryIds).toEqual(["manual_1"]);

    const feature = pages.get("feature_1");
    const manual = pages.get("manual_1");

    expect(feature?.properties.Status).toEqual({ status: { name: "Published" } });
    expect(manual?.properties.Status).toEqual({ status: { name: "Published" } });
    expect(manual?.properties["Publishing Decision"]).toEqual({ select: { name: "Agent Published" } });
  });

  it("forces Needs Review for low-confidence duplicate matches even in fully automatic mode", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "auto-doc-publish-persist-dedupe-"));
    testContext.store = new StateStore(join(stateDir, "state.json"));

    await testContext.store.upsertProject({
      projectId: "proj_2",
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

    const pages = new Map<string, FakePage>([
      [
        "feature_2",
        {
          id: "feature_2",
          properties: {
            Status: { status: { name: "Captured" } },
          },
        },
      ],
      [
        "manual_2",
        {
          id: "manual_2",
          properties: {
            Status: { status: { name: "Captured" } },
            "Publishing Decision": { select: { name: "Queued Review" } },
          },
        },
      ],
    ]);

    testContext.notion = {
      users: {
        me: vi.fn(async () => ({ object: "user" })),
      },
      databases: {
        retrieve: vi.fn(async () => ({ object: "database" })),
      },
      pages: {
        update: vi.fn(async (input: { page_id: string; properties: Record<string, unknown> }) => {
          const page = pages.get(input.page_id);
          if (!page) {
            throw new Error(`Missing page ${input.page_id}`);
          }

          page.properties = {
            ...page.properties,
            ...input.properties,
          };

          return { id: input.page_id, url: `https://notion.local/${input.page_id}` };
        }),
      },
    };

    const server = new FakeServer();
    const { registerPublishOrQueueReviewTool } = await import("../../src/tools/publish-or-queue-review.js");
    registerPublishOrQueueReviewTool(server as never);

    const publish = server.handlers.get("publish_or_queue_review");
    expect(publish).toBeDefined();

    const result = parseToolResult<{ finalStatus: string; publishingDecision: string; reviewNotes: string }>(
      await publish!({
        projectId: "proj_2",
        featureId: "feature_2",
        manualEntryIds: ["manual_2"],
        confidenceScore: 70,
        publishingMode: "fully_automatic",
        autoPublishThreshold: 90,
        dedupeDecision: "matched_existing_feature",
        matchedExistingFeatureKey: "route:billing-settings",
      }),
    );

    expect(result.finalStatus).toBe("Needs Review");
    expect(result.publishingDecision).toBe("Queued Review");
    expect(result.reviewNotes).toContain("low-confidence dedupe match");

    const feature = pages.get("feature_2");
    const manual = pages.get("manual_2");

    expect(feature?.properties.Status).toEqual({ status: { name: "Needs Review" } });
    expect(manual?.properties.Status).toEqual({ status: { name: "Needs Review" } });
    expect(manual?.properties["Publishing Decision"]).toEqual({ select: { name: "Queued Review" } });
    expect(manual?.properties["Reviewer Notes"]).toEqual({
      rich_text: [
        {
          text: {
            content:
              "Forced queue review: low-confidence dedupe match (matched_existing_feature against route:billing-settings).",
          },
        },
      ],
    });
  });
});
