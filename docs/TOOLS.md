# Auto-Doc MCP Tools

Auto-Doc MCP registers 36 tools in v0.2.1.

## Setup And Discovery

- `initialize_project_manual` creates the Notion project page and databases.
- `discover_project_from_notion` rebuilds local state from an existing validated Notion project.
- `configure_ai_provider` selects deterministic, local, Bifrost, or cloud provider routing.
- `health_check` returns runner health and recent monitoring alerts.

## Evidence Capture

- `get_git_diff_summary` summarizes local git changes.
- `capture_development_event` stores commits, PRs, CI, release, and AI-session evidence.
- `capture_ocr_review` imports Open Code Review style findings.
- `attach_visual_evidence` attaches supplied screenshots or figures.
- `capture_feature_screenshot` captures live screenshots when configured safely.

## Analysis And Authoring

- `analyze_documentation_candidate` decides whether evidence is manual-worthy.
- `upsert_feature_documentation` writes user/admin/developer entries to Notion.
- `publish_or_queue_review` applies publishing policy.
- `probe_application` scans an existing repo for undocumented features.
- `generate_gap_report` compares discovered features with documented coverage.
- `synthesize_missing_content` generates missing manual entries from a gap report.
- `humanize_manual` cleans published Notion entries before packaging.
- `humanize_content` humanizes supplied prose/code snippets.

## Packaging And Export

- `assemble_manual` creates coherent user/admin manual pages.
- `package_manual` creates a release package.
- `export_manual_markdown` exports release-ready Markdown.
- `export_manual_pdf` exports release-ready PDF.
- `export_help_center_content` exports help-center JSON.
- `sync_manual_to_local_docs` writes published content to local docs.
- `generate_release_changelog` creates a release changelog.
- `run_release_documentation_pipeline` runs release capture, package, PDF, sync, and optional PR comment flow.

## PR And Release Collaboration

- `generate_pr_comment_preview` builds a PR documentation preview.
- `publish_pr_comment` publishes or updates the preview comment.
- `run_autonomous_documentation_trigger` runs the autonomous capture-analyze-upsert path.

## Runner Operations

- `get_runner_health_summary` summarizes release automation health.
- `get_runner_release_automation_status` reports release automation state.
- `get_runner_failure_triage_metadata` reads failure triage metadata.
- `set_runner_failure_triage_metadata` sets or clears failure triage metadata.

## Adoption And Notifications

- `get_documentation_status` returns basic project documentation status.
- `get_documentation_health` returns coverage percentage, grade, status breakdown, and stale-entry warnings.
- `configure_webhook` stores an outbound Slack, Teams, Discord, or generic webhook.
- `trigger_webhook_test` sends a test notification through a configured webhook.

Use [QUICKSTART.md](../QUICKSTART.md) for the shortest path to a first Notion entry.
