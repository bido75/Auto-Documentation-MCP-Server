import { ChildProcessWithoutNullStreams, spawn } from "node:child_process";

type JsonRpcRequest = {
  jsonrpc: "2.0";
  id?: number;
  method: string;
  params?: Record<string, unknown>;
};

type JsonRpcResponse = {
  jsonrpc: "2.0";
  id?: number;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
};

export class JsonRpcResponseError extends Error {
  constructor(
    message: string,
    public readonly code: number,
    public readonly data?: unknown,
  ) {
    super(message);
    this.name = "JsonRpcResponseError";
  }
}

export class JsonRpcStdioClient {
  private process: ChildProcessWithoutNullStreams | null = null;
  private nextRequestId = 1;
  private initialized = false;
  private buffer = Buffer.alloc(0);
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();

  constructor(private readonly command: string, private readonly args: string[], private readonly env: NodeJS.ProcessEnv) {}

  async start(): Promise<void> {
    if (this.process) {
      return;
    }

    this.process = spawn(this.command, this.args, {
      env: this.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.process.stdout.on("data", (chunk: Buffer) => this.handleStdoutChunk(chunk));
    this.process.stderr.on("data", (chunk: Buffer) => {
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

  stop(): void {
    this.process?.kill();
    this.process = null;
    this.initialized = false;
    this.buffer = Buffer.alloc(0);
    this.pending.clear();
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    await this.ensureInitialized();

    return this.sendRequest("tools/call", {
      name,
      arguments: args,
    });
  }

  private async ensureInitialized(): Promise<void> {
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

  private async sendRequest(method: string, params?: Record<string, unknown>): Promise<unknown> {
    if (!this.process) {
      throw new Error("MCP process is not running.");
    }

    const requestId = this.nextRequestId++;
    const payload: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: requestId,
      method,
      params,
    };

    const body = Buffer.from(JSON.stringify(payload), "utf8");
    const headers = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "utf8");

    const responsePromise = new Promise<unknown>((resolve, reject) => {
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

  private sendNotification(method: string, params?: Record<string, unknown>): void {
    if (!this.process) {
      return;
    }

    const payload: JsonRpcRequest = {
      jsonrpc: "2.0",
      method,
      params,
    };

    const body = Buffer.from(JSON.stringify(payload), "utf8");
    const headers = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "utf8");
    this.process.stdin.write(headers);
    this.process.stdin.write(body);
  }

  private handleStdoutChunk(chunk: Buffer): void {
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
        const message = JSON.parse(body) as JsonRpcResponse;
        this.handleMessage(message);
      } catch {
        continue;
      }
    }
  }

  private handleMessage(message: JsonRpcResponse): void {
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
