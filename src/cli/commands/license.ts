import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as readline from "node:readline/promises";

type ActivationResponse = { ok?: boolean; licenseKey?: string; error?: string };

function argumentValue(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1]?.trim() : undefined;
}

async function saveLicense(cwd: string, licenseKey: string): Promise<void> {
  const envPath = path.join(cwd, ".env");
  const existing = await fs.readFile(envPath, "utf8").catch(() => "");
  const lines = existing.split(/\r?\n/).filter((line) => !line.startsWith("AUTO_DOC_LICENSE_KEY="));
  lines.push(`AUTO_DOC_LICENSE_KEY=${licenseKey}`);
  await fs.writeFile(envPath, `${lines.filter(Boolean).join("\n")}\n`, "utf8");

  const gitignorePath = path.join(cwd, ".gitignore");
  const gitignore = await fs.readFile(gitignorePath, "utf8").catch(() => "");
  if (!gitignore.split(/\r?\n/).includes(".env")) {
    await fs.writeFile(gitignorePath, `${gitignore.trimEnd()}\n.env\n`, "utf8");
  }
}

export async function runLicenseCommand(argv: string[]): Promise<void> {
  if ((argv[0]?.toLowerCase() ?? "") !== "activate") {
    console.error("Usage: auto-doc-mcp license activate [--server https://mcp.example.com] [--email you@example.com]");
    return;
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const serverUrl = argumentValue(argv, "--server") || process.env.AUTO_DOC_MCP_URL?.trim() || "https://mcp.giscop.com";
    const email = argumentValue(argv, "--email") || (await rl.question("Purchase email: ")).trim();
    const lemonLicenseKey = process.env.LEMONSQUEEZY_LICENSE_KEY?.trim() || (await rl.question("Lemon Squeezy license key: ")).trim();
    if (!email || !lemonLicenseKey) throw new Error("Purchase email and Lemon Squeezy license key are required.");

    const response = await fetch(`${serverUrl.replace(/\/$/, "")}/license/exchange`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, licenseKey: lemonLicenseKey }),
      signal: AbortSignal.timeout(15_000),
    });
    const payload = (await response.json()) as ActivationResponse;
    if (!response.ok || !payload.ok || !payload.licenseKey) {
      throw new Error(payload.error || `License activation failed with HTTP ${response.status}.`);
    }

    await saveLicense(process.cwd(), payload.licenseKey);
    console.error("Auto-Doc MCP license activated and saved to .env.");
  } finally {
    rl.close();
  }
}
