export function resolveFeatureKey(featureName: string, moduleName?: string, route?: string): string {
  const slug = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (route) {
    return `route:${slug(route)}`;
  }

  return `${moduleName ? slug(moduleName) : "general"}:${slug(featureName)}`;
}