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
  testStatus: "passed" | "failed" | "unknown";
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
  return `Analyze this software change and produce structured JSON documentation.

CHANGE CONTEXT:
- Branch: ${ev.branch}
- Commit: ${ev.commitMessage}
- PR Title: ${ev.prTitle ?? "N/A"}
- Files Changed: ${ev.filesChanged.slice(0, 20).join(", ") || "none"}
- Routes/URLs: ${ev.routes.join(", ") || "none"}
- API Endpoints: ${ev.apiEndpoints.join(", ") || "none"}
- Environment Variables: ${ev.envVars.join(", ") || "none"}
- DB Migrations: ${ev.dbMigrations.join(", ") || "none"}
- UI Components: ${ev.uiComponents.join(", ") || "none"}
- Auth Patterns: ${ev.authPatterns.join(", ") || "none"}
- Tests: ${ev.testStatus}
- Diff Summary: ${ev.diffSummary.slice(0, 2000)}

RESPOND ONLY WITH VALID JSON USING THIS SHAPE:
{
  "featureName": "Clear, specific feature title",
  "featureKey": "stable-kebab-case-key",
  "shouldDocument": true,
  "audiences": ["User", "Admin"],
  "userGuide": {
    "summary": "One sentence describing the user-facing capability",
    "steps": ["Step 1", "Step 2"],
    "expectedOutcome": "What users should expect",
    "possibleErrors": ["Potential error and resolution"]
  },
  "adminGuide": {
    "configRequired": ["Required configuration"],
    "endpointsAffected": ["POST /api/example"],
    "envVarsRequired": ["EXAMPLE_VAR"],
    "verificationSteps": ["How to verify after deploy"],
    "troubleshooting": ["Operational issue and resolution"]
  },
  "developerNotes": "Optional",
  "confidenceScore": 0,
  "confidenceReasons": ["reason"],
  "reviewQuestions": ["question"],
  "providerUsed": "provider-id",
  "generationMs": 0
}`;
}