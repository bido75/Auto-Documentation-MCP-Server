import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { resolveTraceId } from "../lib/logger.js";
import { buildMcpErrorEnvelope } from "../lib/mcp-error.js";
import { captureScreenshot } from "../lib/screenshots.js";

export function registerCaptureFeatureScreenshotTool(server: McpServer) {
  server.tool(
    "capture_feature_screenshot",
    "Captures a screenshot of a UI feature page using Playwright (optional).",
    {
      url: z.string().url(),
      outputPath: z.string(),
      traceId: z.string().optional(),
    },
    async ({ url, outputPath, traceId: incomingTraceId }) => {
      const traceId = resolveTraceId(incomingTraceId);
      try {
        const savedPath = await captureScreenshot(url, outputPath);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ traceId, ok: true, savedPath }, null, 2),
            },
          ],
        };
      } catch (error) {
        const envelope = buildMcpErrorEnvelope({
          tool: "capture_feature_screenshot",
          traceId,
          error,
          defaultCode: "SCREENSHOT_CAPTURE_FAILED",
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  traceId,
                  ok: false,
                  message:
                    "Screenshot capture is optional and non-blocking. Install Playwright chromium with `npx playwright install chromium`.",
                  error: envelope.error,
                },
                null,
                2,
              ),
            },
          ],
        };
      }
    },
  );
}
