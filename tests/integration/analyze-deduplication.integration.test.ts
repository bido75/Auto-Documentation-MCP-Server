import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { StateStore } from "../../src/lib/state-store.js";
import type { AnalyzeDocumentationCandidateResult } from "../../src/types.js";

const testContext = vi.hoisted(() => {
  return {
    store: null as StateStore | null,
  };
});

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

async function withRetry<T>(operation: () => Promise<T>, attempts = 3): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 40 * attempt);
        });
      }
    }
  }

  throw lastError;
}

describe("analyze_documentation_candidate deduplication", () => {
  it("disambiguates same-route features when an existing route key already exists", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "auto-doc-analyze-dedupe-"));
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

    await testContext.store.setEventSnapshot("proj_1", "evt_1", {
      summary: "Added invoice export action to billing settings page",
      filesChanged: ["src/routes/billing/settings.tsx", "src/components/InvoiceExport.tsx"],
      eventType: "commit",
      source: "local_git",
      commitSha: "def456",
      testStatus: "passed",
    });

    const server = new FakeServer();
    const { registerAnalyzeDocumentationCandidateTool } = await import("../../src/tools/analyze-documentation-candidate.js");
    registerAnalyzeDocumentationCandidateTool(server as never);

    const analyze = server.handlers.get("analyze_documentation_candidate");
    expect(analyze).toBeDefined();

    const result = await withRetry(async () =>
      parseToolResult<AnalyzeDocumentationCandidateResult>(
        await analyze!({
          projectId: "proj_1",
          evidenceEventIds: ["evt_1"],
          existingFeatureKeys: ["route:billing-settings"],
        }),
      ),
    );

    expect(result.shouldDocument).toBe(true);
    expect(result.featureKey).toBe("route:billing-settings:invoice-export-action-to-billing-settings-page");
    expect(result.dedupeDecision).toBe("disambiguated_route_collision");
    expect(result.matchedExistingFeatureKey).toBe("route:billing-settings");
    expect(result.confidenceReasons.join(" ")).toContain("Route key collision detected");
  }, 15000);
});