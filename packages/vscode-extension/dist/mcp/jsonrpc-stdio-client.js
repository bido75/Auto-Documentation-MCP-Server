"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.JsonRpcStdioClient = exports.JsonRpcResponseError = void 0;
const node_child_process_1 = require("node:child_process");
class JsonRpcResponseError extends Error {
    code;
    data;
    constructor(message, code, data) {
        super(message);
        this.code = code;
        this.data = data;
        this.name = "JsonRpcResponseError";
    }
}
exports.JsonRpcResponseError = JsonRpcResponseError;
class JsonRpcStdioClient {
    command;
    args;
    env;
    process = null;
    nextRequestId = 1;
    initialized = false;
    buffer = Buffer.alloc(0);
    pending = new Map();
    constructor(command, args, env) {
        this.command = command;
        this.args = args;
        this.env = env;
    }
    async start() {
        if (this.process) {
            return;
        }
        this.process = (0, node_child_process_1.spawn)(this.command, this.args, {
            env: this.env,
            stdio: ["pipe", "pipe", "pipe"],
        });
        this.process.stdout.on("data", (chunk) => this.handleStdoutChunk(chunk));
        this.process.stderr.on("data", (chunk) => {
            console.log("[auto-doc-mcp]", chunk.toString("utf8"));
        });
        this.process.on("exit", () => {
            for (const pendingRequest of this.pending.values()) {
                pendingRequest.reject(new Error("MCP server process exited before request completed."));
            }
            this.pending.clear();
            this.process = null;
            this.initialized = false;
            this.buffer = Buffer.alloc(0);
        });
    }
    stop() {
        this.process?.kill();
        this.process = null;
        this.initialized = false;
        this.buffer = Buffer.alloc(0);
        this.pending.clear();
    }
    async callTool(name, args) {
        await this.ensureInitialized();
        return this.sendRequest("tools/call", {
            name,
            arguments: args,
        });
    }
    async ensureInitialized() {
        if (this.initialized) {
            return;
        }
        const initializeResult = await this.sendRequest("initialize", {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: {
                name: "auto-doc-mcp-vscode-extension",
                version: "0.1.0",
            },
        });
        if (!initializeResult) {
            throw new Error("Failed to initialize MCP session.");
        }
        this.sendNotification("notifications/initialized", {});
        this.initialized = true;
    }
    async sendRequest(method, params) {
        if (!this.process) {
            throw new Error("MCP process is not running.");
        }
        const requestId = this.nextRequestId++;
        const payload = {
            jsonrpc: "2.0",
            id: requestId,
            method,
            params,
        };
        const body = Buffer.from(JSON.stringify(payload), "utf8");
        const headers = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "utf8");
        const responsePromise = new Promise((resolve, reject) => {
            this.pending.set(requestId, { resolve, reject });
            setTimeout(() => {
                if (!this.pending.has(requestId)) {
                    return;
                }
                this.pending.delete(requestId);
                reject(new Error(`Timed out waiting for JSON-RPC response for ${method}.`));
            }, 15000);
        });
        this.process.stdin.write(headers);
        this.process.stdin.write(body);
        return responsePromise;
    }
    sendNotification(method, params) {
        if (!this.process) {
            return;
        }
        const payload = {
            jsonrpc: "2.0",
            method,
            params,
        };
        const body = Buffer.from(JSON.stringify(payload), "utf8");
        const headers = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "utf8");
        this.process.stdin.write(headers);
        this.process.stdin.write(body);
    }
    handleStdoutChunk(chunk) {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        while (true) {
            const headerEnd = this.buffer.indexOf("\r\n\r\n");
            if (headerEnd === -1) {
                return;
            }
            const headerText = this.buffer.slice(0, headerEnd).toString("utf8");
            const contentLengthMatch = headerText.match(/Content-Length:\s*(\d+)/i);
            if (!contentLengthMatch) {
                this.buffer = this.buffer.slice(headerEnd + 4);
                continue;
            }
            const contentLength = Number.parseInt(contentLengthMatch[1], 10);
            const totalLength = headerEnd + 4 + contentLength;
            if (this.buffer.length < totalLength) {
                return;
            }
            const body = this.buffer.slice(headerEnd + 4, totalLength).toString("utf8");
            this.buffer = this.buffer.slice(totalLength);
            try {
                const message = JSON.parse(body);
                this.handleMessage(message);
            }
            catch {
                continue;
            }
        }
    }
    handleMessage(message) {
        if (typeof message.id !== "number") {
            return;
        }
        const pendingRequest = this.pending.get(message.id);
        if (!pendingRequest) {
            return;
        }
        this.pending.delete(message.id);
        if (message.error) {
            pendingRequest.reject(new JsonRpcResponseError(message.error.message, message.error.code, message.error.data));
            return;
        }
        pendingRequest.resolve(message.result);
    }
}
exports.JsonRpcStdioClient = JsonRpcStdioClient;
