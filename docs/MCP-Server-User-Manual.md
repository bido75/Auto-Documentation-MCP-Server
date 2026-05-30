# Auto-Documentation MCP Server User and Developer Integration Manual

## Manual Metadata and Version History

- Manual title: Auto-Documentation MCP Server User and Developer Integration Manual
- Audience: Developers, technical writers, and release owners
- Source repository: Auto-Documentation MCP Server
- Scope: Part 1 (sections 1.1 through 1.13)
- Last updated: 2026-05-28
- Current implementation baseline: Hybrid deterministic plus optional AI pipeline with Notion-first publishing

| Version | Date | Change |
|---|---|---|
| v1.0 | 2026-05-28 | Full rewrite with end-to-end developer integration guidance |

## 1.1 What This System Does

### The problem it solves

Teams usually postpone documentation until release hardening, when implementation context is already stale. The result is late, incomplete manuals that miss operational details and user workflows. This system moves documentation to the same moment features are implemented and validated.

### What it actually does

The server runs as an MCP tool provider and continuously converts engineering signals into structured Notion manual entries.

- Captures signals from git commits, pull request metadata, AI session completions, CI outcomes, and release tags.
- Analyzes evidence with deterministic extraction first, and optional model reasoning second.
- Generates user and admin documentation content tied to a stable feature identity.
- Deduplicates updates by feature key so repeated changes keep one living entry current.
- Applies confidence scoring and publishing policy to decide publish now versus review queue.
- Packages release-ready manuals from approved and published entries.

### What the developer experiences

1. Install and run setup once.
2. Keep coding normally.
3. Documentation appears in Notion as features land.
4. At release, package the manual with one command.

### The two audiences served

- User audience: workflows, steps, expected outcomes, and error handling.
- Admin audience: deployment config, permissions, operations, monitoring, and troubleshooting.

## 1.2 How Silent Background Mode Works

### Pipeline walkthrough

1. Development signal occurs.
  - Examples: commit, PR merge, release tag, CI pass, AI session completion.

2. Evidence capture stores a raw event.
  - Stored fields include project, source, event type, commit, branch, changed files summary, diff summary, and test status.

3. Analyzer executes in stages.
  - Stage A deterministic extraction identifies routes, API endpoints, env vars, migration clues, and visible behavior changes.
  - Stage B optional provider reasoning creates higher-quality user and admin narrative blocks.
  - Stage C guardrails reject vague output and reapply redaction patterns.
  - Stage D optional semantic deduplication maps near-duplicate updates to existing features.

4. Confidence score is computed.
  - Signal quality, test outcomes, feature clarity, and documentation concreteness determine the score.

5. Publishing policy is applied.
  - Conservative, balanced, and fully automatic modes route entries to captured, review, or published.

6. Notion upsert writes feature and entry pages.
  - Existing features are updated instead of duplicated when keys match.

7. Developer reviews only when needed.
  - Normal flow requires no manual action unless items are marked Needs Review.

### What requires no action

- Evidence capture
- Deterministic extraction
- Confidence scoring
- Feature upsert for high-confidence updates

### When action is required

- Entry status is Needs Review.
- Review questions are present in analyzer output.
- Confidence remains below project threshold after repeated updates.

## 1.3 Quick Start: Connect First IDE in 60 Seconds

### Prerequisites

1. Node.js 20 or later.
2. Notion integration token.
3. Notion parent page ID for manual root.

### Get a Notion token in 3 steps

1. In Notion, create an internal integration.
2. Copy the integration secret.
3. Share your manual parent page with the integration.

### Get parent page ID

1. Open the target Notion page in browser.
2. Copy URL.
3. Use the trailing page UUID as parent page ID.

### Fast setup commands

```bash
npm install -g auto-doc-mcp
npx auto-doc-mcp setup
```

### What setup does

1. Stores token via OS secure storage with placeholder writes to config files.
2. Registers manual home page and project metadata.
3. Creates Notion databases for project, features, entries, evidence, and releases.
4. Detects local tools and writes MCP config where supported.
5. Writes project-level config files for workspace clients.
6. Installs git post-commit hook for universal capture fallback.

### First proof point

1. Create any commit.
2. Trigger capture and analyze tools from your IDE MCP client.
3. Confirm first entry appears in Notion Manual Entries.

## 1.4 IDE and Tool Integration Reference

### Tier 1 native MCP configs (implemented in this repo)

| Tool | Path | Status |
|---|---|---|
| Cursor | ~/.cursor/mcp.json | Supported |
| Windsurf | ~/.codeium/windsurf/mcp_config.json | Supported |
| Claude Desktop | platform app-support claude_desktop_config.json | Supported |
| Cline | ~/.vscode/cline_mcp_settings.json | Supported |
| RooCode | ~/.vscode/roo_cline_mcp_settings.json | Supported |
| Kodu AI | ~/.kodu/mcp_settings.json | Supported |
| OpenCode | ~/.config/opencode/config.json | Supported |
| Goose | ~/.config/goose/config.yaml | Supported |
| Amazon Q Developer | ~/.aws/amazonq/default.json | Supported |

### Tier 2 workspace integrations (implemented)

| Tool | Path | Status |
|---|---|---|
| VS Code MCP registry | .vscode/mcp.json | Supported |
| Generic MCP workspace | .mcp.json | Supported |
| Continue.dev workspace | .continue/config.yaml | Supported |

### Tier 3 plugin configs (implemented)

| Tool | Path | Status |
|---|---|---|
| Zed | ~/.config/zed/settings.json | Supported |
| Neovim avante.nvim | ~/.config/nvim/lua/mcp-servers.lua | Supported |
| Emacs gptel/mcp.el | ~/.emacs.d/mcp-config.el | Supported |
| Helix | ~/.config/helix/config.toml | Supported |

### Config examples

JSON mcpServers style:

```json
{
  "mcpServers": {
   "auto-doc-mcp": {
    "command": "node",
    "args": ["/absolute/path/to/build/index.js"],
    "env": {
      "NOTION_TOKEN": "__NOTION_TOKEN__"
    }
   }
  }
}
```

VS Code workspace style:

```json
{
  "servers": {
   "auto-doc-mcp": {
    "type": "stdio",
    "command": "node",
    "args": ["/absolute/path/to/build/index.js"],
    "env": {
      "NOTION_TOKEN": "__NOTION_TOKEN__"
    }
   }
  }
}
```

Goose YAML style:

```yaml
extensions:
  - name: auto-doc-mcp
   type: stdio
   cmd: node
   args:
    - /absolute/path/to/build/index.js
   env:
    NOTION_TOKEN: "__NOTION_TOKEN__"
   enabled: true
```

### Connection verification checklist

1. Client shows server connected.
2. Tool list includes initialize_project_manual and get_documentation_status.
3. Manual status call returns project counts without auth errors.

## 1.5 The 10 Core MCP Tools and What Each Does

This server currently ships more than 10 tools, but these 10 are the core pipeline.

1. initialize_project_manual
  - Creates the Notion database foundation and project metadata.

2. capture_development_event
  - Captures immutable evidence for commits, PRs, CI, releases, and AI session events.

3. analyze_documentation_candidate
  - Determines whether evidence should become documentation and computes confidence.

4. upsert_feature_documentation
  - Creates or updates feature and manual entries using deduplication keys.

5. publish_or_queue_review
  - Applies policy and confidence rules to set final status.

6. package_manual
  - Builds release manual output for user, admin, or both audiences.

7. get_documentation_status
  - Reports documentation health and backlog distribution by status.

8. get_git_diff_summary
  - Produces redacted, bounded diff summaries for analyzer input.

9. capture_feature_screenshot
  - Captures UI evidence to enrich manual pages.

10. configure_ai_provider
  - Switches provider routing and runtime model configuration.

## 1.6 AI Model Provider Selection Guide

| Option | Privacy | Quality | Cost | Offline | Setup complexity | Best use |
|---|---|---|---|---|---|---|
| Deterministic | Highest | Medium | None | Yes | Low | Baseline and privacy-first workflows |
| Local Ollama | High | Medium to high | Low fixed | Yes | Medium | Solo and small teams with local inference |
| Cloud Claude | Medium | High | Usage-based | No | Medium | Highest narrative quality with low review overhead |
| Cloud OpenAI | Medium | High | Usage-based | No | Medium | Teams standardized on OpenAI stack |
| Bifrost gateway | Depends on backend | High | Optimized by cache and governance | Depends | High | Multi-developer governance and spend control |

### Recommended defaults

- Start with deterministic plus balanced mode.
- Move to local Ollama for private quality uplift.
- Add Bifrost when team size, cost governance, and auditing matter.

## 1.7 Understanding Notion Manual Structure

### Five databases created by initialization

1. Projects
2. Features
3. Manual Entries
4. Evidence Events
5. Releases

### How to navigate quickly

- Filter Manual Entries by Audience equals User for user docs.
- Filter Manual Entries by Audience equals Admin for admin docs.
- Filter Status equals Needs Review for approval queue.
- Filter Release to scope a single version package.

### Manual entry anatomy

1. Status callout
2. Summary
3. User workflow steps
4. Expected results and errors
5. Admin configuration and verification
6. Troubleshooting notes

### Status meanings

- Captured: signal stored, pending higher-confidence documentation.
- Needs Review: actionable draft exists but human confirmation required.
- Approved: reviewer accepted content for publish.
- Published: included in active manual output.
- Deprecated: retained for history, excluded from active release docs.

## 1.8 Documentation Lifecycle Example

### Scenario

Developer implements Google OAuth2 login.

- Commit: feat: add Google OAuth2 login
- Files: src/auth/oauth.ts, src/routes/auth.ts, .env.example, migrations/001_add_oauth_fields.sql

### What evidence capture stores

- Event source local_git
- Event type commit
- Branch and commit SHA
- Changed file list
- Redacted diff summary
- Test status if available

### Deterministic extraction outcome

- Routes detected: /auth/google and /auth/google/callback
- Env vars detected: GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET
- Migration signal detected: oauth_provider and oauth_id fields

### AI reasoner output style

User guide block:
- How users choose Continue with Google
- What redirect and callback behavior to expect
- What error appears for canceled consent and invalid callback state

Admin guide block:
- Required OAuth credentials
- Redirect URI registration
- Secret rotation guidance
- Post-deploy verification script and rollback checks

### Confidence and publishing

- Positive signals: feature name clarity, route changes, migration, env vars, tests.
- Typical confidence: high enough for Balanced auto-publish if tests are green and narrative is concrete.

### Resulting entry layout

- Feature page updated or created under auth module.
- User and admin entry pages linked to same feature.
- Release relation attached when packaging target is present.

## 1.9 Confidence Scoring Explained

### Positive signals

- Feature appears in commit or PR metadata.
- User-impacting files changed.
- Tests passed.
- Release or merged state present.
- Existing feature key match is clean.
- Generated content includes concrete steps and outcomes.

### Negative signals

- Pure formatting or test-only changes.
- No user or admin impact.
- Ambiguous feature intent.
- Contradictory evidence metadata.
- Vague AI text.

### Practical score interpretation

- 90 to 100: usually publish-ready.
- 75 to 89: often publish in fully automatic, review in balanced.
- 60 to 74: needs review in most policy configurations.
- Below 60: captured for traceability, not auto-promoted.

### How to raise low confidence

1. Use descriptive commit and PR titles.
2. Include explicit user impact in PR body.
3. Keep tests behavior-focused and passing.

## 1.10 Publishing Modes

### Conservative

- All entries land in Needs Review.
- Best for regulated, externally controlled doc workflows.

### Balanced

- Auto-publishes above threshold.
- Queues medium confidence entries for review.
- Best default for most teams.

### Fully automatic

- Publishes nearly everything except low confidence or contradictions.
- Best for high-trust internal environments and rapid iteration.

### Switching mode

- Project-level setting in Notion metadata.
- Environment-driven defaults for runtime behavior.
- Provider/config tooling for dynamic runtime adjustments.

## 1.11 Packaging a Release Manual

### Procedure

1. Ensure intended entries are Published or Approved.
2. Run package_manual with releaseVersion, audience, and format.
3. Verify included and excluded counts.
4. Share generated Notion URL or markdown artifact.

### Inclusion rules

- Included: Published and Approved.
- Excluded: Captured, Needs Review, Deprecated.
- Output reports excluded reasons for operational clarity.

## 1.12 Multi-PC and Team Workflow

### Solo developer with multiple machines

- Run setup on each machine.
- Use same Notion project/database identity.
- Rely on feature key deduplication to avoid duplicate entries.

### Team of 2 to 10

- Host MCP bridge and provider stack centrally.
- Use per-developer client identity and virtual keys in gateway.
- Keep one shared Notion manual workspace.

### Team with mixed home and office access

- LAN or VPN paths for trusted devices.
- Cloudflare tunnel for remote, no-inbound-port topology.

### Recommended AI-agent directive

Use this directive in team agent instructions:

Always initialize documentation when project metadata is missing. After completing a feature, collect git diff summary, analyze documentation worthiness, and upsert feature documentation without waiting for manual prompts. Apply publishing policy and report only review-required items back to the developer.

## 1.13 Troubleshooting Developer Issues

### Setup completes but databases do not appear

- Symptom: setup exits without visible Notion artifacts.
- Cause: integration lacks permission to parent page.
- Resolution: share parent page with integration and rerun initialization.

### IDE shows MCP disconnected

- Symptom: no tools listed.
- Cause: wrong server path or malformed config schema.
- Resolution: regenerate config with setup and restart IDE.

### Commits do not trigger captures

- Symptom: no new evidence events.
- Cause: post-commit hook missing or inactive path.
- Resolution: reinstall setup or reapply git hook installer.

### Repeated low confidence results

- Symptom: backlog stuck in Needs Review.
- Cause: weak metadata and vague summaries.
- Resolution: improve commit/PR descriptions and ensure tests are explicit.

### Duplicate features in Notion

- Symptom: similar entries with different feature keys.
- Cause: unstable naming in commit and branch conventions.
- Resolution: standardize feature key strategy and merge duplicates through upsert updates.

### AI timeouts with missing docs

- Symptom: provider timeout and partial output.
- Cause: endpoint latency or model unavailability.
- Resolution: keep deterministic fallback enabled and tune provider timeout.

### package_manual returns zero entries

- Symptom: empty release output.
- Cause: no entries in Published or Approved for selected release.
- Resolution: review status filters and release relation mapping.

### Needs Review queue keeps growing

- Symptom: manual quality stagnates.
- Cause: no review owner and no recurring triage cycle.
- Resolution: schedule weekly review and bulk status updates in Notion views.

### Web clients do not auto-call tools

- Symptom: connected but no background automation.
- Cause: missing system directive in agent instructions.
- Resolution: add explicit workflow directive for capture, analyze, and upsert.

### Screenshot capture fails

- Symptom: screenshot tool error.
- Cause: browser dependency missing or headless restrictions.
- Resolution: install Playwright browser runtime and verify OS sandbox prerequisites.
