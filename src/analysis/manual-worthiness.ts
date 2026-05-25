import type { Audience } from "../types.js";

interface ClassificationInput {
  summary: string;
  filesChanged: string[];
}

interface ClassificationResult {
  shouldDocument: boolean;
  audiences: Audience[];
  reasons: string[];
}

const USER_TERMS = [
  "page",
  "screen",
  "dashboard",
  "button",
  "form",
  "setting",
  "workflow",
  "export",
  "import",
  "login",
  "signup",
  "notification",
  "report",
  "billing",
  "auth",
];

const ADMIN_TERMS = [
  "env",
  "environment",
  "webhook",
  "permission",
  "role",
  "policy",
  "api",
  "endpoint",
  "integration",
  "deployment",
  "audit",
  "security",
  "retry",
  "configuration",
];

const IGNORE_TERMS = ["format", "prettier", "lint", "refactor", "rename variable", "test only"];

export function classifyManualWorthiness(input: ClassificationInput): ClassificationResult {
  const haystack = `${input.summary} ${input.filesChanged.join(" ")}`.toLowerCase();
  const audiences = new Set<Audience>();
  const reasons: string[] = [];

  if (IGNORE_TERMS.some((term) => haystack.includes(term))) {
    return {
      shouldDocument: false,
      audiences: [],
      reasons: ["Change appears internal or formatting-only."],
    };
  }

  if (USER_TERMS.some((term) => haystack.includes(term)) || /routes?|components?|pages?/.test(haystack)) {
    audiences.add("User");
    reasons.push("User-facing workflow or UI change detected.");
  }

  if (ADMIN_TERMS.some((term) => haystack.includes(term)) || /\.env/.test(haystack)) {
    audiences.add("Admin");
    reasons.push("Admin configuration or integration change detected.");
  }

  return {
    shouldDocument: audiences.size > 0,
    audiences: [...audiences],
    reasons: reasons.length > 0 ? reasons : ["No manual-worthy user or admin impact detected."],
  };
}
