import { describe, expect, it } from "vitest";
import { assertProductionSecretConfig, getRuntimeConfig, ProductionSecretConfigError } from "../../src/config.js";

function envWith(value: string | undefined, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "production",
    NOTION_TOKEN: "test_token",
    ...extra,
    ...(value === undefined ? {} : { STATE_ENCRYPTION_KEY: value }),
  };
}

describe("enforce-production-secret-config", () => {
  it("fails production startup when STATE_ENCRYPTION_KEY is missing", () => {
    expect(() => assertProductionSecretConfig(envWith(undefined))).toThrow(ProductionSecretConfigError);
    expect(() => getRuntimeConfig(envWith(undefined))).toThrow(/STATE_ENCRYPTION_KEY/);
  });

  it("fails production startup when STATE_ENCRYPTION_KEY is a known default or placeholder", () => {
    for (const key of [
      "auto-doc-mcp-default-dev-key-change-me",
      "change-this-for-self-hosted",
      "change-this-to-a-random-32-char-string-in-production",
    ]) {
      expect(() => assertProductionSecretConfig(envWith(key))).toThrow(/unique high-entropy/);
    }
  });

  it("passes production startup when STATE_ENCRYPTION_KEY is unique", () => {
    expect(() => assertProductionSecretConfig(envWith("prod-test-key-0123456789abcdef-prod-test-key"))).not.toThrow();
  });

  it("preserves development ergonomics for missing/default keys", () => {
    expect(() =>
      assertProductionSecretConfig({
        NODE_ENV: "development",
        STATE_ENCRYPTION_KEY: "auto-doc-mcp-default-dev-key-change-me",
      } as NodeJS.ProcessEnv),
    ).not.toThrow();
  });
});
