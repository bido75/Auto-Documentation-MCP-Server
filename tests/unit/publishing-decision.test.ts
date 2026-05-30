import { describe, expect, it } from "vitest";
import { decidePublishingStatus } from "../../src/notion/manual-entry.js";

describe("decidePublishingStatus", () => {
  it("queues all entries in conservative mode", () => {
    expect(decidePublishingStatus({ mode: "Conservative", score: 100, threshold: 90 })).toEqual({
      status: "Needs Review",
      decision: "Queued Review",
    });
  });

  it("publishes high confidence entries in balanced mode", () => {
    expect(decidePublishingStatus({ mode: "Balanced", score: 92, threshold: 90 })).toEqual({
      status: "Published",
      decision: "Agent Published",
    });
  });

  it("captures low confidence entries in balanced mode", () => {
    expect(decidePublishingStatus({ mode: "Balanced", score: 55, threshold: 90 })).toEqual({
      status: "Captured",
      decision: "Queued Review",
    });
  });

  it("forces queued review when dedupe policy requests human verification", () => {
    expect(
      decidePublishingStatus({
        mode: "Fully Automatic",
        score: 70,
        threshold: 90,
        forceQueueReview: true,
      }),
    ).toEqual({
      status: "Needs Review",
      decision: "Queued Review",
    });
  });
});
