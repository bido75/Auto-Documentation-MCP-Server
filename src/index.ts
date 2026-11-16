#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { DEFAULT_STATE_ENCRYPTION_KEY } from "./config.js";
import { logToolEvent, resolveTraceId } from "./lib/logger.js";
import { createServer } from "./server.js";
import { runContinuousDocumentationRunner } from "./runner/index.js";
import { resolveToken } from "./installer/token-store.js";
import { runPostCommitTrigger } from "./cli/post-commit.js";
import { logStartupLicenseStatus } from "./lib/license-gate.js";

function resolveRuntimeMode(argv: string[], env: NodeJS.ProcessEnv): "mcp" | "runner" | "post-commit" {
	const explicitArg = argv[2]?.trim().toLowerCase();
	const explicitEnv = env.AUTO_DOC_RUNTIME_MODE?.trim().toLowerCase();
	const candidate = explicitArg ?? explicitEnv ?? "mcp";

	if (candidate === "runner") {
		return "runner";
	}

	if (candidate === "post-commit") {
		return "post-commit";
	}

	return "mcp";
}

export function logMcpModeGuidance(): void {
	console.error(
		"[auto-doc-mcp] MCP server ready (stdio mode).\n" +
			"[auto-doc-mcp] To generate docs: call run_autonomous_documentation_trigger after each session,\n" +
			"[auto-doc-mcp] or install the post-commit hook: npx auto-doc-mcp init --post-commit-hook\n" +
			"[auto-doc-mcp] For continuous background docs, run the runner in a separate process:\n" +
			"[auto-doc-mcp]   AUTO_DOC_RUNNER_PROJECT_ID=<id> AUTO_DOC_RUNNER_REPO_PATH=<path> npm run runner",
	);
}

export async function runApplication(argv = process.argv, env = process.env): Promise<void> {
	if (!env.NOTION_TOKEN || env.NOTION_TOKEN.trim().length === 0) {
		const storedToken = await resolveToken();
		if (storedToken && storedToken.trim().length > 0) {
			env.NOTION_TOKEN = storedToken;
		}
	}

	const mode = resolveRuntimeMode(argv, env);
	logStartupLicenseStatus(env);

	if (mode === "runner") {
		await runContinuousDocumentationRunner(env);
		return;
	}

	if (mode === "post-commit") {
		await runPostCommitTrigger(env);
		return;
	}

	const server = createServer();
	const transport = new StdioServerTransport();
	await server.connect(transport);
	// Warn if the user hasn't set a custom encryption key — data is still
	// encrypted but all installations share the same key, reducing isolation.
	if ((env.STATE_ENCRYPTION_KEY?.trim() || DEFAULT_STATE_ENCRYPTION_KEY) === DEFAULT_STATE_ENCRYPTION_KEY) {
		console.error(
			"[auto-doc-mcp] WARNING: STATE_ENCRYPTION_KEY is not set (using the shared default). " +
				"Generate a unique key with: node -e \"console.log(require('node:crypto').randomBytes(32).toString('hex'))\" " +
				"and add it to your .env file for better isolation between installations.",
		);
	}
	console.error("Auto-Documentation Notion MCP Server running on stdio");
	logMcpModeGuidance();
}

const isExecutedDirectly = fileURLToPath(import.meta.url) === process.argv[1];
if (isExecutedDirectly) {
	void runApplication().catch((error) => {
		const message = error instanceof Error ? error.message : String(error);
		logToolEvent({
			level: "error",
			tool: "auto_doc_entrypoint",
			stage: "startup_failure",
			traceId: resolveTraceId(),
			message: "Failed to start the application entrypoint.",
			data: { error: message },
		});
		process.exitCode = 1;
	});
}
