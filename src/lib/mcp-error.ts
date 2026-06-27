import { NotionPreflightError } from "./notion-preflight.js";
import { redactSecrets } from "./redaction.js";

export interface McpErrorEnvelope {
  ok: false;
  error: {
    code: string;
    message: string;
    traceId: string;
    tool: string;
    remediation?: string[];
    context?: Record<string, unknown>;
    causeName?: string;
  };
}

export class McpToolError extends Error {
  constructor(public readonly envelope: McpErrorEnvelope) {
    super(JSON.stringify(envelope, null, 2));
    this.name = "McpToolError";
  }
}

function getErrorCode(error: unknown, defaultCode: string): string {
  if (error instanceof NotionPreflightError) {
    return error.code;
  }

  if (typeof error === "object" && error !== null && typeof (error as { code?: unknown }).code === "string") {
    return (error as { code: string }).code;
  }

  return defaultCode;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return redactSecrets(error.message);
  }

  return redactSecrets(String(error));
}

export function buildMcpErrorEnvelope(input: {
  tool: string;
  traceId: string;
  error: unknown;
  defaultCode?: string;
}): McpErrorEnvelope {
  const { tool, traceId, error, defaultCode = "TOOL_EXECUTION_FAILED" } = input;

  if (error instanceof McpToolError) {
    return error.envelope;
  }

  const envelope: McpErrorEnvelope = {
    ok: false,
    error: {
      code: getErrorCode(error, defaultCode),
      message: getErrorMessage(error),
      traceId,
      tool,
      ...(error instanceof Error ? { causeName: error.name } : {}),
    },
  };

  if (error instanceof NotionPreflightError) {
    envelope.error.remediation = error.remediation;
    if (error.context) {
      envelope.error.context = redactContext(error.context);
    }
  }

  return envelope;
}

function redactContext(context: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(context).map(([key, value]) => [key, redactContextValue(key, value)]));
}

function redactContextValue(key: string, value: unknown): unknown {
  if (/token|secret|password|api[_-]?key|private[_-]?key|access[_-]?token|authorization/i.test(key)) {
    return "[REDACTED]";
  }
  if (typeof value === "string") {
    return redactSecrets(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactContextValue("", item));
  }
  if (value && typeof value === "object") {
    return redactContext(value as Record<string, unknown>);
  }
  return value;
}

export function throwAsMcpToolError(input: {
  tool: string;
  traceId: string;
  error: unknown;
  defaultCode?: string;
}): never {
  throw new McpToolError(buildMcpErrorEnvelope(input));
}
