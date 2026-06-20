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

export interface ManualAuthoringProviderInput {
  audience: "User" | "Admin" | "Internal";
  entryType: "User Guide" | "Admin Guide" | "Developer Note" | "Release Note";
  featureName: string;
  summary: string;
  diffSummary?: string;
  filesChanged: string[];
  sourceText: string;
}

export interface ManualAuthoringProviderResult {
  body: string;
  providerUsed: string;
  generationMs: number;
}

export interface ModelProvider {
  readonly id: string;
  readonly displayName: string;
  readonly supportsEmbeddings: boolean;
  analyze(evidence: StructuredEvidence): Promise<ModelAnalysis>;
  authorManualSection?(input: ManualAuthoringProviderInput): Promise<ManualAuthoringProviderResult>;
  preflightGenerate?(): Promise<string>;
  embed?(text: string): Promise<number[]>;
  healthCheck(): Promise<boolean>;
}

export function buildSharedPromptContent(ev: StructuredEvidence): string {
  return `Analyze this software change and produce structured JSON documentation.

Return only valid JSON with this exact shape:
{
  "featureName": "short human-readable feature name",
  "featureKey": "stable-kebab-case-feature-key",
  "shouldDocument": true,
  "audiences": ["User", "Admin"],
  "userGuide": {
    "summary": "novice-readable overview of what the user can now do",
    "steps": ["ordered user action step"],
    "expectedOutcome": "what success looks like",
    "possibleErrors": ["likely user-facing failure and fix"]
  },
  "adminGuide": {
    "configRequired": ["operator requirement"],
    "endpointsAffected": ["route or endpoint, or empty array"],
    "envVarsRequired": ["REAL_ENV_VAR_NAME, or empty array"],
    "verificationSteps": ["operator verification step"],
    "troubleshooting": ["operator failure and fix"]
  },
  "developerNotes": "optional implementation note",
  "confidenceScore": 75,
  "confidenceReasons": ["why this is manual-worthy"],
  "reviewQuestions": []
}

Do not return metadata-only analysis. Do not invent environment variables; use only real names from the change context.

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
`;
}

export function buildManualAuthoringPrompt(input: ManualAuthoringProviderInput): string {
  return `Write one complete ${input.entryType} section for a ${input.audience} audience.

Return only valid JSON with this shape:
{
  "body": "markdown manual content"
}

Authoring requirements:
- Write clear novice-readable documentation, not an evidence log.
- Include a short overview, prerequisites or requirements, ordered steps, expected result, and troubleshooting.
- Use real commands, environment variable names, and operational details from the source context when available.
- Document only what is present in the provided source evidence.
- Do NOT invent function names, parameters, parameter types, units, return values, environment variables, configuration, dependencies, file paths, screenshots, deployed URLs, credentials, or numeric behavior.
- Use the exact identifiers and literals from the source, including exact function names, exact parameter names, exact return expressions, and exact numeric multipliers.
- If the source context contains exported functions, document every exported function with its exact signature and source-visible behavior. Treat commit messages, comments, and summaries as secondary to the actual code.
- For multi-function modules, cover the constants, validation branches, return shapes, and status values that appear in source. Do not introduce deployment, queue, database, endpoint, or environment-variable details unless the source explicitly contains them.
- Do not add worked examples, sample user ids, sample payloads, inferred types, or derived numeric examples unless those exact values appear in the source evidence.
- If a detail is not in the evidence, do not state it. For thin evidence, write a short accurate entry and explicitly note what is unspecified instead of padding.
- Do not include raw README dumps, commit summaries, "Source context", or file lists as the manual.
- Keep user-facing and admin-facing content distinct.

Subject:
- Feature: ${input.featureName}
- Summary: ${input.summary}
- Files changed: ${input.filesChanged.slice(0, 40).join(", ") || "none"}
- Diff summary: ${(input.diffSummary ?? "").slice(0, 2500)}

Source context:
${input.sourceText.slice(0, 12000)}
`;
}
