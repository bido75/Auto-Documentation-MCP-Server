import * as fs from "node:fs/promises";
import * as path from "node:path";

export function generateWorkflowContent(input: { serverUrl: string; projectId: string; defaultBranch?: string }): string {
  const defaultBranch = input.defaultBranch ?? "main";
  return `name: Auto-Documentation

on:
  push:
    branches: [${defaultBranch}, master]
  pull_request:
    types: [closed]

jobs:
  document:
    if: |
      github.event_name == 'push' ||
      (github.event_name == 'pull_request' &&
       github.event.pull_request.merged == true)
    runs-on: ubuntu-latest
    name: Capture documentation evidence
    timeout-minutes: 5

    steps:
      - name: Checkout
        uses: actions/checkout@v4
        with:
          fetch-depth: 2

      - name: Extract commit metadata
        id: meta
        run: |
          SHA=$(git rev-parse HEAD)
          BRANCH=$(git rev-parse --abbrev-ref HEAD)
          MSG=$(git log -1 --format='%s' | head -c 200)
          FILES=$(git diff-tree --no-commit-id -r --name-only HEAD | head -50 | tr '\\n' ',' | sed 's/,$//')
          echo "sha=$SHA" >> "$GITHUB_OUTPUT"
          echo "branch=$BRANCH" >> "$GITHUB_OUTPUT"
          echo "msg=$MSG" >> "$GITHUB_OUTPUT"
          echo "files=$FILES" >> "$GITHUB_OUTPUT"

      - name: Skip noise commits
        id: skip
        run: |
          MSG="\${{ steps.meta.outputs.msg }}"
          if echo "$MSG" | grep -qiE "^(merge |wip|temp|tmp|fixup|chore:|style:|ci:|docs:)"; then
            echo "skip=true" >> "$GITHUB_OUTPUT"
          else
            echo "skip=false" >> "$GITHUB_OUTPUT"
          fi

      - name: Capture development event
        if: steps.skip.outputs.skip != 'true'
        run: |
          SSE=$(curl -s --max-time 10 -H "X-Auto-Doc-Bridge-Key: \${{ secrets.AUTO_DOC_BRIDGE_API_KEY }}" "\${{ secrets.AUTO_DOC_MCP_URL }}/sse")
          SESSION_ID=$(echo "$SSE" | grep -o 'sessionId=[a-zA-Z0-9-]*' | cut -d= -f2)

          if [ -z "$SESSION_ID" ]; then
            echo "Could not establish MCP session; skipping documentation capture."
            exit 0
          fi

          if [ "\${{ github.event_name }}" = "pull_request" ]; then
            EVENT_TYPE="pr_merged"
          else
            EVENT_TYPE="commit"
          fi

          curl -s --max-time 60 \\
            -X POST "\${{ secrets.AUTO_DOC_MCP_URL }}/messages?sessionId=$SESSION_ID" \\
            -H "Content-Type: application/json" \\
            -H "X-Auto-Doc-Bridge-Key: \${{ secrets.AUTO_DOC_BRIDGE_API_KEY }}" \\
            -d '{
              "jsonrpc": "2.0",
              "id": 1,
              "method": "tools/call",
              "params": {
                "name": "capture_development_event",
                "arguments": {
                  "projectId": "${input.projectId}",
                  "source": "github",
                  "eventType": "'"$EVENT_TYPE"'",
                  "summary": "'"$(printf '%s' "\${{ steps.meta.outputs.msg }}" | sed 's/"/\\"/g')"'",
                  "commitSha": "\${{ steps.meta.outputs.sha }}",
                  "branch": "\${{ steps.meta.outputs.branch }}",
                  "filesChanged": "\${{ steps.meta.outputs.files }}",
                  "testStatus": "unknown"
                }
              }
            }'

      - name: Documentation captured
        if: steps.skip.outputs.skip != 'true'
        run: echo "Auto-Doc MCP documentation evidence captured."
`;
}

export async function writeGithubActionsWorkflow(input: {
  cwd: string;
  serverUrl: string;
  projectId: string;
  defaultBranch?: string;
  overwrite?: boolean;
}): Promise<string> {
  const workflowPath = path.join(input.cwd, ".github", "workflows", "auto-doc.yml");
  await fs.mkdir(path.dirname(workflowPath), { recursive: true });
  if (!input.overwrite) {
    try {
      await fs.access(workflowPath);
      return workflowPath;
    } catch {
      // File does not exist, continue.
    }
  }
  await fs.writeFile(
    workflowPath,
    generateWorkflowContent({
      serverUrl: input.serverUrl,
      projectId: input.projectId,
      defaultBranch: input.defaultBranch,
    }),
    "utf8",
  );
  return workflowPath;
}
