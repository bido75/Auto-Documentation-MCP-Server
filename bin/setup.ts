#!/usr/bin/env tsx
import { runSetupWizard } from "../src/cli/setup.js";

void runSetupWizard().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
