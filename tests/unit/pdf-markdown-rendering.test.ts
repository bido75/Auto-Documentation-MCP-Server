import { describe, expect, it } from "vitest";
import { markdownToHtml } from "../../src/lib/pdf.js";

describe("PDF markdown rendering", () => {
  it("renders authored markdown syntax as formatted HTML instead of literal text", () => {
    const html = markdownToHtml(`# Title

## Overview
Use **bold** text and \`inlineCode\`.

1. First step
2. Second step

- One fact

\`\`\`javascript
console.log("ok");
\`\`\``);

    expect(html).toContain("<h1>Title</h1>");
    expect(html).toContain("<h2>Overview</h2>");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<code>inlineCode</code>");
    expect(html).toContain("<ol>");
    expect(html).toContain("<li>First step</li>");
    expect(html).toContain("<ul>");
    expect(html).toContain('<pre><code class="language-javascript">console.log(&quot;ok&quot;);</code></pre>');
    expect(html).not.toContain("# Title");
    expect(html).not.toContain("**bold**");
    expect(html).not.toContain("```javascript");
  });

  it("renders Notion round-tripped plain text code fences as code blocks", () => {
    const html = markdownToHtml(`Example Usage:
\`\`\`plain text
import { buildNotification } from './notification-workflow.js';

const notification = buildNotification('user123', 'email', { subject: 'Hello' });
\`\`\`

Returns:
\`\`\`javascript
{
  userId,
  channel,
  status: 'pending'
}
\`\`\``);

    expect(html).toContain('<pre><code class="language-plain-text">');
    expect(html).toContain("import { buildNotification } from &#39;./notification-workflow.js&#39;;");
    expect(html).toContain('<pre><code class="language-javascript">');
    expect(html).not.toContain("```plain text");
    expect(html).not.toContain("```javascript");
  });

  it("strips NUL bytes before rendering PDF HTML", () => {
    const html = markdownToHtml(
      [
        "1. \u0000\u0000\u0000 Import the required functions.",
        "```plain text",
        "const delay = nextBackoffMs(2\u0000; // Returns 4000",
        "const summary = summarize([notification1, notification2\u0000\u0000;",
        "```",
        "- Retry cap in source: `MAX_RETRIES \u0000 3`.",
      ].join("\n"),
    );

    expect(html).not.toContain("\u0000");
    expect(html).toContain("<li>Import the required functions.</li>");
    expect(html).toContain("const delay = nextBackoffMs(2; // Returns 4000");
    expect(html).toContain("MAX_RETRIES  3");
  });

  it("keeps ordered lists incrementing when markdown has blank lines between items", () => {
    const html = markdownToHtml(
      [
        "1. Classify the incident.",
        "",
        "2. Build the escalation plan.",
        "",
        "3. Summarize the plan.",
      ].join("\n"),
    );

    expect(html.match(/<ol>/g)).toHaveLength(1);
    expect(html).toContain("<li>Classify the incident.</li>");
    expect(html).toContain("<li>Build the escalation plan.</li>");
    expect(html).toContain("<li>Summarize the plan.</li>");
  });

  it("resumes ordered lists with the next number after bullets and code details", () => {
    const html = markdownToHtml(
      [
        "1. Classify the incident.",
        "- Returns urgent for critical incidents.",
        "2. Build the escalation plan.",
        "```javascript",
        "buildEscalationPlan(incident);",
        "```",
        "3. Summarize the plan.",
      ].join("\n"),
    );

    expect(html).toContain("<ol>");
    expect(html).toContain('<ol start="2">');
    expect(html).toContain('<ol start="3">');
    expect(html).toContain("<li>Classify the incident.</li>");
    expect(html).toContain("<li>Build the escalation plan.</li>");
    expect(html).toContain("<li>Summarize the plan.</li>");
  });
});
