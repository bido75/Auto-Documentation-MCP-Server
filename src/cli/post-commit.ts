import { simpleGit } from "simple-git";
import { executeAutonomousDocumentationTrigger } from "../orchestrator/auto-doc-orchestrator.js";
import { resolveToken } from "../installer/token-store.js";
import { getStateStore, type ProjectState } from "../lib/state-store.js";

function normalizeRemoteUrl(input: string): string {
  const trimmed = input.trim();
  const sshMatch = trimmed.match(/^git@github\.com:(.+)$/i);
  const normalized = sshMatch ? `https://github.com/${sshMatch[1]}` : trimmed;
  return normalized.replace(/\.git$/i, "").toLowerCase();
}

function selectProject(input: {
  projects: ProjectState[];
  preferredProjectId?: string;
  remoteUrl?: string;
}): ProjectState | null {
  if (input.projects.length === 0) {
    return null;
  }

  if (input.preferredProjectId) {
    const selected = input.projects.find((project) => project.projectId === input.preferredProjectId);
    if (selected) {
      return selected;
    }
  }

  if (input.remoteUrl) {
    const normalizedRemote = normalizeRemoteUrl(input.remoteUrl);
    const selected = input.projects.find(
      (project) => project.repositoryUrl && normalizeRemoteUrl(project.repositoryUrl) === normalizedRemote,
    );
    if (selected) {
      return selected;
    }
  }

  if (input.projects.length === 1) {
    return input.projects[0];
  }

  return null;
}

export async function runPostCommitTrigger(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  if (!env.NOTION_TOKEN || env.NOTION_TOKEN.trim().length === 0) {
    const token = await resolveToken();
    if (token) {
      env.NOTION_TOKEN = token;
    }
  }

  if (!env.NOTION_TOKEN || env.NOTION_TOKEN.trim().length === 0) {
    console.error("[auto-doc-mcp] skipped: NOTION_TOKEN is not available.");
    return;
  }

  const repoPath = env.AUTO_DOC_HOOK_REPO_PATH?.trim();
  if (!repoPath) {
    console.error("[auto-doc-mcp] skipped: AUTO_DOC_HOOK_REPO_PATH is missing.");
    return;
  }

  const store = getStateStore();
  const state = await store.load();
  const projects = Object.values(state.projects);

  let remoteUrl: string | undefined;
  try {
    remoteUrl = (await simpleGit(repoPath).raw(["remote", "get-url", "origin"]))?.trim();
  } catch {
    remoteUrl = undefined;
  }

  const project = selectProject({
    projects,
    preferredProjectId: env.AUTO_DOC_PROJECT_ID?.trim(),
    remoteUrl,
  });

  if (!project) {
    console.error("[auto-doc-mcp] skipped: unable to resolve project mapping for post-commit trigger.");
    return;
  }

  const result = await executeAutonomousDocumentationTrigger({
    projectId: project.projectId,
    repoPath,
    mode: "last_commit",
    source: "local_git",
    eventType: "commit",
    summary: "Automatic post-commit documentation trigger",
    commitSha: env.AUTO_DOC_HOOK_COMMIT_SHA?.trim() || undefined,
    branch: env.AUTO_DOC_HOOK_BRANCH?.trim() || undefined,
  });

  console.error(
    `[auto-doc-mcp] post-commit result: status=${result.status} projectId=${result.projectId} eventId=${result.eventId ?? "none"}`,
  );
}
