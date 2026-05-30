import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { McpToolError } from "../../src/lib/mcp-error.js";
import { StateStore } from "../../src/lib/state-store.js";
import { registerAnalyzeDocumentationCandidateTool } from "../../src/tools/analyze-documentation-candidate.js";
import { registerCaptureDevelopmentEventTool } from "../../src/tools/capture-development-event.js";
import { registerInitializeProjectManualTool } from "../../src/tools/initialize-project-manual.js";
import { registerPackageManualTool } from "../../src/tools/package-manual.js";
import { registerPublishOrQueueReviewTool } from "../../src/tools/publish-or-queue-review.js";
import { registerUpsertFeatureDocumentationTool } from "../../src/tools/upsert-feature-documentation.js";

const SNAPSHOT_PATH = join("tests", "contracts", "v1", "high-value-tool-contracts.snapshot.json");
const UPDATE_SNAPSHOTS = process.env.UPDATE_CONTRACT_SNAPSHOTS === "true";

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

type FakePage = {
  id: string;
  parent: { database_id: string };
  properties: Record<string, unknown>;
  children: unknown[];
};

function getTextValue(property: unknown): string {
  if (!property || typeof property !== "object") {
    return "";
  }

  const asRecord = property as Record<string, unknown>;

  if (Array.isArray(asRecord.rich_text)) {
    const first = asRecord.rich_text[0] as { text?: { content?: string } } | undefined;
    return first?.text?.content ?? "";
  }

  if (Array.isArray(asRecord.title)) {
    const first = asRecord.title[0] as { text?: { content?: string } } | undefined;
    return first?.text?.content ?? "";
  }

  return "";
}

function getStatusValue(property: unknown): string {
  if (!property || typeof property !== "object") {
    return "";
  }

  const asRecord = property as Record<string, unknown>;
  const status = asRecord.status as { name?: string } | undefined;
  return status?.name ?? "";
}

function getRelationIds(property: unknown): string[] {
  if (!property || typeof property !== "object") {
    return [];
  }

  const asRecord = property as Record<string, unknown>;
  const relation = asRecord.relation;
  if (!Array.isArray(relation)) {
    return [];
  }

  return relation
    .map((item) => {
      if (!item || typeof item !== "object") {
        return "";
      }
      const rel = item as { id?: string };
      return rel.id ?? "";
    })
    .filter((id) => id.length > 0);
}

function createFakeNotion(parentPageId = "parent_page") {
  let idCounter = 0;
  const databases = new Map<string, { id: string; title: string }>();
  const pages = new Map<string, FakePage>();

  const nextId = (prefix: string) => {
    idCounter += 1;
    return `${prefix}_${idCounter}`;
  };

  const matchesClause = (page: FakePage, clause: Record<string, unknown>) => {
    const propertyName = clause.property;
    if (typeof propertyName !== "string") {
      return false;
    }

    const candidate = page.properties[propertyName];

    if (typeof clause.relation === "object" && clause.relation !== null) {
      const relation = clause.relation as { contains?: string };
      if (relation.contains) {
        return getRelationIds(candidate).includes(relation.contains);
      }
    }

    if (typeof clause.rich_text === "object" && clause.rich_text !== null) {
      const richText = clause.rich_text as { equals?: string };
      if (richText.equals !== undefined) {
        return getTextValue(candidate) === richText.equals;
      }
    }

    if (typeof clause.title === "object" && clause.title !== null) {
      const title = clause.title as { equals?: string };
      if (title.equals !== undefined) {
        return getTextValue(candidate) === title.equals;
      }
    }

    if (typeof clause.status === "object" && clause.status !== null) {
      const status = clause.status as { equals?: string };
      if (status.equals !== undefined) {
        return getStatusValue(candidate) === status.equals;
      }
    }

    return false;
  };

  return {
    users: {
      me: vi.fn(async () => ({ object: "user" })),
    },
    blocks: {
      retrieve: vi.fn(async (input: { block_id: string }) => {
        if (input.block_id === parentPageId || pages.has(input.block_id)) {
          return { id: input.block_id };
        }

        throw { status: 404, message: "Not found" };
      }),
      children: {
        list: vi.fn(async (input: { block_id: string }) => {
          const page = pages.get(input.block_id);
          return {
            results: page?.children ?? [],
          };
        }),
      },
    },
    databases: {
      create: vi.fn(async (input: { title?: Array<{ text?: { content?: string } }> }) => {
        const id = nextId("db");
        const title = input.title?.[0]?.text?.content ?? "";
        databases.set(id, { id, title });
        return { id, url: `https://notion.local/${id}` };
      }),
      update: vi.fn(async () => ({})),
      retrieve: vi.fn(async (input: { database_id: string }) => {
        if (!databases.has(input.database_id)) {
          throw { status: 404, message: "Database not found" };
        }

        return { id: input.database_id };
      }),
      query: vi.fn(async (input: { database_id: string; filter?: Record<string, unknown>; page_size?: number }) => {
        const matches: FakePage[] = [];
        for (const page of pages.values()) {
          if (page.parent.database_id !== input.database_id) {
            continue;
          }

          if (!input.filter) {
            matches.push(page);
            continue;
          }

          if (Array.isArray(input.filter.and)) {
            const clauses = input.filter.and as Array<Record<string, unknown>>;
            if (clauses.every((clause) => matchesClause(page, clause))) {
              matches.push(page);
            }
            continue;
          }

          if (matchesClause(page, input.filter)) {
            matches.push(page);
          }
        }

        return {
          results: matches.slice(0, input.page_size ?? matches.length).map((page) => ({ id: page.id, properties: page.properties })),
        };
      }),
    },
    pages: {
      create: vi.fn(async (input: { parent: { database_id: string }; properties: Record<string, unknown>; children?: unknown[] }) => {
        const id = nextId("page");
        const page: FakePage = {
          id,
          parent: input.parent,
          properties: { ...input.properties },
          children: input.children ?? [],
        };
        pages.set(id, page);
        return { id, url: `https://notion.local/${id}` };
      }),
      update: vi.fn(async (input: { page_id: string; properties: Record<string, unknown> }) => {
        const page = pages.get(input.page_id);
        if (!page) {
          throw new Error(`Missing page ${input.page_id}`);
        }

        page.properties = {
          ...page.properties,
          ...input.properties,
        };

        return { id: page.id };
      }),
    },
  };
}

class FakeServer {
  handlers = new Map<string, (input: unknown) => Promise<{ content: Array<{ type: string; text: string }> }>>();

  tool(
    name: string,
    _description: string,
    _schema: unknown,
    handler: (input: unknown) => Promise<{ content: Array<{ type: string; text: string }> }>,
  ) {
    this.handlers.set(name, handler);
  }
}

function parseToolResult<T>(value: { content: Array<{ type: string; text: string }> }): T {
  return JSON.parse(value.content[0].text) as T;
}

type JsonSchemaShape =
  | { type: "string" | "number" | "boolean" | "null" | "unknown" }
  | { type: "array"; items: JsonSchemaShape }
  | { type: "object"; required: string[]; properties: Record<string, JsonSchemaShape> };

function toSchemaShape(value: unknown): JsonSchemaShape {
  if (value === null) {
    return { type: "null" };
  }

  if (Array.isArray(value)) {
    if (value.length === 0) {
      return {
        type: "array",
        items: { type: "unknown" },
      };
    }

    const first = value[0];
    return {
      type: "array",
      items: toSchemaShape(first),
    };
  }

  if (typeof value === "string") {
    return { type: "string" };
  }

  if (typeof value === "number") {
    return { type: "number" };
  }

  if (typeof value === "boolean") {
    return { type: "boolean" };
  }

  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    const properties: Record<string, JsonSchemaShape> = {};

    for (const key of keys) {
      properties[key] = toSchemaShape(record[key]);
    }

    return {
      type: "object",
      required: keys,
      properties,
    };
  }

  return { type: "string" };
}

describe("versioned contract snapshots", () => {
  it("matches v1 schema snapshot for high-value tool outputs", async () => {
    const previousNotionToken = process.env.NOTION_TOKEN;
    process.env.NOTION_TOKEN = "test_token";

    try {
      const stateDir = await mkdtemp(join(tmpdir(), "auto-doc-contract-snapshot-v1-"));
      testContext.store = new StateStore(join(stateDir, "state.json"));
      testContext.notion = createFakeNotion("parent_page");

      const server = new FakeServer();
      registerInitializeProjectManualTool(server as never);
      registerCaptureDevelopmentEventTool(server as never);
      registerAnalyzeDocumentationCandidateTool(server as never);
      registerUpsertFeatureDocumentationTool(server as never);
      registerPublishOrQueueReviewTool(server as never);
      registerPackageManualTool(server as never);

      const initialize = server.handlers.get("initialize_project_manual");
      const capture = server.handlers.get("capture_development_event");
      const analyze = server.handlers.get("analyze_documentation_candidate");
      const upsert = server.handlers.get("upsert_feature_documentation");
      const publish = server.handlers.get("publish_or_queue_review");
      const pack = server.handlers.get("package_manual");

      expect(initialize).toBeDefined();
      expect(capture).toBeDefined();
      expect(analyze).toBeDefined();
      expect(upsert).toBeDefined();
      expect(publish).toBeDefined();
      expect(pack).toBeDefined();

      const initialized = parseToolResult<Record<string, unknown>>(
        await initialize!({
          projectName: "Acme Contract Snapshot",
          parentPageId: "parent_page",
          publishingMode: "balanced",
          autoPublishThreshold: 90,
        }),
      );

      const captured = parseToolResult<Record<string, unknown>>(
        await capture!({
          projectId: initialized.projectId,
          source: "local_git",
          eventType: "commit",
          summary: "Added billing settings page and export workflow",
          branch: "feature/billing-export",
          filesChanged: "src/routes/billing/settings.tsx",
          diffSummary: "Added user-facing billing workflow",
          testStatus: "passed",
        }),
      );

      const analyzed = parseToolResult<Record<string, unknown>>(
        await analyze!({
          projectId: initialized.projectId,
          evidenceEventIds: [captured.evidenceEventId],
        }),
      );

      const upserted = parseToolResult<Record<string, unknown>>(
        await upsert!({
          projectId: initialized.projectId,
          featureKey: analyzed.featureKey,
          featureName: analyzed.featureName,
          audiences: ["User", "Admin"],
          manualEntries: [
            {
              entryType: "User Guide",
              title: "Use Billing Export",
              userGuide: "Open Billing settings and click Export invoices.",
              adminGuide: "Configure billing permissions before export.",
              routes: ["/billing/settings"],
              apiEndpoints: ["/api/billing/export"],
            },
          ],
          evidenceEventIds: [captured.evidenceEventId],
          confidenceScore: 95,
          confidenceReasons: analyzed.confidenceReasons,
          publishingMode: "balanced",
          autoPublishThreshold: 90,
          sourceCommit: "abc123",
          filesChanged: ["src/routes/billing/settings.tsx"],
        }),
      );

      const manualEntryIds = (upserted.manualEntries as Array<{ pageId: string }>).map((entry) => entry.pageId);

      const published = parseToolResult<Record<string, unknown>>(
        await publish!({
          projectId: initialized.projectId,
          featureId: upserted.featureId,
          manualEntryIds,
          confidenceScore: 95,
          publishingMode: "balanced",
          autoPublishThreshold: 90,
        }),
      );

      const packaged = parseToolResult<Record<string, unknown>>(
        await pack!({
          projectId: initialized.projectId,
          releaseVersion: "1.0.0",
          audience: "both",
          format: "markdown",
          manualEntryIds,
        }),
      );

      let publishErrorEnvelope: Record<string, unknown>;
      try {
        await publish!({
          projectId: initialized.projectId,
          featureId: upserted.featureId,
          manualEntryIds,
          confidenceScore: Symbol("invalid_number"),
          publishingMode: "balanced",
          autoPublishThreshold: 90,
        });
        throw new Error("Expected publish_or_queue_review to throw McpToolError");
      } catch (error) {
        expect(error).toBeInstanceOf(McpToolError);
        publishErrorEnvelope = JSON.parse((error as Error).message) as Record<string, unknown>;
      }

      const snapshotPayload = {
        schemaVersion: 1,
        generatedBy: "contract-snapshot-v1.integration.test.ts",
        tools: {
          initialize_project_manual: toSchemaShape(initialized),
          analyze_documentation_candidate: toSchemaShape(analyzed),
          upsert_feature_documentation: toSchemaShape(upserted),
          publish_or_queue_review: toSchemaShape(published),
          package_manual: toSchemaShape(packaged),
          publish_or_queue_review_error_envelope: toSchemaShape(publishErrorEnvelope),
        },
      };

      if (UPDATE_SNAPSHOTS) {
        await mkdir(dirname(SNAPSHOT_PATH), { recursive: true });
        await writeFile(SNAPSHOT_PATH, `${JSON.stringify(snapshotPayload, null, 2)}\n`, "utf-8");
      }

      const existing = JSON.parse(await readFile(SNAPSHOT_PATH, "utf-8")) as Record<string, unknown>;
      expect(existing).toEqual(snapshotPayload);
    } finally {
      if (previousNotionToken === undefined) {
        delete process.env.NOTION_TOKEN;
      } else {
        process.env.NOTION_TOKEN = previousNotionToken;
      }
    }
  }, 30_000);
});
