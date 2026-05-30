import type { EventSnapshot } from "../lib/state-store.js";
import type { GeneratedDocumentationNarratives } from "../types.js";
import type { EntryType } from "../types.js";

type NarrativeEntry = {
  entryType: EntryType;
  title: string;
  userGuide: string;
  adminGuide: string;
  developerNotes?: string;
  routes: string[];
  apiEndpoints: string[];
};

function compactWhitespace(input: string): string {
  return input.replace(/\s+/g, " ").trim();
}

function unique(items: string[]): string[] {
  return Array.from(new Set(items.map((item) => item.trim()).filter((item) => item.length > 0)));
}

function inferRoutes(snapshot: EventSnapshot): string[] {
  const routesFromFiles = snapshot.filesChanged
    .map((filePath) => filePath.replaceAll("\\", "/"))
    .map((filePath) => filePath.match(/routes\/(.+?)\.[a-z0-9]+$/i)?.[1])
    .filter((value): value is string => Boolean(value))
    .map((value) => `/${value}`);

  const routesFromText = (snapshot.summary + "\n" + (snapshot.diffSummary ?? ""))
    .match(/\/(?:[a-z0-9\-_]+\/?)+/gi) ?? [];

  return unique([...routesFromFiles, ...routesFromText]).slice(0, 6);
}

function inferApiEndpoints(snapshot: EventSnapshot): string[] {
  const endpointsFromText = (snapshot.summary + "\n" + (snapshot.diffSummary ?? ""))
    .match(/(?:GET|POST|PUT|PATCH|DELETE)\s+\/(?:[a-z0-9\-_]+\/?)+/gi) ?? [];

  const endpointsFromFiles = snapshot.filesChanged
    .map((filePath) => filePath.replaceAll("\\", "/"))
    .filter((filePath) => filePath.includes("/api/") || filePath.includes("/controllers/"))
    .map((filePath) => `Possible endpoint from ${filePath}`);

  return unique([...endpointsFromText, ...endpointsFromFiles]).slice(0, 8);
}

function summarizeDiff(snapshot: EventSnapshot): string {
  const summary = compactWhitespace(snapshot.summary);
  const diff = compactWhitespace((snapshot.diffSummary ?? "").slice(0, 1200));
  if (diff.length === 0) {
    return summary;
  }

  return `${summary}. ${diff}`;
}

function buildUserNarrative(featureName: string, snapshot: EventSnapshot, routes: string[]): string {
  const whereToGo = routes.length > 0 ? routes.join(", ") : "the updated screen or workflow in the app";
  const outcome = summarizeDiff(snapshot);

  return [
    `What users can do now:\n${featureName} is now available for end users.`,
    `Where to go:\nNavigate to ${whereToGo}.`,
    "What action to take:\nFollow the updated UI flow and complete the primary action introduced by this feature.",
    `Expected result:\n${outcome}`,
    "Errors or edge states:\nIf permissions, required fields, or dependencies are missing, users may see validation or access errors; retry after resolving prerequisites.",
  ].join("\n\n");
}

function buildAdminNarrative(featureName: string, snapshot: EventSnapshot, endpoints: string[]): string {
  const endpointLine =
    endpoints.length > 0
      ? `Relevant endpoints and signals:\n${endpoints.join("\n")}`
      : "Relevant endpoints and signals:\nNo explicit endpoints were inferred from this change.";

  return [
    `What must be configured:\nReview configuration, permissions, and environment dependencies required for ${featureName}.`,
    "Permissions and integrations:\nConfirm required roles, tokens, webhooks, and service connections are available in the target environment.",
    `Operational workflow change:\n${summarizeDiff(snapshot)}`,
    "How to verify:\nRun the updated flow in a staging environment and confirm expected behavior, logs, and downstream effects.",
    `Troubleshooting:\n${endpointLine}`,
  ].join("\n\n");
}

function toFallbackEntryTypes(entryTypes: EntryType[]): EntryType[] {
  if (entryTypes.length > 0) {
    return entryTypes;
  }

  return ["Developer Note"];
}

export function buildNarrativeManualEntries(input: {
  entryTypes: EntryType[];
  featureName: string;
  snapshot: EventSnapshot;
  generatedNarratives?: GeneratedDocumentationNarratives | null;
}): NarrativeEntry[] {
  const resolvedTypes = toFallbackEntryTypes(input.entryTypes);
  const routes = inferRoutes(input.snapshot);
  const apiEndpoints = inferApiEndpoints(input.snapshot);
  const userNarrative = input.generatedNarratives
    ? [
        `What users can do now:\n${input.generatedNarratives.userGuide.summary}`,
        `Where to go:\n${routes.join("\n") || "Open the updated workflow in the app."}`,
        `What action to take:\n${input.generatedNarratives.userGuide.steps.join("\n") || "Follow the updated workflow."}`,
        `Expected result:\n${input.generatedNarratives.userGuide.expectedOutcome}`,
        `Errors or edge states:\n${input.generatedNarratives.userGuide.possibleErrors.join("\n") || "No additional edge states were inferred."}`,
      ].join("\n\n")
    : buildUserNarrative(input.featureName, input.snapshot, routes);
  const adminNarrative = input.generatedNarratives
    ? [
        `What must be configured:\n${input.generatedNarratives.adminGuide.configRequired.join("\n") || "No new configuration required."}`,
        `Permissions and integrations:\n${input.generatedNarratives.adminGuide.envVarsRequired.join("\n") || "No additional permissions or integrations were inferred."}`,
        `Operational workflow change:\n${input.generatedNarratives.adminGuide.endpointsAffected.join("\n") || summarizeDiff(input.snapshot)}`,
        `How to verify:\n${input.generatedNarratives.adminGuide.verificationSteps.join("\n") || "Run the updated flow in staging."}`,
        `Troubleshooting:\n${input.generatedNarratives.adminGuide.troubleshooting.join("\n") || "Inspect logs and downstream integrations for failures."}`,
      ].join("\n\n")
    : buildAdminNarrative(input.featureName, input.snapshot, apiEndpoints);

  return resolvedTypes.map((entryType) => ({
    entryType,
    title: `${input.featureName} - ${entryType}`,
    userGuide: entryType === "User Guide" ? userNarrative : `No direct user guide narrative was inferred for ${entryType}.`,
    adminGuide: entryType === "Admin Guide" ? adminNarrative : `No direct admin guide narrative was inferred for ${entryType}.`,
    developerNotes:
      entryType === "Developer Note" || entryType === "Release Note"
        ? input.generatedNarratives?.developerNotes ??
          [
            `Feature: ${input.featureName}`,
            `Source summary: ${input.snapshot.summary}`,
            input.snapshot.diffSummary ? `Diff summary:\n${input.snapshot.diffSummary.slice(0, 1500)}` : "",
          ]
            .filter(Boolean)
            .join("\n\n")
        : undefined,
    routes,
    apiEndpoints: input.generatedNarratives?.adminGuide.endpointsAffected ?? apiEndpoints,
  }));
}
