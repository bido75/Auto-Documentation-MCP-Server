import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveStateStorePath, StateStore, type ProjectState } from "../../src/lib/state-store.js";

const TEST_STATE_KEY = "test-state-key-for-path-resolution";

function hashBytes(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

async function fileHash(path: string): Promise<string> {
  return hashBytes(await readFile(path));
}

function project(projectId = "381d217c-67b1-8119-9449-c5667bed9bf2"): ProjectState {
  return {
    projectId,
    projectName: "Autonomy Test",
    parentPageId: "36ed217c67b180b5b2d0c2a2ca5128f8",
    publishingMode: "Balanced",
    autoPublishThreshold: 90,
    databases: {
      projectsDatabaseId: "projects_db",
      featuresDatabaseId: "features_db",
      manualEntriesDatabaseId: "manual_entries_db",
      evidenceEventsDatabaseId: "evidence_db",
      releasesDatabaseId: "releases_db",
    },
    featuresByKey: { "runner:autonomy": "feature_page" },
    eventsByExternalId: { evt_1: "event_page" },
    eventSnapshots: {},
  };
}

describe("state-store path resolution and legacy migration", () => {
  const previousStateKey = process.env.STATE_ENCRYPTION_KEY;

  beforeEach(() => {
    process.env.STATE_ENCRYPTION_KEY = TEST_STATE_KEY;
  });

  afterEach(() => {
    if (previousStateKey === undefined) {
      delete process.env.STATE_ENCRYPTION_KEY;
    } else {
      process.env.STATE_ENCRYPTION_KEY = previousStateKey;
    }
  });

  it("resolves default state to the stable user-level .auto-doc-mcp directory instead of the cwd", () => {
    const cwd = resolve("C:/work/manual-creator");
    const home = resolve("C:/Users/vinny");

    const resolvedDefault = resolveStateStorePath({}, { cwd, homeDir: home });
    expect(resolvedDefault.explicitOverride).toBe(false);
    expect(resolvedDefault.filePath).toBe(resolve(home, ".auto-doc-mcp", "state.json"));
    expect(resolvedDefault.filePath.startsWith(resolve(cwd, ".auto-doc"))).toBe(false);

    const override = resolve(cwd, "isolated.state.json");
    const resolvedOverride = resolveStateStorePath({ AUTO_DOC_STATE_FILE: override }, { cwd, homeDir: home });
    expect(resolvedOverride.explicitOverride).toBe(true);
    expect(resolvedOverride.filePath).toBe(override);
  });

  it("copies the known legacy state into the canonical path once without touching the source bytes", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "auto-doc-state-cwd-"));
    const home = await mkdtemp(join(tmpdir(), "auto-doc-state-home-"));
    const legacyPath = join(cwd, "autonomy-test.state.json");
    const canonicalPath = join(home, ".auto-doc-mcp", "state.json");

    await new StateStore(legacyPath).upsertProject(project());
    const legacyHashBefore = await fileHash(legacyPath);

    const store = new StateStore(undefined, { cwd, homeDir: home });
    expect((await store.getProject("381d217c-67b1-8119-9449-c5667bed9bf2"))?.projectName).toBe("Autonomy Test");

    expect(await fileHash(legacyPath)).toBe(legacyHashBefore);
    expect(await fileHash(canonicalPath)).toBe(legacyHashBefore);

    const canonicalDir = join(home, ".auto-doc-mcp");
    const backupsAfterFirstLoad = (await readdir(canonicalDir)).filter((name) =>
      name.startsWith("state.migration-source."),
    );
    expect(backupsAfterFirstLoad).toHaveLength(1);

    const secondStore = new StateStore(undefined, { cwd, homeDir: home });
    expect((await secondStore.getProject("381d217c-67b1-8119-9449-c5667bed9bf2"))?.projectName).toBe("Autonomy Test");
    const backupsAfterSecondLoad = (await readdir(canonicalDir)).filter((name) =>
      name.startsWith("state.migration-source."),
    );
    expect(backupsAfterSecondLoad).toEqual(backupsAfterFirstLoad);
  });

  it("aborts a legacy migration anomaly without creating a canonical state file", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "auto-doc-state-cwd-"));
    const home = await mkdtemp(join(tmpdir(), "auto-doc-state-home-"));
    const legacyPath = join(cwd, "autonomy-test.state.json");
    const canonicalPath = join(home, ".auto-doc-mcp", "state.json");
    await writeFile(legacyPath, "{not-json", "utf8");

    const store = new StateStore(undefined, { cwd, homeDir: home });
    await expect(store.load()).rejects.toThrow(/PROJECT_STATE_MIGRATION_FAILED/);
    await expect(readFile(canonicalPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps explicit AUTO_DOC_STATE_FILE environments isolated from legacy auto-migration", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "auto-doc-state-cwd-"));
    const home = await mkdtemp(join(tmpdir(), "auto-doc-state-home-"));
    const legacyPath = join(cwd, "autonomy-test.state.json");
    const overridePath = join(home, "isolated", "state.json");

    await mkdir(join(home, "isolated"), { recursive: true });
    await new StateStore(legacyPath).upsertProject(project());

    const overrideStore = new StateStore(overridePath, { cwd, homeDir: home });
    expect(await overrideStore.getProject("381d217c-67b1-8119-9449-c5667bed9bf2")).toBeNull();
    await expect(readFile(overridePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});
