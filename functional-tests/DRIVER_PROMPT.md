# Functional Verification Driver Prompt

You are verifying that the `manual-creator` Auto-Doc MCP server **actually works at runtime**, not just that its code passes static review. A functional test harness is provided in `functional-tests/`. Your job: get it running against a real disposable Notion workspace, reconcile any tool-schema mismatches, run it, and report real pass/fail with evidence.

This is a **runtime verification** task. You may build the project, run the harness, and read tool schemas. Do not modify production source to make tests pass — if a test fails because the server is genuinely broken, report it as a finding; if it fails because the harness used the wrong argument name, fix the harness.

## Steps

1. **Build the server.** Produce the runnable artifact (e.g. `npm install && npm run build`). Confirm the entrypoint path (e.g. `dist/index.js`) and update `functional-tests/.env` accordingly.

2. **Confirm prerequisites.** Ensure a disposable Notion workspace token and a writable parent page id are available in `functional-tests/.env`. If they are not provided, stop and report exactly what's needed — do not invent credentials or mock Notion.

3. **Schema reconciliation (important).** Before running the pipeline test, start the server and call `tools/list` (the harness client can do this). For each of the seven pipeline tools, read the real `inputSchema` and compare it to the argument names used in `scripts/smoke-pipeline.js`. Where they differ (e.g. the server expects `feature_name` not `featureName`, or `parent_page_id` not `parentPageId`), update the `callTool(...)` arguments in the script to match the real schema. Report every mismatch you corrected — a mismatch is a documentation/consistency finding worth noting, even though it's not a server defect.

4. **Run the stdio pipeline test.** `node scripts/smoke-pipeline.js`. Capture the full output. For any FAIL, determine whether it's a harness-argument issue (fix and rerun) or a real server defect (record as a finding with the tool name, the arguments sent, and the response received).

5. **Run the bridge test.** Build/launch bridge mode per the repo's actual mechanism, set the bridge env in `.env`, and run `node scripts/smoke-bridge.js`. Provide `BRIDGE_CLIENT_TOKEN` and `WEBHOOK_SECRET` if the server supports them so the optional checks run instead of skipping.

6. **Clean up.** Delete the `smoke-<timestamp>` databases/pages created in the test workspace.

## Report

Produce a short runtime-verification report:
- Environment: commit sha, build success, server entrypoint, Notion workspace used (redact the token).
- Schema reconciliation: every tool whose real argument names differed from the harness, with the correction made.
- Pipeline results: each check pass/fail, with the request/response evidence for any failure.
- Bridge results: auth + webhook checks pass/fail.
- Findings: any real server defect surfaced (with tool, inputs, observed vs expected), distinct from harness adjustments.
- Verdict: does the assembled server function correctly end-to-end against real Notion? If not, exactly what's broken?

## Rules

- Do not mock Notion, the provider, or any external system — the entire point is real-system verification.
- Do not edit production source to force a green result. Harness argument names may be corrected; server behavior may not be faked.
- Distinguish a harness mismatch (fix it) from a server defect (report it). Never hide the latter as the former.
- Treat the Notion workspace as disposable and clean up after the run.
- If credentials are missing, stop and ask — do not proceed with fakes.
