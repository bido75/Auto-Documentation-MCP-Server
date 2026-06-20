import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const authoringProvider = vi.hoisted(() => ({
  calls: 0,
  fail: false,
  body:
    "## Overview\nTier 1 dedicated prose explains the billing export in original words.\n\n## Prerequisites\n- Billing Reader access\n- The Auto-Doc MCP server command\n\n## Step-by-step setup\n1. Open Settings > Billing.\n2. Choose Export invoices.\n3. Save the generated CSV.\n\nExpected result: the CSV downloads for the selected billing period.\n\n## Troubleshooting\n- Ask an administrator for Billing Reader access if Export is hidden.",
}));

vi.mock("../../src/providers/factory.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/providers/factory.js")>("../../src/providers/factory.js");
  return {
    ...actual,
    authorManualWithFallback: vi.fn(async () => {
      authoringProvider.calls += 1;
      if (authoringProvider.fail) throw new Error("dedicated authoring unavailable");
      return { body: authoringProvider.body, providerUsed: "test-author-provider", generationMs: 2 };
    }),
  };
});

async function createRepoFixture() {
  const repoPath = await mkdtemp(join(tmpdir(), "auto-doc-tier1-"));
  await writeFile(join(repoPath, "README.md"), "# Auto-Doc\nSource context should not be copied.\n");
  await writeFile(join(repoPath, "package.json"), JSON.stringify({ scripts: { start: "node build/src/index.js" } }));
  await writeFile(join(repoPath, ".env.example"), "NOTION_TOKEN=\nSTATE_ENCRYPTION_KEY=\n");
  return repoPath;
}

async function createShippingRepoFixture() {
  const repoPath = await mkdtemp(join(tmpdir(), "auto-doc-shipping-grounding-"));
  await writeFile(
    join(repoPath, "shipping.js"),
    [
      "export function calculateShippingCost(weightKg, distanceKm, expedited) {",
      "  const base = weightKg * 0.5 + distanceKm * 0.02;",
      "  return expedited ? base * 1.75 : base;",
      "}",
      "",
    ].join("\n"),
  );
  return repoPath;
}

async function createNotificationsRepoFixture() {
  const repoPath = await mkdtemp(join(tmpdir(), "auto-doc-notifications-grounding-"));
  await writeFile(
    join(repoPath, "notifications.js"),
    [
      "const CHANNELS = ['email', 'sms', 'push'];",
      "const MAX_RETRIES = 3;",
      "",
      "export function buildNotification(userId, channel, payload) {",
      "  if (!CHANNELS.includes(channel)) {",
      "    throw new Error(`Unsupported channel: ${channel}`);",
      "  }",
      "  return {",
      "    userId,",
      "    channel,",
      "    payload,",
      "    attempts: 0,",
      "    status: 'pending',",
      "    createdAt: Date.now(),",
      "  };",
      "}",
      "",
      "export function shouldRetry(notification) {",
      "  return notification.status === 'failed' && notification.attempts < MAX_RETRIES;",
      "}",
      "",
      "export function nextBackoffMs(attempts) {",
      "  return Math.min(1000 * 2 ** attempts, 30000);",
      "}",
      "",
      "export function summarize(notifications) {",
      "  const counts = { pending: 0, sent: 0, failed: 0 };",
      "  for (const n of notifications) {",
      "    if (counts[n.status] !== undefined) counts[n.status] += 1;",
      "  }",
      "  return counts;",
      "}",
      "",
    ].join("\n"),
  );
  return repoPath;
}

function functionSectionBody(markdown: string, functionName: string): string {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((line) => new RegExp(`^#{3,6}\\s+\`?${functionName}\\s*\\(`).test(line.trim()));
  if (start < 0) {
    return "";
  }
  const end = lines.findIndex((line, index) => index > start && /^#{3,6}\s+`?[A-Za-z_$][\w$]*\s*\(/.test(line.trim()));
  return lines.slice(start + 1, end < 0 ? undefined : end).join("\n").trim();
}

async function createSingleNotificationRepoFixture() {
  const repoPath = await mkdtemp(join(tmpdir(), "auto-doc-notification-single-"));
  await writeFile(
    join(repoPath, "notification-single.js"),
    [
      "const CHANNELS = ['email', 'sms', 'push'];",
      "",
      "export function buildNotification(userId, channel, payload) {",
      "  if (!CHANNELS.includes(channel)) {",
      "    throw new Error(`Unsupported channel: ${channel}`);",
      "  }",
      "  return {",
      "    userId,",
      "    channel,",
      "    payload,",
      "    attempts: 0,",
      "    status: 'pending',",
      "    createdAt: Date.now(),",
      "  };",
      "}",
      "",
    ].join("\n"),
  );
  return repoPath;
}

const previousEnabled = process.env.AUTO_DOC_DEDICATED_AUTHORING_ENABLED;

afterEach(() => {
  authoringProvider.calls = 0;
  authoringProvider.fail = false;
  vi.clearAllMocks();
  if (previousEnabled === undefined) delete process.env.AUTO_DOC_DEDICATED_AUTHORING_ENABLED;
  else process.env.AUTO_DOC_DEDICATED_AUTHORING_ENABLED = previousEnabled;
});

describe("authoring-tier1-dedicated", () => {
  it("uses dedicated Tier-1 provider prose instead of analyzer narrative or template", async () => {
    process.env.AUTO_DOC_DEDICATED_AUTHORING_ENABLED = "true";
    const { authorManualSection } = await import("../../src/lib/manual-author.js");
    const section = await authorManualSection({
      audience: "User",
      entryType: "User Guide",
      featureName: "Billing Export",
      summary: "Template summary should not win.",
      diffSummary: "Repo evidence excerpt:\nGET POST MCP HTTP",
      filesChanged: ["README.md"],
      repoPath: await createRepoFixture(),
      providerNarrative: {
        providerUsed: "analyzer-provider",
        userGuide: {
          summary: "Tier 2 analyzer narrative should not win.",
          steps: ["Analyzer step"],
          expectedOutcome: "Analyzer outcome.",
          possibleErrors: [],
        },
        adminGuide: {
          configRequired: [],
          endpointsAffected: [],
          envVarsRequired: [],
          verificationSteps: [],
          troubleshooting: [],
        },
      },
    });

    expect(authoringProvider.calls).toBe(1);
    expect(section.authoringTier).toBe("tier1-dedicated");
    expect(section.providerUsed).toBe("test-author-provider");
    expect(section.body).toContain("Tier 1 dedicated prose");
    expect(section.body).toContain("## Prerequisites");
    expect(section.body).toContain("1. Open Settings > Billing.");
    expect(section.body).toContain("Expected result:");
    expect(section.body).not.toContain("Tier 2 analyzer narrative");
    expect(section.body).not.toContain("Source context:");
    expect(section.body).not.toMatch(/\bGET POST MCP HTTP\b/);
  });

  it("uses grounded source facts for thin code evidence before a provider can fabricate", async () => {
    process.env.AUTO_DOC_DEDICATED_AUTHORING_ENABLED = "true";
    authoringProvider.body = [
      "## Overview",
      "Use calculateShipping(weight, 'standard') for pounds-based zones.",
      "",
      "## Configuration",
      "- SHIPPING_BASE_COST",
      "- shipping-calculator package",
      "",
      "## Notes",
      "Expedited shipping adds a 25% premium and may use chmod 644.",
    ].join("\n");
    const { authorManualSection } = await import("../../src/lib/manual-author.js");

    const section = await authorManualSection({
      audience: "Developer",
      entryType: "Developer Note",
      featureName: "Shipping Cost Calculator",
      summary: "Adds shipping cost calculation.",
      diffSummary:
        "export function calculateShippingCost(weightKg, distanceKm, expedited) {\n  const base = weightKg * 0.5 + distanceKm * 0.02;\n  return expedited ? base * 1.75 : base;\n}",
      filesChanged: ["shipping.js"],
      repoPath: await createShippingRepoFixture(),
    });

    expect(authoringProvider.calls).toBe(0);
    expect(section.authoringTier).toBe("tier3-template");
    expect(section.body).toContain("calculateShippingCost");
    expect(section.body).toContain("weightKg");
    expect(section.body).toContain("distanceKm");
    expect(section.body).toContain("expedited");
    expect(section.body).toContain("1.75");
    expect(section.body).toContain("`distanceKm` affects the base cost");
    expect(section.body).toContain("Units, ranges, and configuration are not specified in the source");
    expect(section.body).not.toContain("calculateShipping(");
    expect(section.body).not.toContain("calculateCost");
    expect(section.body).not.toMatch(/\bpounds?\b|\blbs?\b/i);
    expect(section.body).not.toMatch(/\b25%\b|\b2\.5x\b/);
    expect(section.body).not.toMatch(/\bzones?\b/i);
    expect(section.body).not.toContain("SHIPPING_");
    expect(section.body).not.toContain("shipping-calculator");
    expect(section.body).not.toContain("chmod");
  });

  it("does not describe non-shipping thin function evidence with shipping-cost concepts", async () => {
    process.env.AUTO_DOC_DEDICATED_AUTHORING_ENABLED = "true";
    const { authorManualSection } = await import("../../src/lib/manual-author.js");

    const section = await authorManualSection({
      audience: "User",
      entryType: "User Guide",
      featureName: "Notification Builder Helper",
      summary: "Adds a notification builder helper.",
      diffSummary:
        "export function buildNotification(userId, channel, payload) {\n  if (!CHANNELS.includes(channel)) throw new Error(`Unsupported channel: ${channel}`);\n  return { userId, channel, payload, attempts: 0, status: 'pending', createdAt: Date.now() };\n}",
      filesChanged: ["notification-single.js"],
      repoPath: await createSingleNotificationRepoFixture(),
    });

    expect(authoringProvider.calls).toBe(0);
    expect(section.authoringTier).toBe("tier3-template");
    expect(section.body).toContain("buildNotification");
    expect(section.body).toContain("userId");
    expect(section.body).toContain("channel");
    expect(section.body).toContain("payload");
    expect(section.body).toContain("status: 'pending'");
    expect(section.body).not.toMatch(/\bshipping\b|\bshipping-cost\b|\bshipping cost\b/i);
    expect(section.body).not.toContain("calculated shipping cost");
  });

  it("rejects fabricated analyzer narrative prose and falls back to grounded source facts", async () => {
    process.env.AUTO_DOC_DEDICATED_AUTHORING_ENABLED = "false";
    const { authorManualSection } = await import("../../src/lib/manual-author.js");

    const section = await authorManualSection({
      audience: "User",
      entryType: "User Guide",
      featureName: "Shipping Cost Calculator",
      summary: "Adds shipping cost calculation.",
      diffSummary:
        "export function calculateShippingCost(weightKg, distanceKm, expedited) {\n  const base = weightKg * 0.5 + distanceKm * 0.02;\n  return expedited ? base * 1.75 : base;\n}",
      filesChanged: ["shipping.js"],
      repoPath: await createShippingRepoFixture(),
      providerNarrative: {
        providerUsed: "cloud-openai:test",
        userGuide: {
          summary: "Users fill in a shipping documentation form and submit required fields.",
          steps: ["Navigate to the shipping documentation section", "Submit the form"],
          expectedOutcome: "Validation prevents incomplete form submissions.",
          possibleErrors: ["Please fill in all required fields."],
        },
        adminGuide: {
          configRequired: ["SHIPPING_BASE_COST"],
          endpointsAffected: [],
          envVarsRequired: ["SHIPPING_BASE_COST"],
          verificationSteps: ["Check zones"],
          troubleshooting: [],
        },
      },
    });

    expect(section.authoringTier).toBe("tier3-template");
    expect(section.body).toContain("calculateShippingCost");
    expect(section.body).toContain("weightKg");
    expect(section.body).toContain("distanceKm");
    expect(section.body).toContain("expedited");
    expect(section.body).toContain("1.75");
    expect(section.body).not.toContain("form");
    expect(section.body).not.toContain("required fields");
    expect(section.body).not.toContain("SHIPPING_BASE_COST");
    expect(section.body).not.toMatch(/\bzones?\b/i);
  });

  it("accepts well-grounded Tier-1 prose for a substantial multi-function feature", async () => {
    process.env.AUTO_DOC_DEDICATED_AUTHORING_ENABLED = "true";
    authoringProvider.body = [
      "## Overview",
      "The module defines notification helpers for the exact channels `email`, `sms`, and `push`.",
      "",
      "## Source behavior",
      "- `buildNotification(userId, channel, payload)` validates `channel` with `CHANNELS.includes(channel)` and throws `Unsupported channel: ${channel}` when the channel is not supported.",
      "- A created notification starts with `attempts: 0`, `status: 'pending'`, and `createdAt: Date.now()`.",
      "- `shouldRetry(notification)` returns true only when `notification.status === 'failed'` and `notification.attempts < MAX_RETRIES`; `MAX_RETRIES` is `3`.",
      "- `nextBackoffMs(attempts)` returns `Math.min(1000 * 2 ** attempts, 30000)`.",
      "- `summarize(notifications)` returns counts for `pending`, `sent`, and `failed` statuses.",
      "",
      "## Expected result",
      "Callers get source-defined notification objects, retry decisions, capped backoff values, and status counts without any additional package dependency or environment variable.",
    ].join("\n");
    const { authorManualSection } = await import("../../src/lib/manual-author.js");

    const section = await authorManualSection({
      audience: "Developer",
      entryType: "Developer Note",
      featureName: "Notification Helper Validation",
      summary: "Adds notification helper functions.",
      diffSummary:
        "Adds buildNotification, shouldRetry, nextBackoffMs, and summarize with email/sms/push channels, MAX_RETRIES 3, and a 30000ms backoff cap.",
      filesChanged: ["notifications.js"],
      repoPath: await createNotificationsRepoFixture(),
    });

    expect(authoringProvider.calls).toBe(1);
    expect(section.authoringTier).toBe("tier1-dedicated");
    expect(section.body).toContain("buildNotification");
    expect(section.body).toContain("shouldRetry");
    expect(section.body).toContain("nextBackoffMs");
    expect(section.body).toContain("summarize");
    expect(section.body).toContain("CHANNELS.includes(channel)");
    expect(section.body).toContain("Date.now()");
    expect(section.body).toContain("Math.min(1000 * 2 ** attempts, 30000)");
    expect(section.body).not.toContain("Source-grounded behavior");
    expect(section.body).not.toContain("NOTIFICATION_");
    expect(section.body).not.toContain("SMTP_");
    expect(section.body).not.toContain("TWILIO_");
    expect(section.body).not.toMatch(/\bRedis\b|\bKafka\b|\bRabbitMQ\b/);
  });

  it("repairs recoverable multi-function prose with a clean source-grounded appendix", async () => {
    process.env.AUTO_DOC_DEDICATED_AUTHORING_ENABLED = "true";
    authoringProvider.body = [
      "## Overview",
      "Use `buildNotification(userId, channel, payload)` for notification workflow helpers.",
      "",
      "## Unsupported operations note",
      "- Configure SMTP_URL and Redis before running notifications.",
      "- Retry failed notifications five times.",
    ].join("\n");
    const { authorManualSection } = await import("../../src/lib/manual-author.js");

    const section = await authorManualSection({
      audience: "Admin",
      entryType: "Admin Guide",
      featureName: "Notification Helper Validation",
      summary: "Adds notification helper functions.",
      diffSummary:
        "const CHANNELS = ['email', 'sms', 'push'];\u0000\nconst MAX_RETRIES = 3;\u0000\nexport function nextBackoffMs(attempts) {\n  return Math.min(1000 * 2 ** attempts, 30000);\u0000\n}",
      filesChanged: ["notifications.js"],
      repoPath: await createNotificationsRepoFixture(),
    });

    expect(authoringProvider.calls).toBe(1);
    expect(section.authoringTier).toBe("tier1-dedicated");
    expect(section.body).toContain("Source-grounded behavior");
    expect(section.body).toContain("Retry cap in source: `MAX_RETRIES = 3`.");
    expect(section.body).toContain("Backoff in source: `Math.min(1000 * 2 ** attempts, 30000)`.");
    expect(section.body).not.toContain("\u0000");
    expect(section.body).not.toContain("SMTP_URL");
    expect(section.body).not.toContain("Redis");
    expect(section.body).not.toContain("five times");
  });

  it("removes dangling empty Parameter and Returns labels from accepted provider prose", async () => {
    process.env.AUTO_DOC_DEDICATED_AUTHORING_ENABLED = "true";
    authoringProvider.body = [
      "## Overview",
      "The notification helpers document `buildNotification`, `shouldRetry`, `nextBackoffMs`, and `summarize` from source.",
      "",
      "#### buildNotification(userId, channel, payload)",
      "Returns:",
      "",
      "#### nextBackoffMs(attempts)",
      "Parameter:",
      "Returns:",
      "- Examples:",
      "- `attempts = 0` returns `1000`.",
      "- `attempts = 1` returns `2000`.",
      "",
      "#### summarize(notifications)",
      "Returns source-defined counts for `pending`, `sent`, and `failed`.",
    ].join("\n");
    const { authorManualSection } = await import("../../src/lib/manual-author.js");

    const section = await authorManualSection({
      audience: "Admin",
      entryType: "Admin Guide",
      featureName: "Notification Helper Validation",
      summary: "Adds notification helper functions.",
      diffSummary:
        "Adds buildNotification, shouldRetry, nextBackoffMs, and summarize with email/sms/push channels, MAX_RETRIES 3, and a 30000ms backoff cap.",
      filesChanged: ["notifications.js"],
      repoPath: await createNotificationsRepoFixture(),
    });

    expect(section.authoringTier).toBe("tier1-dedicated");
    expect(section.body).not.toMatch(/^Parameter:\s*$/m);
    expect(section.body).not.toMatch(/^Returns:\s*$/m);
    expect(section.body).toContain("`nextBackoffMs` returns `Math.min(1000 * 2 ** attempts, 30000)`.");
    expect(section.body).toContain("`buildNotification(userId, channel, payload)` is exported by the source.");
  });

  it("removes dangling empty Parameter and Returns labels after repairing provider prose", async () => {
    process.env.AUTO_DOC_DEDICATED_AUTHORING_ENABLED = "true";
    authoringProvider.body = [
      "## Overview",
      "The notification helper covers `buildNotification`, `shouldRetry`, `nextBackoffMs`, and `summarize`.",
      "",
      "#### buildNotification(userId, channel, payload)",
      "Returns:",
      "Errors:",
      "",
      "#### nextBackoffMs(attempts)",
      "Parameter:",
      "Returns:",
      "- Configure SMTP_URL before retrying notifications.",
      "",
      "#### summarize(notifications)",
      "Returns source-defined counts for `pending`, `sent`, and `failed`.",
    ].join("\n");
    const { authorManualSection } = await import("../../src/lib/manual-author.js");

    const section = await authorManualSection({
      audience: "Admin",
      entryType: "Admin Guide",
      featureName: "Notification Helper Validation",
      summary: "Adds notification helper functions.",
      diffSummary:
        "Adds buildNotification, shouldRetry, nextBackoffMs, and summarize with email/sms/push channels, MAX_RETRIES 3, and a 30000ms backoff cap.",
      filesChanged: ["notifications.js"],
      repoPath: await createNotificationsRepoFixture(),
    });

    expect(section.authoringTier).toBe("tier1-dedicated");
    expect(section.body).toContain("Source-grounded behavior");
    expect(section.body).not.toContain("SMTP_URL");
    expect(section.body).not.toMatch(/^Parameter:\s*$/m);
    expect(section.body).not.toMatch(/^Returns:\s*$/m);
    expect(section.body).toContain("`nextBackoffMs` returns `Math.min(1000 * 2 ** attempts, 30000)`.");
  });

  it("fills an empty function subsection from source facts before the next function header", async () => {
    process.env.AUTO_DOC_DEDICATED_AUTHORING_ENABLED = "true";
    authoringProvider.body = [
      "## Overview",
      "The notification helper covers `buildNotification`, `shouldRetry`, `nextBackoffMs`, and `summarize`.",
      "",
      "#### buildNotification(userId, channel, payload)",
      "Creates a source-defined notification object.",
      "",
      "#### shouldRetry(notification)",
      "Returns whether a failed notification can retry.",
      "",
      "#### nextBackoffMs(attempts)",
      "Parameter:",
      "Returns:",
      "",
      "#### summarize(notifications)",
      "Returns source-defined counts for `pending`, `sent`, and `failed`.",
    ].join("\n");
    const { authorManualSection } = await import("../../src/lib/manual-author.js");

    const section = await authorManualSection({
      audience: "Admin",
      entryType: "Admin Guide",
      featureName: "Notification Helper Validation",
      summary: "Adds notification helper functions.",
      diffSummary:
        "Adds buildNotification, shouldRetry, nextBackoffMs, and summarize with email/sms/push channels, MAX_RETRIES 3, and a 30000ms backoff cap.",
      filesChanged: ["notifications.js"],
      repoPath: await createNotificationsRepoFixture(),
    });

    const nextBackoffBody = functionSectionBody(section.body, "nextBackoffMs");
    expect(nextBackoffBody).toContain("Math.min(1000 * 2 ** attempts, 30000)");
    expect(nextBackoffBody).not.toMatch(/^Parameter:\s*$/m);
    expect(nextBackoffBody).not.toMatch(/^Returns:\s*$/m);
  });
});
