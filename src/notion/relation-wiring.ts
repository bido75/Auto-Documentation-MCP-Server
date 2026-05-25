import type { Client } from "@notionhq/client";
import type { ProjectDatabases } from "../lib/state-store.js";
import { withNotionRetry } from "../lib/notion-retry.js";

const asProps = (value: Record<string, unknown>) => value as never;

export async function wireProjectRelations(notion: Client, db: ProjectDatabases): Promise<void> {
  const featuresUpdatePayload = {
      database_id: db.featuresDatabaseId,
      properties: asProps({
        Project: {
          relation: {
            database_id: db.projectsDatabaseId,
            single_property: {},
          },
        },
        "Evidence Events": {
          relation: {
            database_id: db.evidenceEventsDatabaseId,
            dual_property: {},
          },
        },
        Release: {
          relation: {
            database_id: db.releasesDatabaseId,
            single_property: {},
          },
        },
      }),
    };

  await withNotionRetry(() => notion.databases.update(featuresUpdatePayload), {
    operationName: "databases.update",
    payload: featuresUpdatePayload,
  });

  const manualEntriesUpdatePayload = {
      database_id: db.manualEntriesDatabaseId,
      properties: asProps({
        Project: {
          relation: {
            database_id: db.projectsDatabaseId,
            single_property: {},
          },
        },
        Feature: {
          relation: {
            database_id: db.featuresDatabaseId,
            dual_property: {},
          },
        },
        Release: {
          relation: {
            database_id: db.releasesDatabaseId,
            dual_property: {},
          },
        },
      }),
    };

  await withNotionRetry(() => notion.databases.update(manualEntriesUpdatePayload), {
    operationName: "databases.update",
    payload: manualEntriesUpdatePayload,
  });

  const evidenceUpdatePayload = {
      database_id: db.evidenceEventsDatabaseId,
      properties: asProps({
        Project: {
          relation: {
            database_id: db.projectsDatabaseId,
            single_property: {},
          },
        },
        Feature: {
          relation: {
            database_id: db.featuresDatabaseId,
            single_property: {},
          },
        },
      }),
    };

  await withNotionRetry(() => notion.databases.update(evidenceUpdatePayload), {
    operationName: "databases.update",
    payload: evidenceUpdatePayload,
  });

  const releasesUpdatePayload = {
      database_id: db.releasesDatabaseId,
      properties: asProps({
        Project: {
          relation: {
            database_id: db.projectsDatabaseId,
            single_property: {},
          },
        },
        "Included Features": {
          relation: {
            database_id: db.featuresDatabaseId,
            dual_property: {},
          },
        },
      }),
    };

  await withNotionRetry(() => notion.databases.update(releasesUpdatePayload), {
    operationName: "databases.update",
    payload: releasesUpdatePayload,
  });
}
