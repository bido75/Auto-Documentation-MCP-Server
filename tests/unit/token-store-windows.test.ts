import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const isWindows = process.platform === "win32";

describe("token-store Windows DPAPI", () => {
  it.skipIf(!isWindows)("stores and resolves token without BOM corruption", async () => {
    const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "auto-doc-token-"));
    const originalUserProfile = process.env.USERPROFILE;
    const originalHomeDrive = process.env.HOMEDRIVE;
    const originalHomePath = process.env.HOMEPATH;
    const originalNotionToken = process.env.NOTION_TOKEN;

    delete process.env.NOTION_TOKEN;
    process.env.USERPROFILE = tempHome;
    delete process.env.HOMEDRIVE;
    delete process.env.HOMEPATH;

    try {
      const modulePath = `../../src/installer/token-store.js?ts=${Date.now()}`;
      const tokenStore = await import(modulePath);
      const token = "ntn_test_token_roundtrip";

      const storage = await tokenStore.storeToken(token);
      expect(storage).toBe("dpapi-file");

      const raw = await fs.readFile(path.join(tempHome, ".auto-doc-mcp", "token.dpapi"), "utf8");
      expect(raw.charCodeAt(0)).not.toBe(0xfeff);

      const resolved = await tokenStore.resolveToken();
      expect(resolved).toBe(token);
    } finally {
      if (originalNotionToken === undefined) {
        delete process.env.NOTION_TOKEN;
      } else {
        process.env.NOTION_TOKEN = originalNotionToken;
      }

      if (originalUserProfile === undefined) {
        delete process.env.USERPROFILE;
      } else {
        process.env.USERPROFILE = originalUserProfile;
      }

      if (originalHomeDrive === undefined) {
        delete process.env.HOMEDRIVE;
      } else {
        process.env.HOMEDRIVE = originalHomeDrive;
      }

      if (originalHomePath === undefined) {
        delete process.env.HOMEPATH;
      } else {
        process.env.HOMEPATH = originalHomePath;
      }

      await fs.rm(tempHome, { recursive: true, force: true });
    }
  }, 90_000);
});