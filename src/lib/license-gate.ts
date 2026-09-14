import { buildLicenseNagMessage, getLicenseStatus, requiresLicense } from "./license.js";
import { logToolEvent, resolveTraceId } from "./logger.js";

export type LicenseGateResult =
  | { allowed: true }
  | {
      allowed: false;
      response: {
        content: Array<{ type: "text"; text: string }>;
      };
    };

const shownMessages = new Set<string>();

export function resetLicenseGateForTests(): void {
  shownMessages.clear();
}

export function checkLicenseGate(toolName: string, env: NodeJS.ProcessEnv = process.env): LicenseGateResult {
  if (!requiresLicense(toolName, env)) {
    return { allowed: true };
  }

  const status = getLicenseStatus(env);
  if (status.valid) {
    if (status.gracePeriodDaysLeft !== undefined && !shownMessages.has("grace")) {
      shownMessages.add("grace");
      logToolEvent({
        level: "warn",
        tool: "license",
        stage: "grace_period",
        traceId: resolveTraceId(),
        message: "Auto-Doc MCP license is in grace period.",
        data: { gracePeriodDaysLeft: status.gracePeriodDaysLeft },
      });
    }
    return { allowed: true };
  }

  if (!shownMessages.has(toolName)) {
    shownMessages.add(toolName);
    logToolEvent({
      level: "warn",
      tool: "license",
      stage: "required",
      traceId: resolveTraceId(),
      message: "Advanced tool blocked because no active license is configured.",
      data: { toolName, reason: status.reason },
    });
  }

  return {
    allowed: false,
    response: {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              ok: false,
              code: "AUTO_DOC_LICENSE_REQUIRED",
              tool: toolName,
              reason: status.reason,
              message: buildLicenseNagMessage({ toolName, reason: status.reason }),
            },
            null,
            2,
          ),
        },
      ],
    },
  };
}

export function logStartupLicenseStatus(env: NodeJS.ProcessEnv = process.env): void {
  const status = getLicenseStatus(env);
  if (status.valid) {
    if (status.gracePeriodDaysLeft !== undefined) {
      console.error(`[license] Grace period: ${status.gracePeriodDaysLeft} days remaining. Renew soon.`);
      return;
    }
    console.error("[license] Licensed - all advanced features active.");
    return;
  }

  console.error("[license] No active license key - core tools available.");
  console.error("[license] Advanced tools require a maintenance license.");
}
