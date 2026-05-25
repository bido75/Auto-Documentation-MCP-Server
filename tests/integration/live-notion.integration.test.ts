import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpToolError } from "../../src/lib/mcp-error.js";
import { StateStore } from "../../src/lib/state-store.js";
import { registerCaptureDevelopmentEventTool } from "../../src/tools/capture-development-event.js";
import { registerInitializeProjectManualTool } from "../../src/tools/initialize-project-manual.js";
import { registerPackageManualTool } from "../../src/tools/package-manual.js";
import { registerPublishOrQueueReviewTool } from "../../src/tools/publish-or-queue-review.js";
import { registerUpsertFeatureDocumentationTool } from "../../src/tools/upsert-feature-documentation.js";

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

const runLive = process.env.RUN_LIVE_NOTION_TESTS === "true";
const describeLive = runLive ? describe : describe.skip;

describeLive("live notion integration", () => {
  it("runs initialize -> capture -> upsert -> package smoke flow against real Notion", async () => {
    const parentPageId = process.env.NOTION_PARENT_PAGE_ID;
    if (!parentPageId) {
      throw new Error("Missing NOTION_PARENT_PAGE_ID for live Notion integration tests.");
    }

    const stateDir = await mkdtemp(join(tmpdir(), "auto-doc-live-notion-"));
    process.env.AUTO_DOC_STATE_FILE = join(stateDir, "state.json");

    const store = new StateStore(process.env.AUTO_DOC_STATE_FILE);
    await store.load();

    const uniqueName = `Live Test ${new Date().toISOString().replace(/[:.]/g, "-")}`;
    const releaseVersion = `0.0.${Date.now()}`;

    const server = new FakeServer();
    registerInitializeProjectManualTool(server as unknown as McpServer);
    registerCaptureDevelopmentEventTool(server as unknown as McpServer);
    registerUpsertFeatureDocumentationTool(server as unknown as McpServer);
    registerPackageManualTool(server as unknown as McpServer);
    registerPublishOrQueueReviewTool(server as unknown as McpServer);

    const initialize = server.handlers.get("initialize_project_manual");
    const capture = server.handlers.get("capture_development_event");
    const upsert = server.handlers.get("upsert_feature_documentation");
    const pack = server.handlers.get("package_manual");
    const publish = server.handlers.get("publish_or_queue_review");

    expect(initialize).toBeDefined();
    expect(capture).toBeDefined();
    expect(upsert).toBeDefined();
    expect(pack).toBeDefined();
    expect(publish).toBeDefined();

    const initialized = parseToolResult<{
      projectId: string;
      projectsDatabaseId: string;
      featuresDatabaseId: string;
      manualEntriesDatabaseId: string;
      evidenceEventsDatabaseId: string;
      releasesDatabaseId: string;
      traceId: string;
    }>(
      await initialize!({
        projectName: uniqueName,
        parentPageId,
        publishingMode: "balanced",
        autoPublishThreshold: 90,
      }),
    );

    const captured = parseToolResult<{
      evidenceEventId: string;
      evidencePageId: string;
      initialClassification: string;
      traceId: string;
    }>(
      await capture!({
        projectId: initialized.projectId,
        source: "local_git",
        eventType: "commit",
        summary: "Added account security settings page with MFA setup flow",
        branch: "feature/live-notion-smoke",
        filesChanged: "src/routes/settings/security.tsx,src/components/MfaSetup.tsx",
        diffSummary: "New account security flow and UI",
        testStatus: "passed",
      }),
    );

    expect(captured.evidenceEventId).toBeTruthy();
    expect(captured.evidencePageId).toBeTruthy();

    const upserted = parseToolResult<{
      featureId: string;
      manualEntries: string[];
      traceId: string;
    }>(
      await upsert!({
        projectId: initialized.projectId,
        featureKey: "route:account-security-settings",
        featureName: "Account Security Settings",
        audiences: ["User"],
        manualEntries: [
          {
            entryType: "User Guide",
            title: "Set Up Multi-Factor Authentication",
            userGuide: "Open Account Settings, go to Security, enable MFA, and verify with your authenticator app.",
            adminGuide: "N/A",
            routes: ["/settings/security"],
          },
        ],
        evidenceEventIds: [captured.evidenceEventId],
        confidenceScore: 95,
        confidenceReasons: ["Live smoke test with user-facing flow"],
        publishingMode: "balanced",
        autoPublishThreshold: 90,
      }),
    );

    expect(upserted.featureId).toBeTruthy();
    expect(upserted.manualEntries.length).toBeGreaterThan(0);

    const packaged = parseToolResult<{
      releasePageId: string;
      includedEntryCount: number;
      output: string;
      traceId: string;
    }>(
      await pack!({
        projectId: initialized.projectId,
        releaseVersion,
        audience: "both",
        format: "markdown",
      }),
    );

    expect(packaged.releasePageId).toBeTruthy();
    expect(packaged.includedEntryCount).toBeGreaterThan(0);
    expect(packaged.output).toContain("Manual");

    const publishResult = parseToolResult<{
      traceId: string;
      finalStatus: string;
      publishingDecision: string;
    }>(
      await publish!({
        projectId: initialized.projectId,
        featureId: upserted.featureId,
        manualEntryIds: upserted.manualEntries,
        confidenceScore: 95,
        publishingMode: "balanced",
        autoPublishThreshold: 90,
      }),
    );

    expect(publishResult.traceId).toBeTruthy();
    expect(publishResult.finalStatus).toBe("Published");
    expect(publishResult.publishingDecision).toBe("Agent Published");

    try {
      await publish!({
        projectId: initialized.projectId,
        featureId: upserted.featureId,
        manualEntryIds: upserted.manualEntries,
        confidenceScore: Symbol("invalid-number"),
        publishingMode: "balanced",
        autoPublishThreshold: 90,
      });
      throw new Error("Expected publish_or_queue_review to throw McpToolError");
    } catch (error) {
      expect(error).toBeInstanceOf(McpToolError);
      const envelope = JSON.parse((error as Error).message) as {
        error?: { code?: string; traceId?: string; tool?: string; message?: string };
      };
      expect(envelope.error?.code).toBe("PUBLISH_POLICY_FAILED");
      expect(envelope.error?.traceId).toBeTruthy();
      expect(envelope.error?.tool).toBe("publish_or_queue_review");
      expect(envelope.error?.message).toBeTruthy();
    }
  });
});
