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

function createFakeNotion() {
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

  const api = {
    databases: {
      create: vi.fn(async (input: { title?: Array<{ text?: { content?: string } }> }) => {
        const id = nextId("db");
        const title = input.title?.[0]?.text?.content ?? "";
        databases.set(id, { id, title });
        return { id, url: `https://notion.local/${id}` };
      }),
      update: vi.fn(async () => ({})),
      query: vi.fn(
        async (input: {
          database_id: string;
          filter?: Record<string, unknown>;
          page_size?: number;
        }) => {
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
        },
      ),
    },
    pages: {
      create: vi.fn(
        async (input: {
          parent: { database_id: string };
          properties: Record<string, unknown>;
          children?: unknown[];
        }) => {
          const id = nextId("page");
          const page: FakePage = {
            id,
            parent: input.parent,
            properties: { ...input.properties },
            children: input.children ?? [],
          };
          pages.set(id, page);
          return { id, url: `https://notion.local/${id}` };
        },
      ),
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
    blocks: {
      children: {
        list: vi.fn(async (input: { block_id: string }) => {
          const page = pages.get(input.block_id);
          return {
            results: page?.children ?? [],
          };
        }),
      },
    },
    _pages: pages,
    _databases: databases,
  };

  return api;
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

describe("full mocked pipeline", () => {
  it("runs initialize->capture->analyze->upsert->package and preserves relation consistency", async () => {
    const previousNotionToken = process.env.NOTION_TOKEN;
    process.env.NOTION_TOKEN = "test_token";

    try {
      const stateDir = await mkdtemp(join(tmpdir(), "auto-doc-full-pipeline-"));
      testContext.store = new StateStore(join(stateDir, "state.json"));
      testContext.notion = createFakeNotion();

      const server = new FakeServer();

      const { registerInitializeProjectManualTool } = await import("../../src/tools/initialize-project-manual.js");
      const { registerCaptureDevelopmentEventTool } = await import("../../src/tools/capture-development-event.js");
      const { registerAnalyzeDocumentationCandidateTool } = await import("../../src/tools/analyze-documentation-candidate.js");
      const { registerUpsertFeatureDocumentationTool } = await import("../../src/tools/upsert-feature-documentation.js");
      const { registerPackageManualTool } = await import("../../src/tools/package-manual.js");

      registerInitializeProjectManualTool(server as never);
      registerCaptureDevelopmentEventTool(server as never);
      registerAnalyzeDocumentationCandidateTool(server as never);
      registerUpsertFeatureDocumentationTool(server as never);
      registerPackageManualTool(server as never);

      const initialize = server.handlers.get("initialize_project_manual");
      const capture = server.handlers.get("capture_development_event");
      const analyze = server.handlers.get("analyze_documentation_candidate");
      const upsert = server.handlers.get("upsert_feature_documentation");
      const pack = server.handlers.get("package_manual");

      expect(initialize).toBeDefined();
      expect(capture).toBeDefined();
      expect(analyze).toBeDefined();
      expect(upsert).toBeDefined();
      expect(pack).toBeDefined();

      const initialized = parseToolResult<{
        projectId: string;
        projectsDatabaseId: string;
        featuresDatabaseId: string;
        manualEntriesDatabaseId: string;
        evidenceEventsDatabaseId: string;
        releasesDatabaseId: string;
      }>(
        await initialize!({
          projectName: "Acme App",
          parentPageId: "parent_page",
          repositoryUrl: "https://github.com/acme/acme-app",
          publishingMode: "balanced",
          autoPublishThreshold: 90,
        }),
      );

      const captured = parseToolResult<{ evidenceEventId: string; evidencePageId: string; initialClassification: string }>(
        await capture!({
          projectId: initialized.projectId,
          source: "local_git",
          eventType: "commit",
          summary: "Added billing settings page with invoice export",
          commitSha: "abc123",
          branch: "feature/billing-export",
          filesChanged: "src/routes/billing/settings.tsx,src/components/InvoiceExport.tsx",
          diffSummary: "Added UI route and export workflow",
          testStatus: "passed",
        }),
      );

      expect(captured.initialClassification).toBe("true");

      const analyzed = parseToolResult<{
        shouldDocument: boolean;
        featureKey: string;
        featureName: string;
        confidenceScore: number;
      }>(
        await analyze!({
          projectId: initialized.projectId,
          evidenceEventIds: [captured.evidenceEventId],
          existingFeatureKeys: [],
        }),
      );

      expect(analyzed.shouldDocument).toBe(true);

      const upserted = parseToolResult<{
        featureId: string;
        manualEntries: Array<{ pageId: string }>;
      }>(
        await upsert!({
          projectId: initialized.projectId,
          featureKey: analyzed.featureKey,
          featureName: analyzed.featureName,
          module: "Billing",
          audiences: ["User", "Admin"],
          manualEntries: [
            {
              entryType: "User Guide",
              title: "Export invoices from Billing settings",
              userGuide:
                "Go to Billing Settings, click Export, choose a date range, and download the CSV. Errors appear for insufficient permissions.",
              adminGuide: "",
            },
          ],
          evidenceEventIds: [captured.evidenceEventId],
          confidenceScore: analyzed.confidenceScore,
          confidenceReasons: ["user-facing page"],
          publishingMode: "balanced",
          autoPublishThreshold: 60,
          sourceCommit: "abc123",
          filesChanged: ["src/routes/billing/settings.tsx"],
        }),
      );

      const packaged = parseToolResult<{ releasePageId: string }>(
        await pack!({
          projectId: initialized.projectId,
          releaseVersion: "1.0.0",
          audience: "both",
          format: "markdown",
        }),
      );

      const projectPage = testContext.notion._pages.get(initialized.projectId) as FakePage;
      const evidencePage = testContext.notion._pages.get(captured.evidencePageId) as FakePage;
      const featurePage = testContext.notion._pages.get(upserted.featureId) as FakePage;
      const manualPage = testContext.notion._pages.get(upserted.manualEntries[0].pageId) as FakePage;
      const releasePage = testContext.notion._pages.get(packaged.releasePageId) as FakePage;

      expect(projectPage).toBeTruthy();

      expect(evidencePage.properties.Project).toEqual({ relation: [{ id: initialized.projectId }] });

      expect(featurePage.properties.Project).toEqual({ relation: [{ id: initialized.projectId }] });
      expect(featurePage.properties["Evidence Events"]).toEqual({ relation: [{ id: captured.evidencePageId }] });

      expect(manualPage.properties.Project).toEqual({ relation: [{ id: initialized.projectId }] });
      expect(manualPage.properties.Feature).toEqual({ relation: [{ id: upserted.featureId }] });
      expect(manualPage.properties.Release).toEqual({ relation: [{ id: packaged.releasePageId }] });

      expect(releasePage.properties.Project).toEqual({ relation: [{ id: initialized.projectId }] });
      expect(releasePage.properties["Included Features"]).toEqual({ relation: [{ id: upserted.featureId }] });
    } finally {
      if (previousNotionToken === undefined) {
        delete process.env.NOTION_TOKEN;
      } else {
        process.env.NOTION_TOKEN = previousNotionToken;
      }
    }
  });
});
