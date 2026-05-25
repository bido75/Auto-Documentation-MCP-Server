import { NotionPreflightError } from "./notion-preflight.js";

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
    return error.message;
  }

  return String(error);
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
    envelope.error.context = error.context;
  }

  return envelope;
}

export function throwAsMcpToolError(input: {
  tool: string;
  traceId: string;
  error: unknown;
  defaultCode?: string;
}): never {
  throw new McpToolError(buildMcpErrorEnvelope(input));
}
