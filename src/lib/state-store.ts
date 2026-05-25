import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export const CURRENT_STATE_SCHEMA_VERSION = 2;

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
  };

  const changed = parsedVersion !== CURRENT_STATE_SCHEMA_VERSION || raw.schemaVersion === undefined;
  return { migrated, changed };
}

export class StateStore {
  constructor(private readonly filePath = ".auto-doc/state.json") {}

  async load(): Promise<StateShape> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as LegacyStateShape;
      const { migrated, changed } = migrateState(parsed);

      if (changed) {
        await this.save(migrated);
      }

      return migrated;
    } catch (error) {
      const asNodeError = error as NodeJS.ErrnoException;
      if (asNodeError.code === "ENOENT") {
        return { ...DEFAULT_STATE };
      }

      throw error;
    }
  }

  private async save(state: StateShape): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(state, null, 2), "utf8");
  }

  async upsertProject(project: ProjectState): Promise<ProjectState> {
    const state = await this.load();
    state.projects[project.projectId] = project;
    await this.save(state);
    return project;
  }

  async getProject(projectId: string): Promise<ProjectState | null> {
    const state = await this.load();
    return state.projects[projectId] ?? null;
  }

  async setFeature(projectId: string, featureKey: string, featurePageId: string): Promise<void> {
    const state = await this.load();
    const project = state.projects[projectId];
    if (!project) {
      throw new Error(`Unknown projectId '${projectId}'. Run initialize_project_manual first.`);
    }

    project.featuresByKey[featureKey] = featurePageId;
    await this.save(state);
  }

  async getFeature(projectId: string, featureKey: string): Promise<string | null> {
    const state = await this.load();
    return state.projects[projectId]?.featuresByKey[featureKey] ?? null;
  }

  async setEvent(projectId: string, externalEventId: string, notionPageId: string): Promise<void> {
    const state = await this.load();
    const project = state.projects[projectId];
    if (!project) {
      throw new Error(`Unknown projectId '${projectId}'. Run initialize_project_manual first.`);
    }

    project.eventsByExternalId[externalEventId] = notionPageId;
    await this.save(state);
  }

  async getEvent(projectId: string, externalEventId: string): Promise<string | null> {
    const state = await this.load();
    return state.projects[projectId]?.eventsByExternalId[externalEventId] ?? null;
  }

  async setEventSnapshot(projectId: string, externalEventId: string, snapshot: EventSnapshot): Promise<void> {
    const state = await this.load();
    const project = state.projects[projectId];
    if (!project) {
      throw new Error(`Unknown projectId '${projectId}'. Run initialize_project_manual first.`);
    }

    project.eventSnapshots[externalEventId] = snapshot;
    await this.save(state);
  }

  async getEventSnapshot(projectId: string, externalEventId: string): Promise<EventSnapshot | null> {
    const state = await this.load();
    return state.projects[projectId]?.eventSnapshots[externalEventId] ?? null;
  }
}

let sharedStore: StateStore | null = null;

export function getStateStore(): StateStore {
  if (!sharedStore) {
    sharedStore = new StateStore();
  }

  return sharedStore;
}
