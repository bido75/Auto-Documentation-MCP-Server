import { scoreDocumentationConfidence } from "../analysis/confidence.js";
import { resolveFeatureKey, type FeatureKeyDedupeDecision } from "../analysis/feature-key.js";
import { classifyManualWorthiness } from "../analysis/manual-worthiness.js";
import type { GeneratedDocumentationNarratives } from "../types.js";
import { getOptionalRuntimeConfig } from "../config.js";
import { embeddingStore } from "./embedding-store.js";
import { validateAndSanitize } from "./guardrail.js";
import type { EventSnapshot } from "./state-store.js";
import { analyzeWithFallback, embedText } from "../providers/factory.js";
import { DeterministicProvider } from "../providers/deterministic.js";
import type { StructuredEvidence } from "../providers/base.js";

export interface HybridAnalysisResult {
  shouldDocument: boolean;
  featureKey: string;
  featureName: string;
  audiences: Array<"User" | "Admin" | "Both" | "Internal">;
  entryTypes: Array<"User Guide" | "Admin Guide" | "Developer Note" | "Release Note">;
  confidenceScore: number;
  confidenceReasons: string[];
  reviewQuestions: string[];
  dedupeDecision: FeatureKeyDedupeDecision;
  matchedExistingFeatureKey: string | null;
  generatedNarratives: GeneratedDocumentationNarratives | null;
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

function extractRoutes(evidence: EventSnapshot[]): string[] {
  const fromFiles = evidence
    .flatMap((snapshot) => snapshot.filesChanged)
    .map((filePath) => filePath.replaceAll("\\", "/"))
    .map((filePath) => filePath.match(/routes\/(.+?)\.[a-z0-9]+$/i)?.[1])
    .filter((value): value is string => Boolean(value))
    .map((route) => `/${route}`);

  const fromText = evidence.flatMap((snapshot) => (snapshot.summary + "\n" + (snapshot.diffSummary ?? "")).match(/\/(?:[a-z0-9\-_]+\/?)+/gi) ?? []);
  return unique([...fromFiles, ...fromText]).slice(0, 12);
}

function extractApiEndpoints(evidence: EventSnapshot[]): string[] {
  return unique(
    evidence.flatMap((snapshot) => (snapshot.summary + "\n" + (snapshot.diffSummary ?? "")).match(/(?:GET|POST|PUT|PATCH|DELETE)\s+\/(?:[a-z0-9\-_]+\/?)+/gi) ?? []),
  ).slice(0, 12);
}

function extractEnvVars(evidence: EventSnapshot[]): string[] {
  return unique(
    evidence.flatMap((snapshot) => (snapshot.summary + "\n" + (snapshot.diffSummary ?? "")).match(/\b[A-Z][A-Z0-9_]{2,}\b/g) ?? []),
  ).slice(0, 12);
}

function extractDbMigrations(evidence: EventSnapshot[]): string[] {
  return unique(
    evidence
      .flatMap((snapshot) => snapshot.filesChanged)
      .filter((filePath) => /migration|prisma|schema|sql/i.test(filePath)),
  ).slice(0, 12);
}

function extractUiComponents(evidence: EventSnapshot[]): string[] {
  return unique(
    evidence
      .flatMap((snapshot) => snapshot.filesChanged)
      .filter((filePath) => /component|page|screen|view|tsx|jsx/i.test(filePath)),
  ).slice(0, 12);
}

function extractAuthPatterns(evidence: EventSnapshot[]): string[] {
  return unique(
    evidence.flatMap((snapshot) => {
      const haystack = `${snapshot.summary}\n${snapshot.diffSummary ?? ""}`;
      return haystack.match(/oauth|auth|sso|permission|role|token|session/gi) ?? [];
    }),
  ).slice(0, 12);
}

function toStructuredEvidence(evidence: EventSnapshot[]): StructuredEvidence {
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
    testStatus: (first?.testStatus ?? "unknown") as StructuredEvidence["testStatus"],
  };
}

function mergeAudiences(
  deterministic: Array<"User" | "Admin" | "Both" | "Internal">,
  providerAudiences: Array<"User" | "Admin" | "Developer" | "Support">,
): Array<"User" | "Admin" | "Both" | "Internal"> {
  const result = new Set<"User" | "Admin" | "Both" | "Internal">(deterministic);
  if (providerAudiences.includes("User")) {
    result.add("User");
  }
  if (providerAudiences.includes("Admin")) {
    result.add("Admin");
  }
  return Array.from(result);
}

function toEntryTypes(audiences: Array<"User" | "Admin" | "Both" | "Internal">, hasDeveloperNotes: boolean) {
  const entries: Array<"User Guide" | "Admin Guide" | "Developer Note" | "Release Note"> = [];
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

export async function analyzeDocumentationCandidate(input: {
  evidence: EventSnapshot[];
  existingFeatureKeys?: string[];
}): Promise<HybridAnalysisResult> {
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
  const rawModelAnalysis = await analyzeWithFallback(structuredEvidence);
  const guardrailResult = validateAndSanitize(rawModelAnalysis);
  const sanitizedAnalysis = guardrailResult.passed
    ? guardrailResult.sanitized
    : await deterministicProvider.analyze(structuredEvidence);

  const resolvedFeatureName = sanitizedAnalysis.featureName?.trim() || inferredFeatureName;
  let resolvedFeatureKey = resolveFeatureKey({
    module: moduleName,
    featureName: resolvedFeatureName,
    route,
    existingFeatureKeys: input.existingFeatureKeys,
  });

  const runtime = getOptionalRuntimeConfig();
  if (runtime.embedding.provider !== "none") {
    await embeddingStore.load();
    const vector = await embedText([
      resolvedFeatureName,
      sanitizedAnalysis.userGuide.summary,
      structuredEvidence.diffSummary,
    ].join("\n")).catch(() => null);

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
    concreteDocumentation:
      sanitizedAnalysis.userGuide.steps.length > 0 && sanitizedAnalysis.userGuide.expectedOutcome.trim().length > 0,
    ambiguousPurpose: !deterministicWorthiness.shouldDocument && !sanitizedAnalysis.shouldDocument,
    duplicateUncertain:
      resolvedFeatureKey.dedupeDecision !== "matched_existing_feature" && (input.existingFeatureKeys?.length ?? 0) > 0,
  });

  const audiences = mergeAudiences(deterministicWorthiness.audiences, sanitizedAnalysis.audiences);
  const generatedNarratives: GeneratedDocumentationNarratives = {
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
      ...sanitizedAnalysis.confidenceReasons,
      ...(guardrailResult.passed ? [] : [...guardrailResult.violations, "Guardrail fallback applied to model output."]),
      ...(resolvedFeatureKey.dedupeDecision === "disambiguated_route_collision"
        ? [
            `Route key collision detected with ${resolvedFeatureKey.matchedExistingFeatureKey}; generated feature-specific key ${resolvedFeatureKey.featureKey}.`,
          ]
        : []),
      ...(issueReferences.length > 0 ? [`Issue references observed: ${issueReferences.join(", ")}`] : []),
      `Provider used: ${sanitizedAnalysis.providerUsed}`,
    ],
    reviewQuestions: Array.from(new Set([...confidence.reviewQuestions, ...sanitizedAnalysis.reviewQuestions])),
    dedupeDecision: resolvedFeatureKey.dedupeDecision,
    matchedExistingFeatureKey: resolvedFeatureKey.matchedExistingFeatureKey ?? null,
    generatedNarratives,
  };
}