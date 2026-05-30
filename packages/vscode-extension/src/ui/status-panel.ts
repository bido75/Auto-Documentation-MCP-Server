export type DocumentationStatusPayload = {
  projectId?: string;
  releaseVersion?: string | null;
  health?: string;
  publishedCount?: number;
  needsReviewCount?: number;
  capturedCount?: number;
  lowConfidenceCount?: number;
  missingReviewQuestions?: string[];
  forcedQueueReasons?: string[];
  traceId?: string;
};

export type StatusPanelState =
  | {
      kind: "loading";
      message: string;
    }
  | {
      kind: "ready";
      status: DocumentationStatusPayload;
      warnings: string[];
      refreshedAt: string;
      allowCopyTraceId?: boolean;
    }
  | {
      kind: "error";
      message: string;
      details?: string;
      traceId?: string;
      refreshedAt: string;
      allowSetupAction?: boolean;
      allowSettingsAction?: boolean;
      allowCopyTraceId?: boolean;
    };

export function createLoadingStatusPanelState(message = "Loading documentation status..."): StatusPanelState {
  return {
    kind: "loading",
    message,
  };
}

export function createReadyStatusPanelState(
  status: DocumentationStatusPayload,
  refreshedAt = new Date().toISOString(),
): StatusPanelState {
  const missingFields = ["health", "publishedCount", "needsReviewCount", "capturedCount", "lowConfidenceCount"].filter(
    (key) => status[key as keyof DocumentationStatusPayload] === undefined,
  );

  return {
    kind: "ready",
    status,
    refreshedAt,
    allowCopyTraceId: Boolean(status.traceId),
    warnings:
      missingFields.length > 0
        ? [`Status response was incomplete. Missing fields: ${missingFields.join(", ")}. Displayed counts default to 0.`]
        : [],
  };
}

export function createErrorStatusPanelState(
  message: string,
  options: {
    details?: string;
    traceId?: string;
    refreshedAt?: string;
    allowSetupAction?: boolean;
    allowSettingsAction?: boolean;
    allowCopyTraceId?: boolean;
  } = {},
): StatusPanelState {
  return {
    kind: "error",
    message,
    details: options.details,
    traceId: options.traceId,
    refreshedAt: options.refreshedAt ?? new Date().toISOString(),
    allowSetupAction: options.allowSetupAction,
    allowSettingsAction: options.allowSettingsAction,
    allowCopyTraceId: options.allowCopyTraceId ?? Boolean(options.traceId),
  };
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderRefreshScript(): string {
  return `<script>
    const vscode = typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : null;
    const refreshButton = document.getElementById("refresh-status");
    const copyTraceButton = document.getElementById("copy-trace-id");
    const openSetupButton = document.getElementById("open-setup");
    const openSettingsButton = document.getElementById("open-settings");
    if (refreshButton && vscode) {
      refreshButton.addEventListener("click", () => {
        refreshButton.setAttribute("disabled", "true");
        vscode.postMessage({ type: "refresh" });
      });
    }
    if (copyTraceButton && vscode) {
      copyTraceButton.addEventListener("click", () => {
        const traceId = copyTraceButton.getAttribute("data-trace-id");
        if (!traceId) {
          return;
        }

        vscode.postMessage({ type: "copyTraceId", traceId });
      });
    }
    if (openSetupButton && vscode) {
      openSetupButton.addEventListener("click", () => {
        vscode.postMessage({ type: "openSetup" });
      });
    }
    if (openSettingsButton && vscode) {
      openSettingsButton.addEventListener("click", () => {
        vscode.postMessage({ type: "openSettings" });
      });
    }
  </script>`;
}

function renderHeader(options: {
  traceId?: string;
  allowCopyTraceId?: boolean;
  allowSetupAction?: boolean;
  allowSettingsAction?: boolean;
}): string {
  const actions = [
    options.allowSetupAction ? `<button id="open-setup" class="secondary">Run Setup Wizard</button>` : "",
    options.allowSettingsAction ? `<button id="open-settings" class="secondary">Open Settings</button>` : "",
    options.allowCopyTraceId && options.traceId
      ? `<button id="copy-trace-id" class="secondary" data-trace-id="${escapeHtml(options.traceId)}">Copy Trace ID</button>`
      : "",
    `<button id="refresh-status" class="refresh">Refresh</button>`,
  ].filter(Boolean);

  return `<div class="toolbar">${actions.join("")}</div>`;
}

function renderWarnings(warnings: string[]): string {
  if (warnings.length === 0) {
    return "";
  }

  const items = warnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join("");
  return `<div class="callout warning"><strong>Partial status</strong><ul>${items}</ul></div>`;
}

function renderMissingQuestions(questions: string[]): string {
  if (questions.length === 0) {
    return `<div class="empty">No open review questions.</div>`;
  }

  const items = questions.map((question) => `<li>${escapeHtml(question)}</li>`).join("");
  return `<ul class="questions">${items}</ul>`;
}

function renderForcedQueueReasons(reasons: string[]): string {
  if (reasons.length === 0) {
    return `<div class="empty">No forced queue reasons.</div>`;
  }

  const items = reasons
    .map((reason) => {
      const typeMatch = reason.match(/\((matched_existing_feature|disambiguated_route_collision)/);
      const rawCode = typeMatch?.[1];
      const label = rawCode === "matched_existing_feature"
        ? "Matched Existing Feature"
        : rawCode === "disambiguated_route_collision"
          ? "Route Collision"
          : "Forced Queue Review";
      const toneClass = rawCode === "matched_existing_feature"
        ? "matched"
        : rawCode === "disambiguated_route_collision"
          ? "collision"
          : "generic";
      const tooltip = rawCode ? `Deduplication code: ${rawCode}` : "Deduplication code unavailable";
      const badge = `<span class="badge ${toneClass}" title="${escapeHtml(tooltip)}">${escapeHtml(label)}</span>`;

      return `<li class="reason-item">${badge}<span>${escapeHtml(reason)}</span></li>`;
    })
    .join("");
  return `<ul class="questions">${items}</ul>`;
}

export function buildStatusPanelHtml(state: StatusPanelState): string {
  const status = state.kind === "ready" ? state.status : undefined;
  const health = status?.health ?? "unknown";
  const published = status?.publishedCount ?? 0;
  const needsReview = status?.needsReviewCount ?? 0;
  const captured = status?.capturedCount ?? 0;
  const lowConfidence = status?.lowConfidenceCount ?? 0;
  const traceId = state.kind === "ready" ? status?.traceId : state.kind === "error" ? state.traceId : undefined;
  const refreshedAt = state.kind === "loading" ? null : state.refreshedAt;
  const allowSetupAction = state.kind === "error" ? state.allowSetupAction : false;
  const allowSettingsAction = state.kind === "error" ? state.allowSettingsAction : false;
  const allowCopyTraceId = state.kind === "ready" ? state.allowCopyTraceId : state.kind === "error" ? state.allowCopyTraceId : false;
  const panelBody =
    state.kind === "loading"
      ? `<div class="callout loading"><strong>Refreshing</strong><p>${escapeHtml(state.message)}</p></div>`
      : state.kind === "error"
        ? `<div class="callout error"><strong>Status unavailable</strong><p>${escapeHtml(state.message)}</p>${
            state.details ? `<pre>${escapeHtml(state.details)}</pre>` : ""
          }</div>`
        : `${renderWarnings(state.warnings)}
  <div class="grid">
    <div class="card"><div class="label">Published</div><div class="value">${published}</div></div>
    <div class="card"><div class="label">Needs Review</div><div class="value">${needsReview}</div></div>
    <div class="card"><div class="label">Captured</div><div class="value">${captured}</div></div>
    <div class="card"><div class="label">Low Confidence</div><div class="value">${lowConfidence}</div></div>
  </div>
  <div class="health"><strong>Health:</strong> ${escapeHtml(health)}</div>
  <section class="section">
    <h2>Review Queue</h2>
    ${renderMissingQuestions(status?.missingReviewQuestions ?? [])}
  </section>
  <section class="section">
    <h2>Forced Queue Reasons</h2>
    ${renderForcedQueueReasons(status?.forcedQueueReasons ?? [])}
  </section>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Auto-Doc Status</title>
  <style>
    body { font-family: Segoe UI, sans-serif; padding: 20px; color: var(--vscode-foreground); background: radial-gradient(circle at top, color-mix(in srgb, var(--vscode-button-background) 12%, transparent), transparent 40%), var(--vscode-editor-background); }
    h1 { font-size: 20px; margin: 0 0 8px; }
    h2 { font-size: 13px; margin: 0 0 10px; text-transform: uppercase; letter-spacing: 0.08em; opacity: 0.8; }
    p, li { line-height: 1.45; }
    .toolbar { display: flex; justify-content: flex-end; gap: 8px; flex-wrap: wrap; margin-bottom: 12px; }
    .refresh { border: 1px solid var(--vscode-button-border, transparent); background: var(--vscode-button-background); color: var(--vscode-button-foreground); border-radius: 999px; padding: 6px 12px; cursor: pointer; }
    .secondary { border: 1px solid var(--vscode-button-border, var(--vscode-panel-border)); background: transparent; color: var(--vscode-foreground); border-radius: 999px; padding: 6px 12px; cursor: pointer; }
    .refresh[disabled], .secondary[disabled] { opacity: 0.65; cursor: default; }
    .meta { margin-bottom: 14px; opacity: 0.8; font-size: 12px; }
    .grid { display: grid; grid-template-columns: repeat(2, minmax(140px, 1fr)); gap: 12px; max-width: 520px; }
    .card { border: 1px solid var(--vscode-panel-border); border-radius: 12px; padding: 12px; background: color-mix(in srgb, var(--vscode-sideBar-background) 84%, transparent); box-shadow: 0 10px 30px rgba(0, 0, 0, 0.08); }
    .label { font-size: 12px; opacity: 0.8; margin-bottom: 4px; }
    .value { font-size: 22px; font-weight: 600; }
    .health { margin-top: 12px; font-size: 14px; }
    .section { margin-top: 20px; max-width: 640px; }
    .callout { max-width: 640px; border-radius: 12px; padding: 14px; margin-bottom: 16px; border: 1px solid var(--vscode-panel-border); }
    .callout p { margin: 8px 0 0; }
    .warning { background: color-mix(in srgb, var(--vscode-editorWarning-foreground) 12%, transparent); }
    .error { background: color-mix(in srgb, var(--vscode-errorForeground) 10%, transparent); }
    .loading { background: color-mix(in srgb, var(--vscode-progressBar-background) 14%, transparent); }
    .empty { opacity: 0.75; }
    .questions { margin: 0; padding-left: 18px; }
    .reason-item { list-style: none; margin: 0 0 8px 0; display: flex; align-items: flex-start; gap: 8px; }
    .reason-item span:last-child { line-height: 1.45; }
    .badge { display: inline-block; border-radius: 999px; padding: 2px 8px; font-size: 11px; font-weight: 600; border: 1px solid var(--vscode-panel-border); white-space: nowrap; }
    .badge.matched { background: color-mix(in srgb, var(--vscode-editorWarning-foreground) 18%, transparent); color: var(--vscode-editorWarning-foreground); }
    .badge.collision { background: color-mix(in srgb, var(--vscode-symbolIcon-structForeground) 20%, transparent); color: var(--vscode-symbolIcon-structForeground); }
    .badge.generic { background: color-mix(in srgb, var(--vscode-editorInfo-foreground) 16%, transparent); color: var(--vscode-editorInfo-foreground); }
    pre { white-space: pre-wrap; word-break: break-word; font-family: var(--vscode-editor-font-family, Consolas, monospace); font-size: 12px; margin: 10px 0 0; }
    .trace { margin-top: 14px; opacity: 0.75; font-size: 11px; }
  </style>
</head>
<body>
  ${renderHeader({ traceId, allowCopyTraceId, allowSetupAction, allowSettingsAction })}
  <h1>Auto-Doc Documentation Status</h1>
  <div class="meta">${
    refreshedAt ? `Last refreshed ${escapeHtml(refreshedAt)}` : "Waiting for status response..."
  }</div>
  ${panelBody}
  ${traceId ? `<div class="trace">Trace ID: ${escapeHtml(traceId)}</div>` : ""}
  ${renderRefreshScript()}
</body>
</html>`;
}
