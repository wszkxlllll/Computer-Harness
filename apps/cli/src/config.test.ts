import { describe, expect, it } from "vitest";
import { resolveRiskConfig } from "./config.js";

describe("resolved CLI risk profiles", () => {
  it("defaults non-interactive runs to an experiment profile with Guard off", () => {
    expect(resolveRiskConfig()).toEqual({ profile: "experiment", riskGuard: "off" });
    expect(resolveRiskConfig({ profile: "fixture", riskGuard: "off" })).toEqual({ profile: "experiment", riskGuard: "off" });
    expect(resolveRiskConfig({ profile: "evaluation", riskGuard: "layered" })).toEqual({ profile: "experiment", riskGuard: "layered" });
  });

  it("defaults interactive runs to layered protection and requires confirmation to disable it", () => {
    expect(resolveRiskConfig({ tui: true })).toEqual({ profile: "live-interactive", riskGuard: "layered" });
    expect(resolveRiskConfig({ interactive: true })).toEqual({ profile: "live-interactive", riskGuard: "layered" });
    expect(() => resolveRiskConfig({ profile: "live-interactive", riskGuard: "off" })).toThrow(/confirm-risk-guard-off/iu);
    expect(resolveRiskConfig({ profile: "live-interactive", riskGuard: "off", confirmRiskGuardOff: true })).toEqual({ profile: "live-interactive", riskGuard: "off" });
    expect(() => resolveRiskConfig({ tui: true, profile: "experiment", riskGuard: "off" })).toThrow(/confirm-risk-guard-off/iu);
    expect(resolveRiskConfig({ profile: "experiment", riskGuard: "off" })).toEqual({ profile: "experiment", riskGuard: "off" });
  });

  it("keeps explicit experiment Guard choices and rejects invalid profile/mode values", () => {
    expect(resolveRiskConfig({ profile: "experiment", riskGuard: "layered" })).toEqual({ profile: "experiment", riskGuard: "layered" });
    expect(() => resolveRiskConfig({ profile: "unknown" })).toThrow(/profile/iu);
    expect(() => resolveRiskConfig({ riskGuard: "unknown" })).toThrow(/risk-guard/iu);
  });
});
