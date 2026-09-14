import { describe, expect, it } from "vitest";
import { authorManualSection } from "../../src/lib/manual-author.js";

const providerNarrative = {
  providerUsed: "test-provider",
  userGuide: {
    summary: "Users connect their MCP client, initialize a project manual, and export finished docs.",
    steps: ["Open the MCP client settings.", "Add the Auto-Doc server command.", "Run initialize_project_manual.", "Export the manual when entries are published."],
    expectedOutcome: "A user can capture and export documentation without editing Notion by hand.",
    possibleErrors: ["If the MCP client cannot connect, check the configured command."],
  },
  adminGuide: {
    configRequired: ["Set NOTION_TOKEN.", "Set STATE_ENCRYPTION_KEY.", "Configure runner project and repo path."],
    endpointsAffected: ["GET /health", "POST /runner/trigger"],
    envVarsRequired: ["NOTION_TOKEN", "STATE_ENCRYPTION_KEY", "AUTO_DOC_RUNNER_PROJECT_ID", "AUTO_DOC_RUNNER_REPO_PATH"],
    verificationSteps: ["Start bridge mode.", "Check GET /health.", "Trigger one runner target in a disposable workspace."],
    troubleshooting: ["If runner jobs fail, inspect failure triage metadata and repository access."],
  },
  developerNotes: "Provider-authored developer notes.",
};

describe("user-admin-content-differs", () => {
  it("provider-authored user and admin sections differ materially by audience", async () => {
    const common = {
      featureName: "Auto-Doc Operations",
      summary: "Provider-authored manuals.",
      filesChanged: [],
      providerNarrative,
    };

    const user = await authorManualSection({ ...common, audience: "User" as const, entryType: "User Guide" as const });
    const admin = await authorManualSection({ ...common, audience: "Admin" as const, entryType: "Admin Guide" as const });

    expect(user.body).toContain("MCP client");
    expect(user.body).toContain("initialize_project_manual");
    expect(user.body).not.toContain("STATE_ENCRYPTION_KEY");
    expect(admin.body).toContain("STATE_ENCRYPTION_KEY");
    expect(admin.body).toContain("AUTO_DOC_RUNNER_PROJECT_ID");
    expect(admin.body).toContain("GET /health");
    expect(admin.body).not.toContain("Open the MCP client settings.");
    expect(user.body).not.toBe(admin.body);
  });
});
