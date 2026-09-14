import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { logToolEvent, resolveTraceId } from "../lib/logger.js";
import { throwAsMcpToolError } from "../lib/mcp-error.js";
import { getStateStore, type ProjectWebhookConfig } from "../lib/state-store.js";
import { sendWebhookNotification } from "../lib/webhook-notifier.js";

const webhookEventSchema = z.enum([
  "entries_need_review",
  "coverage_dropped",
  "circuit_opened",
  "documentation_published",
  "runner_recovered",
]);

const webhookPlatformSchema = z.enum(["slack", "teams", "discord", "generic"]);

function redactWebhookUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname.split("/").slice(0, 2).join("/")}/...`;
  } catch {
    return "[redacted-webhook-url]";
  }
}

export function registerConfigureWebhookTool(server: McpServer) {
  server.tool(
    "configure_webhook",
    "Configures a project-scoped outbound webhook for documentation notifications.",
    {
      projectId: z.string(),
      webhookName: z.string().min(1).default("default"),
      webhookUrl: z.string().url(),
      platform: webhookPlatformSchema.default("slack"),
      events: z.array(webhookEventSchema).min(1).default(["entries_need_review", "coverage_dropped", "circuit_opened"]),
      coverageDropThreshold: z.number().min(0).max(100).default(70),
      sendTest: z.boolean().default(true),
      traceId: z.string().optional(),
    },
    async (input) => {
      const traceId = resolveTraceId(input.traceId);
      const startedAt = Date.now();
      logToolEvent({
        level: "info",
        tool: "configure_webhook",
        stage: "start",
        traceId,
        message: "Configuring documentation webhook",
        data: { projectId: input.projectId, webhookName: input.webhookName, platform: input.platform, events: input.events },
      });

      try {
        const store = getStateStore();
        const project = await store.getProject(input.projectId);
        if (!project) {
          throw new Error("Unknown projectId. Run initialize_project_manual first.");
        }

        const existing = await store.getWebhookConfig(input.projectId, input.webhookName);
        const now = new Date().toISOString();
        const config: ProjectWebhookConfig = {
          name: input.webhookName,
          url: input.webhookUrl,
          platform: input.platform,
          events: input.events,
          coverageDropThreshold: input.coverageDropThreshold,
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
        };

        await store.setWebhookConfig(input.projectId, config);
        const testDelivery = input.sendTest
          ? await sendWebhookNotification(
              { ...config, events: ["documentation_published"] },
              {
                event: "documentation_published",
                projectId: input.projectId,
                projectName: project.projectName,
                details: {
                  featureName: "Webhook Configuration",
                  confidenceScore: 100,
                  note: "This test confirms Auto-Doc MCP can reach the configured webhook endpoint.",
                },
                timestamp: now,
              },
            )
          : null;

        const response = {
          traceId,
          ok: true,
          projectId: input.projectId,
          webhookName: input.webhookName,
          platform: input.platform,
          events: input.events,
          coverageDropThreshold: input.coverageDropThreshold,
          webhookUrl: redactWebhookUrl(input.webhookUrl),
          testDelivery,
        };

        logToolEvent({
          level: "info",
          tool: "configure_webhook",
          stage: "success",
          traceId,
          message: "Configured documentation webhook",
          data: { projectId: input.projectId, webhookName: input.webhookName, testDelivered: testDelivery?.delivered ?? null, durationMs: Date.now() - startedAt },
        });

        return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }] };
      } catch (error) {
        logToolEvent({
          level: "error",
          tool: "configure_webhook",
          stage: "failure",
          traceId,
          message: "Failed to configure documentation webhook",
          data: { projectId: input.projectId, webhookName: input.webhookName, error: error instanceof Error ? error.message : String(error) },
        });
        throwAsMcpToolError({
          tool: "configure_webhook",
          traceId,
          error,
          defaultCode: "CONFIGURE_WEBHOOK_FAILED",
        });
      }
    },
  );
}

export function registerTriggerWebhookTestTool(server: McpServer) {
  server.tool(
    "trigger_webhook_test",
    "Sends a test notification through a configured project webhook.",
    {
      projectId: z.string(),
      webhookName: z.string().min(1).default("default"),
      traceId: z.string().optional(),
    },
    async (input) => {
      const traceId = resolveTraceId(input.traceId);
      try {
        const store = getStateStore();
        const project = await store.getProject(input.projectId);
        if (!project) {
          throw new Error("Unknown projectId. Run initialize_project_manual first.");
        }

        const config = await store.getWebhookConfig(input.projectId, input.webhookName);
        if (!config) {
          throw new Error(`No webhook named '${input.webhookName}' is configured for this project.`);
        }

        const result = await sendWebhookNotification(
          { ...config, events: ["documentation_published"] },
          {
            event: "documentation_published",
            projectId: input.projectId,
            projectName: project.projectName,
            details: {
              featureName: "Webhook Test",
              confidenceScore: 100,
              note: "Manual test triggered via trigger_webhook_test.",
            },
            timestamp: new Date().toISOString(),
          },
        );

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  traceId,
                  projectId: input.projectId,
                  webhookName: input.webhookName,
                  platform: config.platform,
                  delivered: result.delivered,
                  status: result.status,
                  error: result.error,
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (error) {
        throwAsMcpToolError({
          tool: "trigger_webhook_test",
          traceId,
          error,
          defaultCode: "TRIGGER_WEBHOOK_TEST_FAILED",
        });
      }
    },
  );
}
