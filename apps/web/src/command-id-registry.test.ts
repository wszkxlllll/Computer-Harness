import { describe, expect, it } from "vitest";
import { ApiError } from "./types";
import { CommandIdRegistry, shouldClearAfterFailure } from "./command-id-registry";

describe("command ID retry safety", () => {
  it("reuses the same ID after an uncertain network result until completion", () => {
    let next = 0;
    const registry = new CommandIdRegistry(() => `command-${++next}`);
    expect(registry.forAction("pause")).toBe("command-1");
    expect(registry.forAction("pause")).toBe("command-1");
    registry.complete("pause");
    expect(registry.forAction("pause")).toBe("command-2");
  });

  it("keeps unrelated user actions on separate IDs", () => {
    let next = 0;
    const registry = new CommandIdRegistry(() => `command-${++next}`);
    expect(registry.forAction("approve:request-a")).not.toBe(registry.forAction("approve:request-b"));
  });

  it("retains IDs when a server or network failure may have an unknown outcome", () => {
    expect(shouldClearAfterFailure(new ApiError("offline", 0))).toBe(false);
    expect(shouldClearAfterFailure(new ApiError("service unavailable", 503))).toBe(false);
    expect(shouldClearAfterFailure(new ApiError("request is stale", 409))).toBe(true);
  });
});
