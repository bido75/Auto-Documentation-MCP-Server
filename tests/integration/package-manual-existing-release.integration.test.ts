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

describe("package_manual existing release behavior", () => {
  it("updates Included Features and counts when release already exists", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "auto-doc-package-update-"));
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

    const query = vi.fn(
      async (input: {
        database_id: string;
        filter?: {
          property?: string;
          title?: { equals?: string };
        };
      }) => {
        if (input.database_id === "db_releases") {
          return { results: [{ id: "release_page_existing" }] };
        }

        if (input.database_id === "db_manual") {
          return {
            results: [
              {
                id: "manual_1",
                properties: {
                  "Entry Title": { title: [{ text: { content: "User thing" } }] },
                  Audience: { select: { name: "User" } },
                  Status: { status: { name: "Published" } },
                  Feature: { relation: [{ id: "feature_1" }] },
                },
              },
              {
                id: "manual_2",
                properties: {
                  "Entry Title": { title: [{ text: { content: "Admin thing" } }] },
                  Audience: { select: { name: "Admin" } },
                  Status: { status: { name: "Approved" } },
                  Feature: { relation: [{ id: "feature_2" }] },
                },
              },
            ],
          };
        }

        return { results: [] };
      },
    );
    const create = vi.fn(async () => ({ id: "release_page_new" }));
    const update = vi.fn(async () => ({}));
    const listBlocks = vi.fn(async () => ({ results: [] }));

    testContext.notion = {
      databases: {
        query,
      },
      pages: {
        create,
        update,
      },
      blocks: {
        children: {
          list: listBlocks,
        },
      },
    };

    const server = new FakeServer();
    const { registerPackageManualTool } = await import("../../src/tools/package-manual.js");
    registerPackageManualTool(server as never);

    const pack = server.handlers.get("package_manual");
    expect(pack).toBeDefined();

    const result = parseToolResult<{ releasePageId: string }>(
      await pack!({
        projectId: "proj_1",
        releaseVersion: "1.0.0",
        audience: "both",
        format: "markdown",
      }),
    );

    expect(result.releasePageId).toBe("release_page_existing");
    expect(create).not.toHaveBeenCalled();

    const releaseUpdateCall = update.mock.calls.find((call) => call[0].page_id === "release_page_existing");
    expect(releaseUpdateCall).toBeTruthy();
    expect(releaseUpdateCall?.[0].properties).toMatchObject({
      "Included Features": { relation: [{ id: "feature_1" }, { id: "feature_2" }] },
      "User Entries Count": { number: 1 },
      "Admin Entries Count": { number: 1 },
      Project: { relation: [{ id: "project_page_1" }] },
    });

    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        page_id: "manual_1",
        properties: { Release: { relation: [{ id: "release_page_existing" }] } },
      }),
    );
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        page_id: "manual_2",
        properties: { Release: { relation: [{ id: "release_page_existing" }] } },
      }),
    );
  });
});
