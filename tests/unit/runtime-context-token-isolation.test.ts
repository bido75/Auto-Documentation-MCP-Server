import { describe, expect, it, vi } from "vitest";

const notionClientContext = vi.hoisted(() => ({
  auths: [] as Array<string | undefined>,
}));

vi.mock("@notionhq/client", () => ({
  Client: class {
    constructor(options: { auth?: string }) {
      notionClientContext.auths.push(options.auth);
    }
  },
}));

import { createNotionClient } from "../../src/lib/notion-client.js";
import { runWithRuntimeContext } from "../../src/lib/runtime-context.js";

function deferred() {
  let resolvePromise: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });

  return { promise, resolve: resolvePromise };
}

describe("runtime context token isolation", () => {
  it("does not mutate process.env while interleaved requests use their own Notion tokens", async () => {
    const previousToken = process.env.NOTION_TOKEN;
    process.env.NOTION_TOKEN = "base_env_token";
    notionClientContext.auths = [];
    const enteredA = deferred();
    const releaseA = deferred();
    const envDuringContexts: string[] = [];

    try {
      await Promise.all([
        runWithRuntimeContext({ notionToken: "token_a" }, async () => {
          createNotionClient();
          envDuringContexts.push(process.env.NOTION_TOKEN ?? "");
          enteredA.resolve();
          await releaseA.promise;
          createNotionClient();
          envDuringContexts.push(process.env.NOTION_TOKEN ?? "");
        }),
        runWithRuntimeContext({ notionToken: "token_b" }, async () => {
          await enteredA.promise;
          createNotionClient();
          envDuringContexts.push(process.env.NOTION_TOKEN ?? "");
          releaseA.resolve();
        }),
      ]);

      expect(envDuringContexts).toEqual(["base_env_token", "base_env_token", "base_env_token"]);
      expect(notionClientContext.auths).toEqual(["token_a", "token_b", "token_a"]);
      expect(process.env.NOTION_TOKEN).toBe("base_env_token");
    } finally {
      if (previousToken === undefined) {
        delete process.env.NOTION_TOKEN;
      } else {
        process.env.NOTION_TOKEN = previousToken;
      }
    }
  });
});
