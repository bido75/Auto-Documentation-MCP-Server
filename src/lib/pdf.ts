import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

function escapeHtml(input: string): string {
  return input
    .replaceAll("\u0000", "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderInlineMarkdownImage(trimmed: string): string | null {
  const match = trimmed.match(/^!\[([^\]]*)\]\(([^)]+)\)$/);
  if (!match) {
    return null;
  }

  const alt = escapeHtml(match[1]);
  const src = escapeHtml(match[2]);
  return `<figure><img src="${src}" alt="${alt}" /><figcaption>${alt}</figcaption></figure>`;
}

function renderInlineMarkdown(input: string): string {
  const escaped = escapeHtml(input);
  const withCode = escaped.replace(/`([^`]+)`/g, "<code>$1</code>");
  return withCode.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
}

function normalizeCodeLanguage(input: string): string {
  return input.trim().toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9_-]/g, "");
}

export function markdownToHtml(markdown: string): string {
  const lines = markdown.replace(/\u0000/g, "").split(/\r?\n/);
  const output: string[] = [];
  let inBulletList = false;
  let inNumberedList = false;
  let inCodeBlock = false;
  let nextNumberedListStart = 1;
  let codeLanguage = "";
  let codeLines: string[] = [];

  function closeLists(options: { resetNumbering?: boolean } = {}) {
    if (inBulletList) {
      output.push("</ul>");
      inBulletList = false;
    }
    if (inNumberedList) {
      output.push("</ol>");
      inNumberedList = false;
    }
    if (options.resetNumbering) {
      nextNumberedListStart = 1;
    }
  }

  function closeCodeBlock() {
    const normalizedLanguage = normalizeCodeLanguage(codeLanguage);
    const languageClass = normalizedLanguage ? ` class="language-${escapeHtml(normalizedLanguage)}"` : "";
    output.push(`<pre><code${languageClass}>${escapeHtml(codeLines.join("\n"))}</code></pre>`);
    codeLines = [];
    codeLanguage = "";
    inCodeBlock = false;
  }

  for (const line of lines) {
    const trimmed = line.trim();
    const codeFence = trimmed.match(/^```([A-Za-z0-9 _-]+)?\s*$/);
    if (codeFence) {
      if (inCodeBlock) {
        closeCodeBlock();
      } else {
        closeLists();
        codeLanguage = codeFence[1] ?? "";
        codeLines = [];
        inCodeBlock = true;
      }
      continue;
    }

    if (inCodeBlock) {
      codeLines.push(line);
      continue;
    }

    if (trimmed.length === 0) {
      continue;
    }

    if (trimmed.startsWith("- ")) {
      if (inNumberedList) {
        output.push("</ol>");
        inNumberedList = false;
      }
      if (!inBulletList) {
        output.push("<ul>");
        inBulletList = true;
      }
      output.push(`<li>${renderInlineMarkdown(trimmed.slice(2))}</li>`);
      continue;
    }

    const numbered = trimmed.match(/^(\d+)\.\s+(.+)$/);
    if (numbered) {
      if (inBulletList) {
        output.push("</ul>");
        inBulletList = false;
      }
      if (!inNumberedList) {
        const parsedStart = Number.parseInt(numbered[1], 10);
        const start = Math.max(Number.isFinite(parsedStart) ? parsedStart : 1, nextNumberedListStart);
        output.push(start > 1 ? `<ol start="${start}">` : "<ol>");
        inNumberedList = true;
        nextNumberedListStart = start;
      }
      output.push(`<li>${renderInlineMarkdown(numbered[2])}</li>`);
      nextNumberedListStart += 1;
      continue;
    }

    const image = renderInlineMarkdownImage(trimmed);
    if (image) {
      output.push(image);
      continue;
    }

    closeLists({ resetNumbering: true });

    if (trimmed.startsWith("### ")) {
      output.push(`<h3>${renderInlineMarkdown(trimmed.slice(4))}</h3>`);
      continue;
    }

    if (trimmed.startsWith("## ")) {
      output.push(`<h2>${renderInlineMarkdown(trimmed.slice(3))}</h2>`);
      continue;
    }

    if (trimmed.startsWith("# ")) {
      output.push(`<h1>${renderInlineMarkdown(trimmed.slice(2))}</h1>`);
      continue;
    }

    output.push(`<p>${renderInlineMarkdown(trimmed)}</p>`);
  }

  if (inCodeBlock) {
    closeCodeBlock();
  }
  closeLists();

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
      code {
        font-family: "Cascadia Mono", "Consolas", "Courier New", monospace;
        font-size: 11px;
      }
      pre {
        font-family: "Cascadia Mono", "Consolas", "Courier New", monospace;
        font-size: 10px;
        line-height: 1.35;
        white-space: pre;
        overflow-x: hidden;
        background: #f3f4f6;
        border: 1px solid #d1d5db;
        border-radius: 4px;
        padding: 8px;
        page-break-inside: avoid;
      }
      pre code {
        display: block;
        white-space: pre;
      }
      ul {
        margin-top: 0;
      }
      figure {
        margin: 14px 0;
        page-break-inside: avoid;
      }
      img {
        display: block;
        max-width: 100%;
        height: auto;
        border: 1px solid #d1d5db;
      }
      figcaption {
        font-size: 11px;
        color: #4b5563;
        margin-top: 4px;
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
