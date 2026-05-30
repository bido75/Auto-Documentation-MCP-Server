import { describe, expect, it } from "vitest";
import { createFeatureKey, resolveFeatureKey } from "../../src/analysis/feature-key.js";

describe("createFeatureKey", () => {
  it("creates a stable key from module and feature name", () => {
    expect(createFeatureKey({ module: "Billing", featureName: "Invoice Export" })).toBe("billing:invoice-export");
  });

  it("prefers route when route is available", () => {
    expect(createFeatureKey({ module: "Billing", featureName: "Invoice Export", route: "/billing/invoices" })).toBe(
      "route:billing-invoices",
    );
  });

  it("disambiguates same-route features when the route is broader than the feature name", () => {
    expect(createFeatureKey({ module: "Billing", featureName: "Invoice Export", route: "/billing/settings" })).toBe(
      "route:billing-settings:invoice-export",
    );
  });

  it("reports when a route collision was disambiguated against an existing feature key", () => {
    expect(
      resolveFeatureKey({
        module: "Billing",
        featureName: "Invoice Export",
        route: "/billing/settings",
        existingFeatureKeys: ["route:billing-settings"],
      }),
    ).toEqual({
      featureKey: "route:billing-settings:invoice-export",
      dedupeDecision: "disambiguated_route_collision",
      matchedExistingFeatureKey: "route:billing-settings",
      routeBaseKey: "route:billing-settings",
    });
  });
});
