import { describe, expect, it } from "vitest";
import { divider, heading2, markdownBlocks, paragraphs } from "../../src/lib/notion-blocks.js";

describe("notion block rendering", () => {
  it("renders a heading_2 block", () => {
    expect(heading2("User Guide")).toMatchObject({
      object: "block",
      type: "heading_2",
      heading_2: {
        rich_text: [{ type: "text", text: { content: "User Guide" } }],
      },
    });
  });

  it("splits paragraphs on blank lines and trims empty content", () => {
    const blocks = paragraphs("First paragraph.\n\nSecond paragraph.\n\n");
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({
      type: "paragraph",
      paragraph: { rich_text: [{ text: { content: "First paragraph." } }] },
    });
  });

  it("renders a divider block", () => {
    expect(divider()).toEqual({
      object: "block",
      type: "divider",
      divider: {},
    });
  });

  it("renders markdown headings, bold text, lists, and code blocks as formatted Notion blocks", () => {
    const blocks = markdownBlocks(
      [
        "## Overview",
        "Use **calculateShippingCost** safely.",
        "",
        "- No SHIPPING_* env vars are defined.",
        "1. Call calculateShippingCost.",
        "```javascript",
        "return expedited ? base * 1.75 : base;",
        "```",
      ].join("\n"),
    );

    expect(blocks.map((block) => block.type)).toEqual([
      "heading_2",
      "paragraph",
      "bulleted_list_item",
      "numbered_list_item",
      "code",
    ]);
    expect(blocks[0]).toMatchObject({ heading_2: { rich_text: [{ text: { content: "Overview" } }] } });
    expect(blocks[1]).toMatchObject({
      paragraph: {
        rich_text: [
          { text: { content: "Use " } },
          { text: { content: "calculateShippingCost" }, annotations: { bold: true } },
          { text: { content: " safely." } },
        ],
      },
    });
    expect(blocks[4]).toMatchObject({
      code: {
        rich_text: [{ text: { content: "return expedited ? base * 1.75 : base;" } }],
        language: "javascript",
      },
    });
  });

  it("strips NUL bytes from all Notion rich text block content", () => {
    const blocks = markdownBlocks(
      [
        "1. \u0000\u0000\u0000 Import the required functions.",
        "```plain text",
        "const delay = nextBackoffMs(2\u0000; // Returns 4000",
        "const summary = summarize([notification1, notification2\u0000\u0000;",
        "```",
        "- Retry cap in source: `MAX_RETRIES \u0000 3`.",
      ].join("\n"),
    );

    const serialized = JSON.stringify(blocks);
    expect(serialized).not.toContain("\u0000");
    expect(serialized).toContain("Import the required functions.");
    expect(serialized).toContain("const delay = nextBackoffMs(2; // Returns 4000");
    expect(serialized).toContain("MAX_RETRIES  3");
  });

  it("does not write dangling empty labels as Notion paragraph blocks", () => {
    const blocks = markdownBlocks(
      [
        "### nextBackoffMs(attempts)",
        "Parameter:",
        "Returns:",
        "### summarize(notifications)",
        "Returns:",
        "Object with counts for pending, sent, and failed statuses.",
      ].join("\n"),
    );

    const serialized = JSON.stringify(blocks);
    expect(serialized).not.toContain("Parameter:\\nReturns:");
    expect(serialized).not.toContain("Returns:\\n###");
    expect(serialized).toContain("Object with counts for pending, sent, and failed statuses.");
  });
});
