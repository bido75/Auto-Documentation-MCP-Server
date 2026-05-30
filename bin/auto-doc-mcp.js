#!/usr/bin/env node
import { runCli } from "../build/cli/index.js";

void runCli(process.argv.slice(2)).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
