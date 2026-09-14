import { describe, expect, it } from "vitest";
import { composeManualDocument, type ManualAssemblyEntry } from "../../src/lib/manual-assembler.js";

const entries: ManualAssemblyEntry[] = [
  {
    id: "bridge",
    title: "HTTP/SSE Bridge with MCP Authentication User Guide",
    audience: "User",
    status: "Published",
    entryType: "User Guide",
    body: `# HTTP/SSE Bridge with MCP Authentication

## Steps
1. Run npm ci.
2. Run npm run build.
3. Start node build/src/cli/index.js bridge.

## Nested verification
- Check health:
  - GET /health returns OK.
- Check SSE:
  - GET /sse opens a stream.

## Command
\`\`\`bash
npm run build
node build/src/cli/index.js bridge
\`\`\``,
  },
];

function blockText(block: ReturnType<typeof composeManualDocument>["blocks"][number]): string {
  const candidate = block as {
    paragraph?: { rich_text?: Array<{ text?: { content?: string } }> };
    heading_2?: { rich_text?: Array<{ text?: { content?: string } }> };
  };
  return [...(candidate.heading_2?.rich_text ?? []), ...(candidate.paragraph?.rich_text ?? [])]
    .map((part) => part.text?.content ?? "")
    .join("");
}

describe("list-serialization", () => {
  it("preserves ordered list numbering in markdown export", () => {
    const manual = composeManualDocument({
      projectName: "Auto-Documentation MCP Server",
      audience: "user",
      entries,
    });

    expect(manual.markdown).toContain("1. Run npm ci.\n2. Run npm run build.\n3. Start node build/src/cli/index.js bridge.");
    expect(manual.markdown).not.toContain("Run npm ci. 2. Run npm run build.");
  });

  it("keeps ordered steps, nested lists, headings, and code fences intact in Notion block text", () => {
    const manual = composeManualDocument({
      projectName: "Auto-Documentation MCP Server",
      audience: "user",
      entries,
    });
    const text = manual.blocks.map(blockText).join("\n");

    expect(text).toContain("1. Run npm ci.\n2. Run npm run build.\n3. Start node build/src/cli/index.js bridge.");
    expect(text).toContain("- Check health:\n  - GET /health returns OK.");
    expect(text).toContain("### Command");
    expect(text).toContain("```bash\nnpm run build\nnode build/src/cli/index.js bridge\n```");
  });
});
