import { copyFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const scriptDir = dirname(scriptPath);
const repoRoot = resolve(scriptDir, "..");

const source = resolve(repoRoot, "build", "index.js");
const target = resolve(repoRoot, "packages", "vscode-extension", "bundled", "mcp-server.js");

await mkdir(dirname(target), { recursive: true });
await copyFile(source, target);
console.log(`Copied ${source} to ${target}`);
