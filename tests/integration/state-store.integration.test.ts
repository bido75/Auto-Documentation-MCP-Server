import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CURRENT_STATE_SCHEMA_VERSION, StateStore } from "../../src/lib/state-store.js";

describe("StateStore", () => {
  it("persists feature and event IDs across store instances", async () => {
    const dir = await mkdtemp(join(tmpdir(), "auto-doc-persistence-"));
    const filePath = join(dir, "state.json");
    const store = new StateStore(filePath);

    await store.upsertProject({
      projectId: "proj_1",
      projectName: "Acme",
      parentPageId: "parent",
      publishingMode: "Balanced",
      autoPublishThreshold: 90,
      databases: {
        projectsDatabaseId: "db1",
        featuresDatabaseId: "db2",
        manualEntriesDatabaseId: "db3",
        evidenceEventsDatabaseId: "db4",
        releasesDatabaseId: "db5",
      },
      featuresByKey: {},
      eventsByExternalId: {},
      eventSnapshots: {},
    });

    await store.setFeature("proj_1", "billing:invoice-export", "feature_page_1");
    await store.setEvent("proj_1", "evt_123", "evidence_page_1");

    const reloaded = new StateStore(filePath);
    expect(await reloaded.getFeature("proj_1", "billing:invoice-export")).toBe("feature_page_1");
    expect(await reloaded.getEvent("proj_1", "evt_123")).toBe("evidence_page_1");
  });

  it("writes schemaVersion for newly saved state", async () => {
    const dir = await mkdtemp(join(tmpdir(), "auto-doc-state-version-"));
    const filePath = join(dir, "state.json");
    const store = new StateStore(filePath);

    await store.upsertProject({
      projectId: "proj_1",
      projectName: "Acme",
      parentPageId: "parent",
      publishingMode: "Balanced",
      autoPublishThreshold: 90,
      databases: {
        projectsDatabaseId: "db1",
        featuresDatabaseId: "db2",
        manualEntriesDatabaseId: "db3",
        evidenceEventsDatabaseId: "db4",
        releasesDatabaseId: "db5",
      },
      featuresByKey: {},
      eventsByExternalId: {},
      eventSnapshots: {},
    });

    const content = JSON.parse(await readFile(filePath, "utf8")) as {
      schemaVersion?: number;
      checksum?: string;
      encryptedState?: string;
      state?: unknown;
    };
    expect(content.schemaVersion).toBe(CURRENT_STATE_SCHEMA_VERSION);
    expect(typeof content.checksum).toBe("string");
    expect(typeof content.encryptedState).toBe("string");
    expect(content.state).toBeUndefined();
  });

  it("migrates legacy unversioned state and backfills eventSnapshots", async () => {
    const dir = await mkdtemp(join(tmpdir(), "auto-doc-state-migrate-"));
    const filePath = join(dir, "state.json");

    await writeFile(
      filePath,
      JSON.stringify(
        {
          projects: {
            proj_legacy: {
              projectId: "proj_legacy",
              projectName: "Legacy",
              parentPageId: "parent",
              publishingMode: "Balanced",
              autoPublishThreshold: 90,
              databases: {
                projectsDatabaseId: "db1",
                featuresDatabaseId: "db2",
                manualEntriesDatabaseId: "db3",
                evidenceEventsDatabaseId: "db4",
                releasesDatabaseId: "db5",
              },
              featuresByKey: {},
              eventsByExternalId: {},
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const store = new StateStore(filePath);
    const migrated = await store.load();
    expect(migrated.schemaVersion).toBe(CURRENT_STATE_SCHEMA_VERSION);
    expect(migrated.projects.proj_legacy?.eventSnapshots).toEqual({});

    const persisted = JSON.parse(await readFile(filePath, "utf8")) as {
      schemaVersion?: number;
      checksum?: string;
      encryptedState?: string;
    };
    expect(persisted.schemaVersion).toBe(CURRENT_STATE_SCHEMA_VERSION);
    expect(typeof persisted.checksum).toBe("string");
    expect(typeof persisted.encryptedState).toBe("string");
  });
});
