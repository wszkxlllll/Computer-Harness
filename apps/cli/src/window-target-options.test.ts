import { describe, expect, it } from "vitest";
import { resolveCuaWindowTargetOptions } from "./window-target-options.js";

describe("CLI CUA window target options", () => {
  it("requires PID and window id as a pair", () => {
    expect(() => resolveCuaWindowTargetOptions({ pid: "12", computer: "cua", doctor: false })).toThrow(/provided together/iu);
  });

  it("rejects window flags for OSWorld and doctor", () => {
    expect(() => resolveCuaWindowTargetOptions({ pid: "12", windowId: "34", computer: "osworld", doctor: false })).toThrow(/require --computer cua/iu);
    expect(() => resolveCuaWindowTargetOptions({ pid: "12", windowId: "34", computer: "cua", doctor: true })).toThrow(/doctor does not accept/iu);
  });

  it("rejects zero, unsafe, and non-numeric identities", () => {
    expect(() => resolveCuaWindowTargetOptions({ pid: "0", windowId: "34", computer: "cua", doctor: false })).toThrow(/positive safe integer/iu);
    expect(() => resolveCuaWindowTargetOptions({ pid: "9007199254740992", windowId: "34", computer: "cua", doctor: false })).toThrow(/positive safe integer/iu);
    expect(() => resolveCuaWindowTargetOptions({ pid: "not-a-number", windowId: "34", computer: "cua", doctor: false })).toThrow(/positive safe integer/iu);
  });

  it("returns a JSON-safe explicit host target", () => {
    expect(resolveCuaWindowTargetOptions({ pid: "1234", windowId: "5678", computer: "cua", doctor: false })).toEqual({ pid: 1234, windowId: 5678 });
    expect(resolveCuaWindowTargetOptions({ computer: "cua", doctor: false })).toBeUndefined();
  });
});
