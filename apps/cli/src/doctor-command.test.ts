import { describe, expect, it, vi } from "vitest";
import type { CuaCapabilityReport } from "@computer-harness/app-runtime";
import { runCuaDoctor } from "./doctor-command.js";
import { resolveCliModel } from "./cli-model.js";

const report: CuaCapabilityReport = {
  schemaVersion: "cua-doctor-v1",
  backend: "cua-driver-daemon",
  declared: {
    sdkVersion: "0.22.2",
    expectedDriverContractVersion: "0.7.0",
    defaultObservation: "desktop",
    windowCapture: "not_integrated",
    tools: { windowDiscovery: "unknown", windowForeground: "unknown", windowCapture: "unknown" },
  },
  verified: {
    metadata: { status: "supported" },
    inventory: { status: "unknown", reasonCode: "transport" },
    session: { status: "unknown", reasonCode: "not_attempted" },
    health: { status: "unknown", reasonCode: "not_attempted" },
    permissions: { status: "unknown", reasonCode: "not_attempted" },
  },
  cleanup: { status: "unknown", reasonCode: "not_attempted" },
  status: "unknown",
};

describe("CLI CUA doctor command", () => {
  it("keeps the ordinary Run model requirement while allowing doctor-only placeholder state", () => {
    expect(() => resolveCliModel(undefined, false)).toThrow(/--model is required/iu);
    expect(resolveCliModel(undefined, true)).toBe("glm-5.3-flash");
    expect(resolveCliModel("qwen3.8-flash", false)).toBe("qwen3.8-flash");
  });

  it("has a real no-goal command seam while allowing tests to avoid native CUA", async () => {
    const runner = vi.fn(async () => report);
    await expect(runCuaDoctor({ socketPath: "fixture-socket", timeoutMs: 25 }, runner)).resolves.toBe(report);
    expect(runner).toHaveBeenCalledWith({ socketPath: "fixture-socket", timeoutMs: 25 });
  });
});
