import { describe, expect, it } from "vitest";
import { getOptionalRuntimeConfig } from "../../src/config.js";
import { runWithRuntimeContext } from "../../src/lib/runtime-context.js";

describe("runtime config context", () => {
  it("prefers request-scoped notion token without mutating process env", async () => {
    const originalToken = process.env.NOTION_TOKEN;
    process.env.NOTION_TOKEN = "env_token";

    try {
      expect(getOptionalRuntimeConfig().notionToken).toBe("env_token");

      const scopedToken = await runWithRuntimeContext({ notionToken: "header_token" }, async () => {
        await Promise.resolve();
        return getOptionalRuntimeConfig().notionToken;
      });

      expect(scopedToken).toBe("header_token");
      expect(process.env.NOTION_TOKEN).toBe("env_token");
      expect(getOptionalRuntimeConfig().notionToken).toBe("env_token");
    } finally {
      if (originalToken === undefined) {
        delete process.env.NOTION_TOKEN;
      } else {
        process.env.NOTION_TOKEN = originalToken;
      }
    }
  });
});
