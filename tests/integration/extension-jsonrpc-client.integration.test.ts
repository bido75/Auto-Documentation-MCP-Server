import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { JsonRpcResponseError, JsonRpcStdioClient } from "../../packages/vscode-extension/src/mcp/jsonrpc-stdio-client";

describe("extension jsonrpc stdio client", () => {
  it("calls tools over framed stdio JSON-RPC", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "auto-doc-extension-rpc-"));
    const fakeServerPath = join(tempDir, "fake-mcp-server.cjs");

    await writeFile(
      fakeServerPath,
      `
const processBuffer = [];
let pending = Buffer.alloc(0);

function writeMessage(payload) {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  const header = Buffer.from("Content-Length: " + body.length + "\\r\\n\\r\\n", "utf8");
  process.stdout.write(Buffer.concat([header, body]));
}

function handleMessage(message) {
  if (message.method === "initialize") {
    writeMessage({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2024-11-05" } });
    return;
  }

  if (message.method === "tools/call") {
    const toolName = message.params && message.params.name;
    if (toolName === "initialize_project_manual") {
      writeMessage({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          content: [
            {
              type: "text",
              text: JSON.stringify({ projectId: "proj_test", projectsDatabaseId: "db_projects" }),
            },
          ],
        },
      });
      return;
    }

    writeMessage({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        content: [
          {
            type: "text",
            text: JSON.stringify({ ok: true }),
          },
        ],
      },
    });
  }
}

process.stdin.on("data", (chunk) => {
  pending = Buffer.concat([pending, chunk]);

  while (true) {
    const headerEnd = pending.indexOf("\\r\\n\\r\\n");
    if (headerEnd === -1) {
      break;
    }

    const header = pending.slice(0, headerEnd).toString("utf8");
    const match = header.match(/Content-Length:\\s*(\\d+)/i);
    if (!match) {
      pending = pending.slice(headerEnd + 4);
      continue;
    }

    const contentLength = Number.parseInt(match[1], 10);
    const totalLength = headerEnd + 4 + contentLength;
    if (pending.length < totalLength) {
      break;
    }

    const bodyText = pending.slice(headerEnd + 4, totalLength).toString("utf8");
    pending = pending.slice(totalLength);

    try {
      const message = JSON.parse(bodyText);
      handleMessage(message);
    } catch {}
  }
});
`,
      "utf8",
    );

    const client = new JsonRpcStdioClient("node", [fakeServerPath], process.env);
    await client.start();

    const result = (await client.callTool("initialize_project_manual", {
      projectName: "Test Project",
      parentPageId: "0123456789abcdef0123456789abcdef",
    })) as {
      content: Array<{ type: string; text: string }>;
    };

    const parsed = JSON.parse(result.content[0].text) as {
      projectId: string;
      projectsDatabaseId: string;
    };

    expect(parsed.projectId).toBe("proj_test");
    expect(parsed.projectsDatabaseId).toBe("db_projects");

    client.stop();
  });

  it("preserves JSON-RPC error data for structured UI handling", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "auto-doc-extension-rpc-"));
    const fakeServerPath = join(tempDir, "fake-mcp-server-error.cjs");

    await writeFile(
      fakeServerPath,
      `
let pending = Buffer.alloc(0);

function writeMessage(payload) {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  const header = Buffer.from("Content-Length: " + body.length + "\\r\\n\\r\\n", "utf8");
  process.stdout.write(Buffer.concat([header, body]));
}

function handleMessage(message) {
  if (message.method === "initialize") {
    writeMessage({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2024-11-05" } });
    return;
  }

  writeMessage({
    jsonrpc: "2.0",
    id: message.id,
    error: {
      code: -32000,
      message: "Tool failed",
      data: {
        ok: false,
        error: {
          code: "DOCUMENTATION_STATUS_FAILED",
          message: "NOTION_TOKEN is missing.",
          traceId: "trace-error-1",
          tool: "get_documentation_status",
          remediation: ["Set NOTION_TOKEN before starting the server."],
        },
      },
    },
  });
}

process.stdin.on("data", (chunk) => {
  pending = Buffer.concat([pending, chunk]);

  while (true) {
    const headerEnd = pending.indexOf("\\r\\n\\r\\n");
    if (headerEnd === -1) {
      break;
    }

    const header = pending.slice(0, headerEnd).toString("utf8");
    const match = header.match(/Content-Length:\\s*(\\d+)/i);
    if (!match) {
      pending = pending.slice(headerEnd + 4);
      continue;
    }

    const contentLength = Number.parseInt(match[1], 10);
    const totalLength = headerEnd + 4 + contentLength;
    if (pending.length < totalLength) {
      break;
    }

    const bodyText = pending.slice(headerEnd + 4, totalLength).toString("utf8");
    pending = pending.slice(totalLength);

    try {
      const message = JSON.parse(bodyText);
      handleMessage(message);
    } catch {}
  }
});
`,
      "utf8",
    );

    const client = new JsonRpcStdioClient("node", [fakeServerPath], process.env);
    await client.start();

    await expect(client.callTool("get_documentation_status", { projectId: "proj_test" })).rejects.toMatchObject({
      name: "JsonRpcResponseError",
      message: "Tool failed",
      code: -32000,
      data: {
        ok: false,
        error: {
          code: "DOCUMENTATION_STATUS_FAILED",
          traceId: "trace-error-1",
        },
      },
    } satisfies Partial<JsonRpcResponseError>);

    client.stop();
  });
});
