# Auto-Doc MCP Quickstart

By the time your project ships, a complete manual is ready.
Auto-Doc MCP sits quietly in your AI coding environment and writes user and admin guides in Notion as you build features.

## Prerequisites

- Node.js 18 or newer
- Git
- A Notion account with an integration token
- A running Auto-Doc MCP server

For a local server, use [Self-Hosting](docs/SELF-HOSTING.md). For a hosted deployment, use the server URL your team provides.

## Before You Run Init

1. Create a Notion integration at [notion.so/my-integrations](https://www.notion.so/my-integrations).
2. Create or choose a parent Notion page for generated manuals.
3. Share the page with the integration.
4. Copy the parent page ID from the Notion URL.

## Install In Any Project

From the project you want documented:

```bash
npx auto-doc-mcp init
```

The init command:

1. Creates the Notion project manual databases.
2. Installs a git post-commit hook.
3. Writes `.auto-doc-mcp.json` with the project binding.
4. Adds `.cursorrules` instructions for your AI coding agent.
5. Optionally writes a GitHub Actions workflow for CI/CD capture.

No generated config contains your Notion token or bridge key.

## Make Your First Documented Commit

Commit any feature:

```bash
git add .
git commit -m "feat: add user authentication"
```

Within about 45 seconds, open the Notion page you selected during init.
You should see a new evidence entry and, when the analyzer decides it is manual-worthy, user/admin manual content for the feature.

## Connect Your AI Agent

The init command writes this automatically to `.cursorrules`:

```text
After completing any feature, call these auto-doc-mcp tools:
1. get_git_diff_summary with mode "last_commit"
2. capture_development_event with the projectId from .auto-doc-mcp.json
3. analyze_documentation_candidate
4. If shouldDocument is true, call upsert_feature_documentation
```

Your AI coding agent can document completed work without another prompt from you.

## Check Documentation Coverage

In your MCP client, call:

```text
get_documentation_health
```

Pass the `projectId` from `.auto-doc-mcp.json`.
The tool returns coverage percentage, a letter grade, status breakdown, stale-entry warnings, and next actions.

## Export A Manual

When you are ready to ship:

```text
package_manual
export_manual_pdf
```

The export contains the release-ready user/admin manual as a PDF, plus Markdown and help-center JSON when requested.

## Add CI/CD Capture

During init, answer yes when asked to install GitHub Actions, or rerun:

```bash
npx auto-doc-mcp init --github-actions
```

Then add these GitHub repository secrets:

```text
AUTO_DOC_MCP_URL
AUTO_DOC_BRIDGE_API_KEY
```

Every push to `main`/`master` and every merged pull request can now send documentation evidence to Auto-Doc.

## Get Notified In Slack Or Teams

In your MCP client, call:

```text
configure_webhook
```

Use your project ID, webhook URL, platform (`slack`, `teams`, `discord`, or `generic`), and events such as:

```text
entries_need_review
coverage_dropped
circuit_opened
```

Use `trigger_webhook_test` to verify delivery.

## Existing Project? No Problem

If Auto-Doc was not connected from the start, backfill coverage with:

```text
probe_application
generate_gap_report
synthesize_missing_content
```

That discovers existing features, compares them with documented features, and creates missing manual entries through the same Notion pipeline.

## Full Documentation

- [Self-hosting](docs/SELF-HOSTING.md)
- [All MCP tools](docs/TOOLS.md)
- [Configuration reference](docs/CONFIGURATION.md)
- [Architecture overview](ARCHITECTURE.md)
