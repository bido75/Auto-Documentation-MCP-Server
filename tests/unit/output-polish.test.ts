import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { authorManualSection } from "../../src/lib/manual-author.js";
import { extractManualContentFromBlocks } from "../../src/lib/manual-blocks.js";
import { markdownBlocks } from "../../src/lib/notion-blocks.js";

const previousDedicated = process.env.AUTO_DOC_DEDICATED_AUTHORING_ENABLED;

afterEach(() => {
  if (previousDedicated === undefined) {
    delete process.env.AUTO_DOC_DEDICATED_AUTHORING_ENABLED;
  } else {
    process.env.AUTO_DOC_DEDICATED_AUTHORING_ENABLED = previousDedicated;
  }
});

async function createAlertPolicyRepo(): Promise<string> {
  const repoPath = await mkdtemp(join(tmpdir(), "auto-doc-output-polish-"));
  await writeFile(
    join(repoPath, "alert-policy.js"),
    [
      "const DEFAULT_POLICY = {",
      "  urgentChannels: ['sms', 'phone'],",
      "  normalChannels: ['email'],",
      "  retryMinutes: [5, 15, 30],",
      "};",
      "",
      "export function buildEscalationPlan(incident, policy = DEFAULT_POLICY) {",
      "  const classification = incident.severity === 'critical' ? 'urgent' : 'normal';",
      "  const channels = classification === 'urgent' ? policy.urgentChannels : policy.normalChannels;",
      "  return {",
      "    incidentId: incident.id,",
      "    classification,",
      "    channels,",
      "    retryScheduleMinutes: policy.retryMinutes,",
      "    notifyOnCall: classification === 'urgent',",
      "  };",
      "}",
    ].join("\n"),
    "utf8",
  );
  return repoPath;
}

describe("output polish", () => {
  it("does not treat source-declared DEFAULT_POLICY constants as environment variables", async () => {
    process.env.AUTO_DOC_DEDICATED_AUTHORING_ENABLED = "false";
    const repoPath = await createAlertPolicyRepo();

    const section = await authorManualSection({
      audience: "Admin",
      entryType: "Admin Guide",
      featureName: "Alert Policy",
      summary: "Adds alert policy planning.",
      diffSummary: "Adds alert-policy.js",
      filesChanged: ["alert-policy.js"],
      repoPath,
      providerNarrative: {
        providerUsed: "openrouter:test",
        adminGuide: {
          configRequired: ["Set DEFAULT_POLICY to customize alert escalation."],
          endpointsAffected: [],
          envVarsRequired: ["DEFAULT_POLICY"],
          verificationSteps: ["Confirm DEFAULT_POLICY is configured."],
          troubleshooting: ["If DEFAULT_POLICY is missing, set the environment variable."],
        },
      },
    });

    expect(section.body).toContain("DEFAULT_POLICY");
    expect(section.body).toMatch(/source (?:constant|value).*DEFAULT_POLICY|DEFAULT_POLICY.*source (?:constant|value)/i);
    expect(section.body).not.toMatch(/(?:environment variable|env var|runtime setting|configuration reference)[^\n.]{0,120}DEFAULT_POLICY/i);
    expect(section.body).not.toMatch(/set\s+`?DEFAULT_POLICY`?\s+(?:in|as|through)\s+(?:the\s+)?environment/i);
  });

  it("keeps every source-defined return object field present in each authored guide", async () => {
    process.env.AUTO_DOC_DEDICATED_AUTHORING_ENABLED = "false";
    const repoPath = await createAlertPolicyRepo();
    const fields = ["incidentId", "classification", "channels", "retryScheduleMinutes", "notifyOnCall"];

    for (const [audience, entryType] of [
      ["User", "User Guide"],
      ["Admin", "Admin Guide"],
      ["Internal", "Developer Note"],
    ] as const) {
      const section = await authorManualSection({
        audience,
        entryType,
        featureName: "Alert Policy",
        summary: "Adds alert policy planning.",
        diffSummary: "Adds alert-policy.js",
        filesChanged: ["alert-policy.js"],
        repoPath,
        providerNarrative: {
          providerUsed: "openrouter:test",
          userGuide: {
            summary: "Builds an escalation plan.",
            steps: ["Create an incident.", "Build the plan.", "Read the returned fields."],
            expectedOutcome: "A plan is returned.",
            possibleErrors: [],
          },
          adminGuide: {
            configRequired: ["Review the source policy constant."],
            endpointsAffected: [],
            envVarsRequired: [],
            verificationSteps: ["Call buildEscalationPlan."],
            troubleshooting: [],
          },
          developerNotes:
            "buildEscalationPlan returns incidentId, classification, retryScheduleMinutes, and notifyOnCall for callers.",
        },
      });

      for (const field of fields) {
        expect(section.body, `${entryType} should include ${field}`).toContain(field);
      }
    }
  });

  it("round-trips ordered Notion list items back to incrementing markdown numbers", () => {
    const blocks = markdownBlocks(["1. First action", "2. Second action", "3. Third action"].join("\n"));

    const extracted = extractManualContentFromBlocks(blocks);

    expect(extracted.body.split(/\r?\n/)).toEqual(["1. First action", "2. Second action", "3. Third action"]);
  });

  it("keeps numbered Notion list sequence across bullet details between steps", () => {
    const blocks = markdownBlocks(
      [
        "1. Classify the incident",
        "- Returns urgent for critical incidents",
        "2. Build the escalation plan",
        "- Includes channels",
        "3. Summarize the plan",
      ].join("\n"),
    );

    const extracted = extractManualContentFromBlocks(blocks);

    expect(extracted.body.split(/\r?\n/)).toEqual([
      "1. Classify the incident",
      "- Returns urgent for critical incidents",
      "2. Build the escalation plan",
      "- Includes channels",
      "3. Summarize the plan",
    ]);
  });

  it("keeps numbered Notion list sequence across code examples between steps", () => {
    const blocks = markdownBlocks(
      [
        "1. Build the escalation plan",
        "```javascript",
        "buildEscalationPlan(incident);",
        "```",
        "2. Summarize the plan",
      ].join("\n"),
    );

    const extracted = extractManualContentFromBlocks(blocks);

    expect(extracted.body.split(/\r?\n/).filter((line) => /^\d+\.\s+/.test(line))).toEqual([
      "1. Build the escalation plan",
      "2. Summarize the plan",
    ]);
  });
});
