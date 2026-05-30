import { describe, expect, it } from "vitest";
import {
  buildStatusPanelHtml,
  createErrorStatusPanelState,
  createLoadingStatusPanelState,
  createReadyStatusPanelState,
} from "../../packages/vscode-extension/src/ui/status-panel";

describe("buildStatusPanelHtml", () => {
  it("renders status counts and health", () => {
    const html = buildStatusPanelHtml(
      createReadyStatusPanelState({
      health: "healthy",
      publishedCount: 12,
      needsReviewCount: 3,
      capturedCount: 5,
      lowConfidenceCount: 1,
      missingReviewQuestions: ["Which roles need review access?"],
      forcedQueueReasons: [
        "Webhook Setup: Forced queue review: low-confidence dedupe match (matched_existing_feature against route:webhooks-settings).",
        "Admin Notifications: Forced queue review: low-confidence dedupe match (disambiguated_route_collision against route:notifications-settings).",
      ],
      traceId: "trace-123",
      }),
    );

    expect(html).toContain("Auto-Doc Documentation Status");
    expect(html).toContain("healthy");
    expect(html).toContain(">12<");
    expect(html).toContain(">3<");
    expect(html).toContain(">5<");
    expect(html).toContain(">1<");
    expect(html).toContain("Trace ID: trace-123");
    expect(html).toContain("Which roles need review access?");
    expect(html).toContain("Forced Queue Reasons");
    expect(html).toContain("Webhook Setup: Forced queue review: low-confidence dedupe match");
    expect(html).toContain("Matched Existing Feature");
    expect(html).toContain("Route Collision");
    expect(html).toContain('title="Deduplication code: matched_existing_feature"');
    expect(html).toContain('title="Deduplication code: disambiguated_route_collision"');
    expect(html).toContain("badge matched");
    expect(html).toContain("badge collision");
    expect(html).toContain("Refresh");
    expect(html).toContain("Copy Trace ID");
  });

  it("renders a partial-data warning when status fields are missing", () => {
    const html = buildStatusPanelHtml(createReadyStatusPanelState({}));

    expect(html).toContain("Partial status");
    expect(html).toContain("Missing fields: health, publishedCount, needsReviewCount, capturedCount, lowConfidenceCount");
    expect(html).toContain("Health:</strong> unknown");
    expect(html).toContain(">0<");
    expect(html).toContain("No forced queue reasons.");
  });

  it("renders loading state for refresh operations", () => {
    const html = buildStatusPanelHtml(createLoadingStatusPanelState("Refreshing documentation status..."));

    expect(html).toContain("Refreshing");
    expect(html).toContain("Refreshing documentation status...");
  });

  it("renders explicit error details when status loading fails", () => {
    const html = buildStatusPanelHtml(
      createErrorStatusPanelState("NOTION_TOKEN is missing.", {
        details: "Code: DOCUMENTATION_STATUS_FAILED\nRemediation: Set NOTION_TOKEN before starting the server.",
        traceId: "trace-error-1",
        allowSetupAction: true,
        allowSettingsAction: true,
      }),
    );

    expect(html).toContain("Status unavailable");
    expect(html).toContain("NOTION_TOKEN is missing.");
    expect(html).toContain("DOCUMENTATION_STATUS_FAILED");
    expect(html).toContain("Trace ID: trace-error-1");
    expect(html).toContain("Run Setup Wizard");
    expect(html).toContain("Open Settings");
    expect(html).toContain("Copy Trace ID");
  });
});
