---
name: feature-implementation-with-tests-and-docs
description: Workflow command scaffold for feature-implementation-with-tests-and-docs in Auto-Documentation-MCP-Server.
allowed_tools: ["Bash", "Read", "Write", "Grep", "Glob"]
---

# /feature-implementation-with-tests-and-docs

Use this workflow when working on **feature-implementation-with-tests-and-docs** in `Auto-Documentation-MCP-Server`.

## Goal

Implements a new feature or major enhancement, updating core logic, adding or modifying integration/unit tests, and updating documentation/readme files.

## Common Files

- `src/lib/*.ts`
- `src/orchestrator/*.ts`
- `src/providers/*.ts`
- `src/tools/*.ts`
- `tests/integration/*.test.ts`
- `tests/unit/*.test.ts`

## Suggested Sequence

1. Understand the current state and failure mode before editing.
2. Make the smallest coherent change that satisfies the workflow goal.
3. Run the most relevant verification for touched files.
4. Summarize what changed and what still needs review.

## Typical Commit Signals

- Update or add core implementation files in src/lib/, src/orchestrator/, src/providers/, or src/tools/
- Add or update integration tests in tests/integration/ and/or unit tests in tests/unit/
- Update documentation files such as README.md, QUICKSTART.md, or .env.example

## Notes

- Treat this as a scaffold, not a hard-coded script.
- Update the command if the workflow evolves materially.