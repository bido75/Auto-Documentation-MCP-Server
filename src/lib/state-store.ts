import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from "node:crypto";
import { getOptionalRuntimeConfig } from "../config.js";

export const CURRENT_STATE_SCHEMA_VERSION = 6;

export type ReleaseAutomationRunStatus = "success" | "failure";

export interface ReleaseAutomationRunRecord {
  projectId: string;
  repoPath: string;
  releaseTag: string;
  releaseVersion: string;
  status: ReleaseAutomationRunStatus;
  attemptedAt: string;
  errorMessage?: string;
}

export interface RunnerFailureTriageMetadata {
  acknowledgedAt?: string;
  acknowledgedBy?: string;
  note?: string;
  cooldownUntil?: string;
}

export interface RunnerFailureTriageHistoryEntry {
  changedAt: string;
  action: "set" | "clear";
  metadata: RunnerFailureTriageMetadata | null;
}

export interface ProjectDatabases {
  projectsDatabaseId: string;
  featuresDatabaseId: string;
  manualEntriesDatabaseId: string;
  evidenceEventsDatabaseId: string;
  releasesDatabaseId: string;
}

export interface ProjectState {
  projectId: string;
  projectName: string;
  parentPageId: string;
  repositoryUrl?: string;
  publishingMode: "Conservative" | "Balanced" | "Fully Automatic";
  autoPublishThreshold: number;
  projectPageId?: string;
  databases: ProjectDatabases;
  featuresByKey: Record<string, string>;
  eventsByExternalId: Record<string, string>;
  eventSnapshots: Record<string, EventSnapshot>;
}

export interface EventSnapshot {
  summary: string;
  filesChanged: string[];
  diffSummary?: string;
  prBody?: string;
  issueReferences?: string[];
  commitSha?: string;
  branch?: string;
  prUrl?: string;
  prTitle?: string;
  prNumber?: number;
  baseBranch?: string;
  headBranch?: string;
  releaseVersion?: string;
  eventType: "commit" | "diff" | "pr_opened" | "pr_merged" | "tests_passed" | "release_tagged" | "session_completed";
  source: "local_git" | "github" | "ci" | "release" | "ai_session";
  testStatus?: "passed" | "failed" | "unknown" | "not_run";
}

interface StateShape {
  schemaVersion: number;
  projects: Record<string, ProjectState>;
  runner: {
    lastSeenReleaseTags: Record<string, string>;
    releaseRunLedger: Record<string, ReleaseAutomationRunRecord>;
    failureTriageMetadata: Record<string, RunnerFailureTriageMetadata>;
    failureTriageHistory: Record<string, RunnerFailureTriageHistoryEntry[]>;
  };
}

const DEFAULT_STATE: StateShape = {
  schemaVersion: CURRENT_STATE_SCHEMA_VERSION,
  projects: {},
  runner: {
    lastSeenReleaseTags: {},
    releaseRunLedger: {},
    failureTriageMetadata: {},
    failureTriageHistory: {},
  },
};

interface LegacyProjectState {
  projectId?: string;
  projectName?: string;
  parentPageId?: string;
  repositoryUrl?: string;
  publishingMode?: "Conservative" | "Balanced" | "Fully Automatic";
  autoPublishThreshold?: number;
  projectPageId?: string;
  databases?: Partial<ProjectDatabases>;
  featuresByKey?: Record<string, string>;
  eventsByExternalId?: Record<string, string>;
  eventSnapshots?: Record<string, EventSnapshot>;
}

interface LegacyStateShape {
  schemaVersion?: number;
  projects?: Record<string, LegacyProjectState>;
  runner?: {
    lastSeenReleaseTags?: Record<string, string>;
    releaseRunLedger?: Record<string, ReleaseAutomationRunRecord>;
    failureTriageMetadata?: Record<string, RunnerFailureTriageMetadata>;
    failureTriageHistory?: Record<string, RunnerFailureTriageHistoryEntry[]>;
  };
}

interface StoredStateEnvelope {
  schemaVersion: number;
  checksum: string;
  state?: StateShape;
  encryptedState?: string;
}

const RUNNER_FAILURE_TRIAGE_HISTORY_LIMIT = 20;
const STATE_LOCK_RETRY_MS = 50;

function getStateLockTimeoutMs(): number {
  const configured = Number(process.env.AUTO_DOC_STATE_LOCK_TIMEOUT_MS ?? "8000");
  if (!Number.isFinite(configured) || configured < 1000) {
    return 8000;
  }

  return configured;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function releaseTagKey(projectId: string, repoPath: string): string {
  return `${projectId}::${repoPath}`;
}

function releaseRunKey(projectId: string, repoPath: string, releaseTag: string): string {
  return `${projectId}::${repoPath}::${releaseTag}`;
}

function releaseRunKeyPrefix(projectId: string, repoPath: string): string {
  return `${projectId}::${repoPath}::`;
}

function bootstrapAliasKey(requestedProjectId: string): string {
  return `bootstrap_alias::${requestedProjectId}`;
}

function normalizeProject(projectId: string, project: LegacyProjectState): ProjectState {
  return {
    projectId: project.projectId ?? projectId,
    projectName: project.projectName ?? "Unknown Project",
    parentPageId: project.parentPageId ?? "",
    repositoryUrl: project.repositoryUrl,
    publishingMode: project.publishingMode ?? "Balanced",
    autoPublishThreshold: project.autoPublishThreshold ?? 90,
    projectPageId: project.projectPageId,
    databases: {
      projectsDatabaseId: project.databases?.projectsDatabaseId ?? "",
      featuresDatabaseId: project.databases?.featuresDatabaseId ?? "",
      manualEntriesDatabaseId: project.databases?.manualEntriesDatabaseId ?? "",
      evidenceEventsDatabaseId: project.databases?.evidenceEventsDatabaseId ?? "",
      releasesDatabaseId: project.databases?.releasesDatabaseId ?? "",
    },
    featuresByKey: project.featuresByKey ?? {},
    eventsByExternalId: project.eventsByExternalId ?? {},
    eventSnapshots: project.eventSnapshots ?? {},
  };
}

function migrateState(raw: LegacyStateShape): { migrated: StateShape; changed: boolean } {
  const parsedVersion = typeof raw.schemaVersion === "number" ? raw.schemaVersion : 1;
  const projects = raw.projects ?? {};
  const normalizedProjects: Record<string, ProjectState> = {};

  for (const [projectId, project] of Object.entries(projects)) {
    normalizedProjects[projectId] = normalizeProject(projectId, project ?? {});
  }

  const migrated: StateShape = {
    schemaVersion: CURRENT_STATE_SCHEMA_VERSION,
    projects: normalizedProjects,
    runner: {
      lastSeenReleaseTags: raw.runner?.lastSeenReleaseTags ?? {},
      releaseRunLedger: raw.runner?.releaseRunLedger ?? {},
      failureTriageMetadata: raw.runner?.failureTriageMetadata ?? {},
      failureTriageHistory: raw.runner?.failureTriageHistory ?? {},
    },
  };

  const changed = parsedVersion !== CURRENT_STATE_SCHEMA_VERSION || raw.schemaVersion === undefined;
  return { migrated, changed };
}

function computeChecksum(state: StateShape): string {
  return createHash("sha256").update(JSON.stringify(state)).digest("hex");
}

const STATE_ENCRYPTION_ALGO = "aes-256-gcm";

export function encryptState(data: string, key: string): string {
  const iv = randomBytes(16);
  const keyBuf = scryptSync(key, "autodoc-salt", 32);
  const cipher = createCipheriv(STATE_ENCRYPTION_ALGO, keyBuf, iv);
  const encrypted = Buffer.concat([cipher.update(data, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return JSON.stringify({
    iv: iv.toString("hex"),
    tag: tag.toString("hex"),
    data: encrypted.toString("hex"),
  });
}

export function decryptState(raw: string, key: string): string {
  const parsed = JSON.parse(raw) as { iv: string; tag: string; data: string };
  const keyBuf = scryptSync(key, "autodoc-salt", 32);
  const decipher = createDecipheriv(STATE_ENCRYPTION_ALGO, keyBuf, Buffer.from(parsed.iv, "hex"));
  decipher.setAuthTag(Buffer.from(parsed.tag, "hex"));
  return decipher.update(Buffer.from(parsed.data, "hex"), undefined, "utf8") + decipher.final("utf8");
}

function isStoredEnvelope(value: unknown): value is StoredStateEnvelope {
  return (
    typeof value === "object" &&
    value !== null &&
    "checksum" in value &&
    ("state" in value || "encryptedState" in value)
  );
}

function isPlainStateShape(value: unknown): value is LegacyStateShape {
  return typeof value === "object" && value !== null && !("state" in value);
}

export class StateStore {
  constructor(private readonly filePath = ".auto-doc/state.json") {}

  private get lockFilePath(): string {
    return `${this.filePath}.lock`;
  }

  private async withFileLock<T>(operation: () => Promise<T>): Promise<T> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const startedAt = Date.now();

    for (;;) {
      try {
        await writeFile(this.lockFilePath, `${process.pid}:${Date.now()}`, { encoding: "utf8", flag: "wx" });
        break;
      } catch (error) {
        const asNodeError = error as NodeJS.ErrnoException;
        const lockContentionError =
          asNodeError.code === "EEXIST" || asNodeError.code === "EPERM" || asNodeError.code === "EACCES";

        if (!lockContentionError) {
          throw error;
        }

        if (Date.now() - startedAt >= getStateLockTimeoutMs()) {
          throw new Error(`Timed out waiting for state lock: ${this.lockFilePath}`);
        }

        await delay(STATE_LOCK_RETRY_MS);
      }
    }

    try {
      return await operation();
    } finally {
      await unlink(this.lockFilePath).catch(() => undefined);
    }
  }

  private async loadUnlocked(): Promise<{ state: StateShape; changed: boolean }> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as unknown;

      if (isStoredEnvelope(parsed)) {
        const state = parsed.encryptedState
          ? (JSON.parse(decryptState(parsed.encryptedState, getOptionalRuntimeConfig().stateEncryptionKey)) as StateShape)
          : parsed.state;
        if (!state) {
          throw new Error("State file is missing persisted state data.");
        }

        const checksum = computeChecksum(state);
        if (checksum !== parsed.checksum) {
          throw new Error("State file checksum mismatch. The local state file may be corrupted.");
        }

        const { migrated, changed } = migrateState(state as unknown as LegacyStateShape);
        return { state: migrated, changed };
      }

      if (!isPlainStateShape(parsed)) {
        throw new Error("Unrecognized state file format.");
      }

      const { migrated, changed } = migrateState(parsed);
      return { state: migrated, changed };
    } catch (error) {
      const asNodeError = error as NodeJS.ErrnoException;
      if (asNodeError.code === "ENOENT") {
        return {
          state: {
            schemaVersion: DEFAULT_STATE.schemaVersion,
            projects: {},
            runner: {
              lastSeenReleaseTags: {},
              releaseRunLedger: {},
              failureTriageMetadata: {},
              failureTriageHistory: {},
            },
          },
          changed: false,
        };
      }

      throw error;
    }
  }

  private async saveUnlocked(state: StateShape): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const encryptedState = encryptState(JSON.stringify(state), getOptionalRuntimeConfig().stateEncryptionKey);
    const envelope: StoredStateEnvelope = {
      schemaVersion: CURRENT_STATE_SCHEMA_VERSION,
      checksum: computeChecksum(state),
      encryptedState,
    };

    const tempFilePath = `${this.filePath}.tmp`;
    await writeFile(tempFilePath, JSON.stringify(envelope, null, 2), "utf8");
    try {
      await rename(tempFilePath, this.filePath);
    } catch {
      await unlink(this.filePath).catch(() => undefined);
      await rename(tempFilePath, this.filePath);
    }
  }

  private async withStateMutation<T>(mutate: (state: StateShape) => Promise<T> | T): Promise<T> {
    return this.withFileLock(async () => {
      const loaded = await this.loadUnlocked();
      const result = await mutate(loaded.state);
      await this.saveUnlocked(loaded.state);
      return result;
    });
  }

  async load(): Promise<StateShape> {
    const loaded = await this.loadUnlocked();
    if (loaded.changed) {
      await this.save(loaded.state);
    }

    return loaded.state;
  }

  private async save(state: StateShape): Promise<void> {
    await this.withFileLock(async () => {
      await this.saveUnlocked(state);
    });
  }

  async upsertProject(project: ProjectState): Promise<ProjectState> {
    return this.withStateMutation(async (state) => {
      state.projects[project.projectId] = project;
      return project;
    });
  }

  async getProject(projectId: string): Promise<ProjectState | null> {
    const state = await this.load();
    return state.projects[projectId] ?? null;
  }

  async setFeature(projectId: string, featureKey: string, featurePageId: string): Promise<void> {
    await this.withStateMutation(async (state) => {
      const project = state.projects[projectId];
      if (!project) {
        throw new Error(`Unknown projectId '${projectId}'. Run initialize_project_manual first.`);
      }

      project.featuresByKey[featureKey] = featurePageId;
    });
  }

  async getFeature(projectId: string, featureKey: string): Promise<string | null> {
    const state = await this.load();
    return state.projects[projectId]?.featuresByKey[featureKey] ?? null;
  }

  async setEvent(projectId: string, externalEventId: string, notionPageId: string): Promise<void> {
    await this.withStateMutation(async (state) => {
      const project = state.projects[projectId];
      if (!project) {
        throw new Error(`Unknown projectId '${projectId}'. Run initialize_project_manual first.`);
      }

      project.eventsByExternalId[externalEventId] = notionPageId;
    });
  }

  async getEvent(projectId: string, externalEventId: string): Promise<string | null> {
    const state = await this.load();
    return state.projects[projectId]?.eventsByExternalId[externalEventId] ?? null;
  }

  async setEventSnapshot(projectId: string, externalEventId: string, snapshot: EventSnapshot): Promise<void> {
    await this.withStateMutation(async (state) => {
      const project = state.projects[projectId];
      if (!project) {
        throw new Error(`Unknown projectId '${projectId}'. Run initialize_project_manual first.`);
      }

      project.eventSnapshots[externalEventId] = snapshot;
    });
  }

  async getEventSnapshot(projectId: string, externalEventId: string): Promise<EventSnapshot | null> {
    const state = await this.load();
    return state.projects[projectId]?.eventSnapshots[externalEventId] ?? null;
  }

  async setLastSeenReleaseTag(projectId: string, repoPath: string, tag: string): Promise<void> {
    await this.withStateMutation(async (state) => {
      state.runner.lastSeenReleaseTags[releaseTagKey(projectId, repoPath)] = tag;
    });
  }

  async getLastSeenReleaseTag(projectId: string, repoPath: string): Promise<string | null> {
    const state = await this.load();
    return state.runner.lastSeenReleaseTags[releaseTagKey(projectId, repoPath)] ?? null;
  }

  async setBootstrapProjectAlias(requestedProjectId: string, resolvedProjectId: string): Promise<void> {
    await this.withStateMutation(async (state) => {
      state.runner.lastSeenReleaseTags[bootstrapAliasKey(requestedProjectId)] = resolvedProjectId;
    });
  }

  async getBootstrapProjectAlias(requestedProjectId: string): Promise<string | null> {
    const state = await this.load();
    return state.runner.lastSeenReleaseTags[bootstrapAliasKey(requestedProjectId)] ?? null;
  }

  async setReleaseAutomationRun(record: ReleaseAutomationRunRecord): Promise<void> {
    await this.withStateMutation(async (state) => {
      state.runner.releaseRunLedger[releaseRunKey(record.projectId, record.repoPath, record.releaseTag)] = record;
    });
  }

  async getReleaseAutomationRun(projectId: string, repoPath: string, releaseTag: string): Promise<ReleaseAutomationRunRecord | null> {
    const state = await this.load();
    return state.runner.releaseRunLedger[releaseRunKey(projectId, repoPath, releaseTag)] ?? null;
  }

  async listReleaseAutomationRuns(projectId: string, repoPath: string): Promise<ReleaseAutomationRunRecord[]> {
    const state = await this.load();
    const prefix = releaseRunKeyPrefix(projectId, repoPath);

    const runs = Object.entries(state.runner.releaseRunLedger)
      .filter(([key]) => key.startsWith(prefix))
      .map(([, record]) => record);

    runs.sort((a, b) => b.attemptedAt.localeCompare(a.attemptedAt));
    return runs;
  }

  async setRunnerFailureTriageMetadata(
    projectId: string,
    repoPath: string,
    metadata: RunnerFailureTriageMetadata,
  ): Promise<void> {
    await this.withStateMutation(async (state) => {
      const key = releaseTagKey(projectId, repoPath);
      state.runner.failureTriageMetadata[key] = metadata;
      const history = state.runner.failureTriageHistory[key] ?? [];
      history.unshift({
        changedAt: new Date().toISOString(),
        action: "set",
        metadata,
      });
      state.runner.failureTriageHistory[key] = history.slice(0, RUNNER_FAILURE_TRIAGE_HISTORY_LIMIT);
    });
  }

  async getRunnerFailureTriageMetadata(projectId: string, repoPath: string): Promise<RunnerFailureTriageMetadata | null> {
    const state = await this.load();
    return state.runner.failureTriageMetadata[releaseTagKey(projectId, repoPath)] ?? null;
  }

  async clearRunnerFailureTriageMetadata(projectId: string, repoPath: string): Promise<void> {
    await this.withStateMutation(async (state) => {
      const key = releaseTagKey(projectId, repoPath);
      delete state.runner.failureTriageMetadata[key];
      const history = state.runner.failureTriageHistory[key] ?? [];
      history.unshift({
        changedAt: new Date().toISOString(),
        action: "clear",
        metadata: null,
      });
      state.runner.failureTriageHistory[key] = history.slice(0, RUNNER_FAILURE_TRIAGE_HISTORY_LIMIT);
    });
  }

  async listRunnerFailureTriageHistory(projectId: string, repoPath: string, limit = 10): Promise<RunnerFailureTriageHistoryEntry[]> {
    const state = await this.load();
    const history = state.runner.failureTriageHistory[releaseTagKey(projectId, repoPath)] ?? [];
    return history.slice(0, limit);
  }
}

let sharedStore: StateStore | null = null;

export function getStateStore(): StateStore {
  if (!sharedStore) {
    sharedStore = new StateStore();
  }

  return sharedStore;
}
