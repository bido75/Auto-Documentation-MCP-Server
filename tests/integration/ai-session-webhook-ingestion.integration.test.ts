import { createHmac } from "node:crypto";
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

function createFakeNotion() {
  let pageCounter = 0;

  return {
    users: {
      me: vi.fn(async () => ({ object: "user" })),
    },
    databases: {
      retrieve: vi.fn(async () => ({ object: "database" })),
      query: vi.fn(async () => ({ results: [] })),
    },
    pages: {
      create: vi.fn(async () => {
        pageCounter += 1;
        return {
          id: `page_${pageCounter}`,
          url: `https://notion.local/page_${pageCounter}`,
        };
      }),
      update: vi.fn(async (input: { page_id: string }) => ({ id: input.page_id })),
    },
  };
}

describe("ai session webhook ingestion", () => {
  it("verifies ai session webhook signatures", async () => {
    const { verifyAiSessionWebhookSignature } = await import("../../src/http-bridge/server.js");

    const rawBody = Buffer.from(JSON.stringify({ summary: "session" }), "utf8");
    const secret = "ai_secret";
    const validHeader = `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;

    expect(
      verifyAiSessionWebhookSignature({
        rawBody,
        signatureHeader: validHeader,
        secret,
      }),
    ).toBe(true);

    expect(
      verifyAiSessionWebhookSignature({
        rawBody,
        signatureHeader: "sha256=bad",
        secret,
      }),
    ).toBe(false);
  }, 15000);

  it("ignores malformed ai session payloads", async () => {
    const { processAiSessionWebhookEvent } = await import("../../src/http-bridge/server.js");

    const result = await processAiSessionWebhookEvent({
      projectId: "proj_ignored",
      payload: {
        summary: "",
      },
      deliveryId: "ai_delivery_ignored",
    });

    expect(result.status).toBe("ignored");
  });

  it("processes session_completed payloads through capture, analyze, and upsert", async () => {
    const previousToken = process.env.NOTION_TOKEN;
    process.env.NOTION_TOKEN = "test_token";

    try {
      const stateDir = await mkdtemp(join(tmpdir(), "auto-doc-ai-webhook-"));
      testContext.store = new StateStore(join(stateDir, "state.json"));

      await testContext.store.upsertProject({
        projectId: "proj_ai_1",
        projectName: "Acme",
        parentPageId: "parent_1",
        publishingMode: "Balanced",
        autoPublishThreshold: 90,
        projectPageId: "project_page_ai_1",
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

      testContext.notion = createFakeNotion();

      const { processAiSessionWebhookEvent } = await import("../../src/http-bridge/server.js");
      const result = await processAiSessionWebhookEvent({
        projectId: "proj_ai_1",
        deliveryId: "ai_delivery_42",
        payload: {
          summary: "Completed session implementing billing settings workflow",
          sessionId: "sess_123",
          model: "gpt-5.3-codex",
          provider: "copilot",
          branch: "feature/billing-settings",
          diffSummary: "Added /billing/settings route and admin export behavior",
          filesChanged: ["src/routes/billing/settings.tsx", "src/components/BillingExport.tsx"],
          testStatus: "passed",
        },
      });

      expect(result.status).toBe("documented");
      expect(result.evidenceEventId).toBeTruthy();
      expect(result.featureId).toBeTruthy();
      expect((result.manualEntryCount ?? 0) > 0).toBe(true);

      const snapshot = await testContext.store.getEventSnapshot("proj_ai_1", result.evidenceEventId as string);
      expect(snapshot).not.toBeNull();
      expect(snapshot?.source).toBe("ai_session");
      expect(snapshot?.eventType).toBe("session_completed");
      expect(snapshot?.summary).toContain("sess_123");
      expect(snapshot?.summary).toContain("ai_delivery_42");
    } finally {
      if (previousToken === undefined) {
        delete process.env.NOTION_TOKEN;
      } else {
        process.env.NOTION_TOKEN = previousToken;
      }
    }
  }, 15000);
});