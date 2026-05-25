import { simpleGit } from "simple-git";
import { redactSecrets } from "../lib/redaction.js";

type GitMode = "staged" | "last_commit" | "working_tree";

interface GitLike {
  branch(): Promise<{ current: string }>;
  show(args?: string[]): Promise<string>;
  diff(args?: string[]): Promise<string>;
  status(): Promise<{ files: Array<{ path: string }> }>;
}

export interface GitEvidenceInput {
  repoPath: string;
  mode: GitMode;
  git?: GitLike;
}

export async function collectGitEvidence(input: GitEvidenceInput) {
  const git = input.git ?? simpleGit(input.repoPath);
  const branch = await git.branch();
  const status = await git.status();

  const rawSummary =
    input.mode === "last_commit"
      ? await git.show(["--stat", "--summary", "HEAD"])
      : input.mode === "staged"
        ? await git.diff(["--cached"])
        : await git.diff();

  return {
    source: "Local Git" as const,
    eventType: input.mode === "last_commit" ? ("Commit" as const) : ("Diff" as const),
    branch: branch.current,
    summary: redactSecrets(rawSummary),
    filesChanged: status.files.map((file: { path: string }) => file.path),
  };
}
