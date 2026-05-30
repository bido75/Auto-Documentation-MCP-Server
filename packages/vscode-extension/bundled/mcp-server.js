import { fileURLToPath } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { logToolEvent, resolveTraceId } from "./lib/logger.js";
import { createServer } from "./server.js";
import { runContinuousDocumentationRunner } from "./runner/index.js";
function resolveRuntimeMode(argv, env) {
    const explicitArg = argv[2]?.trim().toLowerCase();
    const explicitEnv = env.AUTO_DOC_RUNTIME_MODE?.trim().toLowerCase();
    const candidate = explicitArg ?? explicitEnv ?? "mcp";
    if (candidate === "runner") {
        return "runner";
    }
    return "mcp";
}
export async function runApplication(argv = process.argv, env = process.env) {
    const mode = resolveRuntimeMode(argv, env);
    if (mode === "runner") {
        await runContinuousDocumentationRunner(env);
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
