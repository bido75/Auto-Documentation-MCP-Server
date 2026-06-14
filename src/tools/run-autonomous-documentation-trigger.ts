import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { logToolEvent, resolveTraceId } from "../lib/logger.js";
import { throwAsMcpToolError } from "../lib/mcp-error.js";
import { executeAutonomousDocumentationTrigger } from "../orchestrator/auto-doc-orchestrator.js";

export function registerRunAutonomousDocumentationTriggerTool(server: McpServer) {
    server.tool("run_autonomous_documentation_trigger", "Runs autonomous documentation flow from local git changes through analyze and upsert.", {
        projectId: z.string(),
        repoPath: z.string().optional(),
        mode: z.enum(["staged", "last_commit", "working_tree"]).default("working_tree"),
        source: z.enum(["local_git", "github", "ci", "release", "ai_session"]).optional(),
        eventType: z.enum(["commit", "diff", "pr_opened", "pr_merged", "tests_passed", "release_tagged", "session_completed"]).optional(),
        summary: z.string().optional(),
        diffSummary: z.string().optional(),
        filesChanged: z.array(z.string()).optional(),
        commitSha: z.string().optional(),
        branch: z.string().optional(),
        prUrl: z.string().url().optional(),
        prTitle: z.string().optional(),
        prBody: z.string().optional(),
        prNumber: z.number().int().positive().optional(),
        baseBranch: z.string().optional(),
        headBranch: z.string().optional(),
        issueReferences: z.array(z.string()).optional(),
        releaseVersion: z.string().optional(),
        testStatus: z.enum(["passed", "failed", "unknown", "not_run"]).optional(),
        traceId: z.string().optional(),
    }, async (input) => {
        const traceId = resolveTraceId(input.traceId);
        const startedAt = Date.now();
        try {
            const result = await executeAutonomousDocumentationTrigger({
                projectId: input.projectId,
                repoPath: input.repoPath,
                mode: input.mode,
                source: input.source,
                eventType: input.eventType,
                summary: input.summary,
                diffSummary: input.diffSummary,
                filesChanged: input.filesChanged,
                commitSha: input.commitSha,
                branch: input.branch,
                prUrl: input.prUrl,
                prTitle: input.prTitle,
                prBody: input.prBody,
                prNumber: input.prNumber,
                baseBranch: input.baseBranch,
                headBranch: input.headBranch,
                issueReferences: input.issueReferences,
                releaseVersion: input.releaseVersion,
                testStatus: input.testStatus,
                traceId,
            });
            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify(result, null, 2),
                    },
                ],
            };
        }
        catch (error) {
            logToolEvent({
                level: "error",
                tool: "run_autonomous_documentation_trigger",
                stage: "failure",
                traceId,
                message: "Failed autonomous documentation trigger",
                data: {
                    projectId: input.projectId,
                    repoPath: input.repoPath,
                    mode: input.mode,
                    error: error instanceof Error ? error.message : String(error),
                    durationMs: Date.now() - startedAt,
                },
            });
            throwAsMcpToolError({
                tool: "run_autonomous_documentation_trigger",
                traceId,
                error,
                defaultCode: "RUN_AUTONOMOUS_DOCUMENTATION_TRIGGER_FAILED",
            });
        }
    });
}
