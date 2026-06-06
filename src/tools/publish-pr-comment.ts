// @ts-nocheck
import { z } from "zod";
import { registerGeneratePrCommentPreviewTool } from "./generate-pr-comment-preview.js";
import { logToolEvent, resolveTraceId } from "../lib/logger.js";
import { throwAsMcpToolError } from "../lib/mcp-error.js";
class InMemoryToolHost {
    handlers = new Map();
    tool(name, _description, _schema, handler) {
        this.handlers.set(name, handler);
    }
}
function parseToolText(result) {
    const first = result.content[0];
    if (!first || first.type !== "text") {
        throw new Error("Tool did not return a text payload.");
    }
    return JSON.parse(first.text);
}
function parsePullRequestUrl(prUrl) {
    const match = prUrl.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:$|[?#/])/i);
    if (!match) {
        throw new Error("Invalid GitHub pull request URL. Expected format: https://github.com/<owner>/<repo>/pull/<number>");
    }
    return {
        owner: match[1],
        repo: match[2],
        issueNumber: Number(match[3]),
    };
}
function getGitHubToken() {
    const token = process.env.GITHUB_TOKEN?.trim();
    if (!token) {
        throw new Error("GITHUB_TOKEN environment variable is required to publish PR comments.");
    }
    return token;
}
function getGitHubApiBaseUrl() {
    const base = process.env.GITHUB_API_BASE_URL?.trim();
    return base && base.length > 0 ? base.replace(/\/$/, "") : "https://api.github.com";
}
function createMarker(projectId) {
    return `<!-- auto-doc-pr-comment project=${projectId} -->`;
}
function renderCommentBody(marker, markdownPreview) {
    return `${marker}\n${markdownPreview}`;
}
async function githubRequest(input) {
    const response = await fetch(input.url, {
        method: input.method,
        headers: {
            Authorization: `Bearer ${input.token}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            ...(input.body ? { "Content-Type": "application/json" } : {}),
        },
        ...(input.body ? { body: JSON.stringify(input.body) } : {}),
    });
    if (!response.ok) {
        const details = await response.text();
        throw new Error(`GitHub API request failed (${response.status} ${response.statusText}): ${details}`);
    }
    return (await response.json());
}
async function listIssueComments(input) {
    const url = `${input.baseUrl}/repos/${input.owner}/${input.repo}/issues/${input.issueNumber}/comments?per_page=100`;
    return githubRequest({
        url,
        method: "GET",
        token: input.token,
    });
}
async function createIssueComment(input) {
    const url = `${input.baseUrl}/repos/${input.owner}/${input.repo}/issues/${input.issueNumber}/comments`;
    return githubRequest({
        url,
        method: "POST",
        token: input.token,
        body: { body: input.body },
    });
}
async function updateIssueComment(input) {
    const resolvedUrl = `${input.baseUrl}/repos/${input.owner}/${input.repo}/issues/comments/${input.commentId}`;
    return githubRequest({
        url: resolvedUrl,
        method: "PATCH",
        token: input.token,
        body: { body: input.body },
    });
}
export function registerPublishPrCommentTool(server) {
    server.tool("publish_pr_comment", "Publishes or updates an auto-documentation preview comment on a GitHub pull request.", {
        projectId: z.string(),
        prUrl: z.string().url(),
        audience: z.enum(["user", "admin", "both"]).default("both"),
        maxEntries: z.number().int().min(1).max(50).default(8),
        dryRun: z.boolean().default(false),
        traceId: z.string().optional(),
    }, async ({ projectId, prUrl, audience, maxEntries, dryRun, traceId: incomingTraceId }) => {
        const traceId = resolveTraceId(incomingTraceId);
        const startedAt = Date.now();
        const resolvedAudience = audience ?? "both";
        const resolvedMaxEntries = maxEntries ?? 8;
        const resolvedDryRun = dryRun ?? false;
        logToolEvent({
            level: "info",
            tool: "publish_pr_comment",
            stage: "start",
            traceId,
            message: "Publishing PR comment",
            data: { projectId, prUrl, audience: resolvedAudience, maxEntries: resolvedMaxEntries, dryRun: resolvedDryRun },
        });
        try {
            const host = new InMemoryToolHost();
            registerGeneratePrCommentPreviewTool(host);
            const previewHandler = host.handlers.get("generate_pr_comment_preview");
            if (!previewHandler) {
                throw new Error("Preview tool handler unavailable.");
            }
            const preview = parseToolText(await previewHandler({
                projectId,
                prUrl,
                audience: resolvedAudience,
                maxEntries: resolvedMaxEntries,
                traceId,
            }));
            const marker = createMarker(projectId);
            const commentBody = renderCommentBody(marker, preview.markdownPreview);
            const target = parsePullRequestUrl(prUrl);
            if (resolvedDryRun) {
                return {
                    content: [
                        {
                            type: "text",
                            text: JSON.stringify({
                                traceId,
                                projectId,
                                prUrl,
                                dryRun: true,
                                action: "none",
                                entryCount: preview.entryCount,
                                commentBody,
                            }, null, 2),
                        },
                    ],
                };
            }
            const token = getGitHubToken();
            const baseUrl = getGitHubApiBaseUrl();
            const comments = await listIssueComments({
                baseUrl,
                token,
                owner: target.owner,
                repo: target.repo,
                issueNumber: target.issueNumber,
            });
            const existing = comments.find((comment) => comment.body.includes(marker));
            const published = existing
                ? await updateIssueComment({
                    baseUrl,
                    token,
                    owner: target.owner,
                    repo: target.repo,
                    commentId: existing.id,
                    body: commentBody,
                })
                : await createIssueComment({
                    baseUrl,
                    token,
                    owner: target.owner,
                    repo: target.repo,
                    issueNumber: target.issueNumber,
                    body: commentBody,
                });
            const action = existing ? "updated" : "created";
            logToolEvent({
                level: "info",
                tool: "publish_pr_comment",
                stage: "success",
                traceId,
                message: "Published PR comment",
                data: {
                    projectId,
                    prUrl,
                    action,
                    commentId: published.id,
                    durationMs: Date.now() - startedAt,
                },
            });
            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify({
                            traceId,
                            projectId,
                            prUrl,
                            action,
                            commentId: published.id,
                            commentUrl: published.html_url ?? null,
                            entryCount: preview.entryCount,
                        }, null, 2),
                    },
                ],
            };
        }
        catch (error) {
            logToolEvent({
                level: "error",
                tool: "publish_pr_comment",
                stage: "failure",
                traceId,
                message: "Failed to publish PR comment",
                data: { projectId, prUrl, error: error instanceof Error ? error.message : String(error), durationMs: Date.now() - startedAt },
            });
            throwAsMcpToolError({
                tool: "publish_pr_comment",
                traceId,
                error,
                defaultCode: "PUBLISH_PR_COMMENT_FAILED",
            });
        }
    });
}
