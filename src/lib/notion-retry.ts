import { redactSecrets } from "./redaction.js";

const DEFAULT_BACKOFF_MS = [2000, 4000, 8000] as const;

export interface RetryOptions {
  backoffMs?: number[];
  sleep?: (ms: number) => Promise<void>;
  operationName?: string;
  payload?: unknown;
}

function isRateLimitError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const candidate = error as { code?: unknown; status?: unknown; message?: unknown };
  return (
    candidate.code === "rate_limited" ||
    candidate.status === 429 ||
    (typeof candidate.message === "string" && candidate.message.toLowerCase().includes("rate limit"))
  );
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function getMessage(error: unknown): string {
  if (!error || typeof error !== "object") {
    return String(error);
  }

  const candidate = error as { message?: unknown };
  return typeof candidate.message === "string" ? candidate.message : "Notion request failed.";
}

function isValidationError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const candidate = error as { code?: unknown; status?: unknown; message?: unknown };
  const message = typeof candidate.message === "string" ? candidate.message.toLowerCase() : "";
  return candidate.code === "validation_error" || (candidate.status === 400 && message.includes("validation"));
}

function extractPropertyName(message: string): string | null {
  const bracketNotation = message.match(/body\.properties\[['\"]([^'\"]+)['\"]\]/i);
  if (bracketNotation?.[1]) {
    return bracketNotation[1];
  }

  const dotNotation = message.match(/body\.properties\.([A-Za-z0-9_]+)/i);
  if (dotNotation?.[1]) {
    return dotNotation[1];
  }

  return null;
}

function safeStringify(value: unknown): string {
  try {
    const raw = JSON.stringify(value);
    const cleaned = redactSecrets(raw ?? String(value));
    return cleaned.length > 240 ? `${cleaned.slice(0, 240)}...` : cleaned;
  } catch {
    const fallback = redactSecrets(String(value));
    return fallback.length > 240 ? `${fallback.slice(0, 240)}...` : fallback;
  }
}

function extractAttemptedValue(payload: unknown, propertyName: string | null): string {
  if (!propertyName || !payload || typeof payload !== "object") {
    return "[unavailable]";
  }

  const asRecord = payload as Record<string, unknown>;
  const properties = asRecord.properties;
  if (!properties || typeof properties !== "object") {
    return "[unavailable]";
  }

  const propertyValue = (properties as Record<string, unknown>)[propertyName];
  if (propertyValue === undefined) {
    return "[unavailable]";
  }

  return safeStringify(propertyValue);
}

function normalizeNotionError(error: unknown, options: RetryOptions): Error {
  if (!isValidationError(error)) {
    if (error instanceof Error) {
      return error;
    }

    return new Error(getMessage(error));
  }

  const originalMessage = getMessage(error);
  const propertyName = extractPropertyName(originalMessage);
  const attemptedValue = extractAttemptedValue(options.payload, propertyName);
  const operation = options.operationName ?? "notion_request";
  const propertyPart = propertyName ? `property='${propertyName}'` : "property='unknown'";
  const message = `Notion validation error (${operation}): ${propertyPart}, attempted=${attemptedValue}. ${originalMessage}`;

  return new Error(message, { cause: error as Error });
}

export async function withNotionRetry<T>(operation: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const backoffMs = options.backoffMs ?? [...DEFAULT_BACKOFF_MS];
  const sleep = options.sleep ?? defaultSleep;

  let lastError: unknown;
  for (let attempt = 0; attempt <= backoffMs.length; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!isRateLimitError(error) || attempt === backoffMs.length) {
        throw normalizeNotionError(error, options);
      }

      await sleep(backoffMs[attempt]);
    }
  }

  throw lastError;
}
