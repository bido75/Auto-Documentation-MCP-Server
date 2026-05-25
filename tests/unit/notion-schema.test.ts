import { describe, expect, it } from "vitest";
import { projectDatabaseSchema } from "../../src/lib/notion-schema.js";

describe("projectDatabaseSchema", () => {
  it("includes publishing mode and threshold", () => {
    const schema = projectDatabaseSchema();
    expect(schema["Publishing Mode"]).toMatchObject({ select: expect.any(Object) });
    expect(schema["Auto Publish Threshold"]).toEqual({ number: { format: "number" } });
  });
});
