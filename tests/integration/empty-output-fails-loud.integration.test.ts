import { describe, expect, it } from "vitest";
import { composeAssembledManualMarkdown, composeManualDocument } from "../../src/lib/manual-assembler.js";

describe("empty output fails loudly", () => {
  it("assemble/manual composition refuses to emit default-shell manuals with zero entries", () => {
    expect(() =>
      composeManualDocument({
        projectName: "Auto-Doc",
        audience: "user",
        entries: [],
      }),
    ).toThrow(/No publishable manual entries/i);
  });

  it("package/export composition refuses non-publishable captured entries instead of returning a shell artifact", () => {
    expect(() =>
      composeAssembledManualMarkdown({
        projectName: "Auto-Doc",
        audience: "both",
        releaseVersion: "self-doc-empty",
        entries: [
          {
            id: "captured_1",
            title: "Captured fallback",
            audience: "User",
            status: "Captured",
            body: "Analyzer failed and wrote a captured fallback shell.",
          },
        ],
      }),
    ).toThrow(/No publishable manual entries/i);
  });
});
