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

    const content = JSON.parse(await readFile(filePath, "utf8")) as { schemaVersion?: number; encryptedState?: string };
    expect(content.schemaVersion).toBe(CURRENT_STATE_SCHEMA_VERSION);
    expect(typeof content.encryptedState).toBe("string");
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
      encryptedState?: string;
    };
    expect(persisted.schemaVersion).toBe(CURRENT_STATE_SCHEMA_VERSION);
    expect(typeof persisted.encryptedState).toBe("string");
  });

  it("persists runner last-seen release tags across store instances", async () => {
    const dir = await mkdtemp(join(tmpdir(), "auto-doc-state-release-tags-"));
    const filePath = join(dir, "state.json");
    const store = new StateStore(filePath);

    await store.setLastSeenReleaseTag("proj_1", "C:/repo", "v2.0.0");

    const reloaded = new StateStore(filePath);
    expect(await reloaded.getLastSeenReleaseTag("proj_1", "C:/repo")).toBe("v2.0.0");
    expect(await reloaded.getLastSeenReleaseTag("proj_1", "C:/other")).toBeNull();
  });

  it("persists release automation run records across store instances", async () => {
    const dir = await mkdtemp(join(tmpdir(), "auto-doc-state-release-ledger-"));
    const filePath = join(dir, "state.json");
    const store = new StateStore(filePath);

    await store.setReleaseAutomationRun({
      projectId: "proj_1",
      repoPath: "C:/repo",
      releaseTag: "v3.1.0",
      releaseVersion: "3.1.0",
      status: "failure",
      attemptedAt: "2026-05-26T00:00:00.000Z",
      errorMessage: "release pipeline failed",
    });

    const reloaded = new StateStore(filePath);
    expect(await reloaded.getReleaseAutomationRun("proj_1", "C:/repo", "v3.1.0")).toEqual(
      expect.objectContaining({
        projectId: "proj_1",
        repoPath: "C:/repo",
        releaseTag: "v3.1.0",
        status: "failure",
        errorMessage: "release pipeline failed",
      }),
    );
    expect(await reloaded.getReleaseAutomationRun("proj_1", "C:/repo", "v3.2.0")).toBeNull();
  });

  it("persists runner failure triage metadata across store instances", async () => {
    const dir = await mkdtemp(join(tmpdir(), "auto-doc-state-triage-metadata-"));
    const filePath = join(dir, "state.json");
    const store = new StateStore(filePath);

    await store.setRunnerFailureTriageMetadata("proj_1", "C:/repo", {
      acknowledgedAt: "2026-05-26T04:00:00.000Z",
      acknowledgedBy: "ops@example.com",
      note: "Known vendor outage",
      cooldownUntil: "2026-05-26T08:00:00.000Z",
    });

    const reloaded = new StateStore(filePath);
    expect(await reloaded.getRunnerFailureTriageMetadata("proj_1", "C:/repo")).toEqual({
      acknowledgedAt: "2026-05-26T04:00:00.000Z",
      acknowledgedBy: "ops@example.com",
      note: "Known vendor outage",
      cooldownUntil: "2026-05-26T08:00:00.000Z",
    });

    await reloaded.clearRunnerFailureTriageMetadata("proj_1", "C:/repo");
    expect(await reloaded.getRunnerFailureTriageMetadata("proj_1", "C:/repo")).toBeNull();

    const history = await reloaded.listRunnerFailureTriageHistory("proj_1", "C:/repo", 5);
    expect(history).toHaveLength(2);
    expect(history[0]?.action).toBe("clear");
    expect(history[1]).toEqual(
      expect.objectContaining({
        action: "set",
        metadata: {
          acknowledgedAt: "2026-05-26T04:00:00.000Z",
          acknowledgedBy: "ops@example.com",
          note: "Known vendor outage",
          cooldownUntil: "2026-05-26T08:00:00.000Z",
        },
      }),
    );
  });
});
