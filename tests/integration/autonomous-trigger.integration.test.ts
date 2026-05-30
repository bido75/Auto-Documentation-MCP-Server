import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { StateStore } from "../../src/lib/state-store.js";

const testContext = vi.hoisted(() => {
  return {
    notion: null as unknown,
    store: null as StateStore | null,
    gitFactory: vi.fn(() => ({
      diff: vi.fn(async () => ""),
      show: vi.fn(async () => ""),
    })),
  };
});

vi.mock("simple-git", () => ({
  simpleGit: (repoPath: string) => testContext.gitFactory(repoPath),
}));

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

describe("autonomous documentation trigger", () => {
  it("runs git diff -> analyze -> upsert chain and stores an event snapshot", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "auto-doc-autonomous-trigger-"));
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

    const query = vi.fn(async (input: { database_id: string }) => {
      if (input.database_id === "db_features") {
        return { results: [] };
      }

      return { results: [] };
    });

    const create = vi.fn(async (input: { parent: { database_id: string } }) => {
      if (input.parent.database_id === "db_features") {
        return { id: "feature_1", url: "https://notion.local/feature_1" };
      }

      return { id: "manual_1", url: "https://notion.local/manual_1" };
    });

    const update = vi.fn(async (input: { page_id: string }) => ({ id: input.page_id, url: `https://notion.local/${input.page_id}` }));

    testContext.notion = {
      users: {
        me: vi.fn(async () => ({ object: "user" })),
      },
      databases: {
        retrieve: vi.fn(async () => ({ object: "database" })),
        query,
      },
      pages: {
        create,
        update,
      },
    };

    testContext.gitFactory = vi.fn((_repoPath: string) => ({
      diff: vi.fn(async () => "diff --git a/src/routes/billing.tsx b/src/routes/billing.tsx\n+++ b/src/routes/billing.tsx\n+ Added invoice export button"),
      show: vi.fn(async () => "commit abc123\nAdd billing export workflow"),
    }));

    const server = new FakeServer();
    const { registerRunAutonomousDocumentationTriggerTool } = await import(
      "../../src/tools/run-autonomous-documentation-trigger.js"
    );
    registerRunAutonomousDocumentationTriggerTool(server as never);

    const trigger = server.handlers.get("run_autonomous_documentation_trigger");
    expect(trigger).toBeDefined();

    const result = parseToolResult<{
      projectId: string;
      eventId: string | null;
      status: string;
      analyzed: { shouldDocument: boolean; featureName: string } | null;
      upserted: { featureId: string; manualEntries: Array<{ pageId: string }> } | null;
    }>(
      await trigger!({
        projectId: "proj_1",
        repoPath: "C:/fake/repo",
        mode: "working_tree",
      }),
    );

    expect(result.projectId).toBe("proj_1");
    expect(result.status).toBe("documented");
    expect(result.eventId).toBeTruthy();
    expect(result.analyzed?.shouldDocument).toBe(true);
    expect(result.upserted?.featureId).toBe("feature_1");
    expect(result.upserted?.manualEntries.length).toBeGreaterThan(0);

    const snapshot = await testContext.store.getEventSnapshot("proj_1", result.eventId as string);
    expect(snapshot).not.toBeNull();
    expect(snapshot?.filesChanged).toContain("src/routes/billing.tsx");

    expect(testContext.gitFactory).toHaveBeenCalledWith("C:/fake/repo");
    expect(create).toHaveBeenCalled();
    expect(update).toHaveBeenCalled();
  }, 15000);

  it("accepts GitHub PR metadata and routes it through the same analyze and upsert chain", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "auto-doc-autonomous-github-trigger-"));
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

    const query = vi.fn(async () => ({ results: [] }));
    const create = vi.fn(async (input: { parent: { database_id: string } }) => {
      if (input.parent.database_id === "db_features") {
        return { id: "feature_1", url: "https://notion.local/feature_1" };
      }

      return { id: "manual_1", url: "https://notion.local/manual_1" };
    });
    const update = vi.fn(async (input: { page_id: string }) => ({ id: input.page_id, url: `https://notion.local/${input.page_id}` }));

    testContext.notion = {
      users: { me: vi.fn(async () => ({ object: "user" })) },
      databases: {
        retrieve: vi.fn(async () => ({ object: "database" })),
        query,
      },
      pages: {
        create,
        update,
      },
    };

    const server = new FakeServer();
    const { registerRunAutonomousDocumentationTriggerTool } = await import(
      "../../src/tools/run-autonomous-documentation-trigger.js"
    );
    registerRunAutonomousDocumentationTriggerTool(server as never);

    const trigger = server.handlers.get("run_autonomous_documentation_trigger");
    expect(trigger).toBeDefined();

    const result = parseToolResult<{
      projectId: string;
      eventId: string | null;
      status: string;
      analyzed: { shouldDocument: boolean; featureName: string } | null;
      upserted: { featureId: string; manualEntries: Array<{ pageId: string }> } | null;
    }>(
      await trigger!({
        projectId: "proj_1",
        source: "github",
        eventType: "pr_merged",
        summary: "Merged billing export workflow",
        diffSummary: "Adds billing export route and invoice CSV action",
        filesChanged: ["src/routes/billing/settings.tsx", "src/components/InvoiceExport.tsx"],
        prUrl: "https://github.com/acme/app/pull/42",
        prTitle: "Add billing export workflow",
        prBody: "This PR closes #41 and documents the billing export workflow.",
        prNumber: 42,
        baseBranch: "main",
        headBranch: "feature/billing-export",
        issueReferences: ["#41"],
        testStatus: "passed",
      }),
    );

    expect(result.projectId).toBe("proj_1");
    expect(result.status).toBe("documented");
    expect(result.eventId).toBeTruthy();
    expect(result.analyzed?.shouldDocument).toBe(true);
    expect(result.upserted?.featureId).toBe("feature_1");

    const snapshot = await testContext.store.getEventSnapshot("proj_1", result.eventId as string);
    expect(snapshot?.source).toBe("github");
    expect(snapshot?.eventType).toBe("pr_merged");
    expect(snapshot?.prUrl).toBe("https://github.com/acme/app/pull/42");
    expect(snapshot?.summary).toContain("PR title: Add billing export workflow");
    expect(snapshot?.prBody).toContain("closes #41");
    expect(snapshot?.issueReferences).toEqual(["#41"]);

    expect(create).toHaveBeenCalled();
    expect(update).toHaveBeenCalled();
  }, 15000);
});
