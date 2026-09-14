import { realpath } from "node:fs/promises";
import { delimiter, isAbsolute, relative, resolve } from "node:path";

export class RepoPathNotAllowedError extends Error {
  readonly code = "REPO_PATH_NOT_ALLOWED";

  constructor(message: string) {
    super(message);
    this.name = "RepoPathNotAllowedError";
  }
}

function splitAllowedRoots(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(/[,\n;]/)
    .flatMap((part) => part.split(delimiter))
    .map((part) => part.trim())
    .filter(Boolean);
}

function runnerRepoRoots(env: NodeJS.ProcessEnv): string[] {
  const roots: string[] = [];
  const single = env.AUTO_DOC_RUNNER_REPO_PATH?.trim();
  if (single) {
    roots.push(single);
  }

  const configuredTargets = env.AUTO_DOC_RUNNER_TARGETS?.trim();
  if (!configuredTargets) {
    return roots;
  }

  try {
    const parsed = JSON.parse(configuredTargets) as unknown;
    if (!Array.isArray(parsed)) {
      return roots;
    }
    for (const item of parsed) {
      if (item && typeof item === "object" && typeof (item as { repoPath?: unknown }).repoPath === "string") {
        roots.push((item as { repoPath: string }).repoPath);
      }
    }
  } catch {
    return roots;
  }

  return roots;
}

function isContainedBy(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

async function realpathIfExists(path: string): Promise<string> {
  return realpath(path).catch(() => resolve(path));
}

export async function assertRepoPathAllowed(repoPath: string, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const trimmed = repoPath.trim();
  if (!trimmed) {
    throw new RepoPathNotAllowedError("repoPath is required.");
  }

  const allowedRoots = [...splitAllowedRoots(env.AUTO_DOC_ALLOWED_REPO_ROOTS), ...runnerRepoRoots(env)];
  if (allowedRoots.length === 0) {
    throw new RepoPathNotAllowedError("repoPath is not allowed because AUTO_DOC_ALLOWED_REPO_ROOTS is not configured.");
  }

  const resolvedRepo = resolve(trimmed);
  const realRepo = await realpathIfExists(resolvedRepo);
  const realRoots = await Promise.all(allowedRoots.map((root) => realpathIfExists(resolve(root))));
  if (realRoots.some((root) => isContainedBy(root, realRepo))) {
    return realRepo;
  }

  throw new RepoPathNotAllowedError("repoPath is not allowed by AUTO_DOC_ALLOWED_REPO_ROOTS.");
}
