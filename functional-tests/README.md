# Auto-Doc MCP Server — Functional Test Harness

This is the **empirical backstop** the static audits cannot provide. The two audit
rounds proved the code is structurally sound and not faked; these scripts prove the
server **actually works** by spawning it for real and exercising real tool calls
against a real (throwaway) Notion workspace, asserting real side effects.

Nothing here is mocked. If the server is broken, these tests fail — verified: a
deliberately-broken server (no redaction, no dedupe) is caught by the harness.

## What's here

| File | What it does |
|---|---|
| `lib/mcp-stdio-client.js` | Dependency-free MCP client (JSON-RPC 2.0 over stdio). Real handshake → `tools/list` → `tools/call`. The same protocol path a host like Claude Desktop uses. |
| `scripts/smoke-pipeline.js` | End-to-end test of the documentation pipeline in **stdio MCP mode**: initialize → capture → analyze → upsert → publish → package, plus redaction, idempotency, error-envelope, and resilience checks. |
| `scripts/smoke-bridge.js` | Functional test of **HTTP/SSE bridge mode**: real HTTP requests proving auth is closed by default, the env token doesn't leak to anonymous callers, and webhook HMAC is enforced. |
| `.env.example` | Configuration template. Copy to `.env`. |

## Prerequisites

1. **Build the server** so there's a runnable artifact (e.g. `npm run build` → `dist/index.js`).
2. **A disposable Notion workspace.** Create a Notion integration, get its token, and
   share a parent page with it. These tests create real databases and pages — point
   them somewhere you can delete.
3. Copy `.env.example` → `.env` and fill in the values.

## Run

```bash
# stdio MCP pipeline (the core functional proof)
node scripts/smoke-pipeline.js

# HTTP bridge auth + webhook
node scripts/smoke-bridge.js

# stream server logs while testing
VERBOSE=1 node scripts/smoke-pipeline.js
```

Exit code `0` = all functional checks passed. `1` = a functional assertion failed
(the server misbehaved). `2` = setup error (missing token/config).

## What each check proves

**Pipeline (stdio):**
- The server completes the MCP handshake and advertises the expected tools.
- Each pipeline tool returns a real success result with the IDs it should.
- A development event carrying a fake secret is captured **without the secret being
  echoed back** — redaction is actually applied on a live call.
- Upserting the same feature twice returns the **same** page id — dedupe/idempotency
  is real, not just asserted against a stub.
- A malformed call returns a typed error envelope and the server **stays responsive**
  afterward — no crash-on-bad-input.

**Bridge (HTTP):**
- Unauthenticated `/sse` and `/runner/trigger` are rejected (closed by default).
- The server's env `NOTION_TOKEN` never appears in an anonymous response.
- Valid client token is accepted (when `BRIDGE_CLIENT_TOKEN` is set).
- Webhook routes accept valid HMAC and reject invalid/missing signatures (when
  `WEBHOOK_SECRET` is set).

## Important notes

- **Tool argument names**: the pipeline script uses the most likely argument names
  (`projectId`, `featureName`, `repoPath`, `parentPageId`, etc.). If your server's
  schemas differ, adjust the `callTool(...)` arguments in `smoke-pipeline.js` — run
  `tools/list` output first to see the exact `inputSchema` for each tool. The script
  prints discovery results, so a failing call usually means an argument-name mismatch,
  not a broken server. (See the driver prompt for an automated reconciliation step.)
- **Cleanup**: each run tags its entities with a `smoke-<timestamp>` marker and prints
  it at the end. Delete those from your test workspace afterward.
- **Webhook path probing**: `smoke-bridge.js` probes a few common webhook paths
  (`/webhook`, `/webhooks`, `/webhook/github`, `/mcp/webhook`). If your route differs,
  set it directly in the script.

## Relationship to the rest of the test strategy

- Unit + integration tests (in the repo) prove logic in isolation with mocked boundaries.
- The acceptance-test skeletons prove each remediation item with unmocked seams.
- **This harness proves the assembled server works against real external systems** —
  the one thing neither static audit nor in-process tests can guarantee.

Run all three before calling the server production-ready.
