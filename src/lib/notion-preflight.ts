import type { Client } from "@notionhq/client";
import type { ProjectState } from "./state-store.js";

export type NotionPreflightErrorCode =
  | "NOTION_TOKEN_MISSING"
  | "NOTION_TOKEN_INVALID"
  | "NOTION_AUTH_FORBIDDEN"
  | "NOTION_PARENT_PAGE_FORBIDDEN"
  | "NOTION_PARENT_PAGE_NOT_FOUND"
  | "NOTION_DATABASE_ID_MISSING"
  | "NOTION_DATABASE_FORBIDDEN"
  | "NOTION_DATABASE_NOT_FOUND"
  | "NOTION_PREFLIGHT_FAILED";

export class NotionPreflightError extends Error {
  constructor(
    public readonly code: NotionPreflightErrorCode,
    message: string,
    public readonly remediation: string[],
    public readonly context?: Record<string, unknown>,
  ) {
    super(`${code}: ${message}\nNext steps:\n${remediation.map((step, idx) => `${idx + 1}. ${step}`).join("\n")}`);
    this.name = "NotionPreflightError";
  }
}

type NotionLikeError = { status?: unknown; code?: unknown; message?: unknown };

function getStatus(error: unknown): number | undefined {
  const status = (error as NotionLikeError | undefined)?.status;
  return typeof status === "number" ? status : undefined;
}

function getCode(error: unknown): string | undefined {
  const code = (error as NotionLikeError | undefined)?.code;
  return typeof code === "string" ? code : undefined;
}

function getMessage(error: unknown): string {
  const message = (error as NotionLikeError | undefined)?.message;
  return typeof message === "string" ? message : "Unexpected Notion API error.";
}

function missingTokenRemediation(): string[] {
  return [
    "Create/sign in to a Notion account and workspace.",
    "Create a Notion internal integration and copy its secret token.",
    "Set NOTION_TOKEN in the MCP process environment.",
    "Share the target Notion page/database with the integration before retrying.",
  ];
}

function baseAccessRemediation(): string[] {
  return [
    "Confirm NOTION_TOKEN is valid for your intended Notion workspace.",
    "Share the target parent page and related databases with the integration.",
    "Verify IDs passed to the MCP tool are correct Notion IDs.",
  ];
}

export function assertNotionTokenPresent(token?: string): void {
  if (!token || token.trim().length === 0) {
    throw new NotionPreflightError(
      "NOTION_TOKEN_MISSING",
      "NOTION_TOKEN environment variable is not configured.",
      missingTokenRemediation(),
    );
  }
}

async function assertAuthentication(notion: Client): Promise<void> {
  const usersApi = (notion as unknown as { users?: { me?: () => Promise<unknown> } }).users;
  if (!usersApi?.me) {
    return;
  }

  try {
    await usersApi.me();
  } catch (error) {
    const status = getStatus(error);
    const code = getCode(error);
    if (status === 401 || code === "unauthorized") {
      throw new NotionPreflightError(
        "NOTION_TOKEN_INVALID",
        "Notion rejected the integration token during authentication.",
        missingTokenRemediation(),
        { status, rawCode: code },
      );
    }

    if (status === 403) {
      throw new NotionPreflightError(
        "NOTION_AUTH_FORBIDDEN",
        "Notion integration is authenticated but forbidden from this workspace resource.",
        baseAccessRemediation(),
        { status, rawCode: code },
      );
    }

    throw new NotionPreflightError(
      "NOTION_PREFLIGHT_FAILED",
      `Unable to verify Notion authentication: ${getMessage(error)}`,
      baseAccessRemediation(),
      { status, rawCode: code },
    );
  }
}

async function assertParentPageAccess(notion: Client, parentPageId: string): Promise<void> {
  const blocksApi = (notion as unknown as { blocks?: { retrieve?: (input: { block_id: string }) => Promise<unknown> } }).blocks;
  if (!blocksApi?.retrieve) {
    return;
  }

  try {
    await blocksApi.retrieve({ block_id: parentPageId });
  } catch (error) {
    const status = getStatus(error);
    if (status === 403) {
      throw new NotionPreflightError(
        "NOTION_PARENT_PAGE_FORBIDDEN",
        "Integration cannot access the provided parentPageId.",
        [
          "Open the parent page in Notion.",
          "Use Share -> Connections and add your integration.",
          "Retry initialize_project_manual with the same parentPageId.",
        ],
        { parentPageId },
      );
    }

    if (status === 404) {
      throw new NotionPreflightError(
        "NOTION_PARENT_PAGE_NOT_FOUND",
        "Provided parentPageId was not found or is not shared with the integration.",
        [
          "Verify parentPageId is the correct Notion page ID.",
          "Ensure the page is shared with your integration.",
          "Retry initialize_project_manual.",
        ],
        { parentPageId },
      );
    }

    throw new NotionPreflightError(
      "NOTION_PREFLIGHT_FAILED",
      `Unable to verify parent page access: ${getMessage(error)}`,
      baseAccessRemediation(),
      { parentPageId },
    );
  }
}

async function assertDatabaseAccess(notion: Client, databaseId: string, label: string): Promise<void> {
  if (!databaseId) {
    throw new NotionPreflightError(
      "NOTION_DATABASE_ID_MISSING",
      `Database id '${label}' is missing from project state.`,
      [
        "Re-run initialize_project_manual to rebuild database mappings.",
        "Ensure state file was migrated correctly and contains all Notion database IDs.",
      ],
      { label },
    );
  }

  const databasesApi = (notion as unknown as {
    databases?: { retrieve?: (input: { database_id: string }) => Promise<unknown> };
  }).databases;
  if (!databasesApi?.retrieve) {
    return;
  }

  try {
    await databasesApi.retrieve({ database_id: databaseId });
  } catch (error) {
    const status = getStatus(error);
    if (status === 403) {
      throw new NotionPreflightError(
        "NOTION_DATABASE_FORBIDDEN",
        `Integration cannot access required database '${label}'.`,
        [
          "Open the database in Notion and share it with your integration.",
          "Confirm the integration belongs to the same workspace.",
          "Retry the MCP operation.",
        ],
        { label, databaseId },
      );
    }

    if (status === 404) {
      throw new NotionPreflightError(
        "NOTION_DATABASE_NOT_FOUND",
        `Required database '${label}' was not found or not shared with integration.`,
        [
          "Validate the stored database ID and project initialization state.",
          "Share the database with integration if it exists.",
          "Re-run initialize_project_manual if IDs are stale.",
        ],
        { label, databaseId },
      );
    }

    throw new NotionPreflightError(
      "NOTION_PREFLIGHT_FAILED",
      `Unable to verify database '${label}' access: ${getMessage(error)}`,
      baseAccessRemediation(),
      { label, databaseId },
    );
  }
}

export async function runInitializePreflight(input: { notion: Client; parentPageId: string }): Promise<void> {
  await assertAuthentication(input.notion);
  await assertParentPageAccess(input.notion, input.parentPageId);
}

export async function runProjectPreflight(input: { notion: Client; project: ProjectState }): Promise<void> {
  await assertAuthentication(input.notion);
  await assertDatabaseAccess(input.notion, input.project.databases.projectsDatabaseId, "projectsDatabaseId");
  await assertDatabaseAccess(input.notion, input.project.databases.featuresDatabaseId, "featuresDatabaseId");
  await assertDatabaseAccess(input.notion, input.project.databases.manualEntriesDatabaseId, "manualEntriesDatabaseId");
  await assertDatabaseAccess(input.notion, input.project.databases.evidenceEventsDatabaseId, "evidenceEventsDatabaseId");
  await assertDatabaseAccess(input.notion, input.project.databases.releasesDatabaseId, "releasesDatabaseId");
}
