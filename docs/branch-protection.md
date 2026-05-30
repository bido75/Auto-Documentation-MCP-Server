# Branch Protection and Release Gating

This repository uses two layers of protection:

1. GitHub branch protection on main (merge guard)
2. Release workflow policy checks (tag/release guard)

## Merge Guard (main)

Apply protection from PowerShell:

1. Set a GitHub token:

$env:GITHUB_ADMIN_TOKEN = "<your-admin-token>"

Notes:

- `GITHUB_ADMIN_TOKEN` is required to apply protection.
- `GITHUB_TOKEN` (read-level) can be used for `-VerifyOnly` checks.

2. Run:

./scripts/apply-branch-protection.ps1 -Owner bido75 -Repo Auto-Documentation-MCP-Server

3. Verify in read-only mode:

./scripts/apply-branch-protection.ps1 -Owner bido75 -Repo Auto-Documentation-MCP-Server -VerifyOnly

The script configures:

- required status check context: test-build (from CI job id in .github/workflows/ci.yml)
- strict up-to-date branch before merge
- 1 approving review required
- stale review dismissal enabled
- required conversation resolution
- enforce for admins
- force-push and deletion disabled

CI trigger hardening notes:

- `.github/workflows/ci.yml` runs on all pushes and pull requests, and skips docs-only changes via `paths-ignore` for `**/*.md` and `docs/**`.
- Release tags (`v*.*.*`) are excluded from CI push triggers to avoid duplicate release-tag executions.
- Any code/config push still triggers CI, preserving required status enforcement for merge and release gates.

## Release Preflight

Before creating or pushing a release tag, confirm the live branch policy still matches the repo contract:

```bash
./scripts/apply-branch-protection.ps1 -Owner bido75 -Repo Auto-Documentation-MCP-Server -VerifyOnly
```

The release is only considered ready when verify output shows:

- required status check context: test-build
- strict up-to-date branch before merge
- 1 approving review required
- required conversation resolution
- enforce for admins
- force-push and deletion disabled

## Tag and Release Guard

The release workflow enforces:

- tag commit must be reachable from origin/main
- CI check test-build must already be success for the tag commit

If the CI job id is renamed, update all three locations together:

- `.github/workflows/ci.yml` job id
- `scripts/apply-branch-protection.ps1` required status check context
- `.github/workflows/release.yml` REQUIRED_CI_CHECK value

If either condition fails, the release job fails and no release artifact is published.
