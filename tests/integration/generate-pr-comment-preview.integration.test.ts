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

describe("generate_pr_comment_preview", () => {
  it("builds markdown preview content for entries linked to a PR", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "auto-doc-pr-preview-"));
    testContext.store = new StateStore(join(stateDir, "state.json"));

    await testContext.store.upsertProject({
      projectId: "proj_1",
      projectName: "Acme App",
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
        me: vi.fn(async () => ({ object: "user" })),
      },
      databases: {
        retrieve: vi.fn(async () => ({ object: "database" })),
        query: vi.fn(async () => ({
          results: [
            {
              id: "entry_1",
              properties: {
                "Entry Title": { title: [{ text: { content: "Export invoices from Billing" } }] },
                "Entry Type": { select: { name: "User Guide" } },
                Audience: { select: { name: "User" } },
                Status: { status: { name: "Published" } },
                "Confidence Score": { number: 95 },
                "Source PR": { url: "https://github.com/acme/app/pull/42" },
              },
            },
            {
              id: "entry_2",
              properties: {
                "Entry Title": { title: [{ text: { content: "Configure billing export permissions" } }] },
                "Entry Type": { select: { name: "Admin Guide" } },
                Audience: { select: { name: "Admin" } },
                Status: { status: { name: "Needs Review" } },
                "Confidence Score": { number: 72 },
                "Source PR": { url: "https://github.com/acme/app/pull/42" },
              },
            },
            {
              id: "entry_3",
              properties: {
                "Entry Title": { title: [{ text: { content: "Unrelated entry" } }] },
                "Entry Type": { select: { name: "User Guide" } },
                Audience: { select: { name: "User" } },
                Status: { status: { name: "Published" } },
                "Confidence Score": { number: 80 },
                "Source PR": { url: "https://github.com/acme/app/pull/99" },
              },
            },
          ],
          has_more: false,
          next_cursor: null,
        })),
      },
    };

    const server = new FakeServer();
    const { registerGeneratePrCommentPreviewTool } = await import("../../src/tools/generate-pr-comment-preview.js");
    registerGeneratePrCommentPreviewTool(server as never);

    const preview = server.handlers.get("generate_pr_comment_preview");
    expect(preview).toBeDefined();

    const result = parseToolResult<{
      projectId: string;
      prUrl: string | null;
      entryCount: number;
      markdownPreview: string;
      statusCounts: Record<string, number>;
    }>(
      await preview!({
        projectId: "proj_1",
        prUrl: "https://github.com/acme/app/pull/42",
        audience: "both",
        maxEntries: 5,
      }),
    );

    expect(result.projectId).toBe("proj_1");
    expect(result.prUrl).toBe("https://github.com/acme/app/pull/42");
    expect(result.entryCount).toBe(2);
    expect(result.statusCounts.Published).toBe(1);
    expect(result.statusCounts["Needs Review"]).toBe(1);
    expect(result.markdownPreview).toContain("### Auto-Documentation Preview");
    expect(result.markdownPreview).toContain("Export invoices from Billing");
    expect(result.markdownPreview).not.toContain("Unrelated entry");
  });
});