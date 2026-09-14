import { describe, expect, it } from "vitest";
import { composeManualDocument, type ManualAssemblyEntry } from "../../src/lib/manual-assembler.js";

const entries: ManualAssemblyEntry[] = [
  {
    id: "runner",
    title: "Continuous Documentation Runner User Guide",
    audience: "User",
    status: "Published",
    entryType: "User Guide",
    body: `# Continuous Documentation Runner

## Overview
The runner watches configured repositories and creates documentation in the background.

## Prerequisites
- Set AUTO_DOC_RUNTIME_MODE=runner.
- Configure AUTO_DOC_RUNNER_PROJECT_ID.

## Steps
1. Run npm run build.
2. Start node build/src/index.js.
3. Check the runner logs.

## Troubleshooting
If jobs stop, inspect runner failure triage.`,
  },
  {
    id: "bridge",
    title: "HTTP/SSE Bridge with MCP Authentication User Guide",
    audience: "User",
    status: "Published",
    entryType: "User Guide",
    body: `# HTTP/SSE Bridge with MCP Authentication

## Overview
The bridge exposes the MCP server over SSE and authenticated message posts.

## Prerequisites
- Set AUTO_DOC_HTTP_PORT.
- Set AUTO_DOC_ENABLE_ENV_TOKEN_FALLBACK=true for trusted local fallback only.

## Steps
1. Run npm ci.
2. Run npm run build.
3. Start node build/src/cli/index.js bridge.

## Troubleshooting
If requests fail, verify the request token and /health endpoint.`,
  },
  {
    id: "pipeline",
    title: "Core MCP Tool Pipeline User Guide",
    audience: "User",
    status: "Published",
    entryType: "User Guide",
    body: `# Core MCP Tool Pipeline

## Overview
The core pipeline initializes, captures, analyzes, upserts, publishes, and packages documentation.

## Steps
1. Initialize the project manual.
2. Capture development evidence.
3. Package the release manual.`,
  },
];

function countOccurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

describe("feature-major-composition", () => {
  it("keeps each authored feature intact under one feature heading with titles appearing exactly once", () => {
    const manual = composeManualDocument({
      projectName: "Auto-Documentation MCP Server",
      audience: "user",
      entries,
    });

    expect(countOccurrences(manual.markdown, "## Core MCP Tool Pipeline")).toBe(1);
    expect(countOccurrences(manual.markdown, "## Continuous Documentation Runner")).toBe(1);
    expect(countOccurrences(manual.markdown, "## HTTP/SSE Bridge with MCP Authentication")).toBe(1);

    const runnerStart = manual.markdown.indexOf("## Continuous Documentation Runner");
    const bridgeStart = manual.markdown.indexOf("## HTTP/SSE Bridge with MCP Authentication");
    const runnerSection = manual.markdown.slice(runnerStart, bridgeStart);

    expect(runnerSection).toContain("The runner watches configured repositories");
    expect(runnerSection).toContain("Set AUTO_DOC_RUNTIME_MODE=runner.");
    expect(runnerSection).toContain("1. Run npm run build.");
    expect(runnerSection).toContain("If jobs stop, inspect runner failure triage.");
    expect(runnerSection.indexOf("Overview")).toBeLessThan(runnerSection.indexOf("Prerequisites"));
    expect(runnerSection.indexOf("Prerequisites")).toBeLessThan(runnerSection.indexOf("Steps"));
    expect(runnerSection.indexOf("Steps")).toBeLessThan(runnerSection.indexOf("Troubleshooting"));
  });

  it("orders features by sensible product flow and uses feature titles in the table of contents", () => {
    const manual = composeManualDocument({
      projectName: "Auto-Documentation MCP Server",
      audience: "user",
      entries,
    });

    const toc = manual.markdown.slice(manual.markdown.indexOf("## Table of contents"), manual.markdown.indexOf("## Core MCP Tool Pipeline"));
    expect(toc).toContain("1. [Core MCP Tool Pipeline](#core-mcp-tool-pipeline)");
    expect(toc).toContain("2. [Continuous Documentation Runner](#continuous-documentation-runner)");
    expect(toc).toContain("3. [HTTP/SSE Bridge with MCP Authentication](#http-sse-bridge-with-mcp-authentication)");
    expect(toc).not.toContain("Step-by-step setup");
    expect(toc).not.toContain("Expected results");

    expect(manual.markdown.indexOf("## Core MCP Tool Pipeline")).toBeLessThan(
      manual.markdown.indexOf("## Continuous Documentation Runner"),
    );
    expect(manual.markdown.indexOf("## Continuous Documentation Runner")).toBeLessThan(
      manual.markdown.indexOf("## HTTP/SSE Bridge with MCP Authentication"),
    );
  });
});
