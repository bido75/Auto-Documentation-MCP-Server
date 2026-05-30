# Auto-Documentation MCP Server Admin and Infrastructure Manual

## Manual Metadata and Version History

- Manual title: Auto-Documentation MCP Server Admin and Infrastructure Manual
- Audience: Platform operators, DevOps engineers, security engineers, and technical leads
- Scope: Part 2 (sections 2.1 through 2.17)
- Last updated: 2026-05-28
- Baseline: Self-hosted docker stack with optional Bifrost, Ollama, Cloudflare tunnel, and Tailscale

| Version | Date | Change |
|---|---|---|
| v1.0 | 2026-05-28 | Full rewrite with architecture, deployment, operations, and recovery runbooks |

## 2.1 System Architecture Overview

### Layer 1 transport

- stdio transport for local IDE integrations.
- HTTP bridge transport for network clients.
- SSE endpoint at /sse and message endpoint at /messages.
- Health and metadata endpoints at /health and /info.

### Layer 2 MCP protocol dispatch

- Server built on @modelcontextprotocol/sdk.
- Tool registration centralized in server creation.
- Input schemas and consistent error envelopes used across tools.

### Layer 3 intelligence pipeline

1. Deterministic extraction always runs.
2. Optional model provider reasoning can enrich narrative quality.
3. Guardrails validate quality and redact unsafe content.
4. Optional semantic deduplication keeps entry set compact.

### Layer 4 storage

- Notion stores projects, features, entries, evidence, and release artifacts.
- Local encrypted state stores operational checkpoints and runner metadata.
- Feature dedup and ledger state persist across restarts.

### Layer 5 background runner

- Polls targets on interval.
- Bounded parallel processing.
- Circuit breaker by target with reset cooldown.
- Health summary and triage metadata APIs for operations.

### Commit-to-manual data path

Commit or PR signal -> capture event -> analyze candidate -> upsert feature docs -> publish policy -> release packaging -> status reporting.

## 2.2 Prerequisites and Hardware Requirements

### Minimum solo deterministic

- Node.js 20+
- Reliable internet for Notion API
- 512 MB available runtime memory

### Recommended self-hosted CPU stack

- 4 CPU cores
- 16 GB RAM
- 50 GB storage for containers and local models
- Docker Engine or Docker Desktop with Compose

### GPU-accelerated local inference

- NVIDIA GPU with at least 8 GB VRAM
- CUDA-compatible runtime and container toolkit
- Increased throughput for model-heavy analysis jobs

### Software prerequisites

- Git 2.30+
- Optional cloudflared and tailscale clients
- Optional Bifrost deployment for shared governance

## 2.3 Docker Compose Deployment

### Services in the current stack

1. notion-auto-doc
  - MCP HTTP bridge and tool host.
  - Exposes health and SSE surfaces.

2. bifrost-gateway
  - Shared inference and MCP governance edge.

3. ollama
  - Local model provider and embeddings backend.

4. cloudflared
  - WAN ingress without opening router ports.

5. tailscale
  - Private mesh path for trusted devices.

6. nginx
  - Reverse proxy and optional auth controls.

### Startup procedure

```bash
git clone <repo-url> /opt/auto-doc-mcp
cd /opt/auto-doc-mcp
cp .env.example .env
docker compose run --rm ollama ollama pull llama3.1
docker compose run --rm ollama ollama pull nomic-embed-text
docker compose --profile self-hosted up -d --build
docker compose ps
curl http://localhost:3000/health
curl http://localhost:8080
curl http://localhost:11434/api/tags
```

### Restart procedure

```bash
docker compose pull
docker compose build --no-cache notion-auto-doc
docker compose --profile self-hosted up -d
docker compose logs -f
```

## 2.4 Environment Variables Reference

### Core

| Variable | Required | Default | Service | Secret |
|---|---|---|---|---|
| NOTION_TOKEN | Yes for Notion writes | none | notion-auto-doc | Yes |
| NOTION_PARENT_PAGE_ID | Required for live setup flows | none | tests and setup | No |
| STATE_ENCRYPTION_KEY | Strongly recommended in production | internal fallback | notion-auto-doc | Yes |

### Runtime mode and bridge

| Variable | Required | Default | Service |
|---|---|---|---|
| AUTO_DOC_RUNTIME_MODE | No | stdio | notion-auto-doc |
| AUTO_DOC_HTTP_HOST | No | 127.0.0.1 | notion-auto-doc |
| AUTO_DOC_HTTP_PORT | No | 3741 or configured profile value | notion-auto-doc |

### Runner

| Variable | Required | Default | Service |
|---|---|---|---|
| AUTO_DOC_RUNNER_PROJECT_ID | Optional single-target mode | none | notion-auto-doc |
| AUTO_DOC_RUNNER_REPO_PATH | Optional single-target mode | none | notion-auto-doc |
| AUTO_DOC_RUNNER_TARGETS | Optional multi-target JSON | none | notion-auto-doc |
| AUTO_DOC_RUNNER_MODE | No | working_tree | notion-auto-doc |
| AUTO_DOC_RUNNER_POLL_INTERVAL_MS | No | 60000 | notion-auto-doc |

### Provider and model routing

| Variable | Required | Default | Service |
|---|---|---|---|
| AI_PROVIDER_TYPE | No | deterministic | notion-auto-doc |
| AI_ENDPOINT | Provider-dependent | none | notion-auto-doc |
| AI_MODEL | Provider-dependent | none | notion-auto-doc |
| AI_TIMEOUT_MS | No | provider default | notion-auto-doc |

### Infrastructure

| Variable | Required | Default | Service | Secret |
|---|---|---|---|---|
| CLOUDFLARE_TUNNEL_TOKEN | Optional for WAN | none | cloudflared | Yes |
| CLOUDFLARE_TUNNEL_ID | Optional for WAN | none | cloudflared | No |
| TAILSCALE_AUTH_KEY | Optional for mesh | none | tailscale | Yes |

## 2.5 Bifrost Gateway Configuration

### Role in this deployment

- Central route for model requests.
- Team virtual key governance.
- Optional semantic cache for cost reduction.
- Unified request auditing.

### Operational baseline

- Provider key and wildcard model mapping should be configured after stack start.
- Runtime timeout should be increased for local LLM latency.
- A post-start script can enforce idempotent configuration.

### Virtual key lifecycle

1. Create key per developer or per automation agent.
2. Assign budget and rotation policy.
3. Revoke key during offboarding or compromise events.

## 2.6 Ollama Local Model Setup

### Startup and model pulls

```bash
docker compose up -d ollama
docker exec ollama ollama pull llama3.1:8b-instruct-q4_K_M
docker exec ollama ollama pull qwen2.5-coder:7b-instruct-q4_K_M
docker exec ollama ollama pull nomic-embed-text
```

### CPU versus GPU planning

- CPU mode is sufficient for deterministic-first workflows and moderate AI augmentation.
- GPU mode improves latency and supports larger models.

### Multi-client topology guidance

- Expose Ollama only on trusted networks.
- Prefer VPN or reverse proxy controls because Ollama has no built-in auth.

## 2.7 Network Topology

### Scenario A single machine

- All components local.
- stdio-only integrations.

### Scenario B home server and LAN clients

- Bridge and models on server.
- Clients point to LAN endpoint.

### Scenario C home and office access

- Trusted clients use VPN path.
- Remote clients use tunnel HTTPS endpoint.

### Scenario D small team

- Shared gateway plus provider stack.
- Per-user virtual keys and centralized auditing.

## 2.8 Cloudflare Tunnel Setup

### Steps

1. Create tunnel and obtain token.
2. Configure ingress to bridge endpoint.
3. Add DNS route for tunnel hostname.
4. Start cloudflared service in compose profile.
5. Validate external health endpoint.

### Security posture

- Treat tunnel token as a secret.
- Add access policy controls where possible.
- Combine with app-level auth and CORS controls.

## 2.9 Tailscale VPN Setup

### Steps

1. Install and authenticate server node.
2. Install and authenticate client devices.
3. Use Tailscale-assigned address for bridge access.
4. Optionally advertise routes for shared subnets.

### Why it fits this stack

- No inbound router rule requirements.
- Encrypted mesh connectivity across locations.
- Simple onboarding for small engineering teams.

## 2.10 Notion Schema: Five Databases

### Projects database

- Stores project identity and publishing policy defaults.
- Written by initialize and updated by status workflows.

### Features database

- Stores stable feature keys and lifecycle state.
- Upsert operations prevent duplicate feature pages.

### Manual Entries database

- Stores user, admin, developer, and release entry payloads.
- Status transitions control release inclusion.

### Evidence Events database

- Stores raw but redacted event metadata.
- Supports audit and explainability for generated docs.

### Releases database

- Stores release versions and manual artifact links.
- Packaging tool writes inclusion counts and output URLs.

## 2.11 Five Databases: Relationships and Operations

### Relationship model

- Projects to Features one-to-many.
- Features to Manual Entries one-to-many.
- Projects to Evidence Events one-to-many.
- Projects to Releases one-to-many.
- Releases to Features many-to-many for inclusion tracking.

### Status workflow operations

- Captured -> Needs Review by policy or low confidence.
- Needs Review -> Approved via human workflow.
- Approved -> Published by policy or manual promotion.
- Deprecated applied when feature is retired or superseded.

### Bulk triage recommendation

- Use filtered Notion views by Status and Audience.
- Assign reviewer rotation and SLA for review queue.

## 2.12 Background Runner Operations

### Runner lifecycle

1. Runner starts with runtime mode.
2. Poll interval triggers target processing.
3. Each target runs capture -> analyze -> upsert pipeline.
4. Release automation runs when new tags are detected.

### Circuit breaker behavior

- Failure streak tracked per target.
- Circuit opens after repeated failures.
- Cooldown and reset logic reattempts target later.
- One failing target does not block others.

### Operational controls

```bash
docker compose logs -f notion-auto-doc
curl http://localhost:3000/health
curl http://localhost:3000/info
```

## 2.13 Security Architecture

### Secret handling

- Token placeholders are written to generated client configs.
- Runtime secrets are sourced from environment and secure stores.
- Secrets must never be committed in repo content.

### State encryption and integrity

- Encrypted local state and checksum envelope protections are implemented.
- Locking ensures serialized write access under contention.

### Redaction

- Diff and generated content paths redact secret-like patterns.
- Raw sensitive payloads are not persisted to Notion.

### CORS and network controls

- Restrict allowed origins in bridge deployments.
- Pair with tunnel and VPN controls for WAN paths.

## 2.14 Scaling Guide

### 1 to 5 developers

- Single gateway and model backend are typically sufficient.
- Add per-user virtual keys and shared Notion workspace.

### 5 to 20 developers

- Move to dedicated infrastructure.
- Add gateway redundancy and persistent cache tiers.
- Tune runner concurrency and Notion write batching strategy.

### Cost governance

- Balanced mode plus caching controls cost without losing quality.
- Per-key budgets prevent silent overrun.

## 2.15 Monitoring and Logs

### What to monitor

- Bridge health endpoint status.
- Runner failure trends and circuit-open events.
- Notion write failures and retry pressure.
- Provider fallback frequency and latency.

### Suggested log fields

- timestamp, level, service, event, project, durationMs, traceId, error.

### Alerts

- sustained circuit-open targets
- repeated Notion write failures
- prolonged provider fallback conditions

## 2.16 Backup and Recovery

### Backup targets

1. Notion manual content via export tooling.
2. Local encrypted state directory.
3. Gateway persistent data volumes.
4. Deployment configuration and compose files.

### Recovery procedure

1. Provision new host.
2. Restore repository and env config.
3. Restore persistent volumes.
4. Pull required models.
5. Start stack and validate endpoints.
6. Run status check and package smoke test.

## 2.17 Troubleshooting Admin and Infrastructure Issues

### Container keeps restarting

- Symptom: restart loop in compose ps.
- Diagnostics: check logs for missing env and startup exceptions.
- Resolution: fix env configuration and rebuild container.

### Gateway cannot reach MCP server

- Symptom: connected false and missing tools.
- Diagnostics: verify bridge endpoint path, DNS, and auth headers.
- Resolution: correct network path and rerun client registration.

### Ollama inference timeout

- Symptom: provider timeout under load.
- Diagnostics: check model availability and host resource pressure.
- Resolution: increase timeout, reduce model size, or add GPU capacity.

### Cloudflare tunnel unhealthy

- Symptom: external route unavailable.
- Diagnostics: verify token, tunnel id, and ingress config.
- Resolution: rotate token and redeploy tunnel container.

### Tailscale routes not visible

- Symptom: clients cannot reach bridge over mesh.
- Diagnostics: confirm node auth and route advertisement approval.
- Resolution: reapply route advertisement and policy approval.

### Notion 429 rate-limit errors

- Symptom: repeated retries and delayed writes.
- Diagnostics: inspect write volume and burst patterns.
- Resolution: batch writes, tune cadence, and preserve exponential backoff.

### State decrypt errors after key rotation

- Symptom: state load failure.
- Diagnostics: validate encryption key continuity.
- Resolution: restore previous key or reset state with controlled rehydration.

### Circuit breaker opens for all targets

- Symptom: runner skips most targets.
- Diagnostics: inspect shared dependencies such as Notion auth or network outage.
- Resolution: restore dependency health and clear triage metadata only after fix.

### Disk pressure from model artifacts

- Symptom: compose writes fail.
- Diagnostics: inspect container and model volume usage.
- Resolution: prune unused images and remove stale model tags.

### CORS errors from web clients

- Symptom: browser rejects bridge requests.
- Diagnostics: inspect allowed origin configuration.
- Resolution: add exact trusted origins and restart bridge.

### IDE disconnects while server is healthy

- Symptom: one client disconnected, others fine.
- Diagnostics: check local config syntax and file path permissions.
- Resolution: regenerate tool config and restart the client process.

### Virtual key expired or budget exceeded

- Symptom: gateway rejects inference.
- Diagnostics: inspect key status in gateway dashboard.
- Resolution: rotate key, raise budget, or reroute provider policy.
