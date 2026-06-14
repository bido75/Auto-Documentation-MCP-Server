import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { StateStore } from "../../src/lib/state-store.js";

describe("StateStore concurrency", () => {
  it("preserves parallel feature, event, and snapshot mutations without temp-file collisions", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "auto-doc-state-concurrency-"));
    const statePath = join(stateDir, "state.json");
    const store = new StateStore(statePath);
    const count = 25;

    await store.upsertProject({
      projectId: "project_1",
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

    await Promise.all(
      Array.from({ length: count }, async (_, index) => {
        const eventId = `evt_${index}`;
        await Promise.all([
          store.setFeature("project_1", `feature:${index}`, `feature_page_${index}`),
          store.setEvent("project_1", eventId, `event_page_${index}`),
          store.setEventSnapshot("project_1", eventId, {
            summary: `Added workflow ${index}`,
            filesChanged: [`src/routes/workflow-${index}.tsx`],
            eventType: "commit",
            source: "local_git",
            testStatus: "passed",
          }),
        ]);
      }),
    );

    const project = await store.getProject("project_1");
    expect(project).not.toBeNull();
    expect(Object.keys(project?.featuresByKey ?? {})).toHaveLength(count);
    expect(Object.keys(project?.eventsByExternalId ?? {})).toHaveLength(count);
    expect(Object.keys(project?.eventSnapshots ?? {})).toHaveLength(count);

    for (let index = 0; index < count; index += 1) {
      expect(project?.featuresByKey[`feature:${index}`]).toBe(`feature_page_${index}`);
      expect(project?.eventsByExternalId[`evt_${index}`]).toBe(`event_page_${index}`);
      expect(project?.eventSnapshots[`evt_${index}`]?.summary).toBe(`Added workflow ${index}`);
    }

    const leftovers = await readdir(stateDir);
    expect(leftovers.filter((name) => name.includes(".tmp"))).toEqual([]);
  }, 20_000);
});
