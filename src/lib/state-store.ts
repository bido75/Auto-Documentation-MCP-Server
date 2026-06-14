import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from "node:crypto";
import { copyFile, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { getOptionalRuntimeConfig } from "../config.js";

export const CURRENT_STATE_SCHEMA_VERSION = 3;

export interface ProjectDatabases {
  projectsDatabaseId: string;
  featuresDatabaseId: string;
  manualEntriesDatabaseId: string;
  evidenceEventsDatabaseId: string;
  releasesDatabaseId: string;
}

export interface ReleaseAutomationRun {
  releaseTag: string;
  releaseVersion: string;
  status: "success" | "failure";
  attemptedAt: string;
  errorMessage?: string;
}

export interface RunnerFailureTriageMetadata {
  acknowledgedAt?: string;
  acknowledgedBy?: string;
  cooldownUntil?: string;
  note?: string;
}

export interface RunnerFailureTriageHistoryEntry {
  changedAt: string;
  action: "set" | "clear";
  metadata: RunnerFailureTriageMetadata | null;
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
  lastSeenReleaseTag?: string | null;
  releaseAutomationRuns?: ReleaseAutomationRun[];
  runnerFailureTriage?: RunnerFailureTriageMetadata;
  runnerFailureTriageHistory?: RunnerFailureTriageHistoryEntry[];
}

export interface EventSnapshot {
  summary: string;
  filesChanged: string[];
  diffSummary?: string;
  commitSha?: string;
  branch?: string;
  eventType: "commit" | "diff" | "pr_opened" | "pr_merged" | "tests_passed" | "release_tagged" | "session_completed";
  source: "local_git" | "github" | "ci" | "release" | "ai_session";
  testStatus?: "passed" | "failed" | "unknown" | "not_run";
}

interface StateShape {
  schemaVersion: number;
  projects: Record<string, ProjectState>;
}

const DEFAULT_STATE: StateShape = { schemaVersion: CURRENT_STATE_SCHEMA_VERSION, projects: {} };
const mutationQueues = new Map<string, Promise<void>>();

interface StateEnvelope {
  schemaVersion: number;
  checksum: string;
  encryptedState?: string;
  state?: StateShape;
}

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
  lastSeenReleaseTag?: string | null;
  releaseAutomationRuns?: ReleaseAutomationRun[];
  runnerFailureTriage?: RunnerFailureTriageMetadata;
  runnerFailureTriageHistory?: RunnerFailureTriageHistoryEntry[];
}

interface LegacyStateShape {
  schemaVersion?: number;
  projects?: Record<string, LegacyProjectState>;
}

function computeChecksum(state: StateShape): string {
  return createHash("sha256").update(JSON.stringify(state)).digest("hex");
}

function encryptState(data: string, key: string): string {
  const iv = randomBytes(16);
  const keyBytes = scryptSync(key, "autodoc-state-salt", 32);
  const cipher = createCipheriv("aes-256-gcm", keyBytes, iv);
  const encrypted = Buffer.concat([cipher.update(data, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return JSON.stringify({
    iv: iv.toString("hex"),
    tag: tag.toString("hex"),
    data: encrypted.toString("hex"),
  });
}

function decryptState(payload: string, key: string): string {
  const parsed = JSON.parse(payload) as { iv: string; tag: string; data: string };
  const keyBytes = scryptSync(key, "autodoc-state-salt", 32);
  const decipher = createDecipheriv("aes-256-gcm", keyBytes, Buffer.from(parsed.iv, "hex"));
  decipher.setAuthTag(Buffer.from(parsed.tag, "hex"));
  return decipher.update(Buffer.from(parsed.data, "hex"), undefined, "utf8") + decipher.final("utf8");
}

function isStateEnvelope(value: unknown): value is StateEnvelope {
  return (
    typeof value === "object" &&
    value !== null &&
    "checksum" in value &&
    ("encryptedState" in value || "state" in value)
  );
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
    lastSeenReleaseTag: project.lastSeenReleaseTag ?? null,
    releaseAutomationRuns: project.releaseAutomationRuns ?? [],
    runnerFailureTriage: project.runnerFailureTriage ?? {},
    runnerFailureTriageHistory: project.runnerFailureTriageHistory ?? [],
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
  };

  const changed = parsedVersion !== CURRENT_STATE_SCHEMA_VERSION || raw.schemaVersion === undefined;
  return { migrated, changed };
}

async function runExclusive<T>(filePath: string, operation: () => Promise<T>): Promise<T> {
  const key = resolve(filePath);
  const previous = mutationQueues.get(key) ?? Promise.resolve();
  let release: () => void = () => undefined;
  const current = new Promise<void>((resolveQueued) => {
    release = resolveQueued;
  });
  const queued = previous.then(() => current, () => current);
  mutationQueues.set(key, queued);

  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (mutationQueues.get(key) === queued) {
      mutationQueues.delete(key);
    }
  }
}

export class StateStore {
  constructor(private readonly filePath = ".auto-doc/state.json") {}

  async load(): Promise<StateShape> {
    return this.loadFromPath(this.filePath);
  }

  private async loadFromPath(filePath: string): Promise<StateShape> {
    try {
      const raw = await readFile(filePath, "utf8");
      const parsed = JSON.parse(raw) as LegacyStateShape | StateEnvelope;
      let source: LegacyStateShape;

      if (isStateEnvelope(parsed)) {
        const stateData = parsed.encryptedState
          ? (JSON.parse(decryptState(parsed.encryptedState, getOptionalRuntimeConfig().stateEncryptionKey)) as LegacyStateShape)
          : (parsed.state as LegacyStateShape | undefined);

        if (!stateData) {
          throw new Error("State file is missing persisted state data.");
        }

        const checksum = computeChecksum(stateData as StateShape);
        if (checksum !== parsed.checksum) {
          throw new Error("State file checksum mismatch. The local state file may be corrupted.");
        }

        source = stateData;
      } else {
        source = parsed;
      }

      const { migrated, changed } = migrateState(source);
      if (changed) {
        await this.save(migrated);
      }

      return migrated;
    } catch (error) {
      const asNodeError = error as NodeJS.ErrnoException;
      if (asNodeError.code === "ENOENT") {
        return { ...DEFAULT_STATE };
      }

      if (filePath === this.filePath) {
        const backup = await this.loadFromPath(`${this.filePath}.bak`).catch(() => null);
        if (backup) {
          return backup;
        }
      }

      throw error;
    }
  }

  private async save(state: StateShape): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const encryptedState = encryptState(JSON.stringify(state), getOptionalRuntimeConfig().stateEncryptionKey);
    const envelope: StateEnvelope = {
      schemaVersion: CURRENT_STATE_SCHEMA_VERSION,
      checksum: computeChecksum(state),
      encryptedState,
    };
    const tempFilePath = `${this.filePath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
    await copyFile(this.filePath, `${this.filePath}.bak`).catch(() => undefined);
    await writeFile(tempFilePath, JSON.stringify(envelope, null, 2), "utf8");
    try {
      await rename(tempFilePath, this.filePath);
    } catch {
      await unlink(this.filePath).catch(() => undefined);
      await rename(tempFilePath, this.filePath);
    }
  }

  private async mutate(mutator: (state: StateShape) => void | Promise<void>): Promise<void> {
    await runExclusive(this.filePath, async () => {
      const state = await this.load();
      await mutator(state);
      await this.save(state);
    });
  }

  async upsertProject(project: ProjectState): Promise<ProjectState> {
    await this.mutate((state) => {
      state.projects[project.projectId] = project;
    });
    return project;
  }

  async getProject(projectId: string): Promise<ProjectState | null> {
    const state = await this.load();
    return state.projects[projectId] ?? null;
  }

  async setFeature(projectId: string, featureKey: string, featurePageId: string): Promise<void> {
    await this.mutate((state) => {
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
    await this.mutate((state) => {
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
    await this.mutate((state) => {
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

  async getLastSeenReleaseTag(projectId: string, _repoPath: string): Promise<string | null> {
    const state = await this.load();
    return state.projects[projectId]?.lastSeenReleaseTag ?? null;
  }

  async setLastSeenReleaseTag(projectId: string, _repoPath: string, releaseTag: string): Promise<void> {
    await this.mutate((state) => {
      const project = state.projects[projectId];
      if (!project) {
        throw new Error(`Unknown projectId '${projectId}'. Run initialize_project_manual first.`);
      }

      project.lastSeenReleaseTag = releaseTag;
    });
  }

  async listReleaseAutomationRuns(projectId: string, _repoPath: string): Promise<ReleaseAutomationRun[]> {
    const state = await this.load();
    return state.projects[projectId]?.releaseAutomationRuns ?? [];
  }

  async setReleaseAutomationRun(input: {
    projectId: string;
    repoPath: string;
    releaseTag: string;
    releaseVersion: string;
    status: "success" | "failure";
    attemptedAt: string;
    errorMessage?: string;
  }): Promise<void> {
    await this.mutate((state) => {
      const project = state.projects[input.projectId];
      if (!project) {
        throw new Error(`Unknown projectId '${input.projectId}'. Run initialize_project_manual first.`);
      }

      project.releaseAutomationRuns = project.releaseAutomationRuns ?? [];
      project.releaseAutomationRuns.unshift({
        releaseTag: input.releaseTag,
        releaseVersion: input.releaseVersion,
        status: input.status,
        attemptedAt: input.attemptedAt,
        errorMessage: input.errorMessage,
      });
    });
  }

  async getReleaseAutomationRun(projectId: string, _repoPath: string, releaseTag: string): Promise<ReleaseAutomationRun | null> {
    const state = await this.load();
    const runs = state.projects[projectId]?.releaseAutomationRuns ?? [];
    return runs.find((run) => run.releaseTag === releaseTag) ?? null;
  }

  async getRunnerFailureTriageMetadata(projectId: string, _repoPath: string): Promise<RunnerFailureTriageMetadata | null> {
    const state = await this.load();
    return state.projects[projectId]?.runnerFailureTriage ?? null;
  }

  async setRunnerFailureTriageMetadata(
    projectId: string,
    repoPathOrMetadata: string | RunnerFailureTriageMetadata,
    maybeMetadata?: RunnerFailureTriageMetadata,
  ): Promise<void> {
    await this.mutate((state) => {
      const project = state.projects[projectId];
      if (!project) {
        throw new Error(`Unknown projectId '${projectId}'. Run initialize_project_manual first.`);
      }

      const metadata = typeof repoPathOrMetadata === "string" ? maybeMetadata : repoPathOrMetadata;
      if (!metadata) {
        throw new Error("Runner failure triage metadata is required.");
      }

      project.runnerFailureTriage = metadata;
      project.runnerFailureTriageHistory = project.runnerFailureTriageHistory ?? [];
      project.runnerFailureTriageHistory.unshift({
        changedAt: new Date().toISOString(),
        action: "set",
        metadata,
      });
      project.runnerFailureTriageHistory = project.runnerFailureTriageHistory.slice(0, 100);
    });
  }

  async clearRunnerFailureTriageMetadata(projectId: string, _repoPath: string): Promise<void> {
    await this.mutate((state) => {
      const project = state.projects[projectId];
      if (!project) {
        throw new Error(`Unknown projectId '${projectId}'. Run initialize_project_manual first.`);
      }

      project.runnerFailureTriage = {};
      project.runnerFailureTriageHistory = project.runnerFailureTriageHistory ?? [];
      project.runnerFailureTriageHistory.unshift({
        changedAt: new Date().toISOString(),
        action: "clear",
        metadata: null,
      });
      project.runnerFailureTriageHistory = project.runnerFailureTriageHistory.slice(0, 100);
    });
  }

  async listRunnerFailureTriageHistory(
    projectId: string,
    _repoPath: string,
    limit = 10,
  ): Promise<RunnerFailureTriageHistoryEntry[]> {
    const state = await this.load();
    const history = state.projects[projectId]?.runnerFailureTriageHistory ?? [];
    return history.slice(0, Math.max(1, limit));
  }
}

let sharedStore: StateStore | null = null;
let sharedStorePath: string | null = null;

export function getStateStore(): StateStore {
  const configuredPath = process.env.AUTO_DOC_STATE_FILE?.trim() || ".auto-doc/state.json";
  if (!sharedStore || sharedStorePath !== configuredPath) {
    sharedStore = new StateStore(configuredPath);
    sharedStorePath = configuredPath;
  }

  return sharedStore;
}
