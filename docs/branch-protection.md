# Branch Protection and Release Gating

This repository uses two layers of protection:

1. GitHub branch protection on main (merge guard)
2. Release workflow policy checks (tag/release guard)

## Merge Guard (main)

Apply protection from PowerShell:

1. Set a GitHub token with repository administration permissions:

$env:GITHUB_ADMIN_TOKEN = "<your-admin-token>"

2. Run:

./scripts/apply-branch-protection.ps1 -Owner bido75 -Repo Auto-Documentation-MCP-Server

The script configures:

- required status check: test-build
- strict up-to-date branch before merge
- 1 approving review required
- stale review dismissal enabled
- required conversation resolution
- enforce for admins
- force-push and deletion disabled

## Tag and Release Guard

The release workflow enforces:

- tag commit must be reachable from origin/main
- CI check test-build must already be success for the tag commit

If either condition fails, the release job fails and no release artifact is published.
