import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

function escapeHtml(input: string): string {
  return input
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function markdownToHtml(markdown: string): string {
  const lines = markdown.split(/\r?\n/);
  const output: string[] = [];
  let inList = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      if (inList) {
        output.push("</ul>");
        inList = false;
      }
      continue;
    }

    if (trimmed.startsWith("- ")) {
      if (!inList) {
        output.push("<ul>");
        inList = true;
      }
      output.push(`<li>${escapeHtml(trimmed.slice(2))}</li>`);
      continue;
    }

    if (inList) {
      output.push("</ul>");
      inList = false;
    }

    if (trimmed.startsWith("### ")) {
      output.push(`<h3>${escapeHtml(trimmed.slice(4))}</h3>`);
      continue;
    }

    if (trimmed.startsWith("## ")) {
      output.push(`<h2>${escapeHtml(trimmed.slice(3))}</h2>`);
      continue;
    }

    if (trimmed.startsWith("# ")) {
      output.push(`<h1>${escapeHtml(trimmed.slice(2))}</h1>`);
      continue;
    }

    output.push(`<p>${escapeHtml(trimmed)}</p>`);
  }

  if (inList) {
    output.push("</ul>");
  }

  return output.join("\n");
}

function renderHtmlDocument(title: string, markdown: string): string {
  const body = markdownToHtml(markdown);
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>${escapeHtml(title)}</title>
    <style>
      body {
        font-family: "Segoe UI", Arial, sans-serif;
        margin: 28px;
        color: #111827;
        line-height: 1.45;
      }
      h1, h2, h3 {
        margin-top: 18px;
        margin-bottom: 8px;
      }
      p, li {
        font-size: 12px;
      }
      ul {
        margin-top: 0;
      }
    </style>
  </head>
  <body>
${body}
  </body>
</html>`;
}

export async function generatePdfFromMarkdown(input: {
  title: string;
  markdown: string;
  outputPath: string;
}): Promise<string> {
  const { chromium } = await import("playwright");

  await mkdir(dirname(input.outputPath), { recursive: true });

  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const html = renderHtmlDocument(input.title, input.markdown);
    await page.setContent(html, { waitUntil: "networkidle" });
    await page.pdf({ path: input.outputPath, format: "A4", printBackground: true });
  } finally {
    await browser.close();
  }

  return input.outputPath;
}
