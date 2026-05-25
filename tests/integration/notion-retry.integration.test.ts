import { describe, expect, it, vi } from "vitest";
import { withNotionRetry } from "../../src/lib/notion-retry.js";

describe("withNotionRetry", () => {
  it("retries Notion rate-limited responses with exponential backoff", async () => {
    let attempts = 0;
    const sleep = vi.fn(async () => undefined);

    const result = await withNotionRetry(
      async () => {
        attempts += 1;
        if (attempts < 3) {
          throw { code: "rate_limited", message: "Rate limit hit" };
        }

        return "ok";
      },
      { sleep },
    );

    expect(result).toBe("ok");
    expect(attempts).toBe(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenNthCalledWith(1, 2000);
    expect(sleep).toHaveBeenNthCalledWith(2, 4000);
  });

  it("normalizes Notion validation errors with property and attempted value", async () => {
    await expect(
      withNotionRetry(
        async () => {
          throw {
            code: "validation_error",
            status: 400,
            message:
              "body failed validation: body.properties['Publishing Mode'].select.name should be one of the available options",
          };
        },
        {
          operationName: "pages.create",
          payload: {
            properties: {
              "Publishing Mode": {
                select: { name: "Aggressive" },
              },
            },
          },
        },
      ),
    ).rejects.toThrow(/Notion validation error \(pages.create\): property='Publishing Mode'/);

    await expect(
      withNotionRetry(
        async () => {
          throw {
            code: "validation_error",
            status: 400,
            message:
              "body failed validation: body.properties['Publishing Mode'].select.name should be one of the available options",
          };
        },
        {
          operationName: "pages.create",
          payload: {
            properties: {
              "Publishing Mode": {
                select: { name: "Aggressive" },
              },
            },
          },
        },
      ),
    ).rejects.toThrow(/\"name\":\"Aggressive\"/);
  });
});
