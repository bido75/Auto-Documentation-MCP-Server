/**
 * Acceptance: criterion 4 - assembled manuals are complete enough for a novice.
 * DO NOT DELETE/SKIP.
 */
import { describe, expect, it } from "vitest";
import { composeManualDocument, type ManualAssemblyEntry } from "../../src/lib/manual-assembler.js";

const entries: ManualAssemblyEntry[] = [
  {
    id: "user-install",
    title: "Connect an MCP client",
    audience: "User",
    status: "Published",
    entryType: "User Guide",
    body: [
      "## Overview",
      "Use Auto-Doc from an MCP client after an administrator initializes the project.",
      "## Prerequisites",
      "You need the MCP server command, a configured Notion workspace, and the projectId.",
      "## Step-by-step setup",
      "1. Open the MCP client settings.",
      "2. Add the built server command.",
      "3. Call get_documentation_status with the projectId.",
      "## Expected result",
      "The client lists Auto-Doc tools and returns the project documentation status.",
    ].join("\n"),
  },
  {
    id: "user-export",
    title: "Export documentation",
    audience: "User",
    status: "Published",
    entryType: "User Guide",
    body: [
      "## How to use it",
      "1. Capture a completed change.",
      "2. Run package_manual for the release.",
      "3. Open the generated manual artifact.",
      "## Troubleshooting",
      "If export fails, confirm Notion access and retry with the traceId from the error.",
    ].join("\n"),
  },
  {
    id: "admin-operate",
    title: "Operate the production server",
    audience: "Admin",
    status: "Published",
    entryType: "Admin Guide",
    body: [
      "## Requirements",
      "Install Node.js, configure NOTION_TOKEN, configure STATE_ENCRYPTION_KEY, and grant the integration page access.",
      "## Operations setup",
      "1. Run npm install.",
      "2. Run npm run build.",
      "3. Start node build/src/cli/index.js bridge.",
      "4. Check GET /health.",
      "## Expected result",
      "The bridge reports healthy and tools can read and write the configured Notion workspace.",
      "## Troubleshooting",
      "If the runner stops, inspect runner failure triage before restarting automation.",
    ].join("\n"),
  },
];

function indexOfRequired(haystack: string, needle: string): number {
  const index = haystack.indexOf(needle);
  expect(index, `Expected assembled manual to include ${needle}`).toBeGreaterThanOrEqual(0);
  return index;
}

describe("novice-completeness", () => {
  it("User Manual includes concrete prerequisites, ordered actions, expected result, and recovery guidance", () => {
    const manual = composeManualDocument({ projectName: "Auto-Documentation MCP Server", audience: "user", entries });
    expect(manual.markdown).toContain("Prerequisites");
    expect(manual.markdown).toContain("MCP server command");
    expect(manual.markdown).toContain("projectId");
    expect(manual.markdown).toContain("1. Open the MCP client settings.");
    expect(manual.markdown).toContain("2. Add the built server command.");
    expect(manual.markdown).toContain("Expected result");
    expect(manual.markdown).toContain("The client lists Auto-Doc tools");
    expect(manual.markdown).toContain("Troubleshooting");
    expect(manual.markdown).toContain("traceId");
  });

  it("Admin Manual includes deployable setup prerequisites and a runnable health verification path", () => {
    const manual = composeManualDocument({ projectName: "Auto-Documentation MCP Server", audience: "admin", entries });
    expect(manual.markdown).toContain("Node.js");
    expect(manual.markdown).toContain("NOTION_TOKEN");
    expect(manual.markdown).toContain("STATE_ENCRYPTION_KEY");
    expect(manual.markdown).toContain("npm install");
    expect(manual.markdown).toContain("npm run build");
    expect(manual.markdown).toContain("node build/src/cli/index.js bridge");
    expect(manual.markdown).toContain("GET /health");
    expect(manual.markdown).toContain("The bridge reports healthy");
  });

  it("orders novice-facing content from context to setup to expected result to troubleshooting", () => {
    const manual = composeManualDocument({ projectName: "Auto-Documentation MCP Server", audience: "admin", entries });
    const feature = indexOfRequired(manual.markdown, "## Operate the production server");
    const prerequisites = indexOfRequired(manual.markdown, "### Requirements");
    const setup = indexOfRequired(manual.markdown, "### Operations setup");
    const expected = indexOfRequired(manual.markdown, "### Expected result");
    const troubleshooting = indexOfRequired(manual.markdown, "Troubleshooting");
    expect(feature).toBeLessThan(prerequisites);
    expect(prerequisites).toBeLessThan(setup);
    expect(setup).toBeLessThan(expected);
    expect(expected).toBeLessThan(troubleshooting);
  });

  it("does not emit the old evidence-log format as the assembled deliverable", () => {
    const manual = composeManualDocument({ projectName: "Auto-Documentation MCP Server", audience: "user", entries });
    expect(manual.markdown).not.toContain("Repo evidence excerpt");
    expect(manual.markdown).not.toContain("Files changed:");
    expect(manual.markdown).not.toContain("Commit summary:");
  });
});
