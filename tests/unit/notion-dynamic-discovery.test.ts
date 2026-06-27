import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  discoverProjectFromNotion,
  selfInitializeProjectFromNotion,
  type NotionDiscoveryClient,
} from "../../src/notion/discovery.js";
import { StateStore, type ProjectState } from "../../src/lib/state-store.js";

const projectId = "381d217c-67b1-8119-9449-c5667bed9bf2";
const parentPageId = "36ed217c67b180b5b2d0c2a2ca5128f8";
const db = {
  projectsDatabaseId: "381d217c-67b1-8147-93b3-dc3ca1a38bb8",
  featuresDatabaseId: "381d217c-67b1-813c-88b7-da5eaae90afa",
  manualEntriesDatabaseId: "381d217c-67b1-8140-82c9-e8c0b37077ef",
  evidenceEventsDatabaseId: "381d217c-67b1-81b4-834a-dadf838fdf2b",
  releasesDatabaseId: "381d217c-67b1-8162-86f6-c4a59e1a3184",
};

type FakeDatabase = { id: string; title: Array<{ plain_text: string }>; parent: { type: "page_id"; page_id: string }; properties: Record<string, unknown> };

function prop(type: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: type, type, [type]: extra };
}

function relation(databaseId: string): Record<string, unknown> {
  return prop("relation", { database_id: databaseId });
}

function projectSchema() {
  return {
    "Project Name": prop("title"),
    "Repository URL": prop("url"),
    "Publishing Mode": prop("select"),
    "Auto Publish Threshold": prop("number"),
    "Manual Home": prop("url"),
    "Current Release": prop("rich_text"),
    "Documentation Health": prop("status"),
  };
}

function featureSchema() {
  return {
    "Feature Name": prop("title"),
    "Feature Key": prop("rich_text"),
    Module: prop("select"),
    "Audience Impact": prop("multi_select"),
    Status: prop("status"),
    "First Seen Commit": prop("rich_text"),
    "Last Documented Commit": prop("rich_text"),
    "Release Introduced": prop("rich_text"),
    "Confidence Score": prop("number"),
    Project: relation(db.projectsDatabaseId),
    "Evidence Events": relation(db.evidenceEventsDatabaseId),
    Release: relation(db.releasesDatabaseId),
  };
}

function manualSchema() {
  return {
    "Entry Title": prop("title"),
    "Entry Type": prop("select"),
    Audience: prop("select"),
    Status: prop("status"),
    "Confidence Score": prop("number"),
    "Publishing Decision": prop("select"),
    "Source Commit": prop("rich_text"),
    "Source PR": prop("url"),
    "Files Changed": prop("rich_text"),
    "Routes / URLs": prop("rich_text"),
    "API Endpoints": prop("rich_text"),
    "Date Captured": prop("date"),
    "Date Published": prop("date"),
    "Reviewer Notes": prop("rich_text"),
    Project: relation(db.projectsDatabaseId),
    Feature: relation(db.featuresDatabaseId),
    Release: relation(db.releasesDatabaseId),
  };
}

function evidenceSchema() {
  return {
    "Event Title": prop("title"),
    Source: prop("select"),
    "Event Type": prop("select"),
    "Commit SHA": prop("rich_text"),
    Branch: prop("rich_text"),
    "PR URL": prop("url"),
    "Release Version": prop("rich_text"),
    "Files Changed": prop("rich_text"),
    "Diff Summary": prop("rich_text"),
    "Test Status": prop("select"),
    "Captured At": prop("date"),
    Project: relation(db.projectsDatabaseId),
    Feature: relation(db.featuresDatabaseId),
  };
}

function releaseSchema() {
  return {
    "Release Version": prop("title"),
    Status: prop("status"),
    "Release Date": prop("date"),
    "Manual URL": prop("url"),
    "User Entries Count": prop("number"),
    "Admin Entries Count": prop("number"),
    Project: relation(db.projectsDatabaseId),
    "Included Features": relation(db.featuresDatabaseId),
  };
}

function database(id: string, title: string, properties: Record<string, unknown>): FakeDatabase {
  return {
    id,
    title: [{ plain_text: title }],
    parent: { type: "page_id", page_id: parentPageId },
    properties,
  };
}

function projectPage() {
  return {
    id: projectId,
    parent: { type: "database_id", database_id: db.projectsDatabaseId },
    properties: {
      "Project Name": { type: "title", title: [{ plain_text: "Autonomy Test" }] },
      "Repository URL": { type: "url", url: "https://github.com/bido75/Auto-Documentation-MCP-Server" },
      "Publishing Mode": { type: "select", select: { name: "Balanced" } },
      "Auto Publish Threshold": { type: "number", number: 90 },
    },
  };
}

function completeDatabases(overrides: Partial<Record<keyof typeof db, FakeDatabase>> = {}): FakeDatabase[] {
  return [
    overrides.projectsDatabaseId ?? database(db.projectsDatabaseId, "Autonomy Test - Documentation Projects", projectSchema()),
    overrides.featuresDatabaseId ?? database(db.featuresDatabaseId, "Autonomy Test - Features", featureSchema()),
    overrides.manualEntriesDatabaseId ?? database(db.manualEntriesDatabaseId, "Autonomy Test - Manual Entries", manualSchema()),
    overrides.evidenceEventsDatabaseId ?? database(db.evidenceEventsDatabaseId, "Autonomy Test - Evidence Events", evidenceSchema()),
    overrides.releasesDatabaseId ?? database(db.releasesDatabaseId, "Autonomy Test - Releases", releaseSchema()),
  ];
}

function fakeNotion(databases: FakeDatabase[], options: { denyDatabaseId?: string } = {}): NotionDiscoveryClient {
  const byId = new Map(databases.map((item) => [item.id, item]));
  return {
    pages: {
      retrieve: async ({ page_id }) => {
        if (page_id !== projectId) throw Object.assign(new Error("not found"), { code: "object_not_found", status: 404 });
        return projectPage();
      },
    },
    databases: {
      retrieve: async ({ database_id }) => {
        if (database_id === options.denyDatabaseId) throw Object.assign(new Error("restricted"), { code: "restricted_resource", status: 403 });
        const found = byId.get(database_id);
        if (!found) throw Object.assign(new Error("not found"), { code: "object_not_found", status: 404 });
        return found;
      },
      query: async ({ database_id }) => {
        if (database_id !== db.projectsDatabaseId) throw new Error("unexpected query");
        return { results: [projectPage()] };
      },
    },
    blocks: {
      children: {
        list: async ({ block_id }) => {
          if (block_id !== parentPageId) throw new Error("unexpected parent page");
          return {
            results: databases.map((item) => ({ id: item.id, type: "child_database", child_database: { title: item.title[0]?.plain_text ?? "" } })),
          };
        },
      },
    },
  };
}

function existingProject(): ProjectState {
  return {
    projectId,
    projectName: "Existing",
    parentPageId,
    publishingMode: "Conservative",
    autoPublishThreshold: 10,
    projectPageId: projectId,
    databases: {
      projectsDatabaseId: "existing_projects",
      featuresDatabaseId: "existing_features",
      manualEntriesDatabaseId: "existing_manual",
      evidenceEventsDatabaseId: "existing_events",
      releasesDatabaseId: "existing_releases",
    },
    featuresByKey: { preserved: "feature_page" },
    eventsByExternalId: {},
    eventSnapshots: {},
  };
}

async function scratchStore(): Promise<StateStore> {
  const dir = await mkdtemp(join(tmpdir(), "auto-doc-discovery-state-"));
  return new StateStore(join(dir, "state.json"));
}

describe("Notion dynamic project discovery", () => {
  it("discovers a complete unambiguous schema-valid project binding from the project page", async () => {
    const result = await discoverProjectFromNotion({
      notion: fakeNotion(completeDatabases()),
      projectPageId: projectId,
    });

    expect(result.project).toMatchObject({
      projectId,
      projectName: "Autonomy Test",
      parentPageId,
      repositoryUrl: "https://github.com/bido75/Auto-Documentation-MCP-Server",
      publishingMode: "Balanced",
      autoPublishThreshold: 90,
      projectPageId: projectId,
      databases: db,
    });
  });

  it("refuses and alerts when a required database is missing without writing state", async () => {
    const store = await scratchStore();
    const healthDir = await mkdtemp(join(tmpdir(), "auto-doc-discovery-health-"));
    const env = { AUTO_DOC_HEALTH_FILE: join(healthDir, "health.json"), AUTO_DOC_ALERT_FEED_FILE: join(healthDir, "alerts.jsonl") } as NodeJS.ProcessEnv;

    const result = await selfInitializeProjectFromNotion({
      notion: fakeNotion(completeDatabases().filter((item) => item.id !== db.releasesDatabaseId)),
      store,
      projectPageId: projectId,
      traceId: "missing-db",
      env,
    });

    expect(result.ok).toBe(false);
    expect(result.reasonCode).toBe("missing_database");
    expect(await store.getProject(projectId)).toBeNull();
    const feed = await readFile(env.AUTO_DOC_ALERT_FEED_FILE!, "utf8");
    expect(feed).toContain("project_discovery_failed");
    expect(feed).toContain("missing_database");
  });

  it("refuses ambiguous candidates instead of picking one", async () => {
    const duplicateFeatures = database("duplicate_features", "Autonomy Test - Features Copy", featureSchema());
    const result = await discoverProjectFromNotion({
      notion: fakeNotion([...completeDatabases(), duplicateFeatures]),
      projectPageId: projectId,
    });

    expect(result.ok).toBe(false);
    expect(result.reasonCode).toBe("ambiguous_database");
  });

  it("refuses schema mismatch or broken relation graphs", async () => {
    const brokenManual = database(db.manualEntriesDatabaseId, "Autonomy Test - Manual Entries", {
      ...manualSchema(),
      Feature: relation("wrong_features_database"),
    });

    const result = await discoverProjectFromNotion({
      notion: fakeNotion(completeDatabases({ manualEntriesDatabaseId: brokenManual })),
      projectPageId: projectId,
    });

    expect(result.ok).toBe(false);
    expect(result.reasonCode).toBe("broken_relation");
  });

  it("refuses access-denied database retrieval with a connect-the-integration message", async () => {
    const result = await discoverProjectFromNotion({
      notion: fakeNotion(completeDatabases(), { denyDatabaseId: db.evidenceEventsDatabaseId }),
      projectPageId: projectId,
    });

    expect(result.ok).toBe(false);
    expect(result.reasonCode).toBe("access_denied");
    expect(result.message).toContain("Connect the Notion integration");
  });

  it("does not overwrite an existing valid local project binding", async () => {
    const store = await scratchStore();
    await store.upsertProject(existingProject());

    const result = await selfInitializeProjectFromNotion({
      notion: fakeNotion(completeDatabases()),
      store,
      projectPageId: projectId,
      traceId: "existing-wins",
    });

    expect(result.ok).toBe(true);
    expect(result.status).toBe("existing_state_preserved");
    expect((await store.getProject(projectId))?.databases.projectsDatabaseId).toBe("existing_projects");
  });
});
