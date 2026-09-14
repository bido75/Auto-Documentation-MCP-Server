import type { ProjectWebhookConfig, WebhookEvent, WebhookPlatform } from "./state-store.js";

export interface WebhookPayload {
  event: WebhookEvent;
  projectId: string;
  projectName?: string;
  details: Record<string, unknown>;
  timestamp: string;
}

export interface WebhookDeliveryResult {
  delivered: boolean;
  status: number | null;
  error?: string;
}

function eventTitle(event: WebhookEvent): string {
  return {
    entries_need_review: "Documentation entries need review",
    coverage_dropped: "Documentation coverage dropped",
    circuit_opened: "Documentation runner circuit opened",
    documentation_published: "New documentation published",
    runner_recovered: "Documentation runner recovered",
  }[event];
}

function eventText(event: WebhookEvent, details: Record<string, unknown>): string {
  switch (event) {
    case "entries_need_review":
      return `${details.count ?? 1} documentation entries are waiting for review. Open Notion to approve or edit them.`;
    case "coverage_dropped":
      return `Documentation coverage is ${details.coverage ?? "unknown"}%. Run probe_application and generate_gap_report to close gaps.`;
    case "circuit_opened":
      return `The documentation runner paused for ${details.targetId ?? "a target"} after repeated failures.`;
    case "documentation_published":
      return `"${details.featureName ?? "Documentation"}" was published with ${details.confidenceScore ?? "unknown"} confidence.`;
    case "runner_recovered":
      return `The documentation runner for ${details.targetId ?? "a target"} recovered and is documenting again.`;
  }
}

function eventColor(event: WebhookEvent): string {
  return {
    entries_need_review: "#F5A623",
    coverage_dropped: "#D0021B",
    circuit_opened: "#D0021B",
    documentation_published: "#2E8540",
    runner_recovered: "#2E8540",
  }[event];
}

export function buildWebhookMessage(platform: WebhookPlatform, payload: WebhookPayload): unknown {
  const title = eventTitle(payload.event);
  const text = eventText(payload.event, payload.details);
  const projectLabel = payload.projectName ?? payload.projectId;

  if (platform === "slack") {
    return {
      text: title,
      blocks: [
        { type: "header", text: { type: "plain_text", text: title } },
        { type: "section", text: { type: "mrkdwn", text } },
        {
          type: "context",
          elements: [{ type: "mrkdwn", text: `Project: ${projectLabel} | ${new Date(payload.timestamp).toLocaleString()}` }],
        },
      ],
    };
  }

  if (platform === "teams") {
    return {
      "@type": "MessageCard",
      "@context": "http://schema.org/extensions",
      themeColor: eventColor(payload.event),
      summary: title,
      sections: [
        {
          activityTitle: title,
          activityText: text,
          facts: [
            { name: "Project", value: projectLabel },
            { name: "Time", value: new Date(payload.timestamp).toLocaleString() },
            ...Object.entries(payload.details).map(([name, value]) => ({ name, value: String(value) })),
          ],
        },
      ],
    };
  }

  if (platform === "discord") {
    return {
      embeds: [
        {
          title,
          description: text,
          color: Number.parseInt(eventColor(payload.event).slice(1), 16),
          timestamp: payload.timestamp,
          footer: { text: `Auto-Doc MCP | ${projectLabel}` },
        },
      ],
    };
  }

  return {
    title,
    text,
    ...payload,
  };
}

export async function sendWebhookNotification(config: ProjectWebhookConfig, payload: WebhookPayload): Promise<WebhookDeliveryResult> {
  if (!config.events.includes(payload.event)) {
    return { delivered: false, status: null, error: "event_not_enabled" };
  }

  try {
    const response = await fetch(config.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildWebhookMessage(config.platform, payload)),
      signal: AbortSignal.timeout(10_000),
    });
    return { delivered: response.ok, status: response.status, error: response.ok ? undefined : `HTTP ${response.status}` };
  } catch (error) {
    return { delivered: false, status: null, error: error instanceof Error ? error.message : String(error) };
  }
}
