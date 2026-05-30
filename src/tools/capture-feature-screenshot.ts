import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createNotionClient } from "../lib/notion-client.js";
import { resolveTraceId } from "../lib/logger.js";
import { buildMcpErrorEnvelope } from "../lib/mcp-error.js";
import { heading2, paragraph } from "../lib/notion-blocks.js";
import { withNotionRetry } from "../lib/notion-retry.js";
import { publishScreenshotAsset } from "../lib/screenshot-publisher.js";
import { captureScreenshot } from "../lib/screenshots.js";

type ScreenshotEnrichmentStatus =
  | "not_requested"
  | "attached_external_image"
  | "attached_auto_uploaded_image"
  | "attached_local_reference"
  | "attach_failed";

type ScreenshotEnrichmentResult = {
  attempted: boolean;
  manualEntryPageId: string | null;
  status: ScreenshotEnrichmentStatus;
  attachedBlockCount: number;
  error?: {
    code: string;
    message: string;
    traceId: string;
    tool: string;
  };
  autoUpload?: {
    attempted: boolean;
    uploaded: boolean;
    publicImageUrl?: string;
    storagePath?: string;
    error?: {
      code: string;
      message: string;
      traceId: string;
      tool: string;
    };
  };
};

async function appendScreenshotEnrichment(input: {
  traceId: string;
  manualEntryPageId: string;
  savedPath: string;
  sourceUrl: string;
  publicImageUrl?: string;
  caption?: string;
}): Promise<ScreenshotEnrichmentResult> {
  const notion = createNotionClient();

  const heading = heading2("Screenshot Evidence");
  const source = paragraph(`Source URL: ${input.sourceUrl}`);

  const children = input.publicImageUrl
    ? [
        heading,
        source,
        {
          object: "block" as const,
          type: "image" as const,
          image: {
            type: "external" as const,
            external: { url: input.publicImageUrl },
            caption: input.caption
              ? [{ type: "text" as const, text: { content: input.caption } }]
              : [],
          },
        },
      ]
    : [
        heading,
        source,
        paragraph(`Captured locally at: ${input.savedPath}`),
        paragraph(
          "Upload this screenshot to a reachable URL and pass publicImageUrl to embed it inline.",
        ),
      ];

  await withNotionRetry(
    () =>
      notion.blocks.children.append({
        block_id: input.manualEntryPageId,
        children,
      }),
    {
      operationName: "blocks.children.append",
      payload: {
        block_id: input.manualEntryPageId,
        children,
      },
    },
  );

  return {
    attempted: true,
    manualEntryPageId: input.manualEntryPageId,
    status: input.publicImageUrl ? "attached_external_image" : "attached_local_reference",
    attachedBlockCount: children.length,
  };
}

export function registerCaptureFeatureScreenshotTool(server: McpServer) {
  server.tool(
    "capture_feature_screenshot",
    "Captures a screenshot of a UI feature page using Playwright (optional).",
    {
      url: z.string().url(),
      outputPath: z.string(),
      manualEntryPageId: z.string().optional(),
      publicImageUrl: z.string().url().optional(),
      caption: z.string().max(200).optional(),
      traceId: z.string().optional(),
    },
    async ({ url, outputPath, manualEntryPageId, publicImageUrl, caption, traceId: incomingTraceId }) => {
      const traceId = resolveTraceId(incomingTraceId);
      try {
        const savedPath = await captureScreenshot(url, outputPath);

        let enrichment: ScreenshotEnrichmentResult = {
          attempted: false,
          manualEntryPageId: null,
          status: "not_requested",
          attachedBlockCount: 0,
        };

        if (manualEntryPageId) {
          let resolvedPublicImageUrl = publicImageUrl;
          let autoUpload: ScreenshotEnrichmentResult["autoUpload"] | undefined;

          if (!resolvedPublicImageUrl) {
            try {
              const published = await publishScreenshotAsset(savedPath);
              resolvedPublicImageUrl = published.publicImageUrl;
              autoUpload = {
                attempted: true,
                uploaded: true,
                publicImageUrl: published.publicImageUrl,
                storagePath: published.storagePath,
              };
            } catch (error) {
              const envelope = buildMcpErrorEnvelope({
                tool: "capture_feature_screenshot",
                traceId,
                error,
                defaultCode: "SCREENSHOT_AUTO_UPLOAD_FAILED",
              });

              autoUpload = {
                attempted: true,
                uploaded: false,
                error: envelope.error,
              };
            }
          }

          try {
            enrichment = await appendScreenshotEnrichment({
              traceId,
              manualEntryPageId,
              savedPath,
              sourceUrl: url,
              publicImageUrl: resolvedPublicImageUrl,
              caption,
            });

            if (autoUpload) {
              enrichment.autoUpload = autoUpload;
              if (autoUpload.uploaded) {
                enrichment.status = "attached_auto_uploaded_image";
              }
            }
          } catch (error) {
            const envelope = buildMcpErrorEnvelope({
              tool: "capture_feature_screenshot",
              traceId,
              error,
              defaultCode: "SCREENSHOT_ENRICHMENT_FAILED",
            });

            enrichment = {
              attempted: true,
              manualEntryPageId,
              status: "attach_failed",
              attachedBlockCount: 0,
              error: envelope.error,
              ...(autoUpload ? { autoUpload } : {}),
            };
          }
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ traceId, ok: true, savedPath, enrichment }, null, 2),
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
