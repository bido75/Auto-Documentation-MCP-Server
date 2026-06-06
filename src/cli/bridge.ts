import { resolveToken } from "../installer/token-store.js";
import { startHttpBridge } from "../http-bridge/server.js";

export async function runBridgeCommand(): Promise<void> {
  const token = await resolveToken();
  if (token && !process.env.NOTION_TOKEN) {
    process.env.NOTION_TOKEN = token;
  }

  const envPort = process.env.AUTO_DOC_HTTP_PORT?.trim();
  const parsedPort = envPort ? Number.parseInt(envPort, 10) : undefined;
  const host = process.env.AUTO_DOC_HTTP_HOST?.trim() || undefined;

  await startHttpBridge({
    host,
    port: Number.isInteger(parsedPort) ? parsedPort : undefined,
  });
}
