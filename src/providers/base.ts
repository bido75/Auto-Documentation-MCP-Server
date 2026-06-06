export interface StructuredEvidence {
  diffSummary: string;
  filesChanged: string[];
  routes: string[];
  apiEndpoints: string[];
  envVars: string[];
  dbMigrations: string[];
  uiComponents: string[];
  authPatterns: string[];
  branch: string;
  commitMessage: string;
  prTitle?: string;
  testStatus: "passed" | "failed" | "unknown" | "not_run";
}

export interface ModelAnalysis {
  featureName: string;
  featureKey: string;
  shouldDocument: boolean;
  audiences: Array<"User" | "Admin" | "Developer" | "Support">;
  userGuide: {
    summary: string;
    steps: string[];
    expectedOutcome: string;
    possibleErrors: string[];
  };
  adminGuide: {
    configRequired: string[];
    endpointsAffected: string[];
    envVarsRequired: string[];
    verificationSteps: string[];
    troubleshooting: string[];
  };
  developerNotes?: string;
  confidenceScore: number;
  confidenceReasons: string[];
  reviewQuestions: string[];
  providerUsed: string;
  generationMs: number;
}

export interface ModelProvider {
  readonly id: string;
  readonly displayName: string;
  readonly supportsEmbeddings: boolean;
  analyze(evidence: StructuredEvidence): Promise<ModelAnalysis>;
  embed?(text: string): Promise<number[]>;
  healthCheck(): Promise<boolean>;
}

export function buildSharedPromptContent(ev: StructuredEvidence): string {
  return `Analyze this software change and produce structured JSON documentation.\n\nCHANGE CONTEXT:\n- Branch: ${ev.branch}\n- Commit: ${ev.commitMessage}\n- PR Title: ${ev.prTitle ?? "N/A"}\n- Files Changed: ${ev.filesChanged.slice(0, 20).join(", ") || "none"}\n- Routes/URLs: ${ev.routes.join(", ") || "none"}\n- API Endpoints: ${ev.apiEndpoints.join(", ") || "none"}\n- Environment Variables: ${ev.envVars.join(", ") || "none"}\n- DB Migrations: ${ev.dbMigrations.join(", ") || "none"}\n- UI Components: ${ev.uiComponents.join(", ") || "none"}\n- Auth Patterns: ${ev.authPatterns.join(", ") || "none"}\n- Tests: ${ev.testStatus}\n- Diff Summary: ${ev.diffSummary.slice(0, 2000)}\n`;
}