# Self-Hosting Auto-Doc MCP

Use this path when you want your own Auto-Doc MCP bridge and runner instead of a hosted endpoint.

## Requirements

- Docker and Docker Compose v2
- Node.js 18 or newer for local development
- A Notion integration token
- A Notion page shared with that integration
- A 64-character `STATE_ENCRYPTION_KEY`

## Deploy In 5 Minutes

```bash
git clone https://github.com/bido75/Auto-Documentation-MCP-Server.git
cd Auto-Documentation-MCP-Server
cp .env.example .env
```

Edit `.env` and set at least:

```text
NOTION_TOKEN=your-notion-integration-token
STATE_ENCRYPTION_KEY=your-64-hex-character-key
AUTO_DOC_BRIDGE_API_KEY=your-random-bridge-key
AUTO_DOC_ENABLE_ENV_TOKEN_FALLBACK=false
AUTO_DOC_ALLOW_UNAUTHENTICATED_SSE=false
```

Generate safe keys:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Start the stack:

```bash
docker compose --profile self-hosted up -d --build
curl http://localhost:3000/health
```

Expected result: HTTP `200` and a JSON health response.

## Expose Externally

For remote IDEs or GitHub Actions, expose the bridge through a secure tunnel such as Cloudflare Tunnel.
Keep `AUTO_DOC_BRIDGE_API_KEY` enabled for every non-local deployment.

## Runner Mode

The runner watches git repositories and documents commits automatically.
Configure targets with `AUTO_DOC_RUNNER_TARGETS` or the single-target variables:

```text
AUTO_DOC_RUNTIME_MODE=runner
AUTO_DOC_RUNNER_PROJECT_ID=your-project-id
AUTO_DOC_RUNNER_REPO_PATH=/absolute/path/to/repo
```

Project state defaults to `~/.auto-doc-mcp/state.json`, so restarts resume from the same binding.

## More Configuration

See [Configuration](CONFIGURATION.md) for provider, bridge, runner, webhook, artifact, and state settings.
