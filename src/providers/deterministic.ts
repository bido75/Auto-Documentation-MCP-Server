import type { ModelAnalysis, ModelProvider, StructuredEvidence } from "./base.js";

function sanitizeFeatureName(input: string): string {
  const normalized = input
    .replace(/^(feat|fix|chore|refactor|add|added|update|updated|implement|implemented)[\s(:-]+/i, "")
    .replace(/[\r\n]+/g, " ")
    .trim();
  return normalized.slice(0, 80) || "Undescribed Change";
}

function createFeatureKey(source: string): string {
  return source.replace(/[^a-z0-9/-]+/gi, "-").replace(/-+/g, "-").toLowerCase().replace(/^-|-$/g, "").slice(0, 80) || "general-undescribed-change";
}

export class DeterministicProvider implements ModelProvider {
  readonly id = "deterministic";
  readonly displayName = "Deterministic (Rule-Based)";
  readonly supportsEmbeddings = false;

  async healthCheck(): Promise<boolean> {
    return true;
  }

  async analyze(ev: StructuredEvidence): Promise<ModelAnalysis> {
    const startedAt = Date.now();
    const audiences: Array<"User" | "Admin" | "Developer" | "Support"> = [];
    const hasUserSignals = ev.routes.length > 0 || ev.uiComponents.length > 0;
    const hasAdminSignals = ev.apiEndpoints.length > 0 || ev.envVars.length > 0 || ev.dbMigrations.length > 0;

    if (hasUserSignals) audiences.push("User");
    if (hasAdminSignals) audiences.push("Admin");
    if (audiences.length === 0) audiences.push("Developer");

    let score = 40;
    if (ev.routes.length > 0) score += 15;
    if (ev.uiComponents.length > 0) score += 10;
    if (ev.apiEndpoints.length > 0) score += 10;
    if (ev.testStatus === "passed") score += 10;
    if (ev.prTitle) score += 10;
    if (ev.dbMigrations.length > 0) score += 5;
    score = Math.min(score, 100);

    const featureName = sanitizeFeatureName(ev.prTitle ?? ev.commitMessage);
    const featureKey = createFeatureKey(ev.routes[0] ?? ev.filesChanged[0] ?? featureName);

    return {
      featureName,
      featureKey,
      shouldDocument: score >= 50,
      audiences,
      userGuide: {
        summary: `This update ${ev.routes.length > 0 ? `adds or changes the page at ${ev.routes[0]}` : "changes application behavior"}.`,
        steps: ev.routes.length > 0
          ? [`Navigate to ${ev.routes[0]}`, "Complete the required fields or actions", "Submit or confirm to proceed"]
          : ["Open the updated workflow in the application and follow the new behavior."],
        expectedOutcome: "The feature behaves as described and returns the expected result.",
        possibleErrors: ["Verify required fields are complete", "Check permissions if access is denied"],
      },
      adminGuide: {
        configRequired: ev.envVars.length > 0 ? ev.envVars : ["No new configuration required"],
        endpointsAffected: ev.apiEndpoints,
        envVarsRequired: ev.envVars,
        verificationSteps: ["Confirm the endpoint responds correctly", "Verify logs show no errors after deploy"],
        troubleshooting: ev.dbMigrations.length > 0 ? ["Run pending database migrations before deploy"] : [],
      },
      confidenceScore: score,
      confidenceReasons: [`Routes detected: ${ev.routes.length}`, `Endpoints detected: ${ev.apiEndpoints.length}`, `Tests: ${ev.testStatus}`],
      reviewQuestions: score < 75 ? ["What is the intended user-facing behavior?", "Which user roles can access this feature?"] : [],
      providerUsed: this.id,
      generationMs: Date.now() - startedAt,
    };
  }
}