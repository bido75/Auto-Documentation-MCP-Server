import { afterEach, describe, expect, it, vi } from "vitest";
import { buildMcpErrorEnvelope } from "../../src/lib/mcp-error.js";
import { logToolEvent } from "../../src/lib/logger.js";

const previousLogLevel = process.env.AUTO_DOC_LOG_LEVEL;

afterEach(() => {
  vi.restoreAllMocks();
  if (previousLogLevel === undefined) delete process.env.AUTO_DOC_LOG_LEVEL;
  else process.env.AUTO_DOC_LOG_LEVEL = previousLogLevel;
});

function captureLog(data: Record<string, unknown>, message = "message"): string {
  process.env.AUTO_DOC_LOG_LEVEL = "info";
  const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  logToolEvent({
    level: "info",
    tool: "redaction-test",
    stage: "test",
    traceId: "trace",
    message,
    data,
  });
  return String(spy.mock.calls[0]?.[0] ?? "");
}

describe("redact-log-and-error-payloads", () => {
  it("redacts NOTION_TOKEN assignments in log payloads", () => {
    const line = captureLog({ output: "NOTION_TOKEN=secret_raw_value" });
    expect(line).toContain("NOTION_TOKEN=[REDACTED]");
    expect(line).not.toContain("secret_raw_value");
  });

  it("redacts Authorization bearer headers in log messages", () => {
    const line = captureLog({}, "authorization: Bearer very-secret-token-value");
    expect(line).toContain("authorization: [REDACTED]");
    expect(line).not.toContain("very-secret-token-value");
  });

  it("redacts structured apiKey values in log data", () => {
    const line = captureLog({ apiKey: "raw-api-key", nested: { token: "raw-token" } });
    expect(line).toContain("[REDACTED]");
    expect(line).not.toContain("raw-api-key");
    expect(line).not.toContain("raw-token");
  });

  it("redacts tokens in MCP error envelope messages and context", () => {
    const envelope = buildMcpErrorEnvelope({
      tool: "redaction-test",
      traceId: "trace",
      error: Object.assign(new Error("Failed with NOTION_TOKEN=secret_error_value"), {
        code: "TEST_SECRET_FAILURE",
      }),
    });
    const serialized = JSON.stringify(envelope);
    expect(serialized).toContain("NOTION_TOKEN=[REDACTED]");
    expect(serialized).not.toContain("secret_error_value");
  });

  it("does not emit raw secret substrings anywhere in serialized log or error output", () => {
    const logLine = captureLog({ authorization: "Bearer another-secret-token", safe: "ok" });
    const envelope = buildMcpErrorEnvelope({
      tool: "redaction-test",
      traceId: "trace",
      error: new Error('{"apiKey":"secret-json-key"}'),
    });
    const combined = `${logLine}\n${JSON.stringify(envelope)}`;
    expect(combined).not.toContain("another-secret-token");
    expect(combined).not.toContain("secret-json-key");
    expect(combined).toContain("[REDACTED]");
  });
});
