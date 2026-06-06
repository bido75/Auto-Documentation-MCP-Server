import { getOptionalRuntimeConfig } from "../config.js";

export function interpolatePrompt(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, key: string) => vars[key] ?? "");
}

export function buildPromptVariables(evidence: { [key: string]: unknown }): Record<string, string> {
  return Object.fromEntries(Object.entries(evidence).map(([key, value]) => [key, Array.isArray(value) ? value.join(", ") : String(value ?? "")])) as Record<string, string>;
}

export async function getPromptTemplate(name: string, _context: { endpoint?: string; apiKey?: string }): Promise<string | null> {
  const runtime = getOptionalRuntimeConfig();
  const selected = runtime.prompts.analyzerPromptName === name ? name : runtime.prompts.analyzerPromptName;
  if (!selected) {
    return null;
  }

  return null;
}