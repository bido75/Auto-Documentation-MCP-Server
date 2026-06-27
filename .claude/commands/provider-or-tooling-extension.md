---
name: provider-or-tooling-extension
description: Workflow command scaffold for provider-or-tooling-extension in Auto-Documentation-MCP-Server.
allowed_tools: ["Bash", "Read", "Write", "Grep", "Glob"]
---

# /provider-or-tooling-extension

Use this workflow when working on **provider-or-tooling-extension** in `Auto-Documentation-MCP-Server`.

## Goal

Adds or extends a provider or tool, updating provider factory, adding new provider/tool files, and corresponding tests.

## Common Files

- `src/providers/*.ts`
- `src/providers/factory.ts`
- `src/tools/*.ts`
- `tests/integration/*.test.ts`
- `tests/unit/*.test.ts`
- `README.md`

## Suggested Sequence

1. Understand the current state and failure mode before editing.
2. Make the smallest coherent change that satisfies the workflow goal.
3. Run the most relevant verification for touched files.
4. Summarize what changed and what still needs review.

## Typical Commit Signals

- Add or update provider files in src/providers/ and update src/providers/factory.ts
- Add or update tool files in src/tools/
- Update or add tests for new provider/tool in tests/integration/ and/or tests/unit/
- Update documentation if necessary

## Notes

- Treat this as a scaffold, not a hard-coded script.
- Update the command if the workflow evolves materially.