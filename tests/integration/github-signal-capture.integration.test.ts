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

describe("capture_development_event github support", () => {
  it("persists PR metadata in the captured event snapshot", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "auto-doc-github-capture-"));
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
      users: { me: vi.fn(async () => ({ object: "user" })) },
      databases: { retrieve: vi.fn(async () => ({ object: "database" })) },
      pages: { create: vi.fn(async () => ({ id: "page_1", url: "https://notion.local/page_1" })) },
    };

    const server = new FakeServer();
    const { registerCaptureDevelopmentEventTool } = await import("../../src/tools/capture-development-event.js");
    registerCaptureDevelopmentEventTool(server as never);

    const capture = server.handlers.get("capture_development_event");
    expect(capture).toBeDefined();

    const result = parseToolResult<{ evidenceEventId: string }>(
      await capture!({
        projectId: "proj_1",
        source: "github",
        eventType: "pr_opened",
        summary: "Open billing export pull request",
        prUrl: "https://github.com/acme/app/pull/42",
        prTitle: "Add billing export workflow",
        prBody: "This PR closes #41 and explains the billing export workflow in detail.",
        prNumber: 42,
        baseBranch: "main",
        headBranch: "feature/billing-export",
        issueReferences: ["#41"],
        filesChanged: "src/routes/billing/settings.tsx,src/components/InvoiceExport.tsx",
        diffSummary: "Adds the billing export screen and invoice export action",
        testStatus: "passed",
      }),
    );

    const snapshot = await testContext.store.getEventSnapshot("proj_1", result.evidenceEventId);
    expect(snapshot).not.toBeNull();
    expect(snapshot?.source).toBe("github");
    expect(snapshot?.eventType).toBe("pr_opened");
    expect(snapshot?.prNumber).toBe(42);
    expect(snapshot?.prTitle).toBe("Add billing export workflow");
    expect(snapshot?.prBody).toContain("closes #41");
    expect(snapshot?.issueReferences).toEqual(["#41"]);
    expect(snapshot?.baseBranch).toBe("main");
    expect(snapshot?.headBranch).toBe("feature/billing-export");
    expect(snapshot?.prUrl).toBe("https://github.com/acme/app/pull/42");
    expect(snapshot?.summary).toContain("PR title: Add billing export workflow");
    expect(snapshot?.summary).toContain("Issue references: #41");
    expect(snapshot?.summary).toContain("Pull request #42");
  });
});