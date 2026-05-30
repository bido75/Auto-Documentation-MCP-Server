# Contributing

## CI Job ID Change Policy

If the CI workflow job id changes from `test-build` to a new value, update all required-check references in the same commit.

Required updates:

1. Update the job id in `.github/workflows/ci.yml`.
2. Update `REQUIRED_CI_CHECK` in `.github/workflows/release.yml` so release gating queries the same check name.
3. Update `$RequiredStatusCheckContext` in `scripts/apply-branch-protection.ps1` so branch protection enforces the same required status check.
4. Update `docs/branch-protection.md` so maintainer guidance matches the enforced check name.

Validation checklist:

1. Run `npm test`.
2. Run `npm run build`.
3. Run `npm run build:extension`.
4. Run branch protection verification:

```powershell
./scripts/apply-branch-protection.ps1 -Owner <owner> -Repo <repo> -VerifyOnly
```

Expected outcome:

- The required status check context reported by verification exactly matches the CI job id in `.github/workflows/ci.yml`.
