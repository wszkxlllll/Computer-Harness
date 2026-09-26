import { describe, expect, it } from "vitest";
import { resolveTuiGrounding } from "./window-grounding-policy.js";

describe("TUI window grounding policy", () => {
  it("uses UIA for a selected native window, including an ordinary browser", () => {
    expect(resolveTuiGrounding("auto", "host-window")).toBe("uia-catalog-v1");
  });

  it("uses DOM plus UIA only for a Harness-owned managed browser", () => {
    expect(resolveTuiGrounding("auto", "managed-browser")).toBe("hybrid-catalog-v1");
  });

  it("does not enable grounding for the whole desktop", () => {
    expect(resolveTuiGrounding("auto", "desktop")).toBe("off");
  });

  it("preserves explicit off and explicit modes", () => {
    expect(resolveTuiGrounding("off", "managed-browser")).toBe("off");
    expect(resolveTuiGrounding("dom-catalog-v1", "desktop")).toBe("dom-catalog-v1");
  });
});
