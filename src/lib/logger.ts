import { randomUUID } from "node:crypto";
import { redactSecrets } from "./redaction.js";

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

  const redactedData = event.data ? redactJsonValue(event.data) : undefined;
  const payload: Record<string, unknown> = {
    timestamp: new Date().toISOString(),
    level: event.level,
    tool: event.tool,
    stage: event.stage,
    traceId: event.traceId,
    message: redactSecrets(event.message),
    ...(redactedData ? { data: redactedData } : {}),
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

function isSecretKey(key: string): boolean {
  return /token|secret|password|api[_-]?key|private[_-]?key|access[_-]?token|authorization/i.test(key);
}

function redactJsonValue(value: unknown, keyHint?: string): unknown {
  if (keyHint && isSecretKey(keyHint) && value !== undefined && value !== null) {
    return "[REDACTED]";
  }

  if (typeof value === "string") {
    return redactSecrets(value);
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactJsonValue(item));
  }

  if (value && typeof value === "object") {
    const entries = Object.entries(value).map(([key, item]) => [key, redactJsonValue(item, key)]);
    return Object.fromEntries(entries);
  }

  return value;
}
