#!/usr/bin/env node

const DEFAULT_ENDPOINT = "http://localhost:8080";
const DEFAULT_MODEL = "llama3.2:3b-instruct-q4_K_M";
const DEFAULT_PROVIDER = "openai";
const DEFAULT_TEMPERATURE = 0.1;
const DEFAULT_MAX_TOKENS = 2048;

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
  const response = await fetch(url, options);
  const body = await response.text().catch(() => "");
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText} for ${url}\n${body}`.trim());
  }
  try {
    return body.length > 0 ? JSON.parse(body) : {};
  } catch {
    const contentType = response.headers.get("content-type") || "unknown";
    const snippet = body.slice(0, 200);
    throw new Error(`Received non-JSON response from ${url} (content-type: ${contentType})\n${snippet}`.trim());
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
  const endpoint = normalizeEndpoint(getArgValue("--endpoint") || process.env.BIFROST_ENDPOINT || DEFAULT_ENDPOINT);
  const apiKey = getArgValue("--api-key") || process.env.AI_API_KEY || "";
  const basicAuthUsername = getArgValue("--basic-auth-username") || process.env.BIFROST_BASIC_AUTH_USERNAME || "";
  const basicAuthPassword = getArgValue("--basic-auth-password") || process.env.BIFROST_BASIC_AUTH_PASSWORD || "";
  const model = getArgValue("--model") || process.env.AI_MODEL_NAME || DEFAULT_MODEL;
  const provider = getArgValue("--provider") || DEFAULT_PROVIDER;
  const temperature = Number(getArgValue("--temperature") || DEFAULT_TEMPERATURE);
  const maxTokens = Number(getArgValue("--max-tokens") || DEFAULT_MAX_TOKENS);
  const dryRun = hasFlag("--dry-run");

  const authCandidates = [];
  if (basicAuthUsername.trim().length > 0 && basicAuthPassword.trim().length > 0) {
    const encoded = Buffer.from(`${basicAuthUsername.trim()}:${basicAuthPassword.trim()}`, "utf8").toString("base64");
    authCandidates.push({ mode: "basic", headers: { Authorization: `Basic ${encoded}` } });
  }
  if (apiKey.trim().length > 0) {
    authCandidates.push({ mode: "bearer", headers: { Authorization: "Bearer " + apiKey.trim() } });
  }
  if (authCandidates.length === 0) {
    authCandidates.push({ mode: "none", headers: {} });
  }

  let headers = {};
  let promptsPayload = null;
  const authErrors = [];
  for (const candidate of authCandidates) {
    try {
      promptsPayload = await fetchJson(`${endpoint}/api/prompt-repo/prompts`, { headers: candidate.headers });
      headers = candidate.headers;
      if (authCandidates.length > 1) {
        console.log(`[auth] using ${candidate.mode}`);
      }
      break;
    } catch (error) {
      authErrors.push(`[${candidate.mode}] ${error instanceof Error ? error.message : String(error)}`);
      if (authCandidates.length > 1) {
        console.warn(`[warn] prompt repo auth mode '${candidate.mode}' failed; trying next mode`);
      }
    }
  }

  if (!promptsPayload) {
    throw new Error(`Unable to fetch prompts with available auth modes:\n${authErrors.join("\n")}`);
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

    const versionsPayload = await fetchJson(`${endpoint}/api/prompt-repo/prompts/${match.id}/versions`, { headers });
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
