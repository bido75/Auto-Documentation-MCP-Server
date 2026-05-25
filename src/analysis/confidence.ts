export interface ConfidenceInput {
  manualWorthy: boolean;
  featureNameMatched: boolean;
  testsPassed: boolean;
  mergedOrReleased: boolean;
  concreteDocumentation: boolean;
  ambiguousPurpose: boolean;
  duplicateUncertain: boolean;
}

export interface ConfidenceResult {
  score: number;
  reasons: string[];
  reviewQuestions: string[];
}

export function scoreDocumentationConfidence(input: ConfidenceInput): ConfidenceResult {
  let score = input.manualWorthy ? 40 : 0;
  const reasons: string[] = [];
  const reviewQuestions: string[] = [];

  if (input.featureNameMatched) {
    score += 15;
    reasons.push("Feature name matched source evidence.");
  }

  if (input.testsPassed) {
    score += 15;
    reasons.push("Tests passed.");
  }

  if (input.mergedOrReleased) {
    score += 15;
    reasons.push("Change is merged or release-tagged.");
  }

  if (input.concreteDocumentation) {
    score += 15;
    reasons.push("Generated documentation includes concrete usage details.");
  }

  if (input.ambiguousPurpose) {
    score -= 20;
    reviewQuestions.push("What exact user or admin behavior changed?");
  }

  if (input.duplicateUncertain) {
    score -= 15;
    reviewQuestions.push("Should this update an existing feature instead of creating a new entry?");
  }

  return {
    score: Math.max(0, Math.min(100, score)),
    reasons,
    reviewQuestions,
  };
}
