import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { resolveArtifactPath } from "./artifact-paths.js";

export async function captureScreenshot(url: string, outputPath: string): Promise<string> {
  const { chromium } = await import("playwright");
  const safeOutputPath = resolveArtifactPath(outputPath);
  await mkdir(dirname(safeOutputPath), { recursive: true });

  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: "networkidle" });
    await page.screenshot({ path: safeOutputPath, fullPage: true });
  } finally {
    await browser.close();
  }

  return safeOutputPath;
}
