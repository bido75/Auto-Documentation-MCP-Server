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

describe("github webhook ingestion", () => {
  it("verifies github webhook signatures", async () => {
    const { verifyGitHubWebhookSignature } = await import("../../src/http-bridge/server.js");

    const rawBody = Buffer.from(JSON.stringify({ ping: true }), "utf8");
    const secret = "webhook_secret";
    const validHeader = `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;

    expect(
      verifyGitHubWebhookSignature({
        rawBody,
        signatureHeader: validHeader,
        secret,
      }),
    ).toBe(true);

    expect(
      verifyGitHubWebhookSignature({
        rawBody,
        signatureHeader: "sha256=bad",
        secret,
      }),
    ).toBe(false);
  }, 15000);

  it("ignores unsupported webhook actions without failing", async () => {
    const { processGitHubWebhookEvent } = await import("../../src/http-bridge/server.js");

    const result = await processGitHubWebhookEvent({
      projectId: "proj_ignored",
      eventName: "pull_request",
      payload: {
        action: "closed",
        pull_request: {
          merged: false,
        },
      },
      deliveryId: "delivery_ignored",
    });

    expect(result.status).toBe("ignored");
  });

  it("processes pull request opened events through capture, analyze, and upsert", async () => {
    const previousToken = process.env.NOTION_TOKEN;
    process.env.NOTION_TOKEN = "test_token";

    try {
      const stateDir = await mkdtemp(join(tmpdir(), "auto-doc-github-webhook-"));
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

      testContext.notion = createFakeNotion();

      const { processGitHubWebhookEvent } = await import("../../src/http-bridge/server.js");
      const result = await processGitHubWebhookEvent({
        projectId: "proj_1",
        eventName: "pull_request",
        deliveryId: "delivery_42",
        payload: {
          action: "opened",
          number: 42,
          pull_request: {
            merged: false,
            title: "Add billing settings page workflow",
            body: "Adds /billing/settings route and export endpoint behavior for admins.",
            html_url: "https://github.com/acme/app/pull/42",
            head: {
              sha: "abc123def456",
              ref: "feature/billing-settings",
            },
            base: {
              ref: "main",
            },
          },
        },
      });

      expect(result.status).toBe("documented");
      expect(result.evidenceEventId).toBeTruthy();
      expect(result.featureId).toBeTruthy();
      expect((result.manualEntryCount ?? 0) > 0).toBe(true);

      const snapshot = await testContext.store.getEventSnapshot("proj_1", result.evidenceEventId as string);
      expect(snapshot).not.toBeNull();
      expect(snapshot?.source).toBe("github");
      expect(snapshot?.eventType).toBe("pr_opened");
      expect(snapshot?.prNumber).toBe(42);
      expect(snapshot?.summary).toContain("delivery_42");
    } finally {
      if (previousToken === undefined) {
        delete process.env.NOTION_TOKEN;
      } else {
        process.env.NOTION_TOKEN = previousToken;
      }
    }
  }, 15000);
});
