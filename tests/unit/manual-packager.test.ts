import { describe, expect, it } from "vitest";
import { buildMarkdownManual } from "../../src/packaging/manual-packager.js";

describe("buildMarkdownManual", () => {
  it("packages published and approved entries by audience", () => {
    const markdown = buildMarkdownManual({
      projectName: "Acme App",
      releaseVersion: "1.0.0",
      audience: "User",
      entries: [
        { title: "Invoice Export", body: "Open Billing and click Export.", audience: "User", status: "Published" },
        { title: "CSV Download", body: "Choose date range and download CSV.", audience: "User", status: "Approved" },
        { title: "Webhook Setup", body: "Set STRIPE_WEBHOOK_SECRET.", audience: "Admin", status: "Published" },
      ],
    });

    expect(markdown).toContain("# Acme App - 1.0.0 Manual");
    expect(markdown).toContain("## User Guide");
    expect(markdown).toContain("## Admin Guide");
    expect(markdown).toContain("## What's New in 1.0.0");
    expect(markdown).toContain("### Invoice Export");
    expect(markdown).toContain("### CSV Download");
    expect(markdown).toContain("No entries available.");
    expect(markdown).toContain("- Webhook Setup");
  });
});
