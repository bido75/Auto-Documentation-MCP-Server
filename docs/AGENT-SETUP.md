# Agent Setup

Auto-Doc MCP can run locally over stdio or through the hosted legacy SSE bridge. Local stdio is the recommended default because credentials remain in the developer's Windows user environment and do not cross the bridge.

MCP discovery makes tools available to an agent; it does not poll Git or invoke tools automatically. For unattended documentation, initialize the project and install its post-commit hook:

```powershell
npx auto-doc-mcp init --post-commit-hook
```

Alternatively, configure `AUTO_DOC_RUNNER_PROJECT_ID` and `AUTO_DOC_RUNNER_REPO_PATH` and run the continuous runner as a separate process. An agent-driven workflow should call `run_autonomous_documentation_trigger`; `capture_development_event` alone only stores evidence.

## Prerequisites

- Node.js 18 or newer with `npx` available.
- The required Auto-Doc environment variables set for the user that launches the agent.
- Restart the agent after changing Windows user environment variables.

The local server command is:

```text
npx.cmd -y --package auto-doc-mcp@latest auto-docs-notion-mcp
```

`auto-doc-mcp` is the onboarding CLI. `auto-docs-notion-mcp` is the stdio MCP server binary.

## Portable local configuration

Claude Desktop, Cursor, Claude Code, and compatible portable clients use this entry:

```json
{
  "mcpServers": {
    "auto-doc-mcp": {
      "type": "stdio",
      "command": "npx.cmd",
      "args": [
        "-y",
        "--package",
        "auto-doc-mcp@latest",
        "auto-docs-notion-mcp"
      ]
    }
  }
}
```

Common Windows locations:

- Claude Desktop: `%APPDATA%\Claude\claude_desktop_config.json`
- Cursor: `%USERPROFILE%\.cursor\mcp.json`
- Claude Code: use `claude mcp add --scope user auto-doc-mcp -- npx.cmd -y --package auto-doc-mcp@latest auto-docs-notion-mcp`
- GitHub Copilot: `%USERPROFILE%\.copilot\mcp-config.json`
- Workspace discovery: `.mcp.json` in the repository root

## Codex

Use the Codex CLI so it updates `%USERPROFILE%\.codex\config.toml` safely:

```powershell
codex mcp add auto-doc-mcp -- npx.cmd -y --package auto-doc-mcp@latest auto-docs-notion-mcp
```

## OpenCode v2

OpenCode uses `mcp.servers`, and the command is a single array:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "servers": {
      "auto-doc-mcp": {
        "type": "local",
        "command": [
          "npx.cmd",
          "-y",
          "--package",
          "auto-doc-mcp@latest",
          "auto-docs-notion-mcp"
        ]
      }
    }
  }
}
```

The global Windows file is `%USERPROFILE%\.config\opencode\opencode.json`. This repository also includes `opencode.json` for project discovery.

## Continue

Add the server to `%USERPROFILE%\.continue\config.yaml`:

```yaml
mcpServers:
  - name: auto-doc-mcp
    type: stdio
    command: npx.cmd
    args:
      - -y
      - --package
      - auto-doc-mcp@latest
      - auto-docs-notion-mcp
```

Continue exposes MCP tools in agent mode.

## Zed

Add this entry to Zed's `context_servers` settings when Zed is installed:

```json
{
  "context_servers": {
    "auto-doc-mcp": {
      "command": "npx.cmd",
      "args": [
        "-y",
        "--package",
        "auto-doc-mcp@latest",
        "auto-docs-notion-mcp"
      ]
    }
  }
}
```

## Hosted SSE bridge

Clients that support custom SSE headers can connect without a local npm process:

```json
{
  "mcpServers": {
    "auto-doc-mcp": {
      "type": "sse",
      "url": "https://mcp.giscop.com/sse",
      "headers": {
        "X-Auto-Doc-Bridge-Key": "YOUR_BRIDGE_API_KEY"
      }
    }
  }
}
```

Do not commit a populated bridge key. Prefer an environment-variable reference when the client supports one. Codex's remote MCP configuration supports bearer tokens but not this bridge's custom header, so use the local stdio configuration with Codex.

## Verification

Restart the agent, confirm `auto-doc-mcp` appears in its MCP server list, and call the low-impact `get_provider_status` tool. A configuration file being present is not proof that the MCP process started; verify an actual tool call.
