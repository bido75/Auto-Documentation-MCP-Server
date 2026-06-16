import { scoreDocumentationConfidence } from "../analysis/confidence.js";
import { createFeatureKey } from "../analysis/feature-key.js";
import { classifyManualWorthiness } from "../analysis/manual-worthiness.js";
import { getOptionalRuntimeConfig } from "../config.js";
import type { EventSnapshot } from "./state-store.js";
import { embeddingStore } from "./embedding-store.js";
import { validateAndSanitize } from "./guardrail.js";
import { analyzeWithFallback, embedText } from "../providers/factory.js";
import { DeterministicProvider } from "../providers/deterministic.js";
import type { ModelAnalysis, StructuredEvidence } from "../providers/base.js";
import type { AnalyzeDocumentationCandidateResult, Audience, EntryType } from "../types.js";

export type AnalyzerEvidence = EventSnapshot & {
  headBranch?: string;
  prTitle?: string;
  prBody?: string;
  issueReferences?: string[];
};

export type AnalyzerInput = {
  projectId: string;
  evidence: AnalyzerEvidence[];
  existingFeatureKeys?: string[];
};

export type AnalyzerResult = AnalyzeDocumentationCandidateResult & {
  generatedNarratives: Pick<ModelAnalysis, "providerUsed" | "userGuide" | "adminGuide" | "developerNotes">;
};

type FeatureKeyResolution = {
  featureKey: string;
  dedupeDecision?: string;
  matchedExistingFeatureKey?: string | null;
};

export class ProviderOutputInvalidError extends Error {
  readonly code = "provider_output_invalid";

  constructor(message: string) {
    super(message);
    this.name = "ProviderOutputInvalidError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function numberValue(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function readBoolean(source: Record<string, unknown>, keys: string[], fallback: boolean): boolean {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "boolean") {
      return value;
    }
  }
  return fallback;
}

function readNumber(source: Record<string, unknown>, keys: string[], fallback: number): number {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }
  return fallback;
}

function readRecord(source: Record<string, unknown>, keys: string[]): Record<string, unknown> | null {
  for (const key of keys) {
    const value = source[key];
    if (isRecord(value)) {
      return value;
    }
  }
  return null;
}

function readString(source: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = stringValue(source[key]);
    if (value) {
      return value;
    }
  }
  return "";
}

function splitList(value: string): string[] {
  return value
    .split(/\r?\n|[,;]/)
    .map((item) => item.replace(/^\s*(?:[-*]|\d+\.)\s*/, "").trim())
    .filter(Boolean);
}

function readStringList(source: Record<string, unknown>, keys: string[]): string[] {
  for (const key of keys) {
    const value = source[key];
    if (Array.isArray(value)) {
      const items = value
        .map((item) => (typeof item === "string" ? item : isRecord(item) ? readString(item, ["text", "step", "description", "name"]) : ""))
        .filter(Boolean);
      if (items.length > 0) {
        return items;
      }
    }
    const text = stringValue(value);
    if (text) {
      return splitList(text);
    }
  }
  return [];
}

function readFirstStringFromSources(sources: Record<string, unknown>[], keys: string[]): string {
  for (const source of sources) {
    const value = readString(source, keys);
    if (value) {
      return value;
    }
  }
  return "";
}

function readFirstListFromSources(sources: Record<string, unknown>[], keys: string[]): string[] {
  for (const source of sources) {
    const value = readStringList(source, keys);
    if (value.length > 0) {
      return value;
    }
  }
  return [];
}

function valuesAsList(source: Record<string, unknown> | null): string[] {
  if (!source) {
    return [];
  }
  return Object.values(source)
    .map((value) => {
      if (typeof value === "string") {
        return value.trim();
      }
      if (Array.isArray(value)) {
        return value.filter((item): item is string => typeof item === "string").join("; ").trim();
      }
      return "";
    })
    .filter(Boolean);
}

function normalizeAudiences(value: unknown): ModelAnalysis["audiences"] {
  const raw = Array.isArray(value) ? value : typeof value === "string" ? splitList(value) : [];
  const audiences = new Set<ModelAnalysis["audiences"][number]>();
  for (const item of raw) {
    const normalized = String(item).trim().toLowerCase();
    if (normalized === "user" || normalized === "users") audiences.add("User");
    if (normalized === "admin" || normalized === "administrator" || normalized === "operators") audiences.add("Admin");
    if (normalized === "developer" || normalized === "developers") audiences.add("Developer");
    if (normalized === "support") audiences.add("Support");
  }
  return [...audiences];
}

function normalizeProviderOutput(raw: unknown, structuredEvidence: StructuredEvidence, inferredFeatureName: string): { analysis: ModelAnalysis; repairs: string[] } {
  if (!isRecord(raw)) {
    throw new ProviderOutputInvalidError("Provider output was not a JSON object.");
  }

  const userGuide = readRecord(raw, ["userGuide", "user_guide", "user", "userManual", "user_manual"]);
  const adminGuide = readRecord(raw, ["adminGuide", "admin_guide", "admin", "adminManual", "admin_manual"]);
  const configuration = readRecord(raw, ["configuration", "config", "settings"]);
  const workflowArchitecture = readRecord(raw, ["workflow_architecture", "workflowArchitecture", "workflow", "architecture"]);
  const technicalAnalysis = readRecord(raw, ["technical_analysis", "technicalAnalysis", "analysis"]);
  const implementationDetails = readRecord(raw, ["implementationDetails", "implementation_details"]);
  const impactAssessment = readRecord(raw, ["impact_assessment", "impactAssessment"]);
  const userSources = [
    userGuide,
    raw,
    workflowArchitecture,
    technicalAnalysis,
    implementationDetails,
    impactAssessment,
  ].filter(isRecord);
  const hasTopLevelUserFields = Boolean(
    readFirstStringFromSources(userSources, ["summary", "overview", "description", "change_summary", "diffSummary", "diff_summary", "objective"]) ||
      readFirstListFromSources(userSources, ["steps", "stepByStep", "instructions", "procedure", "workflow_pipeline", "workflowPipeline", "pipeline", "pipeline_steps", "pipelineSteps"]).length > 0,
  );
  if (!userGuide && !adminGuide && !hasTopLevelUserFields) {
    throw new ProviderOutputInvalidError("Provider output did not include a repairable userGuide or adminGuide object.");
  }

  const adminSource = adminGuide ?? configuration ?? {};
  const userSummary =
    readFirstStringFromSources(userSources, ["summary", "overview", "description", "change_summary", "diffSummary", "diff_summary", "objective"]) ||
    structuredEvidence.commitMessage;
  const explicitUserSteps = readFirstListFromSources(userSources, [
    "steps",
    "stepByStep",
    "instructions",
    "procedure",
    "workflow_pipeline",
    "workflowPipeline",
    "pipeline",
    "pipeline_steps",
    "pipelineSteps",
    "affected_modules",
    "affectedModules",
    "securityConsiderations",
  ]);
  const userSteps = explicitUserSteps.length > 0 ? explicitUserSteps : valuesAsList(implementationDetails);
  const expectedOutcome =
    readFirstStringFromSources(userSources, ["expectedOutcome", "expected_outcome", "expectedResult", "expected_result", "result", "outcome", "success"]) ||
    `The ${inferredFeatureName} workflow completes successfully.`;

  if (!userSummary || userSteps.length === 0) {
    throw new ProviderOutputInvalidError("Provider output could not be repaired into a user guide with summary and steps.");
  }

  const adminEnvVars = readStringList(adminSource, ["envVarsRequired", "envVars", "environmentVariables", "environment_variables", "env", "configuration"]);
  const repaired: ModelAnalysis = {
    featureName: readString(raw, ["featureName", "feature_name", "feature", "title", "name"]) || inferredFeatureName,
    featureKey: readString(raw, ["featureKey", "feature_key", "key"]) || createFeatureKey({ featureName: inferredFeatureName }),
    shouldDocument: readBoolean(raw, ["shouldDocument", "should_document"], true),
    audiences: normalizeAudiences(raw.audiences).length > 0 ? normalizeAudiences(raw.audiences) : ["User", ...(Object.keys(adminSource).length > 0 ? ["Admin" as const] : [])],
    userGuide: {
      summary: userSummary,
      steps: userSteps,
      expectedOutcome,
      possibleErrors: readFirstListFromSources(userSources, ["possibleErrors", "possible_errors", "errors", "troubleshooting", "failureModes", "failure_modes", "risk_assessment"]),
    },
    adminGuide: {
      configRequired: readStringList(adminSource, ["configRequired", "requirements", "configuration", "setup"]),
      endpointsAffected: readStringList(adminSource, ["endpointsAffected", "endpoints", "routes", "apiEndpoints"]),
      envVarsRequired: adminEnvVars,
      verificationSteps: readStringList(adminSource, ["verificationSteps", "verify", "validation", "checks"]),
      troubleshooting: readStringList(adminSource, ["troubleshooting", "errors", "failureModes"]),
    },
    developerNotes: readString(raw, ["developerNotes", "developer_notes", "implementationNotes"]) || undefined,
    confidenceScore: readNumber(raw, ["confidenceScore", "confidence_score"], 65),
    confidenceReasons: readStringList(raw, ["confidenceReasons", "confidence_reasons", "reasons"]).length > 0 ? readStringList(raw, ["confidenceReasons", "confidence_reasons", "reasons"]) : ["Provider output repaired into analyzer schema."],
    reviewQuestions: readStringList(raw, ["reviewQuestions", "review_questions", "questions"]),
    providerUsed: readString(raw, ["providerUsed", "provider_used", "provider"]) || "unknown-provider",
    generationMs: readNumber(raw, ["generationMs", "generation_ms"], 0),
  };

  const repairs: string[] = [];
  if (!isRecord(raw.userGuide) || !isRecord(raw.adminGuide)) {
    repairs.push("Provider output repaired: mapped alternate guide keys and filled missing schema fields.");
  }
  if (adminEnvVars.length > 0) {
    repaired.adminGuide.envVarsRequired = adminEnvVars.map((item) => item.replace(/`/g, "").trim()).filter(Boolean);
  }

  return { analysis: repaired, repairs };
}

function toTitleCase(input: string): string {
  return input
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1).toLowerCase()}`)
    .join(" ");
}

function inferFeatureNameFromEvidence(summaries: string[]): string {
  const first = summaries.find((summary) => summary.trim().length > 0) ?? "Captured Feature Update";
  const normalized = first
    .replace(/^(add|added|create|created|implement|implemented|update|updated|fix|fixed)\s+/i, "")
    .replace(/[\.;:].*$/, "")
    .trim();

  return toTitleCase(normalized || "Captured Feature Update");
}

function inferModuleFromEvidence(haystack: string): string | undefined {
  const checks: Array<[string, string]> = [
    ["auth", "Auth"],
    ["billing", "Billing"],
    ["admin", "Admin Panel"],
    ["report", "Reports"],
    ["api", "API"],
    ["frontend", "Frontend"],
    ["backend", "Backend"],
  ];

  for (const [needle, moduleName] of checks) {
    if (haystack.includes(needle)) {
      return moduleName;
    }
  }

  return undefined;
}

function inferRoute(filesChanged: string[], summaries: string[]): string | undefined {
  const routeFromFile = filesChanged.find((filePath) => filePath.includes("/routes/") || filePath.includes("\\routes\\"));
  if (routeFromFile) {
    const normalized = routeFromFile.replaceAll("\\", "/");
    const match = normalized.match(/routes\/(.+?)\.[a-z0-9]+$/i);
    if (match?.[1]) {
      return `/${match[1]}`;
    }
  }

  return summaries.join(" ").match(/\/(?:[a-z0-9\-_]+\/?)+/i)?.[0];
}

function inferMergedOrReleased(eventTypes: string[]): boolean {
  return eventTypes.includes("pr_merged") || eventTypes.includes("release_tagged");
}

function inferTestsPassed(testStatuses: Array<string | undefined>, eventTypes: string[]): boolean {
  return testStatuses.includes("passed") || eventTypes.includes("tests_passed");
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function extractRoutes(evidence: AnalyzerEvidence[]): string[] {
  const fromFiles = evidence
    .flatMap((snapshot) => snapshot.filesChanged)
    .map((filePath) => filePath.replaceAll("\\", "/"))
    .map((filePath) => filePath.match(/routes\/(.+?)\.[a-z0-9]+$/i)?.[1])
    .filter((value): value is string => Boolean(value))
    .map((route) => `/${route}`);
  const fromText = evidence.flatMap((snapshot) => (snapshot.summary + "\n" + (snapshot.diffSummary ?? "")).match(/\/(?:[a-z0-9\-_]+\/?)+/gi) ?? []);

  return unique([...fromFiles, ...fromText]).slice(0, 12);
}

function extractApiEndpoints(evidence: AnalyzerEvidence[]): string[] {
  return unique(
    evidence.flatMap((snapshot) => (snapshot.summary + "\n" + (snapshot.diffSummary ?? "")).match(/(?:GET|POST|PUT|PATCH|DELETE)\s+\/(?:[a-z0-9\-_]+\/?)+/gi) ?? []),
  ).slice(0, 12);
}

function extractEnvVars(evidence: AnalyzerEvidence[]): string[] {
  return unique(evidence.flatMap((snapshot) => (snapshot.summary + "\n" + (snapshot.diffSummary ?? "")).match(/\b[A-Z][A-Z0-9_]{2,}\b/g) ?? [])).slice(0, 12);
}

function extractDbMigrations(evidence: AnalyzerEvidence[]): string[] {
  return unique(evidence.flatMap((snapshot) => snapshot.filesChanged).filter((filePath) => /migration|prisma|schema|sql/i.test(filePath))).slice(0, 12);
}

function extractUiComponents(evidence: AnalyzerEvidence[]): string[] {
  return unique(evidence.flatMap((snapshot) => snapshot.filesChanged).filter((filePath) => /component|page|screen|view|tsx|jsx/i.test(filePath))).slice(0, 12);
}

function extractAuthPatterns(evidence: AnalyzerEvidence[]): string[] {
  return unique(
    evidence.flatMap((snapshot) => {
      const haystack = `${snapshot.summary}\n${snapshot.diffSummary ?? ""}`;
      return haystack.match(/oauth|auth|sso|permission|role|token|session/gi) ?? [];
    }),
  ).slice(0, 12);
}

function toStructuredEvidence(evidence: AnalyzerEvidence[]): StructuredEvidence {
  const first = evidence[0];
  return {
    diffSummary: evidence.map((item) => item.diffSummary ?? item.summary).join("\n\n").slice(0, 8000),
    filesChanged: unique(evidence.flatMap((item) => item.filesChanged)).slice(0, 100),
    routes: extractRoutes(evidence),
    apiEndpoints: extractApiEndpoints(evidence),
    envVars: extractEnvVars(evidence),
    dbMigrations: extractDbMigrations(evidence),
    uiComponents: extractUiComponents(evidence),
    authPatterns: extractAuthPatterns(evidence),
    branch: first?.branch ?? first?.headBranch ?? "unknown",
    commitMessage: first?.summary ?? "Captured feature update",
    prTitle: first?.prTitle,
    testStatus: first?.testStatus ?? "unknown",
  };
}

function mergeAudiences(deterministic: Audience[], providerAudiences: ModelAnalysis["audiences"]): Audience[] {
  const result = new Set<Audience>(deterministic);
  if (providerAudiences.includes("User")) {
    result.add("User");
  }

  if (providerAudiences.includes("Admin")) {
    result.add("Admin");
  }

  return Array.from(result);
}

function toEntryTypes(audiences: Audience[], hasDeveloperNotes: boolean): EntryType[] {
  const entries: EntryType[] = [];
  if (audiences.includes("User") || audiences.includes("Both")) {
    entries.push("User Guide");
  }

  if (audiences.includes("Admin") || audiences.includes("Both")) {
    entries.push("Admin Guide");
  }

  if (entries.length === 0 || hasDeveloperNotes) {
    entries.push("Developer Note");
  }

  return Array.from(new Set(entries));
}

function clampScore(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function resolveAnalyzerFeatureKey(input: {
  module?: string;
  featureName: string;
  route?: string;
  existingFeatureKeys?: string[];
}): FeatureKeyResolution {
  const routeKey = createFeatureKey({ module: input.module, featureName: input.featureName, route: input.route });
  if (!input.existingFeatureKeys?.includes(routeKey) || !input.route) {
    return { featureKey: routeKey };
  }

  return {
    featureKey: routeKey,
    dedupeDecision: "matched_existing_feature",
    matchedExistingFeatureKey: routeKey,
  };
}

export async function analyzeDocumentationCandidate(input: AnalyzerInput): Promise<AnalyzerResult> {
  const summaries = input.evidence.map((item) => item.summary);
  const filesChanged = input.evidence.flatMap((item) => item.filesChanged);
  const eventTypes = input.evidence.map((item) => item.eventType);
  const testStatuses = input.evidence.map((item) => item.testStatus);
  const prBodies = input.evidence
    .map((item) => item.prBody)
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0);
  const issueReferences = Array.from(new Set(input.evidence.flatMap((item) => item.issueReferences ?? [])));
  const inferredFeatureName = inferFeatureNameFromEvidence(summaries);
  const evidenceHaystack = `${summaries.join(" ")} ${filesChanged.join(" ")} ${prBodies.join(" ")} ${issueReferences.join(" ")}`.toLowerCase();
  const moduleName = inferModuleFromEvidence(evidenceHaystack);
  const route = inferRoute(filesChanged, summaries);
  const deterministicWorthiness = classifyManualWorthiness({
    summary: summaries.join("\n"),
    filesChanged,
  });
  const structuredEvidence = toStructuredEvidence(input.evidence);
  const deterministicProvider = new DeterministicProvider();
  const rawModelAnalysis = await analyzeWithFallback(structuredEvidence).catch(() => deterministicProvider.analyze(structuredEvidence));
  const normalized = normalizeProviderOutput(rawModelAnalysis, structuredEvidence, inferredFeatureName);
  const guardrailResult = validateAndSanitize(normalized.analysis);
  const sanitizedAnalysis = guardrailResult.passed ? guardrailResult.sanitized : await deterministicProvider.analyze(structuredEvidence);
  const resolvedFeatureName = sanitizedAnalysis.featureName?.trim() || inferredFeatureName;
  let resolvedFeatureKey = resolveAnalyzerFeatureKey({
    module: moduleName,
    featureName: resolvedFeatureName,
    route,
    existingFeatureKeys: input.existingFeatureKeys,
  });
  const runtime = getOptionalRuntimeConfig();
  if (runtime.embedding.provider !== "none") {
    await embeddingStore.load();
    const vector = await embedText([resolvedFeatureName, sanitizedAnalysis.userGuide.summary, structuredEvidence.diffSummary].join("\n")).catch(() => null);
    const similar = vector ? embeddingStore.findSimilar(vector) : null;
    if (similar && similar.featureKey !== resolvedFeatureKey.featureKey) {
      resolvedFeatureKey = {
        featureKey: similar.featureKey,
        dedupeDecision: "matched_existing_feature",
        matchedExistingFeatureKey: similar.featureKey,
      };
    }
  }

  const confidence = scoreDocumentationConfidence({
    manualWorthy: deterministicWorthiness.shouldDocument,
    featureNameMatched: summaries.join(" ").toLowerCase().includes(resolvedFeatureName.toLowerCase()),
    testsPassed: inferTestsPassed(testStatuses, eventTypes),
    mergedOrReleased: inferMergedOrReleased(eventTypes),
    concreteDocumentation: sanitizedAnalysis.userGuide.steps.length > 0 && sanitizedAnalysis.userGuide.expectedOutcome.trim().length > 0,
    ambiguousPurpose: !deterministicWorthiness.shouldDocument && !sanitizedAnalysis.shouldDocument,
    duplicateUncertain: resolvedFeatureKey.dedupeDecision !== "matched_existing_feature" && (input.existingFeatureKeys?.length ?? 0) > 0,
  });
  const audiences = mergeAudiences(deterministicWorthiness.audiences, sanitizedAnalysis.audiences);
  const generatedNarratives = {
    providerUsed: sanitizedAnalysis.providerUsed,
    userGuide: sanitizedAnalysis.userGuide,
    adminGuide: sanitizedAnalysis.adminGuide,
    developerNotes: sanitizedAnalysis.developerNotes,
  };

  return {
    shouldDocument: deterministicWorthiness.shouldDocument || sanitizedAnalysis.shouldDocument,
    featureKey: resolvedFeatureKey.featureKey,
    featureName: resolvedFeatureName,
    audiences,
    entryTypes: toEntryTypes(audiences, Boolean(sanitizedAnalysis.developerNotes)),
    confidenceScore: clampScore((confidence.score + sanitizedAnalysis.confidenceScore) / 2),
    confidenceReasons: [
      ...deterministicWorthiness.reasons,
      ...confidence.reasons,
      ...normalized.repairs,
      ...sanitizedAnalysis.confidenceReasons,
      ...(guardrailResult.passed ? [] : [...guardrailResult.violations, "Guardrail fallback applied to model output."]),
      ...(resolvedFeatureKey.dedupeDecision === "disambiguated_route_collision"
        ? [`Route key collision detected with ${resolvedFeatureKey.matchedExistingFeatureKey}; generated feature-specific key ${resolvedFeatureKey.featureKey}.`]
        : []),
      ...(issueReferences.length > 0 ? [`Issue references observed: ${issueReferences.join(", ")}`] : []),
      `Provider used: ${sanitizedAnalysis.providerUsed}`,
    ],
    reviewQuestions: Array.from(new Set([...confidence.reviewQuestions, ...sanitizedAnalysis.reviewQuestions])),
    fallbackStatus: null,
    fallbackEntryId: null,
    fallbackReasonCode: "none",
    dedupeDecision: resolvedFeatureKey.dedupeDecision,
    matchedExistingFeatureKey: resolvedFeatureKey.matchedExistingFeatureKey ?? null,
    generatedNarratives,
  };
}
