import { describe, expect, it } from "vitest";
import {
  NotionPreflightError,
  assertNotionTokenPresent,
  runInitializePreflight,
  runProjectPreflight,
} from "../../src/lib/notion-preflight.js";

describe("notion preflight", () => {
  it("throws NOTION_TOKEN_MISSING when token is not configured", () => {
    expect(() => assertNotionTokenPresent(undefined)).toThrow(NotionPreflightError);
    try {
      assertNotionTokenPresent(undefined);
    } catch (error) {
      const preflight = error as NotionPreflightError;
      expect(preflight.code).toBe("NOTION_TOKEN_MISSING");
    }
  });

  it("maps authentication failure to NOTION_TOKEN_INVALID", async () => {
    const notion = {
      users: {
        me: async () => {
          throw { status: 401, code: "unauthorized", message: "Unauthorized" };
        },
      },
    };

    await expect(runInitializePreflight({ notion: notion as never, parentPageId: "parent" })).rejects.toMatchObject({
      code: "NOTION_TOKEN_INVALID",
    });
  });

  it("maps inaccessible parent page to NOTION_PARENT_PAGE_FORBIDDEN", async () => {
    const notion = {
      users: { me: async () => ({}) },
      blocks: {
        retrieve: async () => {
          throw { status: 403, message: "Forbidden" };
        },
      },
    };

    await expect(runInitializePreflight({ notion: notion as never, parentPageId: "parent" })).rejects.toMatchObject({
      code: "NOTION_PARENT_PAGE_FORBIDDEN",
    });
  });

  it("maps inaccessible project database to NOTION_DATABASE_FORBIDDEN", async () => {
    const notion = {
      users: { me: async () => ({}) },
      databases: {
        retrieve: async () => {
          throw { status: 403, message: "Forbidden" };
        },
      },
    };

    await expect(
      runProjectPreflight({
        notion: notion as never,
        project: {
          projectId: "proj_1",
          projectName: "Acme",
          parentPageId: "parent",
          publishingMode: "Balanced",
          autoPublishThreshold: 90,
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
        },
      }),
    ).rejects.toMatchObject({
      code: "NOTION_DATABASE_FORBIDDEN",
    });
  });
});
