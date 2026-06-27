---
name: security-or-production-hardening
description: Workflow command scaffold for security-or-production-hardening in Auto-Documentation-MCP-Server.
allowed_tools: ["Bash", "Read", "Write", "Grep", "Glob"]
---

# /security-or-production-hardening

Use this workflow when working on **security-or-production-hardening** in `Auto-Documentation-MCP-Server`.

## Goal

Performs security or production hardening by updating configuration, Docker, and CI files, as well as making targeted code and test changes.

## Common Files

- `.env.example`
- `.gitignore`
- `.dockerignore`
- `docker-compose.yml`
- `Dockerfile`
- `.github/workflows/ci.yml`

## Suggested Sequence

1. Understand the current state and failure mode before editing.
2. Make the smallest coherent change that satisfies the workflow goal.
3. Run the most relevant verification for touched files.
4. Summarize what changed and what still needs review.

## Typical Commit Signals

- Update configuration files (.env.example, .gitignore, .dockerignore, docker-compose.yml, Dockerfile, .github/workflows/ci.yml)
- Update or patch core code for security or reliability (src/lib/, src/http-bridge/, src/config.ts, etc.)
- Update or add relevant integration/unit tests to verify hardening
- Update documentation as needed (README.md, QUICKSTART.md)

## Notes

- Treat this as a scaffold, not a hard-coded script.
- Update the command if the workflow evolves materially.