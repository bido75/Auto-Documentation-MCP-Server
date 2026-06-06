// @ts-nocheck
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);
const WINDOWS_POWERSHELL_ARGS = ["-NoLogo", "-NonInteractive", "-NoProfile", "-Command"];
const TOKEN_DIR = path.join(os.homedir(), ".auto-doc-mcp");
const LINUX_ENV_PATH = path.join(TOKEN_DIR, ".env");
const WINDOWS_DPAPI_PATH = path.join(TOKEN_DIR, "token.dpapi");
export const TOKEN_PLACEHOLDER = "__NOTION_TOKEN__";
function normalizeSecretName(secretName) {
    return secretName.replace(/[^a-z0-9_-]+/gi, "-").toLowerCase();
}
function getLinuxSecretPath(secretName) {
    return secretName === "notion-token" ? LINUX_ENV_PATH : path.join(TOKEN_DIR, `${normalizeSecretName(secretName)}.env`);
}
function getWindowsSecretPath(secretName) {
    return secretName === "notion-token" ? WINDOWS_DPAPI_PATH : path.join(TOKEN_DIR, `${normalizeSecretName(secretName)}.dpapi`);
}
async function storeNamedSecret(secretName, value) {
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
        const escapedValue = value.replace(/'/g, "''");
        const command = [`$secure = ConvertTo-SecureString '${escapedValue}' -AsPlainText -Force`, "$secure | ConvertFrom-SecureString"].join("; ");
        const { stdout } = await execFileAsync("powershell", [...WINDOWS_POWERSHELL_ARGS, command]);
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
async function resolveNamedSecret(secretName) {
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
export async function storeToken(token) {
    return storeNamedSecret("notion-token", token);
}
export async function resolveToken() {
    if (process.env.NOTION_TOKEN && process.env.NOTION_TOKEN.trim().length > 0) {
        return process.env.NOTION_TOKEN.trim();
    }
    return resolveNamedSecret("notion-token");
}
export async function storeApiKey(providerType, apiKey) {
    return storeNamedSecret(`ai-${providerType}-api-key`, apiKey);
}
export async function resolveApiKey(providerType) {
    return resolveNamedSecret(`ai-${providerType}-api-key`);
}
