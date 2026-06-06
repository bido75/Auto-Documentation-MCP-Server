export type Audience = "User" | "Admin" | "Both" | "Internal";

export type EntryType = "User Guide" | "Admin Guide" | "Developer Note" | "Release Note";

export type DocumentationStatus = "Captured" | "Needs Review" | "Approved" | "Published" | "Deprecated";

export type PublishingDecision = "Agent Published" | "Queued Review" | "Human Approved" | "Ignored";

export type EvidenceSource = "Local Git" | "GitHub" | "CI" | "Release" | "AI Session";

export type EvidenceEventType =
  | "Commit"
  | "Diff"
  | "PR Opened"
  | "PR Merged"
  | "Tests Passed"
  | "Release Tagged"
  | "Session Completed";

export interface ManualEntryDraft {
  entryTitle: string;
  entryType: EntryType;
  audience: Audience;
  body: string;
  routes?: string[];
  apiEndpoints?: string[];
}

export interface DocumentationCandidate {
  shouldDocument: boolean;
  featureKey: string;
  featureName: string;
  audiences: Audience[];
  entryTypes: EntryType[];
  confidenceScore: number;
  confidenceReasons: string[];
  reviewQuestions: string[];
}

export type AnalyzeFallbackReasonCode =
  | "none"
  | "no_usable_evidence"
  | "analyzer_exception_fallback_persisted"
  | "analyzer_exception_fallback_persist_failed";

export type AnalyzeFallbackStatus = "Captured" | null;

export interface AnalyzeDocumentationCandidateResult extends DocumentationCandidate {
  fallbackStatus: AnalyzeFallbackStatus;
  fallbackEntryId: string | null;
  fallbackReasonCode: AnalyzeFallbackReasonCode;
  dedupeDecision?: string;
  matchedExistingFeatureKey?: string | null;
}
