import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { resolveArtifactPath } from "./artifact-paths.js";
import { isPrivateOrMetadataHost } from "./network-security.js";

export class ScreenshotCaptureError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ScreenshotCaptureError";
  }
}

function configuredAllowlist(env: NodeJS.ProcessEnv): string[] {
  return (env.AUTO_DOC_CAPTURE_ALLOWLIST ?? "")
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
}

function hostMatchesAllowlist(hostname: string, allowlist: string[]): boolean {
  const host = hostname.toLowerCase();
  return allowlist.some((entry) => {
    if (entry.startsWith("*.")) {
      const suffix = entry.slice(1);
      return host.endsWith(suffix) && host.length > suffix.length;
    }
    return host === entry;
  });
}

function assertCaptureTargetAllowed(url: string, env: NodeJS.ProcessEnv): URL {
  const parsed = new URL(url);
  if (parsed.username || parsed.password) {
    throw new ScreenshotCaptureError("SCREENSHOT_TARGET_CREDENTIALS_REJECTED", "Capture URLs may not include embedded credentials.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ScreenshotCaptureError("SCREENSHOT_TARGET_PROTOCOL_REJECTED", "Capture URLs must use http or https.");
  }

  const allowlist = configuredAllowlist(env);
  if (allowlist.length === 0) {
    throw new ScreenshotCaptureError("SCREENSHOT_CAPTURE_UNAVAILABLE", "Screenshot capture is disabled until AUTO_DOC_CAPTURE_ALLOWLIST is configured.");
  }

  const host = parsed.hostname;
  const devAllowPrivate = env.AUTO_DOC_CAPTURE_DEV_ALLOW_PRIVATE?.trim().toLowerCase() === "true";
  if (isPrivateOrMetadataHost(host) && !devAllowPrivate) {
    throw new ScreenshotCaptureError("SCREENSHOT_TARGET_FORBIDDEN", "Screenshot capture rejected a private, localhost, or metadata target.");
  }

  if (!hostMatchesAllowlist(host, allowlist)) {
    throw new ScreenshotCaptureError("SCREENSHOT_TARGET_NOT_ALLOWLISTED", "Screenshot capture target host is not in AUTO_DOC_CAPTURE_ALLOWLIST.");
  }

  return parsed;
}

export async function captureScreenshot(url: string, outputPath: string): Promise<string> {
  const safeUrl = assertCaptureTargetAllowed(url, process.env);
  const { chromium } = await import("playwright");
  const safeOutputPath = resolveArtifactPath(outputPath);
  await mkdir(dirname(safeOutputPath), { recursive: true });

  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(safeUrl.toString(), { waitUntil: "networkidle" });
    await page.screenshot({ path: safeOutputPath, fullPage: true });
  } finally {
    await browser.close();
  }

  return safeOutputPath;
}
