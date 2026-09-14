#!/usr/bin/env node

const DEFAULT_ENDPOINT = "http://localhost:8080";
const DEFAULT_MODEL = "llama3.2:3b-instruct-q4_K_M";
const DEFAULT_PROVIDER = "openai";
const DEFAULT_TEMPERATURE = 0.1;
const DEFAULT_MAX_TOKENS = 2048;

class PromptRepoUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = "PromptRepoUnavailableError";
  }
}

const PROMPTS = [
  {
    name: "auto-doc-analyzer",
    content: `SYSTEM:
You are an expert technical documentation writer. Produce structured documentation for User and Admin audiences. Output valid JSON only.

RULES:
- User guide must be UI-oriented and imperative.
- Admin guide must include concrete env vars, endpoints, and verification steps.
- No vague phrasing.

USER TEMPLATE:
Analyze this software change and produce complete documentation.
Branch: {{branch}}
Commit Message: {{commit_message}}
PR Title: {{pr_title}}
Files Changed: {{files_changed}}
Routes: {{routes}}
API Endpoints: {{api_endpoints}}
Environment Variables: {{env_vars}}
DB Migrations: {{db_migrations}}
UI Components: {{ui_components}}
Auth Patterns: {{auth_patterns}}
Test Status: {{test_status}}
Diff Summary: {{diff_summary}}

Return JSON keys:
featureName, featureKey, shouldDocument, audiences, userGuide, adminGuide, developerNotes, confidenceScore, confidenceReasons, reviewQuestions.`,
  },
  {
    name: "auto-doc-reviewer",
    content: `SYSTEM:
You are a senior technical writer reviewing generated docs. Be skeptical and specific. Output valid JSON only.

USER TEMPLATE:
Review generated documentation for quality and safety.
Feature Name: {{feature_name}}
Audiences: {{audiences}}
Confidence Score: {{confidence_score}}
Provider: {{provider_used}}
User Summary: {{user_summary}}
User Steps: {{user_steps}}
Expected Outcome: {{expected_outcome}}
Possible Errors: {{possible_errors}}
Admin Config: {{config_required}}
Admin Endpoints: {{endpoints_affected}}
Admin Env Vars: {{env_vars_required}}
Verification Steps: {{verification_steps}}
Troubleshooting: {{troubleshooting}}
Developer Notes: {{developer_notes}}

Return JSON keys:
verdict, issues, blockingIssues, missingFields, redactionConcerns, revisionSuggestions.`,
  },
  {
    name: "auto-doc-gap-filler",
    content: `SYSTEM:
You generate documentation for an undocumented feature discovered from code scanning. Output valid JSON only.

USER TEMPLATE:
Discovery Type: {{discovery_type}}
Identifier: {{identifier}}
File: {{file}}
Line: {{line}}
Estimated Audience: {{estimated_audience}}
Suggested Feature Name: {{suggested_feature_name}}
Suggested Feature Key: {{suggested_feature_key}}
Source Code Context:
{{source_code}}

Requirements:
- featureKey must equal {{suggested_feature_key}}
- confidenceScore <= 65
- include review question asking for human verification.`,
  },
  {
    name: "auto-doc-staleness-updater",
    content: `SYSTEM:
You update stale documentation based on newer code evidence. Preserve correct existing content and modify only changed sections. Output valid JSON only.

USER TEMPLATE:
Feature Name: {{feature_name}}
Feature Key: {{feature_key}}
Current User Summary: {{current_user_summary}}
Current User Steps: {{current_user_steps}}
Current Admin Config: {{current_admin_config}}
Current Admin Endpoints: {{current_admin_endpoints}}
Days Since Update: {{days_since_update}}
Commits Since Update: {{commits_since_last_doc}}
Files Changed: {{files_changed}}
Diff Summary: {{diff_summary}}

Add developerNotes with stale-update reason and age metadata.`,
  },
];

function getArgValue(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return null;
  return process.argv[index + 1] ?? null;
}

function hasFlag(name) {
  return process.argv.includes(name);
}

function normalizeEndpoint(endpoint) {
  return endpoint.replace(/\/+$/, "");
}

function extractTemplate(version) {
  const candidates = [
    version?.template,
    version?.prompt,
    version?.content,
    version?.text,
    version?.body,
    version?.commit_message,
  ];
  for (const value of candidates) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }
  return "";
}

function toComparableString(value) {
  return String(value ?? "").replace(/\r\n/g, "\n").trim();
}

function toComparableNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : NaN;
}

function isLatestEquivalent(latest, desired) {
  if (!latest) return false;

  const templateMatches = toComparableString(extractTemplate(latest)) === toComparableString(desired.commit_message);
  const providerMatches = toComparableString(latest.provider) === toComparableString(desired.provider);
  const modelMatches = toComparableString(latest.model) === toComparableString(desired.model);

  const latestTemp = toComparableNumber(latest?.model_params?.temperature);
  const desiredTemp = toComparableNumber(desired?.model_params?.temperature);
  const latestMaxTokens = toComparableNumber(latest?.model_params?.max_tokens);
  const desiredMaxTokens = toComparableNumber(desired?.model_params?.max_tokens);

  return templateMatches && providerMatches && modelMatches && latestTemp === desiredTemp && latestMaxTokens === desiredMaxTokens;
}

async function fetchJson(url, options = {}) {
  let response;
  try {
    response = await fetch(url, options);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new PromptRepoUnavailableError(`Prompt repo unavailable for ${url}: ${message}`);
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    const preview = body.trim().slice(0, 300);
    throw new PromptRepoUnavailableError(`${response.status} ${response.statusText} for ${url}${preview ? `\n${preview}` : ""}`.trim());
  }

  const contentType = response.headers.get("content-type") || "";
  const body = await response.text();
  if (!contentType.toLowerCase().includes("application/json")) {
    const preview = body.trim().slice(0, 120);
    throw new PromptRepoUnavailableError(`Prompt repo returned a non-JSON response from ${url} (${contentType || "no content-type"}).${preview ? ` Preview: ${preview}` : ""}`);
  }

  try {
    return JSON.parse(body);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new PromptRepoUnavailableError(`Prompt repo returned invalid JSON from ${url}: ${message}`);
  }
}

async function postJson(url, payload, headers) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      ...headers,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`${response.status} ${response.statusText} for ${url}\n${body}`.trim());
  }

  return response.json().catch(() => ({}));
}

async function main() {
  const endpointArg = getArgValue("--endpoint");
  const endpointEnv = process.env.BIFROST_ENDPOINT || process.env.BIFROST_PROMPT_REPO_ENDPOINT || "";
  const endpointConfigured = Boolean(endpointArg?.trim() || endpointEnv.trim());
  const dryRun = hasFlag("--dry-run");
  const required = hasFlag("--required") || process.env.BIFROST_PROMPT_DRIFT_REQUIRED === "true";
  if (dryRun && !required && !endpointConfigured) {
    console.error("Prompt drift guard skipped: prompt repo endpoint is not configured.");
    return;
  }

  const endpoint = normalizeEndpoint(endpointArg || endpointEnv || DEFAULT_ENDPOINT);
  const apiKey = getArgValue("--api-key") || process.env.AI_API_KEY || "";
  const basicAuthUsername = getArgValue("--basic-auth-username") || process.env.BIFROST_BASIC_AUTH_USERNAME || "";
  const basicAuthPassword = getArgValue("--basic-auth-password") || process.env.BIFROST_BASIC_AUTH_PASSWORD || "";
  const model = getArgValue("--model") || process.env.AI_MODEL_NAME || DEFAULT_MODEL;
  const provider = getArgValue("--provider") || DEFAULT_PROVIDER;
  const temperature = Number(getArgValue("--temperature") || DEFAULT_TEMPERATURE);
  const maxTokens = Number(getArgValue("--max-tokens") || DEFAULT_MAX_TOKENS);

  const headers = {};
  if (basicAuthUsername.trim().length > 0 && basicAuthPassword.trim().length > 0) {
    const encoded = Buffer.from(`${basicAuthUsername.trim()}:${basicAuthPassword.trim()}`, "utf8").toString("base64");
    headers.Authorization = `Basic ${encoded}`;
  } else if (apiKey.trim().length > 0) {
    headers.Authorization = `Bearer ${apiKey.trim()}`;
  }

  let promptsPayload;
  try {
    promptsPayload = await fetchJson(`${endpoint}/api/prompt-repo/prompts`, { headers });
  } catch (error) {
    if (dryRun && !required && error instanceof PromptRepoUnavailableError) {
      console.error(`Prompt drift guard skipped: ${error.message}`);
      return;
    }
    throw error;
  }
  const prompts = Array.isArray(promptsPayload?.prompts) ? promptsPayload.prompts : [];

  let unchanged = 0;
  let created = 0;
  let missing = 0;

  for (const prompt of PROMPTS) {
    const match = prompts.find((item) => item?.name === prompt.name);
    if (!match?.id) {
      missing += 1;
      console.error(`[missing] ${prompt.name}`);
      continue;
    }

    let versionsPayload;
    try {
      versionsPayload = await fetchJson(`${endpoint}/api/prompt-repo/prompts/${match.id}/versions`, { headers });
    } catch (error) {
      if (dryRun && !required && error instanceof PromptRepoUnavailableError) {
        console.error(`Prompt drift guard skipped: ${error.message}`);
        return;
      }
      throw error;
    }
    const versions = Array.isArray(versionsPayload?.versions) ? versionsPayload.versions : [];
    const latest = versions.find((item) => item?.is_latest) ?? versions[0] ?? null;

    const desired = {
      commit_message: prompt.content,
      provider,
      model,
      model_params: {
        temperature,
        max_tokens: maxTokens,
      },
    };

    if (isLatestEquivalent(latest, desired)) {
      unchanged += 1;
      const latestVersion = latest?.version_number ?? "?";
      console.log(`[ok] ${prompt.name} already up to date (v${latestVersion})`);
      continue;
    }

    if (dryRun) {
      created += 1;
      console.log(`[plan] ${prompt.name} would create new version`);
      continue;
    }

    const createdVersion = await postJson(
      `${endpoint}/api/prompt-repo/prompts/${match.id}/versions`,
      desired,
      headers,
    );
    created += 1;
    const versionNumber = createdVersion?.version?.version_number ?? createdVersion?.version_number ?? "new";
    console.log(`[updated] ${prompt.name} -> v${versionNumber}`);
  }

  console.log(`summary: updated=${created} unchanged=${unchanged} missing=${missing} dry_run=${dryRun}`);

  if (missing > 0) {
    process.exitCode = 2;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
