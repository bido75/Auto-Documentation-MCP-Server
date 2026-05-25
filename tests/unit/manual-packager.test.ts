import { describe, expect, it } from "vitest";
import { buildMarkdownManual } from "../../src/packaging/manual-packager.js";

describe("buildMarkdownManual", () => {
  it("packages published entries by audience", () => {
    const markdown = buildMarkdownManual({
      projectName: "Acme App",
      releaseVersion: "1.0.0",
      audience: "User",
      entries: [
        { title: "Invoice Export", body: "Open Billing and click Export.", audience: "User", status: "Published" },
        { title: "Webhook Setup", body: "Set STRIPE_WEBHOOK_SECRET.", audience: "Admin", status: "Published" },
      ],
    });

    expect(markdown).toContain("# Acme App User Manual - 1.0.0");
    expect(markdown).toContain("## Invoice Export");
    expect(markdown).not.toContain("Webhook Setup");
  });
});
