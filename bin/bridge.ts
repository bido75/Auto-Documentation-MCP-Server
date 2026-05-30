#!/usr/bin/env tsx
import { runBridgeCommand } from "../src/cli/bridge.js";

void runBridgeCommand().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
