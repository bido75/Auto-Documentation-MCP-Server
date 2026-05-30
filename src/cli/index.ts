import { runBridgeCommand } from "./bridge.js";
import { runSetupWizard } from "./setup.js";

export async function runCli(argv: string[]): Promise<void> {
  const command = argv[0]?.trim().toLowerCase() ?? "help";

  switch (command) {
    case "setup":
      await runSetupWizard();
      return;
    case "bridge":
      await runBridgeCommand();
      return;
    case "help":
    default:
      console.log("Auto-Doc MCP CLI");
      console.log("  auto-doc-mcp setup   Run universal setup and config writer");
      console.log("  auto-doc-mcp bridge  Start HTTP bridge for web-based tools");
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
