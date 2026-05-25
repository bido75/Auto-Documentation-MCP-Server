import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export async function captureScreenshot(url: string, outputPath: string): Promise<string> {
  const { chromium } = await import("playwright");
  await mkdir(dirname(outputPath), { recursive: true });

  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: "networkidle" });
    await page.screenshot({ path: outputPath, fullPage: true });
  } finally {
    await browser.close();
  }

  return outputPath;
}
