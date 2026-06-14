import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const WINDOWS_POWERSHELL_ARGS = ["-NoLogo", "-NonInteractive", "-NoProfile", "-Command"];
const TOKEN_DIR = path.join(os.homedir(), ".auto-doc-mcp");
const LINUX_ENV_PATH = path.join(TOKEN_DIR, ".env");
const WINDOWS_DPAPI_PATH = path.join(TOKEN_DIR, "token.dpapi");
export const TOKEN_PLACEHOLDER = "__NOTION_TOKEN__";

type SecretBackend = "keychain" | "dpapi-file" | "env-file";

function normalizeSecretName(secretName: string): string {
    return secretName.replace(/[^a-z0-9_-]+/gi, "-").toLowerCase();
}

function getLinuxSecretPath(secretName: string): string {
    return secretName === "notion-token" ? LINUX_ENV_PATH : path.join(TOKEN_DIR, `${normalizeSecretName(secretName)}.env`);
}

function getWindowsSecretPath(secretName: string): string {
    return secretName === "notion-token" ? WINDOWS_DPAPI_PATH : path.join(TOKEN_DIR, `${normalizeSecretName(secretName)}.dpapi`);
}

async function runPowerShellWithStdin(command: string, input: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const child = spawn("powershell", [...WINDOWS_POWERSHELL_ARGS, command], {
            stdio: ["pipe", "pipe", "pipe"],
            windowsHide: true,
        });
        const stdoutChunks: Buffer[] = [];
        const stderrChunks: Buffer[] = [];
        child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
        child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
        child.on("error", reject);
        child.on("close", (code) => {
            if (code === 0) {
                resolve(Buffer.concat(stdoutChunks).toString("utf8"));
                return;
            }

            reject(new Error(Buffer.concat(stderrChunks).toString("utf8").trim() || `PowerShell exited with code ${code ?? "unknown"}.`));
        });
        child.stdin.end(input, "utf8");
    });
}

async function storeNamedSecret(secretName: string, value: string): Promise<SecretBackend> {
    if (process.platform === "darwin") {
        await execFileAsync("security", [
            "add-generic-password",
            "-a",
            "auto-doc-mcp",
            "-s",
            `auto-doc-mcp-${normalizeSecretName(secretName)}`,
            "-w",
            value,
            "-U",
        ]);
        return "keychain";
    }
    if (process.platform === "win32") {
        await fs.mkdir(TOKEN_DIR, { recursive: true });
        const command = [
            "$plain = [Console]::In.ReadToEnd()",
            "$secure = ConvertTo-SecureString $plain -AsPlainText -Force",
            "$secure | ConvertFrom-SecureString",
        ].join("; ");
        const stdout = await runPowerShellWithStdin(command, value);
        await fs.writeFile(getWindowsSecretPath(secretName), stdout.trim(), "utf8");
        return "dpapi-file";
    }
    await fs.mkdir(TOKEN_DIR, { recursive: true });
    await fs.writeFile(getLinuxSecretPath(secretName), `${secretName.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}=${value}\n`, {
        encoding: "utf8",
        mode: 0o600,
    });
    return "env-file";
}

async function resolveNamedSecret(secretName: string): Promise<string | undefined> {
    if (process.platform === "darwin") {
        try {
            const { stdout } = await execFileAsync("security", [
                "find-generic-password",
                "-a",
                "auto-doc-mcp",
                "-s",
                `auto-doc-mcp-${normalizeSecretName(secretName)}`,
                "-w",
            ]);
            const secret = stdout.trim();
            return secret.length > 0 ? secret : undefined;
        }
        catch {
            return undefined;
        }
    }
    if (process.platform === "win32") {
        try {
            const secretPath = getWindowsSecretPath(secretName);
            await fs.access(secretPath);
            const escapedPath = secretPath.replace(/\\/g, "\\\\");
            const command = [
                `$encrypted = (Get-Content -Path '${escapedPath}' -Raw).Trim()`,
                "$secure = ConvertTo-SecureString $encrypted",
                "[System.Net.NetworkCredential]::new('', $secure).Password",
            ].join("; ");
            const { stdout } = await execFileAsync("powershell", [...WINDOWS_POWERSHELL_ARGS, command]);
            const secret = stdout.trim();
            return secret.length > 0 ? secret : undefined;
        }
        catch {
            return undefined;
        }
    }
    try {
        const envContent = await fs.readFile(getLinuxSecretPath(secretName), "utf8");
        const match = envContent.match(/=(.+)$/m);
        return match?.[1]?.trim();
    }
    catch {
        return undefined;
    }
}

export async function storeToken(token: string): Promise<SecretBackend> {
    return storeNamedSecret("notion-token", token);
}

export async function resolveToken(): Promise<string | undefined> {
    if (process.env.NOTION_TOKEN && process.env.NOTION_TOKEN.trim().length > 0) {
        return process.env.NOTION_TOKEN.trim();
    }
    return resolveNamedSecret("notion-token");
}

export async function storeApiKey(providerType: string, apiKey: string): Promise<SecretBackend> {
    return storeNamedSecret(`ai-${providerType}-api-key`, apiKey);
}

export async function resolveApiKey(providerType: string): Promise<string | undefined> {
    return resolveNamedSecret(`ai-${providerType}-api-key`);
}
