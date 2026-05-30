import { describe, expect, it } from "vitest";
import { createFixedWindowRateLimiter, createReplayProtector } from "../../src/http-bridge/server.js";

describe("webhook guards", () => {
  it("deduplicates delivery ids within ttl and expires them after ttl", () => {
    let nowValue = 1_000;
    const replay = createReplayProtector({
      ttlMs: 1_000,
      now: () => nowValue,
    });

    expect(replay.isReplay("github", "delivery_1")).toBe(false);
    expect(replay.isReplay("github", "delivery_1")).toBe(true);

    nowValue += 1_001;
    expect(replay.isReplay("github", "delivery_1")).toBe(false);
  });

  it("scopes replay ids per endpoint", () => {
    const replay = createReplayProtector();

    expect(replay.isReplay("github", "same_id")).toBe(false);
    expect(replay.isReplay("ai-session", "same_id")).toBe(false);
    expect(replay.isReplay("github", "same_id")).toBe(true);
  });

  it("applies fixed-window rate limiting with retry-after", () => {
    let nowValue = 10_000;
    const limiter = createFixedWindowRateLimiter({
      limit: 2,
      windowMs: 1_000,
      now: () => nowValue,
    });

    expect(limiter.check("github:127.0.0.1").allowed).toBe(true);
    expect(limiter.check("github:127.0.0.1").allowed).toBe(true);

    const blocked = limiter.check("github:127.0.0.1");
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);

    nowValue += 1_001;
    expect(limiter.check("github:127.0.0.1").allowed).toBe(true);
  });
});
