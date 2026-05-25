import type { Client } from "@notionhq/client";
import { withNotionRetry } from "../lib/notion-retry.js";
import type { ProjectDatabases, StateStore } from "../lib/state-store.js";
import {
  evidenceEventsDatabaseSchema,
  featuresDatabaseSchema,
  manualEntriesDatabaseSchema,
  projectDatabaseSchema,
  releasesDatabaseSchema,
} from "../lib/notion-schema.js";
import { wireProjectRelations } from "./relation-wiring.js";

export async function initializeProjectManual(input: {
  notion: Client;
  store: StateStore;
  projectName: string;
  parentPageId: string;
  repositoryUrl?: string;
  publishingMode: "Conservative" | "Balanced" | "Fully Automatic";
  autoPublishThreshold: number;
}) {
  const schema = (properties: Record<string, unknown>) => properties as never;
  const notionUrl = (value: unknown): string | undefined => {
    if (value && typeof value === "object" && "url" in value) {
      const maybeUrl = (value as { url?: unknown }).url;
      return typeof maybeUrl === "string" ? maybeUrl : undefined;
    }

    return undefined;
  };

  const projectsPayload = {
    parent: { page_id: input.parentPageId },
    title: [{ type: "text", text: { content: `${input.projectName} - Documentation Projects` } }],
    properties: schema(projectDatabaseSchema()),
  };

  const projects = await withNotionRetry(() => input.notion.databases.create(projectsPayload as never), {
    operationName: "databases.create",
    payload: projectsPayload,
  });

  const manualEntriesPayload = {
    parent: { page_id: input.parentPageId },
    title: [{ type: "text", text: { content: `${input.projectName} - Manual Entries` } }],
    properties: schema(manualEntriesDatabaseSchema()),
  };

  const manualEntries = await withNotionRetry(() => input.notion.databases.create(manualEntriesPayload as never), {
    operationName: "databases.create",
    payload: manualEntriesPayload,
  });

  const featuresPayload = {
    parent: { page_id: input.parentPageId },
    title: [{ type: "text", text: { content: `${input.projectName} - Features` } }],
    properties: schema(featuresDatabaseSchema()),
  };

  const features = await withNotionRetry(() => input.notion.databases.create(featuresPayload as never), {
    operationName: "databases.create",
    payload: featuresPayload,
  });

  const evidenceEventsPayload = {
    parent: { page_id: input.parentPageId },
    title: [{ type: "text", text: { content: `${input.projectName} - Evidence Events` } }],
    properties: schema(evidenceEventsDatabaseSchema()),
  };

  const evidenceEvents = await withNotionRetry(() => input.notion.databases.create(evidenceEventsPayload as never), {
    operationName: "databases.create",
    payload: evidenceEventsPayload,
  });

  const releasesPayload = {
    parent: { page_id: input.parentPageId },
    title: [{ type: "text", text: { content: `${input.projectName} - Releases` } }],
    properties: schema(releasesDatabaseSchema()),
  };

  const releases = await withNotionRetry(() => input.notion.databases.create(releasesPayload as never), {
    operationName: "databases.create",
    payload: releasesPayload,
  });

  const db: ProjectDatabases = {
    projectsDatabaseId: projects.id,
    featuresDatabaseId: features.id,
    manualEntriesDatabaseId: manualEntries.id,
    evidenceEventsDatabaseId: evidenceEvents.id,
    releasesDatabaseId: releases.id,
  };

  await wireProjectRelations(input.notion, db);

  const projectPagePayload = {
      parent: { database_id: projects.id },
      properties: {
        "Project Name": { title: [{ text: { content: input.projectName } }] },
        ...(input.repositoryUrl ? { "Repository URL": { url: input.repositoryUrl } } : {}),
        "Publishing Mode": { select: { name: input.publishingMode } },
        "Auto Publish Threshold": { number: input.autoPublishThreshold },
        "Documentation Health": { status: { name: "Healthy" } },
      },
    };

  const projectPage = await withNotionRetry(() => input.notion.pages.create(projectPagePayload), {
    operationName: "pages.create",
    payload: projectPagePayload,
  });

  const projectId = projectPage.id;
  await input.store.upsertProject({
    projectId,
    projectName: input.projectName,
    parentPageId: input.parentPageId,
    repositoryUrl: input.repositoryUrl,
    publishingMode: input.publishingMode,
    autoPublishThreshold: input.autoPublishThreshold,
    projectPageId: projectPage.id,
    databases: db,
    featuresByKey: {},
    eventsByExternalId: {},
    eventSnapshots: {},
  });

  return {
    projectId,
    projectsDatabaseId: db.projectsDatabaseId,
    featuresDatabaseId: db.featuresDatabaseId,
    manualEntriesDatabaseId: db.manualEntriesDatabaseId,
    evidenceEventsDatabaseId: db.evidenceEventsDatabaseId,
    releasesDatabaseId: db.releasesDatabaseId,
    projectsUrl: notionUrl(projects),
    featuresUrl: notionUrl(features),
    manualEntriesUrl: notionUrl(manualEntries),
    evidenceEventsUrl: notionUrl(evidenceEvents),
    releasesUrl: notionUrl(releases),
  };
}
