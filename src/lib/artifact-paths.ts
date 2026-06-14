import { isAbsolute, relative, resolve } from "node:path";
import { getOptionalRuntimeConfig } from "../config.js";

export class ArtifactPathError extends Error {
  readonly code = "ARTIFACT_PATH_OUTSIDE_ROOT";

  constructor(message: string) {
    super(message);
    this.name = "ArtifactPathError";
  }
}

export function resolveArtifactPath(requestedPath: string, env = process.env): string {
  const trimmed = requestedPath.trim();
  if (!trimmed) {
    throw new ArtifactPathError("Artifact output path is required.");
  }

  if (trimmed.split(/[\\/]+/).includes("..")) {
    throw new ArtifactPathError("Artifact output paths may not contain '..' traversal segments.");
  }

  const root = resolve(getOptionalRuntimeConfig(env).artifactRoot);
  const requested = isAbsolute(trimmed) ? resolve(trimmed) : resolve(root, trimmed);
  const rel = relative(root, requested);
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
    return requested;
  }

  throw new ArtifactPathError(`Artifact output path '${requestedPath}' must stay within AUTO_DOC_ARTIFACT_ROOT (${root}).`);
}
