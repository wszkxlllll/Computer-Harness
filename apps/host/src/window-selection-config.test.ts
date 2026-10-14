import { describe, expect, it } from "vitest";
import { resolveHostWindowSelector } from "./window-selection-config.js";

describe("Host window-selection configuration", () => {
  it("keeps local selection as the default", () => {
    expect(resolveHostWindowSelector({})).toBeUndefined();
    expect(resolveHostWindowSelector({ HARNESS_WINDOW_SELECTOR: "local" })).toBeUndefined();
  });

  it("requires explicit Jev opt-in and the TypeSafe key", () => {
    expect(() => resolveHostWindowSelector({ HARNESS_WINDOW_SELECTOR: "jev" })).toThrow("requires TYPESAFE_API_KEY");
    expect(() => resolveHostWindowSelector({ HARNESS_WINDOW_SELECTOR: "other" })).toThrow("must be local or jev");
    expect(resolveHostWindowSelector({ HARNESS_WINDOW_SELECTOR: "jev", TYPESAFE_API_KEY: "test-key" })).toBeDefined();
  });
});
