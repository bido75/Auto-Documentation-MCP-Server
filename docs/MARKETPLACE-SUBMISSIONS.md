# Marketplace Submission Notes

Use this copy for MCP registry submissions after the npm package is live.

## Short Description

Auto-Doc MCP automatically generates user and admin manuals in Notion as you build features.

## Long Description

Auto-Doc MCP sits in your AI coding environment and turns completed development work into living documentation.
It captures commits, PRs, CI/release events, screenshots, and retrospective codebase probes; analyzes whether the change is manual-worthy; writes grounded user/admin documentation into Notion; and exports release-ready manuals as PDF, Markdown, and help-center JSON.

By ship time, the manual is ready.

## Categories

- Developer Tools
- Documentation
- AI
- Notion
- MCP

## Links

- GitHub: `https://github.com/bido75/Auto-Documentation-MCP-Server`
- npm: `https://www.npmjs.com/package/auto-doc-mcp`
- Quickstart: `https://github.com/bido75/Auto-Documentation-MCP-Server#quickstart`

## Cursor

Submit at `https://cursor.com/mcp`.

Suggested listing:

```text
Auto-Doc MCP automatically generates user and admin manuals in Notion as you build.
Connect it to Cursor and every feature you complete gets documented: user guide, admin guide, troubleshooting, and release packaging.
By the time your project ships, the manual is ready.
```

## VS Code MCP Registry

Suggested registry entry:

```json
{
  "name": "auto-doc-mcp",
  "displayName": "Auto-Doc MCP",
  "description": "Automatically generates user and admin manuals in Notion as you build features.",
  "publisher": "bido75",
  "repository": "https://github.com/bido75/Auto-Documentation-MCP-Server",
  "installUrl": "https://github.com/bido75/Auto-Documentation-MCP-Server#quickstart",
  "transport": "sse",
  "categories": ["documentation", "developer-tools"],
  "tags": ["notion", "documentation", "mcp", "ai", "automatic-documentation"]
}
```

## Smithery

Submit at `https://smithery.ai/submit`.

Use:

- Server name: `auto-doc-mcp`
- Transport: SSE and stdio
- Category: Documentation, Developer Tools

## Other Directories

- `https://mcp.so/submit`
- `https://glama.ai/mcp/servers/submit`
