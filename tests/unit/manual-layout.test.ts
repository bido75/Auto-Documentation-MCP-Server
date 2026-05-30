import { describe, expect, it } from "vitest";
import { buildManualArtifactPageBlocks, buildManualEntryBlocks } from "../../src/notion/manual-layout.js";

describe("manual Notion layout", () => {
  it("renders a structured user guide layout", () => {
    const blocks = buildManualEntryBlocks({
      title: "MFA Authentication Engine",
      entryType: "User Guide",
      audience: "User",
      status: "Published",
      body: [
        "What users can do now:\nUsers can protect their account with TOTP MFA.",
        "Where to go:\nOpen Account Settings > Security.",
        "What action to take:\nScan the QR code and enter the six-digit code.",
        "Expected result:\nMFA is enabled and backup codes are shown.",
        "Errors or edge states:\nIf the code is expired, retry with a fresh code.",
      ].join("\n\n"),
      routes: ["/account/security"],
      apiEndpoints: [],
    });

    expect(blocks.some((block) => block.type === "callout")).toBe(true);
    expect(blocks.some((block) => block.type === "numbered_list_item")).toBe(true);
    expect(blocks.some((block) => block.type === "code")).toBe(true);
  });

  it("renders packaged manual sections and version history toggles", () => {
    const blocks = buildManualArtifactPageBlocks({
      releaseVersion: "v1.2.0",
      audience: "both",
      entries: [
        {
          title: "MFA Authentication Engine",
          entryType: "User Guide",
          audience: "User",
          status: "Published",
          body: "What users can do now:\nUsers can protect their account with TOTP MFA.",
          routes: ["/account/security"],
          apiEndpoints: [],
        },
        {
          title: "MFA Authentication Engine",
          entryType: "Admin Guide",
          audience: "Admin",
          status: "Approved",
          body: [
            "What must be configured:\nSet the MFA encryption key in the runtime environment.",
            "Troubleshooting:\nVerify clock drift allowances in staging before rollout.",
          ].join("\n\n"),
          routes: [],
          apiEndpoints: ["POST /api/v1/auth/mfa/generate", "POST /api/v1/auth/mfa/verify"],
        },
      ],
    });

    expect(blocks.some((block) => block.type === "toggle")).toBe(true);
    expect(blocks.some((block) => block.type === "code")).toBe(true);
    expect(blocks.some((block) => block.type === "heading_2" && block.heading_2?.rich_text?.[0]?.text?.content === "User Manual & Guides")).toBe(true);
    expect(blocks.some((block) => block.type === "heading_2" && block.heading_2?.rich_text?.[0]?.text?.content === "Admin & Technical Specifications")).toBe(true);
  });

  it("sanitizes rehydrated packaged content metadata noise", () => {
    const blocks = buildManualArtifactPageBlocks({
      releaseVersion: "v1.2.1",
      audience: "both",
      entries: [
        {
          title: "MFA Authentication Engine",
          entryType: "User Guide",
          audience: "User",
          status: "Published",
          body: [
            "Audience: User | Entry Type: User Guide | Status: Needs Review",
            "User Manual & Guides",
            "What users can do now:",
            "Users can enable MFA from account security settings.",
            "How to Use",
            "Routes / URLs",
            "/account/security",
          ].join("\n"),
          routes: ["/account/security"],
          apiEndpoints: [],
        },
      ],
    });

    const calloutTexts = blocks
      .filter((block) => block.type === "callout")
      .map((block) => block.callout?.rich_text?.[0]?.text?.content ?? "");

    expect(calloutTexts.some((text) => text.includes("User Manual & Guides"))).toBe(false);
    expect(calloutTexts.some((text) => text.includes("Status: Needs Review"))).toBe(false);
  });
});