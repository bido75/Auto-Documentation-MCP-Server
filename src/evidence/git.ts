import { simpleGit } from "simple-git";
import { redactSecrets } from "../lib/redaction.js";

type GitMode = "staged" | "last_commit" | "working_tree";

interface GitLike {
  branch(): Promise<{ current: string }>;
  revparse(args?: string[]): Promise<string>;
  show(args?: string[]): Promise<string>;
  diff(args?: string[]): Promise<string>;
  status(): Promise<{ files: Array<{ path: string }> }>;
}

export interface GitEvidenceInput {
  repoPath: string;
  mode: GitMode;
  git?: GitLike;
}

function normalizeGitText(content: string): string {
  return content.replace(/\u0000/g, "");
}

export async function collectGitEvidence(input: GitEvidenceInput) {
  const git = input.git ?? simpleGit(input.repoPath);
  const branch = await git.branch();
  const status = await git.status();
  const commitSha = input.mode === "last_commit" ? (await git.revparse(["HEAD"])).trim() : undefined;

  const rawSummary =
    input.mode === "last_commit"
      ? await git.show(["--stat", "--summary", "HEAD"])
      : input.mode === "staged"
        ? await git.diff(["--cached"])
        : await git.diff();
  const rawDiffSummary =
    input.mode === "last_commit"
      ? await git.show(["--format=", "--patch", "HEAD"])
      : input.mode === "staged"
        ? await git.diff(["--cached"])
        : await git.diff();
  const changedFiles =
    input.mode === "last_commit"
      ? (await git.show(["--format=", "--name-only", "HEAD"]))
          .split(/\r?\n/)
          .map((file) => file.trim())
          .filter(Boolean)
      : status.files.map((file: { path: string }) => file.path);

  return {
    source: "Local Git" as const,
    eventType: input.mode === "last_commit" ? ("Commit" as const) : ("Diff" as const),
    branch: branch.current,
    commitSha,
    summary: redactSecrets(normalizeGitText(rawSummary)),
    diffSummary: redactSecrets(normalizeGitText(rawDiffSummary)),
    filesChanged: changedFiles,
  };
}
