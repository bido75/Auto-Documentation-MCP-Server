import { describe, expect, it, vi } from "vitest";
import type { ProjectWebhookConfig } from "../../src/lib/state-store.js";
import { buildWebhookMessage, sendWebhookNotification } from "../../src/lib/webhook-notifier.js";

const config: ProjectWebhookConfig = {
  name: "default",
  url: "https://hooks.example.com/team/secret",
  platform: "slack",
  events: ["entries_need_review"],
  coverageDropThreshold: 70,
  createdAt: "2026-09-13T00:00:00.000Z",
  updatedAt: "2026-09-13T00:00:00.000Z",
};

describe("webhook notifier", () => {
  it("does not send events that are not enabled", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const result = await sendWebhookNotification(config, {
      event: "documentation_published",
      projectId: "project_1",
      details: { featureName: "Search", confidenceScore: 95 },
      timestamp: "2026-09-13T00:00:00.000Z",
    });

    expect(result).toEqual({ delivered: false, status: null, error: "event_not_enabled" });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("posts a platform-specific message body for enabled events", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok", { status: 200 }));
    const result = await sendWebhookNotification(config, {
      event: "entries_need_review",
      projectId: "project_1",
      projectName: "Example",
      details: { count: 2 },
      timestamp: "2026-09-13T00:00:00.000Z",
    });

    expect(result).toMatchObject({ delivered: true, status: 200 });
    expect(fetchSpy).toHaveBeenCalledWith(
      config.url,
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
      }),
    );
    const body = JSON.parse(String((fetchSpy.mock.calls[0]?.[1] as RequestInit | undefined)?.body));
    expect(body.blocks[0].text.text).toBe("Documentation entries need review");
    fetchSpy.mockRestore();
  });

  it("builds Teams-compatible cards", () => {
    const body = buildWebhookMessage("teams", {
      event: "coverage_dropped",
      projectId: "project_1",
      details: { coverage: 62 },
      timestamp: "2026-09-13T00:00:00.000Z",
    });

    expect(body).toMatchObject({
      "@type": "MessageCard",
      summary: "Documentation coverage dropped",
    });
  });
});
