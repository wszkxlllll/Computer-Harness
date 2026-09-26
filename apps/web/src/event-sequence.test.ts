import { describe, expect, it } from "vitest";
import { reconnectCursor, decideSequence } from "./event-sequence";
import { runEventsUrl } from "./api";

describe("event sequence recovery", () => {
  it("ignores duplicates, accepts the next event, and requests a snapshot on gaps", () => {
    expect(decideSequence(8, 8)).toBe("duplicate");
    expect(decideSequence(8, 7)).toBe("duplicate");
    expect(decideSequence(8, 9)).toBe("next");
    expect(decideSequence(8, 11)).toBe("gap");
  });

  it("uses the refreshed snapshot watermark when reopening the feed", () => {
    const sequence = reconnectCursor(43);
    expect(runEventsUrl("run one", sequence)).toBe("/api/runs/run%20one/events?after=43");
  });

  it("falls back to the start if the server snapshot has an invalid sequence", () => {
    expect(reconnectCursor(Number.NaN)).toBe(0);
    expect(reconnectCursor(-1)).toBe(0);
  });
});
