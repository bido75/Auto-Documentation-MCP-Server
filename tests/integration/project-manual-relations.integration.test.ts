import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { StateStore } from "../../src/lib/state-store.js";
import { initializeProjectManual } from "../../src/notion/project-manual.js";

describe("initializeProjectManual", () => {
  it("creates databases, wires relations, and persists project state", async () => {
    const create = vi
      .fn()
      .mockResolvedValueOnce({ id: "db_projects", url: "https://notion/projects" })
      .mockResolvedValueOnce({ id: "db_manual", url: "https://notion/manual" })
      .mockResolvedValueOnce({ id: "db_features", url: "https://notion/features" })
      .mockResolvedValueOnce({ id: "db_evidence", url: "https://notion/evidence" })
      .mockResolvedValueOnce({ id: "db_releases", url: "https://notion/releases" });

    const update = vi.fn().mockResolvedValue({});
    const createPage = vi.fn().mockResolvedValue({ id: "project_page_1", url: "https://notion/project-page" });

    const notion = {
      databases: {
        create,
        update,
      },
      pages: {
        create: createPage,
      },
    };

    const dir = await mkdtemp(join(tmpdir(), "auto-doc-state-"));
    const store = new StateStore(join(dir, "state.json"));

    const result = await initializeProjectManual({
      notion: notion as never,
      store,
      projectName: "Acme",
      parentPageId: "parent_1",
      repositoryUrl: "https://github.com/acme/repo",
      publishingMode: "Balanced",
      autoPublishThreshold: 90,
    });

    expect(create).toHaveBeenCalledTimes(5);
    expect(update).toHaveBeenCalledTimes(4);
    expect(result.projectId).toBe("project_page_1");

    const updatePayloads = update.mock.calls.map((call) => call[0]);
    expect(updatePayloads.some((payload) => payload.database_id === "db_features")).toBe(true);
    expect(updatePayloads.some((payload) => payload.database_id === "db_manual")).toBe(true);
    expect(updatePayloads.some((payload) => payload.database_id === "db_evidence")).toBe(true);
    expect(updatePayloads.some((payload) => payload.database_id === "db_releases")).toBe(true);

    const featuresUpdate = updatePayloads.find((payload) => payload.database_id === "db_features");
    const manualUpdate = updatePayloads.find((payload) => payload.database_id === "db_manual");
    const evidenceUpdate = updatePayloads.find((payload) => payload.database_id === "db_evidence");
    const releasesUpdate = updatePayloads.find((payload) => payload.database_id === "db_releases");

    expect(featuresUpdate?.properties).toMatchObject({
      Project: { relation: { database_id: "db_projects" } },
      "Evidence Events": { relation: { database_id: "db_evidence" } },
      Release: { relation: { database_id: "db_releases" } },
    });

    expect(manualUpdate?.properties).toMatchObject({
      Project: { relation: { database_id: "db_projects" } },
      Feature: { relation: { database_id: "db_features" } },
      Release: { relation: { database_id: "db_releases" } },
    });

    expect(evidenceUpdate?.properties).toMatchObject({
      Project: { relation: { database_id: "db_projects" } },
      Feature: { relation: { database_id: "db_features" } },
    });

    expect(releasesUpdate?.properties).toMatchObject({
      Project: { relation: { database_id: "db_projects" } },
      "Included Features": { relation: { database_id: "db_features" } },
    });

    const saved = await store.getProject("project_page_1");
    expect(saved?.databases.featuresDatabaseId).toBe("db_features");
    expect(saved?.projectName).toBe("Acme");
  });
});
