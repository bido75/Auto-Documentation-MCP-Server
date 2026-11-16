import { describe, expect, it, vi } from "vitest";
import { logMcpModeGuidance } from "../../src/index.js";

describe("stdio startup guidance", () => {
  it("explains the agent, hook, and runner activation paths", () => {
    const stderr = vi.spyOn(console, "error").mockImplementation(() => undefined);
    logMcpModeGuidance();
    const message = stderr.mock.calls.flat().join("\n");
    expect(message).toContain("run_autonomous_documentation_trigger");
    expect(message).toContain("--post-commit-hook");
    expect(message).toContain("npm run runner");
    stderr.mockRestore();
  });
});
