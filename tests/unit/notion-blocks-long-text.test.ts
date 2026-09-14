import { describe, expect, it } from "vitest";
import { paragraph } from "../../src/lib/notion-blocks.js";

describe("notion block rich text limits", () => {
  it("splits long paragraph text into rich_text chunks within Notion's 2000 character limit", () => {
    const block = paragraph("a".repeat(4501));
    expect(block.paragraph.rich_text).toHaveLength(3);
    expect(block.paragraph.rich_text.every((part) => part.text.content.length <= 2000)).toBe(true);
    expect(block.paragraph.rich_text.map((part) => part.text.content).join("")).toHaveLength(4501);
  });
});
