import { describe, expect, it } from "vitest";
import { composeAssembledManualMarkdown, type ManualAssemblyEntry } from "../../src/lib/manual-assembler.js";

function entry(body: string): ManualAssemblyEntry {
  return {
    id: "entry_1",
    title: "Export Manual Artifacts with Safety Boundary User Guide",
    audience: "User",
    status: "Published",
    body,
  };
}

describe("manual assembler source appendices", () => {
  it("removes raw source-grounded appendix sections from packaged output", () => {
    const markdown = composeAssembledManualMarkdown({
      projectName: "Auto-Doc MCP Server",
      audience: "user",
      entries: [
        entry(`# Export Manual Artifacts with Safety Boundary

## Overview
Export PDF, MANUAL.md, and help-center JSON artifacts from published manual entries.

### Source-grounded behavior
- \`queryAll(notion: ReturnType<typeof createNotionClient>, input: Record<string, unknown>)\` is exported by the source.

### Source-defined return fields
- \`queryAll\` returns object fields: \`results\`, \`has_more\`, \`next_cursor\`.

## Troubleshooting
If an output path is rejected, keep it inside AUTO_DOC_ARTIFACT_ROOT.`),
      ],
    });

    expect(markdown).toContain("Export PDF, MANUAL.md, and help-center JSON artifacts");
    expect(markdown).toContain("Troubleshooting");
    expect(markdown).not.toContain("Source-grounded behavior");
    expect(markdown).not.toContain("Source-defined return fields");
    expect(markdown).not.toContain("queryAll");
  });
});
