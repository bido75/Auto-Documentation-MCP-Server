import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { StateStore } from "../../src/lib/state-store.js";
import type { AnalyzeDocumentationCandidateResult } from "../../src/types.js";

const providerContext = vi.hoisted(() => ({
  calls: 0,
  shouldFail: false,
}));

const testContext = vi.hoisted(() => ({
  store: null as StateStore | null,
}));

vi.mock("../../src/providers/factory.js", () => ({
  analyzeWithFallback: vi.fn(async () => {
    providerContext.calls += 1;
    if (providerContext.shouldFail) {
      throw new Error("simulated provider outage");
    }

    return {
      featureName: "Provider Billing Export",
      featureKey: "provider:billing-export",
      shouldDocument: true,
      audiences: ["User"],
      userGuide: {
        summary: "Users can export billing invoices from the billing settings page.",
        steps: ["Open billing settings", "Select export invoices", "Download the generated invoice"],
        expectedOutcome: "The invoice export downloads successfully.",
        possibleErrors: ["Verify billing permissions if the export button is hidden"],
      },
      adminGuide: {
        configRequired: ["No new configuration required"],
        endpointsAffected: [],
        envVarsRequired: [],
        verificationSteps: ["Confirm billing users can see the export action"],
        troubleshooting: [],
      },
      confidenceScore: 86,
      confidenceReasons: ["Provider generated billing workflow documentation."],
      reviewQuestions: [],
      providerUsed: "test-provider",
      generationMs: 1,
    };
  }),
  embedText: vi.fn(async () => [1, 0, 0]),
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

async function createStoreWithEvidence(projectId: string, eventId: string): Promise<StateStore> {
  const stateDir = await mkdtemp(join(tmpdir(), "auto-doc-analyze-provider-"));
  const store = new StateStore(join(stateDir, "state.json"));

  await store.upsertProject({
    projectId,
    projectName: "Acme",
    parentPageId: "parent_1",
    publishingMode: "Balanced",
    autoPublishThreshold: 90,
    projectPageId: `${projectId}_page`,
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

  await store.setEventSnapshot(projectId, eventId, {
    summary: "Added billing settings page with invoice export workflow",
    diffSummary: "Added /billing/settings export button",
    filesChanged: ["src/routes/billing/settings.tsx"],
    eventType: "commit",
    source: "local_git",
    testStatus: "passed",
    branch: "feature/billing-export",
  });

  return store;
}

async function registerAnalyzeTool() {
  const server = new FakeServer();
  const { registerAnalyzeDocumentationCandidateTool } = await import("../../src/tools/analyze-documentation-candidate.js");
  registerAnalyzeDocumentationCandidateTool(server as unknown as McpServer);
  const analyze = server.handlers.get("analyze_documentation_candidate");
  expect(analyze).toBeDefined();
  return analyze;
}

describe("analyze_documentation_candidate provider path", () => {
  beforeEach(() => {
    providerContext.calls = 0;
    providerContext.shouldFail = false;
    testContext.store = null;
  });

  it("uses the provider-backed analyzer when analyzing captured evidence", async () => {
    testContext.store = await createStoreWithEvidence("proj_provider", "evt_provider");
    const analyze = await registerAnalyzeTool();

    const result = parseToolResult<AnalyzeDocumentationCandidateResult>(
      await analyze!({
        projectId: "proj_provider",
        evidenceEventIds: ["evt_provider"],
      }),
    );

    expect(providerContext.calls).toBe(1);
    expect(result.shouldDocument).toBe(true);
    expect(result.featureName).toBe("Provider Billing Export");
    expect(result.confidenceReasons.join(" ")).toContain("Provider used: test-provider");
  });

  it("falls back to deterministic analysis when the provider path fails", async () => {
    providerContext.shouldFail = true;
    testContext.store = await createStoreWithEvidence("proj_fallback", "evt_fallback");
    const analyze = await registerAnalyzeTool();

    const result = parseToolResult<AnalyzeDocumentationCandidateResult>(
      await analyze!({
        projectId: "proj_fallback",
        evidenceEventIds: ["evt_fallback"],
      }),
    );

    expect(providerContext.calls).toBe(1);
    expect(result.shouldDocument).toBe(true);
    expect(result.fallbackReasonCode).toBe("none");
    expect(result.fallbackEntryId).toBeNull();
    expect(result.confidenceReasons.join(" ")).toContain("Provider used: deterministic");
  });
});
