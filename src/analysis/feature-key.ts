function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function createFeatureKey(input: { module?: string; featureName: string; route?: string }): string {
  if (input.route) {
    return `route:${slug(input.route)}`;
  }

  const moduleName = input.module ? slug(input.module) : "general";
  return `${moduleName}:${slug(input.featureName)}`;
}
