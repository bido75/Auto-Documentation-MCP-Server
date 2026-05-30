import { readFile, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { StateStore } from "../../src/lib/state-store";

function createSampleProject(projectId: string) {
  return {
    projectId,
    projectName: "Sample Project",
    parentPageId: "parent-page",
    publishingMode: "Balanced" as const,
    autoPublishThreshold: 90,
    databases: {
      projectsDatabaseId: "projects-db",
      featuresDatabaseId: "features-db",
      manualEntriesDatabaseId: "manual-db",
      evidenceEventsDatabaseId: "events-db",
      releasesDatabaseId: "releases-db",
    },
    featuresByKey: {},
    eventsByExternalId: {},
    eventSnapshots: {},
  };
}

describe("StateStore", () => {
  it("persists a checksum envelope when saving", async () => {
    const dir = await mkdtemp(join(tmpdir(), "auto-doc-state-"));
    const store = new StateStore(join(dir, "state.json"));

    await store.upsertProject(createSampleProject("proj_1"));

    const raw = await readFile(join(dir, "state.json"), "utf8");
    const parsed = JSON.parse(raw) as { checksum: string; encryptedState: string };

    expect(parsed.checksum).toHaveLength(64);
    expect(parsed.encryptedState.length).toBeGreaterThan(0);
  });

  it("rejects corrupted checksum envelopes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "auto-doc-state-"));
    const filePath = join(dir, "state.json");
    const store = new StateStore(filePath);

    await store.upsertProject(createSampleProject("proj_1"));

    const raw = JSON.parse(await readFile(filePath, "utf8")) as { checksum: string; encryptedState: string };
    raw.checksum = "broken";
    await writeFile(filePath, JSON.stringify(raw, null, 2), "utf8");

    await expect(store.load()).rejects.toThrow(/checksum mismatch/i);
  });

  it("preserves concurrent mutations from multiple store instances", async () => {
    const previousLockTimeout = process.env.AUTO_DOC_STATE_LOCK_TIMEOUT_MS;
    process.env.AUTO_DOC_STATE_LOCK_TIMEOUT_MS = "60000";

    const dir = await mkdtemp(join(tmpdir(), "auto-doc-state-concurrency-"));
    const filePath = join(dir, "state.json");

    const bootstrap = new StateStore(filePath);
    await bootstrap.upsertProject(createSampleProject("proj_1"));

    try {
      const stores = Array.from({ length: 8 }, () => new StateStore(filePath));
      await Promise.all(
        stores.map((store, index) =>
          store.setFeature("proj_1", `feature_${index}`, `page_${index}`),
        ),
      );

      const loaded = await bootstrap.load();
      const keys = Object.keys(loaded.projects.proj_1.featuresByKey);

      expect(keys).toHaveLength(8);
      for (let index = 0; index < 8; index += 1) {
        expect(loaded.projects.proj_1.featuresByKey[`feature_${index}`]).toBe(`page_${index}`);
      }
    } finally {
      if (previousLockTimeout === undefined) {
        delete process.env.AUTO_DOC_STATE_LOCK_TIMEOUT_MS;
      } else {
        process.env.AUTO_DOC_STATE_LOCK_TIMEOUT_MS = previousLockTimeout;
      }
    }
  }, 70_000);
});
