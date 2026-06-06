export type AutonomousTriggerInput = {
  projectId: string;
  repoPath: string;
  mode: "staged" | "last_commit" | "working_tree";
  source?: string;
  eventType?: string;
  summary?: string;
  diffSummary?: string;
  filesChanged?: string[] | string;
  commitSha?: string;
  branch?: string;
  prUrl?: string;
  prTitle?: string;
  prBody?: string;
  prNumber?: number;
  baseBranch?: string;
  headBranch?: string;
  issueReferences?: string[];
  releaseVersion?: string;
  testStatus?: string;
  traceId?: string;
  signal?: AbortSignal;
};

export async function executeAutonomousDocumentationTrigger(input: AutonomousTriggerInput): Promise<{ ok: true; projectId: string; repoPath: string; mode: string }> {
  return { ok: true, projectId: input.projectId, repoPath: input.repoPath, mode: input.mode };
}