import { fileURLToPath } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { logToolEvent, resolveTraceId } from "./lib/logger.js";
import { createServer } from "./server.js";
import { runContinuousDocumentationRunner } from "./runner/index.js";
import { resolveToken } from "./installer/token-store.js";
import { runPostCommitTrigger } from "./cli/post-commit.js";
import { startHttpBridge } from "./http-bridge/server.js";

type RuntimeMode = "auto" | "mcp" | "runner" | "post-commit";

function envFlag(value: string | undefined, fallback: boolean): boolean {
	if (!value) {
		return fallback;
	}

	const normalized = value.trim().toLowerCase();
	if (["1", "true", "yes", "y", "on"].includes(normalized)) {
		return true;
	}

	if (["0", "false", "no", "n", "off"].includes(normalized)) {
		return false;
	}

	return fallback;
}

function canRunBackgroundMode(env: NodeJS.ProcessEnv): boolean {
	const projectId = env.AUTO_DOC_RUNNER_PROJECT_ID?.trim();
	const repoPath = env.AUTO_DOC_RUNNER_REPO_PATH?.trim();
	return Boolean(projectId && repoPath);
}

function resolveRuntimeMode(argv: string[], env: NodeJS.ProcessEnv): RuntimeMode {
	const explicitArg = argv[2]?.trim().toLowerCase();
	const explicitEnv = env.AUTO_DOC_RUNTIME_MODE?.trim().toLowerCase();
	const candidate = explicitArg ?? explicitEnv ?? "auto";

	if (candidate === "mcp") {
		return "mcp";
	}

	if (candidate === "runner") {
		return "runner";
	}

	if (candidate === "post-commit") {
		return "post-commit";
	}

	return "auto";
}

export async function runApplication(argv: string[] = process.argv, env: NodeJS.ProcessEnv = process.env): Promise<void> {
	if (!env.NOTION_TOKEN || env.NOTION_TOKEN.trim().length === 0) {
		const storedToken = await resolveToken();
		if (storedToken && storedToken.trim().length > 0) {
			env.NOTION_TOKEN = storedToken;
		}
	}

	const mode = resolveRuntimeMode(argv, env);

	if (mode === "auto") {
		if (canRunBackgroundMode(env)) {
			const startBridgeInAuto = envFlag(env.AUTO_DOC_AUTO_START_HTTP_BRIDGE, true);
			if (startBridgeInAuto) {
				await startHttpBridge();
			}

			await runContinuousDocumentationRunner(env);
			return;
		}
	}

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
	console.error("Auto-Documentation Notion MCP Server running on stdio");
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
