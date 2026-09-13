export type HumanizerMode = "prose" | "code" | "both";
export type HumanizerStrictness = 1 | 2 | 3 | 4;
export type HumanizerAudience = "developers" | "end_users" | "admins";

export type HumanizerOptions = {
  mode?: HumanizerMode;
  strictnessLevel?: HumanizerStrictness;
  targetAudience?: HumanizerAudience;
  voiceSample?: string;
};

export type HumanizerMetrics = {
  aiPhraseReplacements: number;
  proseLineChanges: number;
  codeLineChanges: number;
  normalizedFenceCount: number;
  removedCodeCommentCount: number;
};

export type HumanizedText = {
  text: string;
  changed: boolean;
  metrics: HumanizerMetrics;
};

export type HumanizableManualEntry = {
  title: string;
  body: string;
  audience?: string;
  status?: string;
  figures?: unknown[];
};

export type HumanizedManualEntry<T extends HumanizableManualEntry = HumanizableManualEntry> = T & {
  body: string;
};

const AI_PHRASE_REPLACEMENTS: Array<[RegExp, string]> = [
  [/\bIn this (?:guide|section),?\s+/gi, ""],
  [/\bThis (?:guide|section) (?:will )?(?:walks? you through|explains|describes)\s+/gi, ""],
  [/\bIt is important to note that\s+/gi, ""],
  [/\bPlease note that\s+/gi, ""],
  [/\bIn order to\b/gi, "To"],
  [/\butilize\b/gi, "use"],
  [/\bleverage\b/gi, "use"],
  [/\bseamlessly\b/gi, ""],
  [/\brobust\b/gi, "reliable"],
  [/\bcomprehensive\b/gi, "complete"],
  [/\bensure that you\b/gi, "make sure you"],
  [/\bmake sure to\b/gi, "make sure you"],
  [/\bthe following steps below\b/gi, "these steps"],
  [/\bbelow are\b/gi, "here are"],
];

function emptyMetrics(): HumanizerMetrics {
  return {
    aiPhraseReplacements: 0,
    proseLineChanges: 0,
    codeLineChanges: 0,
    normalizedFenceCount: 0,
    removedCodeCommentCount: 0,
  };
}

function mergeMetrics(left: HumanizerMetrics, right: HumanizerMetrics): HumanizerMetrics {
  return {
    aiPhraseReplacements: left.aiPhraseReplacements + right.aiPhraseReplacements,
    proseLineChanges: left.proseLineChanges + right.proseLineChanges,
    codeLineChanges: left.codeLineChanges + right.codeLineChanges,
    normalizedFenceCount: left.normalizedFenceCount + right.normalizedFenceCount,
    removedCodeCommentCount: left.removedCodeCommentCount + right.removedCodeCommentCount,
  };
}

function resolveOptions(modeOrOptions: HumanizerMode | HumanizerOptions): Required<Pick<HumanizerOptions, "mode" | "strictnessLevel" | "targetAudience">> &
  Pick<HumanizerOptions, "voiceSample"> {
  if (typeof modeOrOptions === "string") {
    return { mode: modeOrOptions, strictnessLevel: 2, targetAudience: "developers" };
  }
  return {
    mode: modeOrOptions.mode ?? "both",
    strictnessLevel: modeOrOptions.strictnessLevel ?? 2,
    targetAudience: modeOrOptions.targetAudience ?? "developers",
    ...(modeOrOptions.voiceSample ? { voiceSample: modeOrOptions.voiceSample } : {}),
  };
}

function tidyWhitespace(line: string): string {
  const leading = line.match(/^\s*/)?.[0] ?? "";
  const body = line.slice(leading.length);
  return leading + body
    .replace(/\u0000/g, "")
    .replace(/[ \t]+$/g, "")
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/([.!?]){2,}/g, "$1")
    .replace(/\s{2,}/g, " ");
}

function humanizeProseLine(line: string, strictnessLevel: HumanizerStrictness): { line: string; replacements: number } {
  if (/^\s*```/.test(line)) {
    return { line, replacements: 0 };
  }

  let next = tidyWhitespace(line);
  let replacements = 0;
  next = next.replace(/\s+—\s+/g, () => {
    replacements += 1;
    return ", ";
  });

  for (const [pattern, replacement] of AI_PHRASE_REPLACEMENTS) {
    next = next.replace(pattern, (...args: unknown[]) => {
      const matched = String(args[0]);
      if (matched.length > 0) {
        replacements += 1;
      }
      return replacement;
    });
  }

  if (strictnessLevel >= 2) {
    next = next
      .replace(/\bIn this (?:section|guide|chapter|tutorial),?\s+(?:we|you)\s+(?:will|are going to|can)\s+(?:explore|review|learn|cover|configure)\s+/gi, () => {
        replacements += 1;
        return "";
      })
      .replace(/^(?:Great question|Excellent point|Of course|Certainly|Absolutely)[!.]?\s*/i, () => {
        replacements += 1;
        return "";
      })
      .replace(/\b(?:let'?s|let us)\s+(?:take a closer look at|dive into|explore)\s+/gi, () => {
        replacements += 1;
        return "";
      });
    next = next.replace(/\bIn this (?:section|guide|chapter|tutorial),?\s+(?:we|you)\s+(?:will|are going to|can)\s+(?:explore|review|learn|cover|configure)\s+/gi, () => {
      replacements += 1;
      return "";
    });
  }

  if (strictnessLevel >= 3) {
    next = next.replace(/\b(?:cutting-edge|state-of-the-art|industry-leading|best-in-class|world-class|enterprise-grade|powerful|intuitive|elegant|sophisticated)\b\s*/gi, () => {
      replacements += 1;
      return "";
    });
  }

  next = next
    .replace(/^(\s*[-*]\s+)Simply\s+/i, "$1")
    .replace(/^(\s*\d+\.\s+)Simply\s+/i, "$1")
    .trimEnd();

  return { line: next, replacements };
}

function normalizeCodeLine(line: string, language: string, strictnessLevel: HumanizerStrictness): { line: string; changed: boolean } {
  const withoutNul = line.replace(/\u0000/g, "");
  let next = withoutNul.replace(/[ \t]+$/g, "");

  if (/^(?:bash|sh|shell|powershell|ps1)$/i.test(language.trim())) {
    next = next
      .replace(/^\s*\$\s+/, "")
      .replace(/^\s*(?:bash|sh|powershell|pwsh)\s+(npm|pnpm|yarn|node|docker|git|curl|npx)\b/i, "$1");
  }

  if (strictnessLevel >= 2 && /^[A-Z][A-Z0-9_]+=.+\s+#\s+[A-Za-z].+$/.test(next)) {
    next = next.replace(/\s+#\s+[A-Za-z].+$/, "");
  }

  if (strictnessLevel >= 2 && /^\s*import\s+\w+\s*#\s*(?:unused|not used)/i.test(next)) {
    next = "";
  }

  return { line: next, changed: next !== line };
}

function isNarratingComment(line: string, nextLine: string | undefined, language: string): boolean {
  const trimmed = line.trim();
  if (!nextLine || !trimmed) {
    return false;
  }
  const next = nextLine.trim().toLowerCase();
  const comment = trimmed.replace(/^(?:\/\/|#)\s*/, "").toLowerCase();
  if (!/^(?:\/\/|#)\s+/.test(trimmed)) {
    return false;
  }
  if (/todo|fixme|warning|caution|security|required/i.test(comment)) {
    return false;
  }
  if (/^(?:bash|sh|shell|powershell|ps1)$/i.test(language)) {
    return /^(?:run|start|install|build|export|set)\b/.test(comment) && /^[a-z_$][\w$-]*/i.test(next);
  }
  return /\b(?:get|set|join|return|create|update|delete|parse|read|write|initialize)\b/.test(comment);
}

function humanizeCodeBlock(block: string, strictnessLevel: HumanizerStrictness): { block: string; metrics: HumanizerMetrics } {
  const metrics = emptyMetrics();
  const lines = block.split("\n");
  const opening = lines[0] ?? "```";
  const language = opening.replace(/^```/, "").trim();
  const bodyEnd = lines.length > 1 && lines[lines.length - 1]?.startsWith("```") ? lines.length - 1 : lines.length;
  const normalizedLines = [opening.trimEnd()];

  for (let index = 1; index < bodyEnd; index += 1) {
    const current = lines[index] ?? "";
    if (strictnessLevel >= 2 && isNarratingComment(current, lines[index + 1], language)) {
      metrics.removedCodeCommentCount += 1;
      metrics.codeLineChanges += 1;
      continue;
    }
    const normalized = normalizeCodeLine(current, language, strictnessLevel);
    if (normalized.changed) {
      metrics.codeLineChanges += 1;
    }
    if (normalized.line.length > 0 || current.length === 0) {
      normalizedLines.push(normalized.line);
    }
  }

  const closing = lines[bodyEnd]?.startsWith("```") ? "```" : "```";
  if (lines[bodyEnd] !== closing) {
    metrics.normalizedFenceCount += 1;
  }
  normalizedLines.push(closing);

  return { block: normalizedLines.join("\n"), metrics };
}

function splitMarkdown(markdown: string): Array<{ type: "prose" | "code"; text: string }> {
  const segments: Array<{ type: "prose" | "code"; text: string }> = [];
  const fencePattern = /```[\s\S]*?(?:```|$)/g;
  let cursor = 0;
  for (const match of markdown.matchAll(fencePattern)) {
    const index = match.index ?? 0;
    if (index > cursor) {
      segments.push({ type: "prose", text: markdown.slice(cursor, index) });
    }
    segments.push({ type: "code", text: match[0] });
    cursor = index + match[0].length;
  }
  if (cursor < markdown.length) {
    segments.push({ type: "prose", text: markdown.slice(cursor) });
  }
  return segments;
}

function humanizeProseBlock(block: string, strictnessLevel: HumanizerStrictness): { block: string; metrics: HumanizerMetrics } {
  const metrics = emptyMetrics();
  const lines = block.split("\n").map((line) => {
    const humanized = humanizeProseLine(line, strictnessLevel);
    metrics.aiPhraseReplacements += humanized.replacements;
    if (humanized.line !== line) {
      metrics.proseLineChanges += 1;
    }
    return humanized.line;
  });

  return {
    block: lines.join("\n").replace(/\n{4,}/g, "\n\n\n"),
    metrics,
  };
}

export function humanizeManualMarkdown(markdown: string, modeOrOptions: HumanizerMode | HumanizerOptions = "both"): HumanizedText {
  const options = resolveOptions(modeOrOptions);
  const normalized = markdown.replace(/\r\n/g, "\n").replace(/\u0000/g, "");
  let metrics = emptyMetrics();
  const output = splitMarkdown(normalized)
    .map((segment) => {
      if (segment.type === "code") {
        if (options.mode === "prose") {
          return segment.text;
        }
        const humanized = humanizeCodeBlock(segment.text, options.strictnessLevel);
        metrics = mergeMetrics(metrics, humanized.metrics);
        return humanized.block;
      }

      if (options.mode === "code") {
        return segment.text;
      }
      const humanized = humanizeProseBlock(segment.text, options.strictnessLevel);
      metrics = mergeMetrics(metrics, humanized.metrics);
      return humanized.block;
    })
    .join("")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();

  return {
    text: output.length > 0 ? `${output}\n` : "",
    changed: output !== normalized.trim(),
    metrics,
  };
}

export function humanizeManualEntries<T extends HumanizableManualEntry>(entries: T[], modeOrOptions: HumanizerMode | HumanizerOptions = "both"): {
  entries: Array<HumanizedManualEntry<T>>;
  changedCount: number;
  metrics: HumanizerMetrics;
} {
  let metrics = emptyMetrics();
  let changedCount = 0;
  const humanizedEntries = entries.map((entry) => {
    const humanized = humanizeManualMarkdown(entry.body, modeOrOptions);
    metrics = mergeMetrics(metrics, humanized.metrics);
    if (humanized.changed) {
      changedCount += 1;
    }
    return { ...entry, body: humanized.text.trimEnd() };
  });

  return { entries: humanizedEntries, changedCount, metrics };
}
