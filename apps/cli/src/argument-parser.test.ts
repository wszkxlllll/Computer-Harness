import { describe, expect, it } from "vitest";
import { validateCliArguments } from "./argument-parser.js";

describe("CLI argument validation", () => {
  it("accepts the pnpm separator, flags, aliases, and value options", () => {
    expect(validateCliArguments([
      "--",
      "--goal",
      "observe the screen",
      "--model",
      "glm-5.3-flash",
      "--computer",
      "cua",
      "--socket",
      "private.sock",
      "--planning",
      "--window-switch",
      "--tui",
      "--help",
    ])).toEqual([
      "--goal",
      "observe the screen",
      "--model",
      "glm-5.3-flash",
      "--computer",
      "cua",
      "--socket",
      "private.sock",
      "--planning",
      "--window-switch",
      "--tui",
      "--help",
    ]);
  });

  it("rejects removed Jev options and arbitrary positional arguments", () => {
    expect(() => validateCliArguments(["--jev-mode", "shadow"])).toThrow(/unknown option/iu);
    expect(() => validateCliArguments(["--jev-policy", "active"])).toThrow(/unknown option/iu);
    expect(() => validateCliArguments(["--confirm-jev-data-sharing"])).toThrow(/unknown option/iu);
    expect(() => validateCliArguments(["--help", "--jev-mode", "shadow"])).toThrow(/unknown option/iu);
    expect(() => validateCliArguments(["unexpected-positional"])).toThrow(/unknown option or positional argument/iu);
  });

  it("rejects a value option without its value", () => {
    expect(() => validateCliArguments(["--goal"])).toThrow(/--goal requires a value/iu);
    expect(() => validateCliArguments(["--model", "--tui"])).toThrow(/--model requires a value/iu);
  });
});
