import type { Client } from "@notionhq/client";
import { withNotionRetry } from "../lib/notion-retry.js";
import type { DocumentationStatus, ManualEntryDraft, PublishingDecision } from "../types.js";
import { buildManualEntryBlocks } from "./manual-layout.js";

export function decidePublishingStatus(input: {
  mode: "Conservative" | "Balanced" | "Fully Automatic";
  score: number;
  threshold: number;
  hasContradiction?: boolean;
  forceQueueReview?: boolean;
}): { status: DocumentationStatus; decision: PublishingDecision } {
  if (input.forceQueueReview) {
    return { status: "Needs Review", decision: "Queued Review" };
  }

  if (input.mode === "Conservative") {
    return { status: "Needs Review", decision: "Queued Review" };
  }

  if (input.mode === "Fully Automatic") {
    if (input.score < 60 || input.hasContradiction) {
      return { status: "Needs Review", decision: "Queued Review" };
    }

    return { status: "Published", decision: "Agent Published" };
  }

  if (input.score >= input.threshold) {
    return { status: "Published", decision: "Agent Published" };
  }

  if (input.score >= 60) {
    return { status: "Needs Review", decision: "Queued Review" };
  }

  return { status: "Captured", decision: "Queued Review" };
}

export async function createManualEntry(input: {
  notion: Client;
  databaseId: string;
  draft: ManualEntryDraft;
  status: DocumentationStatus;
  decision: PublishingDecision;
  confidenceScore: number;
  reviewerNotes?: string;
  sourceCommit?: string;
  sourcePr?: string;
  filesChanged?: string[];
  projectPageId?: string;
  featurePageId?: string;
  releasePageId?: string;
}) {
  const payload = {
    parent: { database_id: input.databaseId },
    properties: {
      "Entry Title": { title: [{ text: { content: input.draft.entryTitle } }] },
      "Entry Type": { select: { name: input.draft.entryType } },
      Audience: { select: { name: input.draft.audience } },
      Status: { status: { name: input.status } },
      "Confidence Score": { number: input.confidenceScore },
      "Publishing Decision": { select: { name: input.decision } },
      ...(input.reviewerNotes && {
        "Reviewer Notes": { rich_text: [{ text: { content: input.reviewerNotes } }] },
      }),
      ...(input.sourceCommit && {
        "Source Commit": { rich_text: [{ text: { content: input.sourceCommit } }] },
      }),
      ...(input.sourcePr && { "Source PR": { url: input.sourcePr } }),
      ...(input.filesChanged && {
        "Files Changed": {
          rich_text: [{ text: { content: input.filesChanged.join("\n") } }],
        },
      }),
      ...(input.draft.routes && {
        "Routes / URLs": {
          rich_text: [{ text: { content: input.draft.routes.join("\n") } }],
        },
      }),
      ...(input.draft.apiEndpoints && {
        "API Endpoints": {
          rich_text: [{ text: { content: input.draft.apiEndpoints.join("\n") } }],
        },
      }),
      "Date Captured": { date: { start: new Date().toISOString().slice(0, 10) } },
      ...(input.status === "Published" && {
        "Date Published": { date: { start: new Date().toISOString().slice(0, 10) } },
      }),
      ...(input.projectPageId && {
        Project: {
          relation: [{ id: input.projectPageId }],
        },
      }),
      ...(input.featurePageId && {
        Feature: {
          relation: [{ id: input.featurePageId }],
        },
      }),
      ...(input.releasePageId && {
        Release: {
          relation: [{ id: input.releasePageId }],
        },
      }),
    },
    children: buildManualEntryBlocks({
      title: input.draft.entryTitle,
      entryType: input.draft.entryType,
      audience: input.draft.audience,
      body: input.draft.body,
      status: input.status,
      routes: input.draft.routes,
      apiEndpoints: input.draft.apiEndpoints,
    }),
  };

  const page = await withNotionRetry(() =>
    input.notion.pages.create(payload as never),
    {
      operationName: "pages.create",
      payload,
    },
  );

  const url = "url" in page && typeof page.url === "string" ? page.url : undefined;
  return { pageId: page.id, url };
}
