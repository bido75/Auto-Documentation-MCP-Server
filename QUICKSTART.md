# Auto-Documentation MCP Server Quickstart

This runbook takes a new operator from a fresh checkout to a first successful documentation run. It is intentionally separate from the generated User/Admin manuals: those manuals explain each feature; this file is the cold-start path.

## 1. Prerequisites

- Node.js 20 or newer
- npm 10 or newer
- Docker Desktop or Docker Engine with Docker Compose v2
- Git
- curl, PowerShell, or another HTTP client
- A Notion account where you can create integrations and share pages
- Optional: an OpenRouter API key for cloud fallback

Clone and build the repository:

```bash
git clone git@github.com:bido75/Auto-Documentation-MCP-Server.git
cd Auto-Documentation-MCP-Server
npm ci
npm run build
```

## 2. Create a Notion integration

1. Open [https://www.notion.so/my-integrations](https://www.notion.so/my-integrations).
2. Select **New integration**.
3. Name it `Auto-Documentation MCP Server`.
4. Select the workspace where the manual should live.
5. Enable read, insert, and update content capabilities.
6. Save the integration.
7. Copy the internal integration token. You will use it as `NOTION_TOKEN`.

Share the page with the integration:

1. In Notion, create a page such as `Auto-Doc Manual Sandbox`.
2. Open the page.
3. Select **Share** to share the page with the integration.
4. Select your `Auto-Documentation MCP Server` integration.
5. Grant access.

Find the parent page ID:

1. Copy the Notion page URL.
2. Use the 32-character hexadecimal page ID at the end of the URL.
3. Remove dashes if the URL includes them.

Example:

```text
https://www.notion.so/workspace/Auto-Doc-Manual-Sandbox-36ed217c67b180b5b2d0c2a2ca5128f8
NOTION_PARENT_PAGE_ID=36ed217c67b180b5b2d0c2a2ca5128f8
```

## 3. Create `.env`

Generate a production-safe state key:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Copy `.env.example` to `.env` and set these values:

```bash
# Core Notion setup
NOTION_TOKEN=ntn_your_real_notion_integration_token
NOTION_PARENT_PAGE_ID=36ed217c67b180b5b2d0c2a2ca5128f8
RUN_LIVE_NOTION_TESTS=false

# Bridge transport
AUTO_DOC_HTTP_HOST=0.0.0.0
AUTO_DOC_HTTP_PORT=3000
AUTO_DOC_RUNTIME_MODE=bridge
AUTO_DOC_ALLOW_UNAUTHENTICATED_SSE=false
AUTO_DOC_ENABLE_ENV_TOKEN_FALLBACK=true
CORS_ALLOWED_ORIGINS=http://localhost:3000,http://127.0.0.1:3000

# Local Docker Ollama provider
AI_PROVIDER_TYPE=local-ollama
AI_ENDPOINT=http://ollama:11434
AI_API_KEY=ollama
AI_MODEL_NAME=llama3.1:8b-instruct-q4_K_M
AI_TEMPERATURE=0.2
AI_TIMEOUT_MS=90000
AI_MAX_RETRIES=2
AI_FALLBACK_TO_DETERMINISTIC=false

# OpenRouter cloud fallback
OPENROUTER_ENDPOINT=https://openrouter.ai/api/v1
OPENROUTER_API_KEY=replace-with-your-openrouter-key
AI_CLOUD_FALLBACK_MODEL=qwen/qwen3.6-flash

# Publishing and artifacts
PUBLISHING_MODE=balanced
AUTO_PUBLISH_THRESHOLD=60
AUTO_DOC_ARTIFACT_ROOT=.auto-doc/artifacts

# Security and infrastructure
STATE_ENCRYPTION_KEY=paste_the_64_hex_character_key_here
POSTGRES_PASSWORD=replace-with-a-strong-local-password
GITHUB_WEBHOOK_SECRET=replace-with-a-random-string-if-you-use-webhooks
```

Newer Notion internal integrations issue tokens prefixed `ntn_`; paste the exact token your integration shows.

By default, Auto-Doc stores encrypted project state at `~/.auto-doc-mcp/state.json`. Leave `AUTO_DOC_STATE_FILE` unset for normal bridge and runner deployments so restarts resume the same project even when the process starts from a different working directory. Set `AUTO_DOC_STATE_FILE` only for isolated tests or intentionally separate environments; an explicit override starts from that file and does not auto-migrate legacy state.

If you use a LAN Ollama server instead of the bundled Docker service, set:

```bash
AI_PROVIDER_TYPE=local-ollama
AI_ENDPOINT=http://10.0.0.219:11434
AI_API_KEY=ollama
AI_MODEL_NAME=llama3.1:8b-instruct-q4_K_M
```

If you expose that LAN Ollama through a tunnel, use the tunnel URL as `AI_ENDPOINT` only when the server runtime can reach it.

## 4. Start the Self-Hosted Stack

Start the bridge, database, and Ollama services:

```bash
docker compose --profile self-hosted up -d --build
```

If the Ollama container does not already have the model, pull it:

```bash
docker compose --profile self-hosted exec ollama ollama pull llama3.1:8b-instruct-q4_K_M
```

Check container status:

```bash
docker compose --profile self-hosted ps
```

Check the bridge health endpoint:

```bash
curl http://localhost:3000/health
```

A healthy response is HTTP `200` with JSON showing the bridge is ready. The exact fields may vary, but the request should not return `401`, `404`, or `500`.

## 5. Open an MCP Session

The bridge uses HTTP-SSE:

- `GET /sse` opens a session stream.
- `POST /messages?sessionId=<session-id>` sends JSON-RPC requests.

For a manual smoke test, open the SSE stream in one terminal and copy the `sessionId` from the server event:

```bash
curl -N http://localhost:3000/sse
```

In the examples below, replace:

- `<session-id>` with the SSE session ID
- `<parent-page-id>` with your `NOTION_PARENT_PAGE_ID`
- `<project-id>`, `<evidence-event-id>`, `<feature-id>`, and `<manual-entry-id>` with IDs returned by earlier calls

## 6. First Documentation Run

### 6.1 Initialize the Project Manual

```bash
curl -X POST "http://localhost:3000/messages?sessionId=<session-id>" \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tools/call",
    "params": {
      "name": "initialize_project_manual",
      "arguments": {
        "projectName": "Quickstart Demo Project",
        "parentPageId": "<parent-page-id>",
        "repositoryUrl": "https://github.com/example/quickstart-demo",
        "publishingMode": "balanced",
        "autoPublishThreshold": 60
      }
    }
  }'
```

Save the returned `projectId`.

### 6.2 Capture a Development Event

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "tools/call",
  "params": {
    "name": "capture_development_event",
    "arguments": {
      "projectId": "<project-id>",
      "source": "local_git",
      "eventType": "commit",
      "summary": "Added a user settings page with notification controls",
      "branch": "main",
      "commitSha": "abc1234",
      "filesChanged": "src/pages/settings.tsx,src/components/NotificationSettings.tsx",
      "diffSummary": "Adds a settings workflow where users can enable or disable email notifications.",
      "testStatus": "passed"
    }
  }
}
```

Save the returned `evidenceEventId`.

### 6.3 Analyze the Candidate

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "tools/call",
  "params": {
    "name": "analyze_documentation_candidate",
    "arguments": {
      "projectId": "<project-id>",
      "evidenceEventIds": ["<evidence-event-id>"]
    }
  }
}
```

Save the returned `featureKey`, `featureName`, `audiences`, `entryTypes`, `confidenceScore`, `confidenceReasons`, and `generatedNarratives`.

### 6.4 Upsert Feature Documentation

Use the analysis output to create manual entries:

```json
{
  "jsonrpc": "2.0",
  "id": 4,
  "method": "tools/call",
  "params": {
    "name": "upsert_feature_documentation",
    "arguments": {
      "projectId": "<project-id>",
      "featureKey": "<feature-key>",
      "featureName": "<feature-name>",
      "audiences": ["User", "Admin"],
      "manualEntries": [
        {
          "entryType": "User Guide",
          "title": "Use notification settings",
          "userGuide": "## Overview\nUsers can control email notifications from the settings page.\n\n## Steps\n1. Open Settings.\n2. Choose Notifications.\n3. Toggle email notifications.\n\n## Expected result\nThe preference is saved.",
          "adminGuide": "",
          "developerNotes": ""
        },
        {
          "entryType": "Admin Guide",
          "title": "Operate notification settings",
          "userGuide": "",
          "adminGuide": "## Overview\nAdmins can verify notification settings are available after deployment.\n\n## Verification\n1. Run npm run build.\n2. Open the app settings page.\n3. Confirm notification controls render.",
          "developerNotes": ""
        }
      ],
      "evidenceEventIds": ["<evidence-event-id>"],
      "confidenceScore": 85,
      "confidenceReasons": ["User-facing settings workflow with passing tests."],
      "publishingMode": "balanced",
      "autoPublishThreshold": 60,
      "filesChanged": ["src/pages/settings.tsx", "src/components/NotificationSettings.tsx"]
    }
  }
}
```

Save the returned `featureId` and `manualEntryIds`.

### 6.5 Publish or Queue Review

```json
{
  "jsonrpc": "2.0",
  "id": 5,
  "method": "tools/call",
  "params": {
    "name": "publish_or_queue_review",
    "arguments": {
      "projectId": "<project-id>",
      "featureId": "<feature-id>",
      "manualEntryIds": ["<manual-entry-id-1>", "<manual-entry-id-2>"],
      "confidenceScore": 85,
      "publishingMode": "balanced",
      "autoPublishThreshold": 60,
      "hasContradiction": false
    }
  }
}
```

The expected `finalStatus` is `Published`.

### 6.6 Package the Manual

```json
{
  "jsonrpc": "2.0",
  "id": 6,
  "method": "tools/call",
  "params": {
    "name": "package_manual",
    "arguments": {
      "projectId": "<project-id>",
      "releaseVersion": "quickstart-1",
      "audience": "both",
      "format": "markdown"
    }
  }
}
```

You can also export the assembled manual directly:

```json
{
  "jsonrpc": "2.0",
  "id": 7,
  "method": "tools/call",
  "params": {
    "name": "export_manual_markdown",
    "arguments": {
      "projectId": "<project-id>",
      "audience": "both"
    }
  }
}
```

## 7. Verify Success

You should now see the following:

- In Notion, a project manual workspace under the parent page.
- Project, Feature, Manual Entry, Evidence Event, and Release databases.
- At least one published User Guide manual entry.
- At least one published Admin Guide manual entry.
- A packaged markdown manual from `package_manual` or `export_manual_markdown`.
- If `AUTO_DOC_ARTIFACT_ROOT` is configured, generated artifacts under that directory.

If the first run fails:

- `401` from Notion means the token is wrong or the parent page was not shared with the integration.
- Provider timeouts mean `AI_ENDPOINT`, `AI_MODEL_NAME`, or model availability is wrong. For Docker Ollama, verify `docker compose --profile self-hosted exec ollama ollama list`.
- `Unknown projectId` means `initialize_project_manual` did not complete or you copied the wrong ID.
- `Needs Review` instead of `Published` means the confidence score was lower than `autoPublishThreshold`; lower the threshold for the demo or review/publish manually.

## 8. VS Code MCP Setup

For local VS Code use, connect the editor to your own checked-out server with stdio. The committed `.vscode/mcp.json` and `.mcp.json` files use:

```json
{
  "command": "node",
  "args": ["build/src/index.js"]
}
```

Build first:

```bash
npm run build
```

Then reload VS Code with **Developer: Reload Window**. No Langflow API key or hosted project endpoint is required for the default local setup.
