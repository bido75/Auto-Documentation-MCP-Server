#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const explicitPath = process.env.AUTO_DOC_MCP_SERVER_PATH;
const projectPath = process.env.AUTO_DOC_MCP_PROJECT_PATH;

const candidates = [
	explicitPath,
	projectPath ? path.join(projectPath, 'build', 'index.js') : null,
	path.resolve(process.cwd(), 'build', 'index.js'),
	path.resolve(__dirname, '../../../../build/index.js'),
].filter(Boolean);

const resolved = candidates.find((candidate) => {
	try {
		return fs.existsSync(candidate);
	} catch {
		return false;
	}
});

if (!resolved) {
	console.error('Auto-Doc MCP server build artifact not found.');
	console.error('Run "npm run build" in the project root or configure autoDocMcp.serverPath.');
	process.exit(1);
}

require(resolved);
