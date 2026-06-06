import { randomUUID } from "node:crypto";

type LogLevel = "debug" | "info" | "warn" | "error";

export interface ToolLogEvent {
  level: LogLevel;
  tool: string;
  stage: string;
  traceId: string;
  message: string;
  data?: Record<string, unknown>;
}

const levelOrder: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function currentLogLevel(): LogLevel {
  const raw = (process.env.AUTO_DOC_LOG_LEVEL ?? "info").toLowerCase();
  if (raw === "debug" || raw === "info" || raw === "warn" || raw === "error") {
    return raw;
  }

  return "info";
}

export function resolveTraceId(traceId?: string): string {
  const candidate = traceId?.trim();
  return candidate && candidate.length > 0 ? candidate : randomUUID();
}

export function logToolEvent(event: ToolLogEvent): void {
  if (levelOrder[event.level] < levelOrder[currentLogLevel()]) {
    return;
  }

  const payload: Record<string, unknown> = {
    timestamp: new Date().toISOString(),
    level: event.level,
    tool: event.tool,
    stage: event.stage,
    traceId: event.traceId,
    message: event.message,
    ...(event.data ? { data: event.data } : {}),
  };

  const line = JSON.stringify(payload);
  if (event.level === "error") {
    console.error(line);
    return;
  }

  if (event.level === "warn") {
    console.warn(line);
    return;
  }

  console.error(line);
}
