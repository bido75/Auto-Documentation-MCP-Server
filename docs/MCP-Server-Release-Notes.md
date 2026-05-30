# Auto-Documentation MCP Server Release Notes and Changelog

## 3.1 v1.0.0 Initial Release

### Initial capability set

- Core MCP server with stdio transport and production tool registration.
- Deterministic analyzer and confidence scoring for manual-worthiness decisions.
- Notion writer with feature-key deduplication.
- Five-database Notion schema created by initialization flow.
- VS Code extension setup path and universal installer scaffolding.
- Git post-commit hook for low-friction evidence capture.

## 3.2 v1.1.0 HTTP and SSE plus Multi-Client

### Platform expansion

- HTTP bridge runtime with SSE client transport.
- Multi-client session support in bridge mode.
- Self-hosted docker stack including Bifrost, Ollama, cloudflared, tailscale, and nginx.
- Broadened config-writer support across multiple editor and agent ecosystems.
- Deployment guidance for LAN and WAN scenarios.

## 3.3 v1.2.0 Hybrid Intelligence and Hardening

### Intelligence layer improvements

- Provider abstraction with deterministic baseline and optional cloud or local reasoning.
- Local Ollama provider path and routed gateway provider options.
- Guardrail validation and redaction improvements.
- Optional embedding-assisted deduplication and stable feature updates.

### Operational hardening

- Runner circuit-breaker and target-level isolation controls.
- Encrypted local state and lock-based contention handling.
- Expanded status, triage, and release automation tooling.
- Better contract coverage and consistent error envelope semantics.

### Bug fixes included

- Runner failures no longer silently swallowed.
- Manual export and pagination limits corrected.
- CORS and runtime configurability improved.
- Sensitive material handling strengthened in storage and diff pipelines.

## 3.4 Roadmap

### v1.3.0 planned

- Improved bidirectional sync workflow between Notion and local docs.
- Stronger release artifact export pipeline for markdown and PDF distribution.
- PR-level documentation preview and publication workflows.
- Better semantic retrieval over generated manual content.

### v2.0.0 future vision

- Multi-target publication surfaces beyond Notion.
- Automated screenshot enrichment integration in release flows.
- Help-center structured export expansion.
- Enterprise-grade authentication and policy controls for larger teams.
