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

The `self-hosted` profile is required. A plain `docker compose up -d` does not
include the bridge, Bifrost, or Cloudflare Tunnel services.

### Start automatically after a reboot

On a Linux host installed at `/opt/auto-doc-mcp`, install the bundled systemd
unit after `.env` contains `CLOUDFLARE_TUNNEL_TOKEN`:

```bash
cd /opt/auto-doc-mcp
sudo sh deploy/systemd/install.sh
```

The unit explicitly starts the `self-hosted` profile. Docker's
`restart: unless-stopped` policy then restarts individual containers after a
daemon restart or container failure.

On Windows with Docker Desktop, register the current-user logon task:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/register-windows-autostart.ps1
Start-ScheduledTask -TaskName "Auto-Doc MCP Self-Hosted Stack"
```

The Windows launcher waits for Docker Desktop, starts the full profile, and
fails loudly if the tunnel token is missing or the connector is not running.

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
