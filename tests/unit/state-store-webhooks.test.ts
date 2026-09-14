import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { StateStore, type ProjectState } from "../../src/lib/state-store.js";

function projectState(): ProjectState {
  return {
    projectId: "project_1",
    projectName: "Example",
    parentPageId: "parent_1",
    publishingMode: "Balanced",
    autoPublishThreshold: 85,
    projectPageId: "project_page_1",
    databases: {
      projectsDatabaseId: "projects_db",
      featuresDatabaseId: "features_db",
      manualEntriesDatabaseId: "entries_db",
      evidenceEventsDatabaseId: "events_db",
      releasesDatabaseId: "releases_db",
    },
    featuresByKey: {},
    eventsByExternalId: {},
    eventSnapshots: {},
  };
}

describe("state store webhook configs", () => {
  it("persists project-scoped webhook configs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "auto-doc-webhook-state-"));
    const store = new StateStore(join(dir, "state.json"));
    await store.upsertProject(projectState());

    await store.setWebhookConfig("project_1", {
      name: "ops",
      url: "https://hooks.example.com/ops/secret",
      platform: "generic",
      events: ["circuit_opened"],
      coverageDropThreshold: 70,
      createdAt: "2026-09-13T00:00:00.000Z",
      updatedAt: "2026-09-13T00:00:00.000Z",
    });

    await expect(store.getWebhookConfig("project_1", "ops")).resolves.toMatchObject({
      name: "ops",
      platform: "generic",
      events: ["circuit_opened"],
    });
    await expect(store.listWebhookConfigs("project_1")).resolves.toHaveLength(1);
  });
});
