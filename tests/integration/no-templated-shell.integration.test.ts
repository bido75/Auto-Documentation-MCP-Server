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

## Overview
The bridge exposes the MCP server over SSE and authenticated message posts.

## Steps
1. Build the server.
2. Start bridge mode.

## Expected Result
The /health endpoint returns OK.`,
  },
  {
    id: "runner",
    title: "Continuous Documentation Runner User Guide",
    audience: "User",
    status: "Published",
    entryType: "User Guide",
    body: `# Continuous Documentation Runner

## Overview
The runner polls repositories and triggers documentation generation.

## Steps
1. Configure runner targets.
2. Start runner mode.`,
  },
];

describe("no-templated-shell", () => {
  it("does not wrap real authored content in generic global shell sections", () => {
    const manual = composeManualDocument({
      projectName: "Auto-Documentation MCP Server",
      audience: "user",
      entries,
    });

    expect(manual.markdown).not.toContain("turns completed development work into readable documentation");
    expect(manual.markdown).not.toContain("Connect your MCP client to the built server");
    expect(manual.markdown).not.toContain("Confirm the project has been initialized");
    expect(manual.markdown).not.toContain("assembled as a single User Manual page");
  });

  it("opens with an introduction and feature map instead of section buckets", () => {
    const manual = composeManualDocument({
      projectName: "Auto-Documentation MCP Server",
      audience: "user",
      entries,
    });

    const beforeFirstFeature = manual.markdown.slice(0, manual.markdown.indexOf("## Continuous Documentation Runner"));
    expect(beforeFirstFeature).toContain("## Introduction");
    expect(beforeFirstFeature).toContain("Feature map:");
    expect(beforeFirstFeature).toContain("- Continuous Documentation Runner");
    expect(beforeFirstFeature).toContain("- HTTP/SSE Bridge with MCP Authentication");
    expect(beforeFirstFeature).not.toContain("## Overview");
    expect(beforeFirstFeature).not.toContain("## Step-by-step setup");
  });

  it("normalizes already-redacted known boolean flags in assembled output", () => {
    const manual = composeManualDocument({
      projectName: "Auto-Documentation MCP Server",
      audience: "user",
      entries: [
        {
          id: "bridge",
          title: "HTTP/SSE Bridge with MCP Authentication User Guide",
          audience: "User",
          status: "Published",
          entryType: "User Guide",
          body: "## Configuration\nSet AUTO_DOC_ENABLE_ENV_TOKEN_FALLBACK=[REDACTED] for trusted local development.",
        },
      ],
    });

    expect(manual.markdown).toContain("AUTO_DOC_ENABLE_ENV_TOKEN_FALLBACK=true");
    expect(manual.markdown).not.toContain("AUTO_DOC_ENABLE_ENV_TOKEN_FALLBACK=[REDACTED]");
  });
});
