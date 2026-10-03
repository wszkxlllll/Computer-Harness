import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { parseGlmOutputBudget } from "./glm-output-budget.js";

describe("Host GLM output budget", () => {
  it("wires the CLI parser result to config and the safe startup audit (source contract)", () => {
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    expect(source).toContain('parseGlmOutputBudget(one("--glm-max-output-tokens"))');
    expect(source).toContain("glmMaxOutputTokens: args.glmMaxOutputTokens");
    expect(source).toContain("max_tokens=${args.glmMaxOutputTokens} thinking=${config.glmThinking} requestTimeoutMs=90000");
  });
  it("uses the bounded 8192 default and accepts explicit supported overrides", () => {
    expect(parseGlmOutputBudget()).toBe(8192);
    expect(parseGlmOutputBudget("16384")).toBe(16384);
    expect(parseGlmOutputBudget("131072")).toBe(131072);
  });
  it.each(["0", "-1", "1.5", "NaN", "Infinity", "131073", "9007199254740992", ""])("rejects invalid option %s", (value) => {
    expect(() => parseGlmOutputBudget(value)).toThrow(/--glm-max-output-tokens/u);
  });
});
