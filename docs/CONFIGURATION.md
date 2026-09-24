# Auto-Doc MCP Configuration

This is the short reference for production operators.

## Required

- `NOTION_TOKEN`: Notion integration token.
- `STATE_ENCRYPTION_KEY`: 64 hex characters or similarly high-entropy secret for encrypted local state.

## License

Core tools work without a license. Advanced tools require a signed maintenance license.

- `AUTO_DOC_LICENSE_KEY`: Signed license JWT.
- `AUTO_DOC_LICENSE_PUBLIC_KEY`: Optional override for the bundled offline-validation public key. Use `\n` escapes for multiline PEM values.
- `AUTO_DOC_LICENSE_PUBLIC_KEY_FILE`: Optional file-based public-key override for rotation or private distributions.
- `LEMONSQUEEZY_WEBHOOK_SECRET`: Server-side webhook secret for verified Lemon Squeezy events.
- `LEMONSQUEEZY_PRODUCT_ID`: Required product identity for license exchange. Keys for other products are rejected.
- `LEMONSQUEEZY_VARIANT_ID`: Optional plan/variant identity for stricter license exchange.
- `AUTO_DOC_LICENSE_PRIVATE_KEY_PATH`: Server-side private key path for license issuance. Never commit the private key.

## HTTP Bridge

- `AUTO_DOC_HTTP_HOST`: Bridge host. Use `127.0.0.1` for local-only.
- `AUTO_DOC_HTTP_PORT`: Bridge port. Default deployment uses `3000`.
- `AUTO_DOC_BRIDGE_API_KEY`: Required for non-local bridge access.
- `AUTO_DOC_ALLOW_UNAUTHENTICATED_SSE`: Keep `false` in production.
- `AUTO_DOC_ENABLE_ENV_TOKEN_FALLBACK`: Keep `false` unless you intentionally use env-token fallback.
- `CORS_ALLOWED_ORIGINS`: Exact allowed origins for browser clients.

## Runner

- `AUTO_DOC_RUNTIME_MODE=runner`: Starts continuous runner mode.
- `AUTO_DOC_RUNNER_PROJECT_ID`: Project ID for single-target runner mode.
- `AUTO_DOC_RUNNER_REPO_PATH`: Absolute repo path for single-target runner mode.
- `AUTO_DOC_RUNNER_TARGETS`: JSON array for multi-target runner mode.
- `AUTO_DOC_RUNNER_RELEASE_PROBE_BEFORE_PACKAGE=true`: Runs retrospective probing before release packaging.

## State

- `AUTO_DOC_STATE_FILE`: Optional explicit state file for isolated test/staging environments.
- Default state path: `~/.auto-doc-mcp/state.json`.

Leave `AUTO_DOC_STATE_FILE` unset for normal deployments so restarts resume from the canonical path.

## Providers

- `AI_PROVIDER_TYPE`: `deterministic`, `local-ollama`, `local-lmstudio`, `cloud-openai`, `cloud-anthropic`, or `bifrost`.
- `AI_ENDPOINT`: Provider endpoint.
- `AI_API_KEY`: Provider credential, if required.
- `AI_MODEL_NAME`: Primary model.
- `AI_TIMEOUT_MS`: Request timeout.
- `AI_CLOUD_FALLBACK_MODELS`: Ordered cloud fallback model list when configured.
- `AI_CLOUD_FALLBACK_MODEL`: Legacy single-model fallback alias.
- `OPENROUTER_ENDPOINT`: OpenRouter-compatible endpoint.
- `OPENROUTER_API_KEY`: OpenRouter key.
- `BIFROST_VIRTUAL_KEY`: Bifrost virtual key.

## Artifacts

- `AUTO_DOC_ARTIFACT_ROOT`: Safety boundary for PDFs, Markdown, help-center JSON, and screenshots.

## Webhooks

Configure outbound notifications with the `configure_webhook` MCP tool.
Webhook URLs are persisted in encrypted project state, not in repository files.

## Security Notes

- Never commit `.env`, state files, `.dpapi` files, `bifrost-data/`, or generated artifacts.
- Rotate any token that was pasted into chat, logs, or screenshots.
- Keep the bridge key enabled before exposing the bridge beyond localhost.
