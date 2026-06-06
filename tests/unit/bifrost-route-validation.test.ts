import { describe, expect, it } from "vitest";
import { validateBifrostRouteConfig } from "../../src/lib/bifrost-route-validation.js";

describe("validateBifrostRouteConfig", () => {
  it("passes for aligned bifrost gateway and openai-compatible /v1 endpoint", () => {
    process.env.BIFROST_ENDPOINT = "http://bifrost-gateway:8080";
    process.env.AI_PROVIDER_TYPE = "bifrost";
    process.env.AI_ENDPOINT = "http://bifrost-gateway:8080/v1";

    const result = validateBifrostRouteConfig();
    expect(result.valid).toBe(true);
    expect(result.warnings).toEqual([]);
  });

  it("warns when BIFROST_ENDPOINT includes route suffixes", () => {
    process.env.BIFROST_ENDPOINT = "http://bifrost-gateway:8080/v1";
    process.env.AI_PROVIDER_TYPE = "bifrost";
    process.env.AI_ENDPOINT = "http://bifrost-gateway:8080/v1";

    const result = validateBifrostRouteConfig();
    expect(result.valid).toBe(false);
    expect(result.warnings.join(" ")).toContain("BIFROST_ENDPOINT should be a gateway base URL");
  });

  it("warns when AI endpoint for bifrost providers is missing /v1", () => {
    process.env.BIFROST_ENDPOINT = "http://bifrost-gateway:8080";
    process.env.AI_PROVIDER_TYPE = "bifrost";
    process.env.AI_ENDPOINT = "http://bifrost-gateway:8080";

    const result = validateBifrostRouteConfig();
    expect(result.valid).toBe(false);
    expect(result.warnings.join(" ")).toContain("should end with /v1");
  });
});
