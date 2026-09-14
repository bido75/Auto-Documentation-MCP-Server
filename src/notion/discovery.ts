import { emitRunnerHealthAlert } from "../lib/runner-health.js";
import type { ProjectDatabases, ProjectState, StateStore } from "../lib/state-store.js";
import { withNotionRetry } from "../lib/notion-retry.js";

type DatabaseRole =
  | "projectsDatabaseId"
  | "featuresDatabaseId"
  | "manualEntriesDatabaseId"
  | "evidenceEventsDatabaseId"
  | "releasesDatabaseId";

export type DiscoveryReasonCode =
  | "access_denied"
  | "ambiguous_database"
  | "broken_relation"
  | "missing_database"
  | "schema_mismatch";

export interface NotionDiscoveryClient {
  pages: {
    retrieve(input: { page_id: string }): Promise<unknown>;
  };
  databases: {
    retrieve(input: { database_id: string }): Promise<unknown>;
    query(input: { database_id: string; filter?: unknown; page_size?: number }): Promise<unknown>;
  };
  blocks: {
    children: {
      list(input: { block_id: string; page_size?: number; start_cursor?: string }): Promise<unknown>;
    };
  };
}

export type DiscoverySuccess = {
  ok: true;
  project: ProjectState;
  discoveredDatabaseIds: ProjectDatabases;
};

export type DiscoveryRefusal = {
  ok: false;
  reasonCode: DiscoveryReasonCode;
  message: string;
  details: Record<string, unknown>;
};

export type DiscoveryResult = DiscoverySuccess | DiscoveryRefusal;

export type SelfInitializeResult =
  | (DiscoverySuccess & { status: "initialized_from_notion" })
  | {
      ok: true;
      status: "existing_state_preserved";
      project: ProjectState;
      discoveredDatabaseIds: ProjectDatabases;
    }
  | DiscoveryRefusal;

const ROLE_LABELS: Record<DatabaseRole, string> = {
  projectsDatabaseId: "projects",
  featuresDatabaseId: "features",
  manualEntriesDatabaseId: "manual entries",
  evidenceEventsDatabaseId: "evidence events",
  releasesDatabaseId: "releases",
};

const REQUIRED_PROPERTIES: Record<DatabaseRole, Record<string, string>> = {
  projectsDatabaseId: {
    "Project Name": "title",
    "Repository URL": "url",
    "Publishing Mode": "select",
    "Auto Publish Threshold": "number",
    "Documentation Health": "status",
  },
  featuresDatabaseId: {
    "Feature Name": "title",
    "Feature Key": "rich_text",
    Module: "select",
    "Audience Impact": "multi_select",
    Status: "status",
    "Confidence Score": "number",
  },
  manualEntriesDatabaseId: {
    "Entry Title": "title",
    Audience: "select",
    Status: "status",
    "Publishing Decision": "select",
    "Date Captured": "date",
  },
  evidenceEventsDatabaseId: {
    "Event Title": "title",
    Source: "select",
    "Event Type": "select",
    "Commit SHA": "rich_text",
    "Captured At": "date",
  },
  releasesDatabaseId: {
    "Release Version": "title",
    Status: "status",
    "Release Date": "date",
    "Manual URL": "url",
    "User Entries Count": "number",
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function notionId(value: unknown): string {
  return readString(value)?.replaceAll("-", "") ?? "";
}

function idsEqual(left: unknown, right: unknown): boolean {
  return notionId(left) === notionId(right);
}

function refusal(reasonCode: DiscoveryReasonCode, message: string, details: Record<string, unknown>): DiscoveryRefusal {
  return { ok: false, reasonCode, message, details };
}

function errorStatus(error: unknown): number | null {
  if (!isRecord(error)) {
    return null;
  }
  const status = error.status;
  return typeof status === "number" ? status : null;
}

function accessDenied(error: unknown): boolean {
  const status = errorStatus(error);
  if (status === 403 || status === 404) {
    return true;
  }
  if (!isRecord(error)) {
    return false;
  }
  return error.code === "object_not_found" || error.code === "restricted_resource";
}

async function retrievePage(notion: NotionDiscoveryClient, projectPageId: string): Promise<unknown | DiscoveryRefusal> {
  try {
    return await withNotionRetry(() => notion.pages.retrieve({ page_id: projectPageId }), {
      operationName: "pages.retrieve",
      payload: { page_id: projectPageId },
    });
  } catch (error) {
    if (accessDenied(error)) {
      return refusal(
        "access_denied",
        "Connect the Notion integration to the project page before running discovery.",
        { projectPageId },
      );
    }
    throw error;
  }
}

async function retrieveDatabase(
  notion: NotionDiscoveryClient,
  databaseId: string,
  label: string,
): Promise<unknown | DiscoveryRefusal> {
  try {
    return await withNotionRetry(() => notion.databases.retrieve({ database_id: databaseId }), {
      operationName: "databases.retrieve",
      payload: { database_id: databaseId },
    });
  } catch (error) {
    if (accessDenied(error)) {
      return refusal(
        "access_denied",
        `Connect the Notion integration to the ${label} database before running discovery.`,
        { databaseId, label },
      );
    }
    throw error;
  }
}

async function listChildDatabaseIds(notion: NotionDiscoveryClient, parentPageId: string): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | undefined;

  do {
    const payload = await withNotionRetry(() => notion.blocks.children.list({ block_id: parentPageId, page_size: 100, start_cursor: cursor }), {
      operationName: "blocks.children.list",
      payload: { block_id: parentPageId },
    });
    if (!isRecord(payload)) {
      break;
    }
    const results = Array.isArray(payload.results) ? payload.results : [];
    for (const block of results) {
      if (isRecord(block) && block.type === "child_database") {
        const id = readString(block.id);
        if (id) {
          ids.push(id);
        }
      }
    }
    cursor = payload.has_more === true ? readString(payload.next_cursor) ?? undefined : undefined;
  } while (cursor);

  return [...new Set(ids)];
}

function databaseProperties(database: unknown): Record<string, unknown> | null {
  if (!isRecord(database) || !isRecord(database.properties)) {
    return null;
  }
  return database.properties;
}

function parentPageId(database: unknown): string | null {
  if (!isRecord(database) || !isRecord(database.parent)) {
    return null;
  }
  return database.parent.type === "page_id" ? readString(database.parent.page_id) : null;
}

function parentDatabaseId(page: unknown): string | null {
  if (!isRecord(page) || !isRecord(page.parent)) {
    return null;
  }
  return page.parent.type === "database_id" ? readString(page.parent.database_id) : null;
}

function propertyType(property: unknown): string | null {
  if (!isRecord(property)) {
    return null;
  }
  return readString(property.type);
}

function relationTarget(property: unknown): string | null {
  if (!isRecord(property) || property.type !== "relation" || !isRecord(property.relation)) {
    return null;
  }
  return readString(property.relation.database_id);
}

function hasRequiredProperties(database: unknown, role: DatabaseRole): boolean {
  const properties = databaseProperties(database);
  if (!properties) {
    return false;
  }

  return Object.entries(REQUIRED_PROPERTIES[role]).every(([name, expectedType]) => propertyType(properties[name]) === expectedType);
}

function classifyDatabase(database: unknown): DatabaseRole[] {
  const roles: DatabaseRole[] = [];
  for (const role of Object.keys(REQUIRED_PROPERTIES) as DatabaseRole[]) {
    if (hasRequiredProperties(database, role)) {
      roles.push(role);
    }
  }
  return roles;
}

function pageTitle(page: unknown): string {
  if (!isRecord(page) || !isRecord(page.properties)) {
    return "Discovered Project";
  }
  const property = page.properties["Project Name"];
  if (!isRecord(property) || !Array.isArray(property.title)) {
    return "Discovered Project";
  }
  return property.title.map((part) => (isRecord(part) ? readString(part.plain_text) ?? "" : "")).join("").trim() || "Discovered Project";
}

function pageUrl(page: unknown): string | undefined {
  if (!isRecord(page) || !isRecord(page.properties)) {
    return undefined;
  }
  const property = page.properties["Repository URL"];
  if (!isRecord(property)) {
    return undefined;
  }
  return readString(property.url) ?? undefined;
}

function pagePublishingMode(page: unknown): ProjectState["publishingMode"] {
  if (!isRecord(page) || !isRecord(page.properties)) {
    return "Balanced";
  }
  const property = page.properties["Publishing Mode"];
  if (!isRecord(property) || !isRecord(property.select)) {
    return "Balanced";
  }
  const name = readString(property.select.name);
  return name === "Conservative" || name === "Fully Automatic" ? name : "Balanced";
}

function pageThreshold(page: unknown): number {
  if (!isRecord(page) || !isRecord(page.properties)) {
    return 90;
  }
  const property = page.properties["Auto Publish Threshold"];
  if (!isRecord(property) || typeof property.number !== "number") {
    return 90;
  }
  return property.number;
}

function validateRelations(databases: ProjectDatabases, byRole: Record<DatabaseRole, unknown>): DiscoveryRefusal | null {
  const checks: Array<{ role: DatabaseRole; property: string; expected: string }> = [
    { role: "featuresDatabaseId", property: "Project", expected: databases.projectsDatabaseId },
    { role: "featuresDatabaseId", property: "Evidence Events", expected: databases.evidenceEventsDatabaseId },
    { role: "featuresDatabaseId", property: "Release", expected: databases.releasesDatabaseId },
    { role: "manualEntriesDatabaseId", property: "Project", expected: databases.projectsDatabaseId },
    { role: "manualEntriesDatabaseId", property: "Feature", expected: databases.featuresDatabaseId },
    { role: "manualEntriesDatabaseId", property: "Release", expected: databases.releasesDatabaseId },
    { role: "evidenceEventsDatabaseId", property: "Project", expected: databases.projectsDatabaseId },
    { role: "evidenceEventsDatabaseId", property: "Feature", expected: databases.featuresDatabaseId },
    { role: "releasesDatabaseId", property: "Project", expected: databases.projectsDatabaseId },
    { role: "releasesDatabaseId", property: "Included Features", expected: databases.featuresDatabaseId },
  ];

  for (const check of checks) {
    const properties = databaseProperties(byRole[check.role]);
    const actual = properties ? relationTarget(properties[check.property]) : null;
    if (!actual || !idsEqual(actual, check.expected)) {
      return refusal(
        "broken_relation",
        `Discovered ${ROLE_LABELS[check.role]} database relation '${check.property}' does not point at the expected Auto-Doc database.`,
        { role: check.role, property: check.property, expected: check.expected, actual },
      );
    }
  }

  return null;
}

async function confirmProjectPageInProjectsDatabase(
  notion: NotionDiscoveryClient,
  projectPageId: string,
  projectsDatabaseId: string,
): Promise<DiscoveryRefusal | null> {
  const result = await withNotionRetry(() => notion.databases.query({ database_id: projectsDatabaseId, page_size: 100 }), {
    operationName: "databases.query",
    payload: { database_id: projectsDatabaseId, page_size: 100 },
  });
  if (!isRecord(result) || !Array.isArray(result.results)) {
    return refusal("schema_mismatch", "Projects database query did not return a Notion results array.", { projectsDatabaseId });
  }
  const matches = result.results.filter((page) => isRecord(page) && idsEqual(page.id, projectPageId));
  if (matches.length !== 1) {
    return refusal(
      matches.length > 1 ? "ambiguous_database" : "schema_mismatch",
      "Project page was not found exactly once in the discovered Projects database.",
      { projectPageId, projectsDatabaseId, matchCount: matches.length },
    );
  }
  return null;
}

export async function discoverProjectFromNotion(input: {
  notion: NotionDiscoveryClient;
  projectPageId: string;
}): Promise<DiscoveryResult> {
  const page = await retrievePage(input.notion, input.projectPageId);
  if (isRefusal(page)) {
    return page;
  }

  const projectsDatabaseIdFromPage = parentDatabaseId(page);
  if (!projectsDatabaseIdFromPage) {
    return refusal("schema_mismatch", "Discovery input must be an Auto-Doc project page inside the Projects database.", {
      projectPageId: input.projectPageId,
    });
  }

  const projectsDatabase = await retrieveDatabase(input.notion, projectsDatabaseIdFromPage, "projects");
  if (isRefusal(projectsDatabase)) {
    return projectsDatabase;
  }

  const rootPageId = parentPageId(projectsDatabase);
  if (!rootPageId) {
    return refusal("schema_mismatch", "Discovered Projects database is not attached to a Notion page.", {
      projectsDatabaseId: projectsDatabaseIdFromPage,
    });
  }

  const childDatabaseIds = await listChildDatabaseIds(input.notion, rootPageId);
  const candidateIds = [...new Set([projectsDatabaseIdFromPage, ...childDatabaseIds])];
  const candidates: unknown[] = [];
  for (const databaseId of candidateIds) {
    const candidate = idsEqual(databaseId, projectsDatabaseIdFromPage)
      ? projectsDatabase
      : await retrieveDatabase(input.notion, databaseId, databaseId);
    if (isRefusal(candidate)) {
      return candidate;
    }
    candidates.push(candidate);
  }

  const roleCandidates: Record<DatabaseRole, unknown[]> = {
    projectsDatabaseId: hasRequiredProperties(projectsDatabase, "projectsDatabaseId") ? [projectsDatabase] : [],
    featuresDatabaseId: [],
    manualEntriesDatabaseId: [],
    evidenceEventsDatabaseId: [],
    releasesDatabaseId: [],
  };

  for (const candidate of candidates) {
    for (const role of classifyDatabase(candidate)) {
      if (role === "projectsDatabaseId") {
        continue;
      }
      roleCandidates[role].push(candidate);
    }
  }

  for (const role of Object.keys(roleCandidates) as DatabaseRole[]) {
    if (role === "projectsDatabaseId") {
      continue;
    }
    const narrowed = roleCandidates[role].filter((candidate) => {
      const properties = databaseProperties(candidate);
      return properties ? idsEqual(relationTarget(properties.Project), projectsDatabaseIdFromPage) : false;
    });
    if (narrowed.length > 0) {
      roleCandidates[role] = narrowed;
    }
  }

  const byRole: Record<DatabaseRole, unknown> = {
    projectsDatabaseId: null,
    featuresDatabaseId: null,
    manualEntriesDatabaseId: null,
    evidenceEventsDatabaseId: null,
    releasesDatabaseId: null,
  };

  for (const role of Object.keys(roleCandidates) as DatabaseRole[]) {
    const matches = roleCandidates[role];
    if (matches.length === 0) {
      return refusal("missing_database", `Discovery did not find a schema-valid ${ROLE_LABELS[role]} database.`, {
        role,
        candidateDatabaseIds: candidateIds,
      });
    }
    if (matches.length > 1) {
      return refusal("ambiguous_database", `Discovery found multiple plausible ${ROLE_LABELS[role]} databases and refused to guess.`, {
        role,
        candidateDatabaseIds: matches.map((item) => (isRecord(item) ? item.id : null)),
      });
    }
    byRole[role] = matches[0];
  }

  const databases: ProjectDatabases = {
    projectsDatabaseId: readString((byRole.projectsDatabaseId as { id?: unknown }).id) ?? "",
    featuresDatabaseId: readString((byRole.featuresDatabaseId as { id?: unknown }).id) ?? "",
    manualEntriesDatabaseId: readString((byRole.manualEntriesDatabaseId as { id?: unknown }).id) ?? "",
    evidenceEventsDatabaseId: readString((byRole.evidenceEventsDatabaseId as { id?: unknown }).id) ?? "",
    releasesDatabaseId: readString((byRole.releasesDatabaseId as { id?: unknown }).id) ?? "",
  };

  if (!idsEqual(databases.projectsDatabaseId, projectsDatabaseIdFromPage)) {
    return refusal("broken_relation", "Project page parent did not match the discovered Projects database.", {
      projectPageId: input.projectPageId,
      pageParentDatabaseId: projectsDatabaseIdFromPage,
      discoveredProjectsDatabaseId: databases.projectsDatabaseId,
    });
  }

  const relationRefusal = validateRelations(databases, byRole);
  if (relationRefusal) {
    return relationRefusal;
  }

  const projectQueryRefusal = await confirmProjectPageInProjectsDatabase(input.notion, input.projectPageId, databases.projectsDatabaseId);
  if (projectQueryRefusal) {
    return projectQueryRefusal;
  }

  const project: ProjectState = {
    projectId: readString((page as { id?: unknown }).id) ?? input.projectPageId,
    projectName: pageTitle(page),
    parentPageId: rootPageId,
    repositoryUrl: pageUrl(page),
    publishingMode: pagePublishingMode(page),
    autoPublishThreshold: pageThreshold(page),
    projectPageId: readString((page as { id?: unknown }).id) ?? input.projectPageId,
    databases,
    featuresByKey: {},
    eventsByExternalId: {},
    eventSnapshots: {},
  };

  return { ok: true, project, discoveredDatabaseIds: databases };
}

function isRefusal(value: unknown): value is DiscoveryRefusal {
  return isRecord(value) && value.ok === false && typeof value.reasonCode === "string";
}

export async function selfInitializeProjectFromNotion(input: {
  notion: NotionDiscoveryClient;
  store: StateStore;
  projectPageId: string;
  traceId?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<SelfInitializeResult> {
  const discovered = await discoverProjectFromNotion({ notion: input.notion, projectPageId: input.projectPageId });
  if (!discovered.ok) {
    await emitRunnerHealthAlert({
      failureMode: "project_discovery_failed",
      severity: "critical",
      traceId: input.traceId,
      env: input.env,
      message: "Notion project discovery refused to bind because validation failed.",
      data: {
        projectPageId: input.projectPageId,
        reasonCode: discovered.reasonCode,
        message: discovered.message,
        details: discovered.details,
      },
    });
    return discovered;
  }

  const existing = await input.store.getProject(discovered.project.projectId);
  if (existing) {
    return {
      ok: true,
      status: "existing_state_preserved",
      project: existing,
      discoveredDatabaseIds: discovered.discoveredDatabaseIds,
    };
  }

  await input.store.upsertProject(discovered.project);
  return { ...discovered, status: "initialized_from_notion" };
}
