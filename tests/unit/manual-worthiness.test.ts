import { describe, expect, it } from "vitest";
import { classifyManualWorthiness } from "../../src/analysis/manual-worthiness.js";

describe("classifyManualWorthiness", () => {
  it("marks UI routes and components as user manual worthy", () => {
    const result = classifyManualWorthiness({
      summary: "Added billing settings page with invoice export button",
      filesChanged: ["src/routes/billing/settings.tsx", "src/components/InvoiceExport.tsx"],
    });

    expect(result.shouldDocument).toBe(true);
    expect(result.audiences).toContain("User");
    expect(result.reasons).toContain("User-facing workflow or UI change detected.");
  });

  it("marks environment and webhook changes as admin manual worthy", () => {
    const result = classifyManualWorthiness({
      summary: "Added Stripe webhook secret and retry configuration",
      filesChanged: ["src/api/webhooks/stripe.ts", ".env.example"],
    });

    expect(result.shouldDocument).toBe(true);
    expect(result.audiences).toContain("Admin");
    expect(result.reasons).toContain("Admin configuration or integration change detected.");
  });

  it("ignores formatting-only changes", () => {
    const result = classifyManualWorthiness({
      summary: "Format code with prettier",
      filesChanged: ["src/components/Button.tsx"],
    });

    expect(result.shouldDocument).toBe(false);
    expect(result.reasons).toContain("Change appears internal or formatting-only.");
  });
});
