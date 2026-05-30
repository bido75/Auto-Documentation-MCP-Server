function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function normalizeToken(token: string): string {
  return token.endsWith("s") && token.length > 3 ? token.slice(0, -1) : token;
}

const GENERIC_FEATURE_TOKENS = new Set(["page", "screen", "view", "workflow", "flow", "tab", "panel"]);
const GENERIC_ROUTE_TOKENS = new Set(["settings", "setting", "index", "home", "dashboard", "overview", "manage"]);

export type FeatureKeyDedupeDecision =
  | "matched_existing_feature"
  | "new_feature_candidate"
  | "disambiguated_route_collision";

export interface ResolvedFeatureKey {
  featureKey: string;
  dedupeDecision: FeatureKeyDedupeDecision;
  matchedExistingFeatureKey?: string;
  routeBaseKey?: string;
}

function toRelevantTokens(value: string): string[] {
  return slug(value)
    .split("-")
    .map(normalizeToken)
    .filter((token) => token.length > 0 && !GENERIC_FEATURE_TOKENS.has(token));
}

function routeDescribesFeature(route: string, featureName: string): boolean {
  const routeTokens = toRelevantTokens(route);
  const featureTokens = toRelevantTokens(featureName);

  if (routeTokens.length === 0 || featureTokens.length === 0) {
    return true;
  }

  const routeLeaf = routeTokens[routeTokens.length - 1];
  if (!routeLeaf || GENERIC_ROUTE_TOKENS.has(routeLeaf)) {
    return false;
  }

  const routeTokenSet = new Set(routeTokens);
  const featureTokenSet = new Set(featureTokens);
  const sharedTokenCount = featureTokens.filter((token) => routeTokenSet.has(token)).length;

  return sharedTokenCount > 0;
}

export function createFeatureKey(input: { module?: string; featureName: string; route?: string }): string {
  if (input.route) {
    const routeKey = `route:${slug(input.route)}`;
    return routeDescribesFeature(input.route, input.featureName)
      ? routeKey
      : `${routeKey}:${slug(input.featureName)}`;
  }

  const moduleName = input.module ? slug(input.module) : "general";
  return `${moduleName}:${slug(input.featureName)}`;
}

export function resolveFeatureKey(input: {
  module?: string;
  featureName: string;
  route?: string;
  existingFeatureKeys?: string[];
}): ResolvedFeatureKey {
  const featureKey = createFeatureKey(input);
  const existingFeatureKeys = input.existingFeatureKeys ?? [];
  const routeBaseKey = input.route ? `route:${slug(input.route)}` : undefined;

  if (existingFeatureKeys.includes(featureKey)) {
    return {
      featureKey,
      dedupeDecision: "matched_existing_feature",
      matchedExistingFeatureKey: featureKey,
      routeBaseKey,
    };
  }

  if (routeBaseKey && featureKey !== routeBaseKey && existingFeatureKeys.includes(routeBaseKey)) {
    return {
      featureKey,
      dedupeDecision: "disambiguated_route_collision",
      matchedExistingFeatureKey: routeBaseKey,
      routeBaseKey,
    };
  }

  return {
    featureKey,
    dedupeDecision: "new_feature_candidate",
    routeBaseKey,
  };
}
