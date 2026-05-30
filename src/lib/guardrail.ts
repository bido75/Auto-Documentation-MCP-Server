import type { ModelAnalysis } from "../providers/base.js";

const VAGUE_PHRASES = [
  "various improvements",
  "miscellaneous changes",
  "general updates",
  "some fixes",
  "code cleanup",
  "minor changes",
  "stuff was changed",
  "things were improved",
  "updated the code",
  "made changes to",
];

const SECRET_PATTERNS = [
  /sk-[a-z0-9]{20,}/gi,
  /secret_[a-z0-9]{20,}/gi,
  /ghp_[a-zA-Z0-9]{20,}/gi,
  /xoxb-[0-9-]+/gi,
  /password\s*=\s*["'][^"']+/gi,
  /api[_-]?key\s*=\s*["'][^"']+/gi,
  /\/home\/[a-z]+\//gi,
  /\/Users\/[a-zA-Z]+\//gi,
  /C:\\\\Users\\\\[^\\]+\\/gi,
];

export interface GuardrailResult {
  passed: boolean;
  sanitized: ModelAnalysis;
  violations: string[];
}

export function validateAndSanitize(analysis: ModelAnalysis): GuardrailResult {
  const sanitized = structuredClone(analysis);
  const violations: string[] = [];

  const haystack = [
    sanitized.userGuide.summary,
    ...sanitized.userGuide.steps,
    sanitized.userGuide.expectedOutcome,
    ...sanitized.userGuide.possibleErrors,
    ...sanitized.adminGuide.configRequired,
    ...sanitized.adminGuide.verificationSteps,
    ...sanitized.adminGuide.troubleshooting,
  ]
    .join(" ")
    .toLowerCase();

  for (const phrase of VAGUE_PHRASES) {
    if (haystack.includes(phrase)) {
      violations.push(`Vague phrase detected: \"${phrase}\"`);
    }
  }

  const redact = (value: string) => SECRET_PATTERNS.reduce((acc, pattern) => acc.replace(pattern, "[REDACTED]"), value);

  sanitized.userGuide.summary = redact(sanitized.userGuide.summary);
  sanitized.userGuide.steps = sanitized.userGuide.steps.map(redact);
  sanitized.userGuide.expectedOutcome = redact(sanitized.userGuide.expectedOutcome);
  sanitized.userGuide.possibleErrors = sanitized.userGuide.possibleErrors.map(redact);
  sanitized.adminGuide.configRequired = sanitized.adminGuide.configRequired.map(redact);
  sanitized.adminGuide.endpointsAffected = sanitized.adminGuide.endpointsAffected.map(redact);
  sanitized.adminGuide.envVarsRequired = sanitized.adminGuide.envVarsRequired.map(redact);
  sanitized.adminGuide.verificationSteps = sanitized.adminGuide.verificationSteps.map(redact);
  sanitized.adminGuide.troubleshooting = sanitized.adminGuide.troubleshooting.map(redact);
  if (sanitized.developerNotes) {
    sanitized.developerNotes = redact(sanitized.developerNotes);
  }

  if (!sanitized.userGuide.summary || sanitized.userGuide.summary.length < 20) {
    violations.push("User guide summary is missing or too short");
  }
  if (sanitized.userGuide.steps.length === 0) {
    violations.push("User guide has no steps");
  }
  if (!sanitized.featureName || sanitized.featureName.length < 5) {
    violations.push("Feature name is missing or too short");
  }

  return {
    passed: violations.length === 0,
    sanitized,
    violations,
  };
}