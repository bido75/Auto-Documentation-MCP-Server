import { describe, expect, it } from "vitest";
import { callout, codeBlock, divider, heading2, paragraphs, toggle } from "../../src/lib/notion-blocks.js";

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

  it("renders a callout block", () => {
    expect(callout("Summary", "💡", "blue_background")).toMatchObject({
      type: "callout",
      callout: {
        rich_text: [{ text: { content: "Summary" } }],
        icon: { type: "emoji", emoji: "💡" },
        color: "blue_background",
      },
    });
  });

  it("renders a code block", () => {
    expect(codeBlock("POST /api/test", "http")).toMatchObject({
      type: "code",
      code: {
        rich_text: [{ text: { content: "POST /api/test" } }],
        language: "http",
      },
    });
  });

  it("renders a toggle block with children", () => {
    expect(toggle("More", [divider()])).toMatchObject({
      type: "toggle",
      toggle: {
        rich_text: [{ text: { content: "More" } }],
        children: [{ type: "divider" }],
      },
    });
  });
});
