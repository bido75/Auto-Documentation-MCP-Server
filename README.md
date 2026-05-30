# Auto-Documentation MCP Server

Production-ready TypeScript MCP server that captures development signals and continuously builds user/admin documentation in Notion.

## Quick Start

1. Install dependencies:

```bash
npm ci
```

2. Run checks:

```bash
npm run typecheck
npm test
npm run build
```

3. Run locally:

```bash
npm run dev
```

5. Run universal ecosystem setup (writes MCP configs for detected tools):

```bash
npm run setup
```

6. Start HTTP bridge for web-based MCP clients:

```bash
npm run bridge
```

## Local Ollama (CPU-Only Quantized)

The included Compose service runs CPU-only by default. Keep the GPU block in `docker-compose.yml` commented out.

Start Ollama:

```bash
docker compose up -d
```

Pull quantized models tuned for CPU usage:

```bash
docker exec ollama ollama pull llama3.1:8b-instruct-q4_K_M
docker exec ollama ollama pull nomic-embed-text
docker exec ollama ollama pull qwen2.5-coder:7b-instruct-q4_K_M
```

Fallback if tag naming differs in your Ollama registry build:

```bash
# List available models/tags first
docker exec ollama ollama search llama3.1
docker exec ollama ollama search qwen2.5-coder

# Alternate common quantized tags
docker exec ollama ollama pull llama3.1:8b-instruct-q4_0
docker exec ollama ollama pull llama3.1:8b-instruct-q5_K_M
docker exec ollama ollama pull qwen2.5-coder:7b-instruct-q4_0
docker exec ollama ollama pull qwen2.5-coder:7b-instruct-q5_K_M
```

If a pull fails with model not found, run `ollama search <model>` and choose the nearest `q4` or `q5` quantized variant for CPU-only usage.

One-liner fallback pull (tries preferred tags first):

```bash
docker exec ollama sh -lc 'for t in 8b-instruct-q4_K_M 8b-instruct-q4_0 8b-instruct-q5_K_M; do ollama pull llama3.1:$t && break; done'
docker exec ollama sh -lc 'for t in 7b-instruct-q4_K_M 7b-instruct-q4_0 7b-instruct-q5_K_M; do ollama pull qwen2.5-coder:$t && break; done'
```

Optional quick check:

```bash
docker exec ollama ollama list
```

## Self-Hosted Stack (Bifrost + Cloudflared + Tailscale + Nginx)

The repository now includes an optional self-hosted deployment profile in `docker-compose.yml`.

One-command bootstrap (brings up the stack and pulls quantized models):

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File ./scripts/bootstrap-self-hosted.ps1
```

```bash
bash ./scripts/bootstrap-self-hosted.sh
```

Optional skip-build mode when images are already built:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File ./scripts/bootstrap-self-hosted.ps1 -SkipBuild
```

```bash
SKIP_BUILD=1 bash ./scripts/bootstrap-self-hosted.sh
```

1. Set environment variables in `.env` (see `.env.example`), especially:

```bash
NOTION_TOKEN=secret_xxx
CLOUDFLARE_TUNNEL_TOKEN=...
CLOUDFLARE_TUNNEL_ID=...
TAILSCALE_AUTH_KEY=...
AUTO_DOC_HTTP_HOST=0.0.0.0
AUTO_DOC_HTTP_PORT=3000
```

2. Start the full stack:

```bash
docker compose --profile self-hosted up -d --build
```

3. Verify service endpoints:

```bash
curl http://localhost:3000/health
curl http://localhost:3000/info
curl http://localhost:3000/startup/preflight
curl http://localhost:3000/contracts/bifrost-discovery
curl http://localhost:3000/runner/status
curl http://localhost:8080
```

Notes:
- `cloudflared/config.yml`, `bifrost-config.json`, and `nginx/nginx.conf` are included.
- The MCP HTTP bridge now supports `/info` and host binding via `AUTO_DOC_HTTP_HOST`.
- Bootstrap now auto-configures Bifrost's Ollama provider/key defaults via `scripts/configure-bifrost.mjs`.
- You can rerun only that step anytime with `npm run selfhost:configure:bifrost`.

## Bifrost MCP Discoverability Contract

Use these endpoints to verify Bifrost/Gateway routing and MCP endpoint discoverability before connecting clients.

- `GET /health` returns bridge liveness metadata.
- `GET /info` returns server metadata, tools, and endpoint map.
- `GET /contracts/bifrost-discovery` returns a machine-readable discovery contract (paths, methods, expected status codes, verification steps).
- `GET /startup/preflight` returns provider health + runner target readiness summary.
- `GET /runner/status` returns configured target status and latest release automation outcomes.
- `POST /runner/trigger` executes an on-demand autonomous trigger for a target.

Reference checks:

```bash
curl http://localhost:3000/health
curl http://localhost:3000/info
curl http://localhost:3000/contracts/bifrost-discovery
curl http://localhost:3000/startup/preflight
curl http://localhost:3000/runner/status
curl -X POST http://localhost:3000/runner/trigger -H "content-type: application/json" -d '{"projectId":"proj_1","repoPath":"C:/repo-one","mode":"working_tree"}'
```

Expected status codes for discovery and operations:

- `200` for `/health`, `/info`, `/contracts/bifrost-discovery`, `/startup/preflight`, `/runner/status`, and successful `/runner/trigger` requests.
- `400` for `/runner/trigger` with missing/invalid target configuration.
- `500` for unexpected server-side execution failures.

4. Run the continuous documentation runner:

```bash
$env:NOTION_TOKEN="secret_token"
$env:AUTO_DOC_RUNTIME_MODE="runner"
$env:AUTO_DOC_RUNNER_TARGETS='[{"projectId":"proj_1","repoPath":"C:/path/to/repo","mode":"working_tree"}]'
npm run dev:runner
```

## Environment

- `NOTION_TOKEN` for Notion API access
- `NOTION_PARENT_PAGE_ID` for live integration tests
- `RUN_LIVE_NOTION_TESTS=true` to enable env-gated live tests
- `AUTO_DOC_RUNTIME_MODE=runner` to start the deployed continuous runner instead of the MCP stdio server
- `AUTO_DOC_RUNNER_TARGETS` as a JSON array of `{ projectId, repoPath, mode }` objects
- `AUTO_DOC_RUNNER_PROJECT_ID`, `AUTO_DOC_RUNNER_REPO_PATH`, and optional `AUTO_DOC_RUNNER_MODE` for a single-target runner setup
- `AUTO_DOC_RUNNER_POLL_INTERVAL_MS` to override the default 60-second polling interval
- `GITHUB_TOKEN` for posting auto-documentation comments to pull requests
- `AUTO_DOC_SCREENSHOT_PUBLIC_BASE_URL` for automatic screenshot publication URLs
- `AUTO_DOC_SCREENSHOT_PUBLIC_DIR` local folder where screenshots are copied for publication

## Continuous Runner

Use the unified app entrypoint to run the background documentation loop.

Single-target example:

```bash
$env:NOTION_TOKEN="secret_token"
$env:AUTO_DOC_RUNTIME_MODE="runner"
$env:AUTO_DOC_RUNNER_PROJECT_ID="proj_1"
$env:AUTO_DOC_RUNNER_REPO_PATH="C:/path/to/repo"
$env:AUTO_DOC_RUNNER_MODE="last_commit"
$env:AUTO_DOC_RUNNER_RELEASE_AUTOMATION="true"
$env:AUTO_DOC_RUNNER_RELEASE_AUDIENCE="both"
$env:AUTO_DOC_RUNNER_RELEASE_PACKAGE_FORMAT="markdown"
$env:AUTO_DOC_RUNNER_RELEASE_PDF_OUTPUT_PATH="artifacts/release-manual.pdf"
$env:AUTO_DOC_RUNNER_RELEASE_LOCAL_DOCS_OUTPUT_PATH="docs/MANUAL.md"
$env:AUTO_DOC_RUNNER_RELEASE_HELP_CENTER_OUTPUT_PATH="docs/help-center.json"
npm run start:runner
```

Multi-target example:

```bash
$env:NOTION_TOKEN="secret_token"
$env:AUTO_DOC_RUNTIME_MODE="runner"
$env:AUTO_DOC_RUNNER_TARGETS='[{"projectId":"proj_1","repoPath":"C:/repo-one","mode":"working_tree","releaseAutomation":true,"releaseAudience":"both","releasePackageFormat":"markdown","releaseHelpCenterOutputPath":"docs/help-center.json"},{"projectId":"proj_2","repoPath":"C:/repo-two","mode":"last_commit"}]'
npm run start:runner
```

The process stays alive, polls each target on the configured interval, and shuts down cleanly on `Ctrl+C` or `SIGTERM`.
When `releaseAutomation` is enabled for a target (or `AUTO_DOC_RUNNER_RELEASE_AUTOMATION=true` in single-target mode), the runner detects the latest Git tag and triggers `run_release_documentation_pipeline` once per newly observed tag.
Release tag checkpoints are persisted in the local state file so a runner restart does not re-run the same tag automatically.
Each release automation attempt is also recorded in the local state ledger with timestamp and outcome (`success` or `failure`) per project, repo, and tag.

Use `get_runner_release_automation_status` to inspect the runner ledger for a target:

```json
{
	"projectId": "proj_1",
	"repoPath": "C:/repo-one",
	"releaseTag": "v2.0.0",
	"limit": 10
}
```

The response includes `lastSeenReleaseTag`, `queriedRun`, and recent run outcomes so you can see why a tag did or did not trigger.

Use `get_runner_health_summary` for a compact cross-target view when you want to quickly spot failing repos/tags:

```json
{
	"limitPerTarget": 1
}
```

You can tune `staleFailureMinutesThreshold` and `escalationFailureStreakThreshold` in the tool input; each failing target then includes `stale` and `escalated`, and triage includes `staleFailureCount` and `escalationCount`.
You can also set `highestPriorityLimit` to get a separate `highestPriorityTargets` section for paging or alerting workflows.

When `targets` are not provided, the tool uses configured runner targets from environment variables and returns summary counts plus a `failingTargets` list.
`failingTargets` are sorted for triage: newest failure first, then larger failure streaks, and include `severity` and `severityScore` to prioritize response.
The response also includes a compact `triage` block (`criticalCount`, `highCount`, `mediumCount`, `lowCount`, newest/oldest failure timestamps) and per-target context like `lastSuccessAt`, `minutesSinceFailure`, acknowledgment metadata, cooldown metadata, and `priorityScore`.
Runner failure triage metadata is stored in local state per project/repo target, so known failures can be acknowledged or cooled down without hiding them completely from summary responses.

Use `set_runner_failure_triage_metadata` when an operator wants to acknowledge a failure or place a target into cooldown without editing local state manually:

```json
{
	"projectId": "proj_1",
	"repoPath": "C:/repo-one",
	"action": "set",
	"acknowledge": true,
	"acknowledgedBy": "ops@example.com",
	"note": "Known vendor outage",
	"cooldownUntil": "2026-05-26T08:00:00.000Z"
}
```

Use `action: "clear"` to remove stored triage metadata for a target.

Use `get_runner_failure_triage_metadata` to inspect the current triage metadata plus recent updates for a target, including the last acknowledgement and the last cooldown change:

```json
{
	"projectId": "proj_1",
	"repoPath": "C:/repo-one",
	"historyView": "acknowledgement_only",
	"sortOrder": "asc",
	"responseMode": "timeline",
	"timelineLabels": ["acknowledged", "cleared"],
	"limit": 10
}
```

`historyView` supports `all` (default), `acknowledgement_only`, and `cooldown_change_only` for faster incident triage.
`sortOrder` supports `desc` (default, newest-first) and `asc` (oldest-first) for chronological timeline views.
`responseMode` supports `standard` (default) and `timeline`; timeline mode adds normalized labels (`acknowledged`, `cooldown_set`, `cleared`, `note_updated`, `metadata_updated`) to make incident scans faster.
`timelineLabels` is optional and only affects timeline mode; when provided, timeline events are filtered to entries matching any requested label.

## Screenshot Enrichment (Post-MVP)

Use `capture_feature_screenshot` to capture UI evidence and optionally append it to a Notion manual-entry page.

Minimal capture:

```json
{
	"url": "https://app.example.com/billing",
	"outputPath": "./artifacts/billing.png"
}
```

Capture plus manual-entry enrichment:

```json
{
	"url": "https://app.example.com/billing",
	"outputPath": "./artifacts/billing.png",
	"manualEntryPageId": "<notion-manual-entry-page-id>",
	"publicImageUrl": "https://cdn.example.com/docs/billing.png",
	"caption": "Billing dashboard after export enhancements"
}
```

If `manualEntryPageId` is provided but `publicImageUrl` is omitted, the tool appends a local screenshot reference note instead of an inline image.

When automatic upload is configured (`AUTO_DOC_SCREENSHOT_PUBLIC_BASE_URL` and `AUTO_DOC_SCREENSHOT_PUBLIC_DIR`), omitted `publicImageUrl` values are auto-published and attached as external images.

## Changelog Generation (Post-MVP)

Use `generate_release_changelog` to compile a release-focused markdown changelog from published/approved manual entries linked to the target release.

```json
{
	"projectId": "proj_1",
	"releaseVersion": "2.0.0",
	"maxEntries": 50
}
```

The tool returns sectioned markdown (`User Impact`, `Admin / Operations`, `Developer Notes`) plus per-section counts.

## GitHub PR Comment Publishing (Post-MVP)

Use `publish_pr_comment` to publish or update an auto-documentation preview comment on a GitHub PR.

```json
{
	"projectId": "proj_1",
	"prUrl": "https://github.com/acme/app/pull/42",
	"audience": "both",
	"maxEntries": 8
}
```

The tool is idempotent per project and PR: it updates the existing auto-doc comment if one is already present.

## PDF Manual Export (Post-MVP)

Use `export_manual_pdf` to generate a local PDF artifact from release-linked manual entries.

```json
{
	"projectId": "proj_1",
	"releaseVersion": "2.0.0",
	"audience": "both",
	"outputPath": "./artifacts/release-2.0.0-manual.pdf"
}
```

This export requires Playwright Chromium (`npx playwright install chromium`) in the execution environment.

## Bi-directional Sync (Post-MVP)

Use `sync_manual_to_local_docs` to pull published Notion manual content and write it into a local markdown file.

```json
{
	"projectId": "proj_1",
	"audience": "both",
	"releaseVersion": "2.0.0",
	"outputPath": "docs/MANUAL.md"
}
```

This keeps a local docs artifact synchronized with the current published manual content in Notion.

## Release-triggered Automation (Post-MVP)

Use `run_release_documentation_pipeline` to execute the full release documentation chain:

1. `run_autonomous_documentation_trigger` (release signal capture)
2. `generate_release_changelog`
3. `package_manual`
4. `export_manual_pdf`
5. `sync_manual_to_local_docs`
6. Optional `export_help_center_content` when `helpCenterOutputPath` is provided
7. Optional `publish_pr_comment` when `prUrl` is provided

```json
{
	"projectId": "proj_1",
	"releaseVersion": "2.0.0",
	"mode": "last_commit",
	"audience": "both",
	"packageFormat": "notion_page",
	"pdfOutputPath": "artifacts/manual-2.0.0.pdf",
	"localDocsOutputPath": "docs/MANUAL.md",
	"helpCenterOutputPath": "docs/help-center.json",
	"prUrl": "https://github.com/acme/app/pull/42"
}
```

## In-app Help Center Export (Post-MVP)

Use `export_help_center_content` to produce structured JSON payloads that can be embedded into an in-app help center UI.

```json
{
	"projectId": "proj_1",
	"audience": "both",
	"releaseVersion": "2.0.0",
	"outputPath": "docs/help-center.json"
}
```

The output groups published entries into sections by entry type (for example, `User Guide` and `Admin Guide`) and includes article summaries and slugs for UI routing.

## CI

GitHub Actions runs typecheck, tests, and build on pushes and pull requests to `main`.

## Branch Protection

Enforce merge protection on `main` so CI must pass before merge:

- Required status check: `test-build`
- Require branch to be up to date before merge
- Require at least one approving pull request review

Apply these settings with the included script:

1. Set a GitHub admin token:

```bash
export GITHUB_ADMIN_TOKEN=<your-admin-token>
```

2. Run:

```bash
./scripts/apply-branch-protection.ps1 -Owner bido75 -Repo Auto-Documentation-MCP-Server
```

3. Read-only verification:

```bash
./scripts/apply-branch-protection.ps1 -Owner bido75 -Repo Auto-Documentation-MCP-Server -VerifyOnly
```

See full policy details in `docs/branch-protection.md`.

## CD Releases

GitHub Actions publishes a release when you push a semantic version tag (`v*.*.*`).

Release workflow:

- Runs `typecheck`, `test`, and `build`
- Verifies the tag commit is on `main`
- Verifies required CI check `test-build` already passed
- Packages a release artifact from `build/` plus runtime metadata files
- Publishes a GitHub Release with autogenerated notes

Before tagging a release, verify the branch policy still matches the repo contract:

```bash
./scripts/apply-branch-protection.ps1 -Owner bido75 -Repo Auto-Documentation-MCP-Server -VerifyOnly
```

Create and push a release tag:

```bash
git tag v1.0.0
git push origin v1.0.0
```

You can also run the Release workflow manually from GitHub Actions using a tag input.

## GitHub Push Setup (Required Once)

This repository is configured to push through SSH.

1. Confirm remote URL:

```bash
git remote -v
```

You should see `git@github.com:bido75/Auto-Documentation-MCP-Server.git`.

2. Generate an SSH key (if needed):

```bash
ssh-keygen -t ed25519 -C "bido75@users.noreply.github.com"
```

3. Copy your public key:

```bash
cat ~/.ssh/id_ed25519.pub
```

4. Add the key in GitHub:

- GitHub Settings -> SSH and GPG keys -> New SSH key

5. Verify auth:

```bash
ssh -T git@github.com
```

6. Push:

```bash
git push -u origin main
```

## Optional Auto-Push

This repo includes a `post-commit` git hook in `.githooks/post-commit` that attempts to push after each commit on `main`.

Enable it locally:

```bash
git config core.hooksPath .githooks
```

If push auth is not configured yet, the hook prints the error and retries once.
