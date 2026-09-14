#!/usr/bin/env node
import { runBridgeCommand } from "./bridge.js";
import { runInit } from "./commands/init.js";
import { runSetupWizard } from "./setup.js";
import { SERVER_METADATA } from "../server.js";

export async function runCli(argv: string[]): Promise<void> {
	const command = argv[0]?.trim().toLowerCase() ?? "help";

	switch (command) {
		case "--version":
		case "-v":
		case "version":
			console.log(SERVER_METADATA.version);
			return;
		case "init":
			await runInit(argv.slice(1));
			return;
		case "setup":
			await runSetupWizard();
			return;
		case "bridge":
			await runBridgeCommand();
			return;
		case "help":
		default:
			console.error("Auto-Doc MCP CLI");
			console.error(`  version: ${SERVER_METADATA.version}`);
			console.error("  auto-doc-mcp init    Initialize Auto-Doc in the current project");
			console.error("  auto-doc-mcp setup   Run universal setup and config writer");
			console.error("  auto-doc-mcp bridge  Start HTTP bridge for web-based tools");
			return;
	}
}

const executedDirectly = process.argv[1]?.includes("index.js") ?? false;
if (executedDirectly) {
	void runCli(process.argv.slice(2)).catch((error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	});
}
