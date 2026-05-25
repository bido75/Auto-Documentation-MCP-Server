import { describe, expect, it } from "vitest";
import { createFeatureKey } from "../../src/analysis/feature-key.js";

describe("createFeatureKey", () => {
  it("creates a stable key from module and feature name", () => {
    expect(createFeatureKey({ module: "Billing", featureName: "Invoice Export" })).toBe("billing:invoice-export");
  });

  it("prefers route when route is available", () => {
    expect(createFeatureKey({ module: "Billing", featureName: "Invoice Export", route: "/billing/invoices" })).toBe(
      "route:billing-invoices",
    );
  });
});
