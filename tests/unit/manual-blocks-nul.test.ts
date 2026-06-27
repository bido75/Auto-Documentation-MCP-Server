import { describe, expect, it } from "vitest";
import { extractManualContentFromBlocks } from "../../src/lib/manual-blocks.js";

describe("manual block text normalization", () => {
  it("strips NUL bytes when reconstructing markdown from Notion blocks", () => {
    const result = extractManualContentFromBlocks([
      {
        type: "numbered_list_item",
        numbered_list_item: {
          rich_text: [{ plain_text: "\u0000\u0000\u0000 Import the required functions." }],
        },
      },
      {
        type: "code",
        code: {
          language: "plain text",
          rich_text: [
            {
              plain_text:
                "const delay = nextBackoffMs(2\u0000; // Returns 4000\nconst summary = summarize([notification1, notification2\u0000\u0000;",
            },
          ],
        },
      },
      {
        type: "bulleted_list_item",
        bulleted_list_item: {
          rich_text: [{ plain_text: "Retry cap in source: MAX_RETRIES \u0000 3." }],
        },
      },
    ]);

    expect(result.body).not.toContain("\u0000");
    expect(result.body).toContain("1. Import the required functions.");
    expect(result.body).toContain("const delay = nextBackoffMs(2; // Returns 4000");
    expect(result.body).toContain("Retry cap in source: MAX_RETRIES  3.");
  });

  it("removes dangling labels when reconstructing markdown from Notion blocks", () => {
    const result = extractManualContentFromBlocks([
      { type: "heading_3", heading_3: { rich_text: [{ plain_text: "nextBackoffMs(attempts)" }] } },
      { type: "paragraph", paragraph: { rich_text: [{ plain_text: "Parameter:" }] } },
      { type: "paragraph", paragraph: { rich_text: [{ plain_text: "Returns:" }] } },
      { type: "heading_3", heading_3: { rich_text: [{ plain_text: "summarize(notifications)" }] } },
      { type: "paragraph", paragraph: { rich_text: [{ plain_text: "Returns:" }] } },
      { type: "paragraph", paragraph: { rich_text: [{ plain_text: "Object with counts for pending, sent, and failed statuses." }] } },
    ]);

    expect(result.body).not.toMatch(/^Parameter:\s*$/m);
    expect(result.body).not.toContain("### nextBackoffMs(attempts)\nReturns:\n### summarize");
    expect(result.body).toContain("Returns:\nObject with counts for pending, sent, and failed statuses.");
  });
});
