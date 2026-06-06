# Auto-Documentation MCP Server — Vibe Coding Build Prompt

You are building a production-ready **Auto-Documentation MCP Server** in TypeScript. This server sits silently in the background of a developer's AI coding environment (Cursor, Claude Desktop, VS Code + Copilot, etc.) and automatically generates living user and admin manuals in Notion as features are completed — so by the time a project ships, a fully packaged manual is ready.

---

## Project Vision

Most teams write documentation at the very end of a project, when context is stale and the work is rushed. This MCP server fixes that by capturing documentation-worthy details **while the work is fresh**, turning them into polished manual entries automatically — with zero friction for the developer.

The flow is:

```
Developer works normally
        ↓
Development signal appears (git commit, PR, AI session summary)
        ↓
Evidence collector records the event
        ↓
Documentation analyzer decides if the event is manual-worthy
        ↓
Feature key resolver matches or creates a stable feature identity
        ↓
Documentation generator creates User / Admin / Developer sections
        ↓
Confidence scorer assigns a publish confidence score (0–100)
        ↓
Notion writer upserts docs and sets review status
        ↓
Manual packager assembles a release-ready manual on demand
```

---

## Tech Stack

- **Runtime:** Node.js with TypeScript (`"type": "module"`)
- **MCP SDK:** `@modelcontextprotocol/sdk` (official, latest)
- **Notion client:** `@notionhq/client`
- **Schema validation:** `zod`
- **Git integration:** `simple-git`
- **Screenshot capture:** `playwright` (optional, non-blocking)
- **Transport:** stdio (for local IDE integration)

### Install commands
```bash
npm init -y
npm install @modelcontextprotocol/sdk @notionhq/client zod simple-git
npm install -D typescript tsx @types/node
npx playwright install chromium   # optional, for screenshot capture
```

### tsconfig.json
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "build",
    "strict": true,
    "esModuleInterop": true
  },
  "include": ["src"]
}
```

### package.json scripts
```json
{
  "type": "module",
  "scripts": {
    "dev": "tsx src/index.ts",
    "build": "tsc",
    "start": "node build/src/index.js"
  }
}
```

---

## Project Folder Structure

```
src/
  index.ts                         ← MCP server entry point
  tools/
    initialize-project-manual.ts
    capture-development-event.ts
    analyze-documentation-candidate.ts
    upsert-feature-documentation.ts
    publish-or-queue-review.ts
    package-manual.ts
    get-documentation-status.ts
    get-git-diff-summary.ts
    capture-feature-screenshot.ts
    export-manual-markdown.ts
  lib/
    notion.ts                      ← Notion client singleton
    blocks.ts                      ← Notion block builder helpers
    git.ts                         ← simple-git helpers
    confidence.ts                  ← confidence scoring logic
    analyzer.ts                    ← manual-worthy classification logic
    deduplication.ts               ← feature key resolver
    export.ts                      ← markdown export helpers
    screenshots.ts                 ← playwright screenshot capture
```

---

## Notion Database Schema

Build these **five Notion databases** when `initialize_project_manual` is called.

### 1. Projects
| Property | Type | Purpose |
|---|---|---|
| Project Name | Title | Human-readable name |
| Repository URL | URL | Main repo link |
| Publishing Mode | Select | Conservative / Balanced / Fully Automatic |
| Auto Publish Threshold | Number | Confidence score required for auto-publish (default 90) |
| Manual Home | URL | Primary Notion manual page URL |
| Current Release | Rich text | Active release version |
| Documentation Health | Status | Healthy / Needs Review / Behind |

### 2. Features
| Property | Type | Purpose |
|---|---|---|
| Feature Name | Title | Stable display name |
| Feature Key | Rich text | Deduplication key (route/module/domain) |
| Project | Relation | Owning project |
| Module | Select | Auth / Billing / Admin Panel / Reports / API / Frontend / Backend |
| Audience Impact | Multi-select | User / Admin / Developer / Support |
| Status | Status | Captured / Needs Review / Approved / Published / Deprecated |
| First Seen Commit | Rich text | First source commit SHA |
| Last Documented Commit | Rich text | Latest source commit included |
| Release Introduced | Rich text | Release version where feature first appears |
| Confidence Score | Number | Latest scoring result |

### 3. Manual Entries
| Property | Type | Purpose |
|---|---|---|
| Entry Title | Title | Manual section title |
| Entry Type | Select | User Guide / Admin Guide / Developer Note / Release Note |
| Audience | Select | User / Admin / Both / Internal |
| Project | Relation | Owning project |
| Feature | Relation | Related feature |
| Release | Relation | Related release |
| Status | Status | Captured / Needs Review / Approved / Published / Deprecated |
| Confidence Score | Number | Score used for publish decision |
| Publishing Decision | Select | Agent Published / Queued Review / Human Approved / Ignored |
| Source Commit | Rich text | Commit that generated the entry |
| Source PR | URL | PR URL when available |
| Files Changed | Rich text | Important source files |
| Routes / URLs | Rich text | User-facing routes |
| API Endpoints | Rich text | Admin or integration endpoints |
| Date Captured | Date | Initial capture date |
| Date Published | Date | Publication date |
| Reviewer Notes | Rich text | Human review notes |

### 4. Evidence Events
| Property | Type | Purpose |
|---|---|---|
| Event Title | Title | Short event label |
| Project | Relation | Owning project |
| Source | Select | Local Git / GitHub / CI / Release / AI Session |
| Event Type | Select | Commit / Diff / PR Opened / PR Merged / Tests Passed / Release Tagged / Session Completed |
| Commit SHA | Rich text | Commit identifier |
| Branch | Rich text | Branch name |
| PR URL | URL | Pull request URL |
| Release Version | Rich text | Release version |
| Files Changed | Rich text | Changed file list (summaries only, no raw secrets) |
| Diff Summary | Rich text | Concise diff summary |
| Test Status | Select | Passed / Failed / Unknown / Not Run |
| Captured At | Date | Capture timestamp |

### 5. Releases
| Property | Type | Purpose |
|---|---|---|
| Release Version | Title | Version name |
| Project | Relation | Owning project |
| Status | Status | Planned / In Progress / Ready / Released |
| Release Date | Date | Ship date |
| Included Features | Relation | Features in release |
| Manual URL | URL | Packaged release manual |
| User Entries Count | Number | Count of included user docs |
| Admin Entries Count | Number | Count of included admin docs |

---

## MCP Tools to Implement

### Tool 1: `initialize_project_manual`
Creates the full five-database Notion schema for a project.

**Input:**
- `projectName` (string)
- `parentPageId` (string) — Notion page ID where databases should live
- `repositoryUrl` (string, optional)
- `publishingMode` (enum: `conservative` | `balanced` | `fully_automatic`, default `balanced`)
- `autoPublishThreshold` (number, default 90)

**Output:** Returns all five database IDs as a JSON object.

---

### Tool 2: `capture_development_event`
Stores raw development evidence from any signal source.

**Input:**
- `projectId` (string)
- `source` (enum: `local_git` | `github` | `ci` | `release` | `ai_session`)
- `eventType` (enum: `commit` | `diff` | `pr_opened` | `pr_merged` | `tests_passed` | `release_tagged` | `session_completed`)
- `summary` (string)
- `commitSha` (string, optional)
- `branch` (string, optional)
- `prUrl` (string URL, optional)
- `releaseVersion` (string, optional)
- `filesChanged` (string, optional) — comma-separated list
- `diffSummary` (string, optional) — concise summary, NO raw secrets
- `testStatus` (enum: `passed` | `failed` | `unknown` | `not_run`, optional)

**Output:** Evidence event ID, initial manual-worthy classification (`true` | `false` | `uncertain`).

---

### Tool 3: `analyze_documentation_candidate`
Classifies evidence and computes confidence. This is the brain of the system.

**Input:**
- `projectId` (string)
- `evidenceEventIds` (array of strings)
- `existingFeatureKeys` (array of strings, optional) — pass known keys to help deduplication

**Output:**
```json
{
  "shouldDocument": true,
  "featureKey": "auth/oauth2-login",
  "featureName": "OAuth2 Login Integration",
  "audiences": ["User", "Admin"],
  "entryTypes": ["User Guide", "Admin Guide"],
  "confidenceScore": 87,
  "confidenceReasons": ["PR title matches feature name", "auth files changed", "tests passed"],
  "reviewQuestions": ["Which OAuth providers are supported?"]
}
```

**Classification rules — Document when:**
- New screen, page, dashboard, form, button, setting, or workflow
- Changed behavior visible to end users
- New validation, error state, onboarding flow, notification, export, import, auth, or billing behavior
- New role, permission, policy, integration, webhook, environment variable, or deployment setting
- New API endpoint that admins or integrators use
- New database migration, monitoring, audit, security, or troubleshooting behavior

**Skip when:**
- Formatting-only changes
- Test-only changes
- Internal refactors with no behavior change
- Dependency updates (unless they affect setup, security, or compatibility)

**Confidence scoring — Positive signals:**
- Feature name appears in PR title, issue title, branch, or commit message (+15)
- User-facing files changed (routes, UI components, forms, API endpoints) (+20)
- Tests passed (+10)
- PR merged or release tagged (+15)
- Existing feature key matched cleanly (+10)
- Generated documentation contains concrete steps and expected outcomes (+15)

**Confidence scoring — Negative signals:**
- Appears formatting/test/refactor-only (-30)
- No user or admin impact detected (-25)
- Feature purpose is ambiguous (-15)
- Evidence conflicts across commits and PR text (-10)
- Generated documentation is vague ("various improvements") (-20)

---

### Tool 4: `upsert_feature_documentation`
Creates or updates Notion feature and manual entry pages. This is the primary deduplication-aware write path. Before creating a new feature, search for existing features by `featureKey` and update if found.

**Input:**
- `projectId` (string)
- `featureKey` (string) — stable deduplication key
- `featureName` (string)
- `module` (string, optional)
- `audiences` (array: `User` | `Admin` | `Developer` | `Support`)
- `manualEntries` (array of objects):
  - `entryType`: `User Guide` | `Admin Guide` | `Developer Note` | `Release Note`
  - `title`: string
  - `userGuide`: string (what the user can do, where to go, what to click, what to expect, what errors might appear)
  - `adminGuide`: string (what to configure, which permissions/env vars matter, how to verify, troubleshooting)
  - `developerNotes`: string (optional, only include when relevant for deployment/support)
- `evidenceEventIds` (array of strings)
- `confidenceScore` (number)
- `confidenceReasons` (array of strings)

**Output:** Feature page ID, manual entry page IDs, publishing status.

**Deduplication logic:** Match `featureKey` against existing features in the project. If match found, append new evidence and update the existing page rather than creating a duplicate.

---

### Tool 5: `publish_or_queue_review`
Applies the project publishing policy to a documentation candidate.

**Input:**
- `projectId` (string)
- `featureId` (string)
- `manualEntryIds` (array of strings)
- `confidenceScore` (number)
- `publishingMode` (enum: `conservative` | `balanced` | `fully_automatic`)

**Publishing mode behavior:**

| Mode | Behavior |
|---|---|
| `conservative` | All entries saved as `Needs Review` |
| `balanced` | Score ≥ threshold → `Published`; 60–89 → `Needs Review`; < 60 → `Captured` |
| `fully_automatic` | `Published` unless score is low (< 60) or analyzer detects a contradiction |

**Output:** Final status (`Captured` | `Needs Review` | `Approved` | `Published`), review notes.

---

### Tool 6: `package_manual`
Builds a release-ready manual from published or approved entries.

**Input:**
- `projectId` (string)
- `releaseVersion` (string)
- `audience` (enum: `user` | `admin` | `both`)
- `format` (enum: `notion_page` | `markdown`)

**Output:** Notion page URL or Markdown content, included entry count, excluded entry count with reasons.

**Manual structure:**
```
# [Project Name] — [Release Version] Manual

## User Guide
[All published User Guide entries, grouped by module]

## Admin Guide
[All published Admin Guide entries, grouped by module]

## What's New in [Version]
[Release notes for this version]
```

---

### Tool 7: `get_documentation_status`
Reports documentation health for a project.

**Input:**
- `projectId` (string)
- `releaseVersion` (string, optional)

**Output:** Published count, needs review count, captured count, low confidence count, missing review questions list.

---

### Tool 8: `get_git_diff_summary`
Reads recent local Git changes so the AI can decide what to document.

**Input:**
- `repoPath` (string) — absolute path to the local repo
- `mode` (enum: `staged` | `last_commit` | `working_tree`)

**Output:** Diff text or stat summary. Truncate at 8000 characters. Strip any values that look like secrets (tokens, passwords, API keys).

---

### Tool 9: `capture_feature_screenshot` *(optional, non-blocking)*
Captures a screenshot of a UI feature page using Playwright.

**Input:**
- `url` (string URL)
- `outputPath` (string) — local file path to save PNG

**Output:** Confirmation message with saved path.

---

### Tool 10: `export_manual_markdown`
Exports all published Notion manual entries into a single Markdown document.

**Input:**
- `projectId` (string)
- `projectName` (string)
- `audience` (enum: `user` | `admin` | `both`, optional, default `both`)

**Output:** Full Markdown string, ready to be saved as `MANUAL.md` or embedded in an in-app help center.

---

## Content Rules for Generated Documentation

### User guide entries must answer:
1. What can the user do now?
2. Where does the user go?
3. What action does the user take?
4. What result should the user expect?
5. What errors or edge states might the user see?

### Admin guide entries must answer:
1. What must be configured?
2. Which permissions, roles, integrations, endpoints, or environment variables matter?
3. What operational workflow changed?
4. How should an admin verify the feature works?
5. What troubleshooting information belongs here?

### Developer notes:
Include only when they help with deployment, support, maintenance, integrations, or release operations. Do not include low-level implementation details that only matter to the author.

---

## Security and Privacy Rules

- Read the `NOTION_TOKEN` only from environment variables — never hardcode it.
- Do not store raw diffs in Notion. Store summaries and file lists only.
- Redact secret-looking values (tokens, passwords, keys) from any diff content before storage.
- Never include local repository paths in user-facing manual entries.
- Project settings can disable developer notes for external-facing manuals.

---

## Error Handling

- Missing `NOTION_TOKEN` → clear MCP error with setup instructions.
- Missing database IDs → project initialization error pointing to `initialize_project_manual`.
- Notion rate limits → retry with exponential backoff (3 retries, 2s / 4s / 8s).
- Notion validation errors → include property name and attempted value in error message.
- Analyzer failures → store evidence event as `Captured` status rather than losing the signal.
- Duplicate feature matches below confidence threshold → queue for human review.

---

## IDE Integration Config

After building, the server is registered in the IDE like this:

```json
{
  "mcpServers": {
    "auto-doc-server": {
      "command": "node",
      "args": ["/absolute/path/to/build/src/index.js"],
      "env": {
        "NOTION_TOKEN": "secret_yourNotionIntegrationTokenHere"
      }
    }
  }
}
```

---

## System Directive for the AI Agent

Add this to `.cursorrules`, the system prompt, or the IDE's AI instructions file:

> "You have access to the `auto-doc-server` MCP tool suite. At the start of any project, call `initialize_project_manual` if no documentation database exists yet. Every time you finish implementing a complete feature, module, screen, API endpoint, or architecture change, silently call `get_git_diff_summary` to read what changed, then call `analyze_documentation_candidate` to classify it, then call `upsert_feature_documentation` to write the manual entry. Do not ask the developer for permission — documentation runs in the background as a natural part of finishing work. At release time, call `package_manual` to produce the final user and admin manual."

---

## MVP Acceptance Criteria

- [ ] TypeScript MCP server starts over stdio with no errors.
- [ ] `initialize_project_manual` creates all five Notion databases with correct schema.
- [ ] `capture_development_event` stores evidence without losing any signal on failure.
- [ ] `analyze_documentation_candidate` classifies manual-worthy vs ignored changes correctly.
- [ ] `upsert_feature_documentation` creates new features and updates existing ones without duplication.
- [ ] Confidence-gated publishing works correctly in all three modes.
- [ ] `package_manual` assembles a readable release manual from Published and Approved entries.
- [ ] `get_git_diff_summary` reads staged, last commit, and working tree diffs.
- [ ] All tools handle Notion API errors gracefully without crashing the server.
- [ ] Solo local usage (git-based signals) and team usage (GitHub PR metadata) both flow through the same core pipeline.

---

## Future Enhancements (Post-MVP)

- **Screenshot enrichment** — UI screenshots uploaded to Notion pages automatically.
- **Changelog generation** — Auto-compiled "What's New" page per major version bump.
- **Bi-directional sync** — Pull Notion doc updates back down to local `docs/` or `README.md`.
- **PDF export** — Generate a downloadable PDF manual for distribution.
- **GitHub PR comments** — Post a documentation preview as a PR comment before merge.
- **In-app help center** — Export Markdown manual as structured content for embedding in the shipped app.
