import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { parseGlmInputBudgets, parseGlmOutputBudget, readGlmThinking } from "./glm-output-budget.js";

describe("Host GLM output budget", () => {
  it("wires the CLI parser result to config and the safe startup audit (source contract)", () => {
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    expect(source).toContain('parseGlmOutputBudget(one("--glm-max-output-tokens"))');
    expect(source).toContain("glmMaxOutputTokens: args.glmMaxOutputTokens");
    expect(source).toContain("max_tokens=${args.glmMaxOutputTokens} thinking=${config.glmThinking} reasoning_effort=${glmReasoningEffort(config.glmThinking)} maxInputTokens=${config.contextMaxInputTokens} maxWireInputTokens=${config.contextMaxWireInputTokens} requestTimeoutMs=90000");
    expect(source).toContain("parseGlmInputBudgets(process.env.GLM_MAX_INPUT_TOKENS, process.env.GLM_MAX_WIRE_INPUT_TOKENS)");
  });
  it("uses bounded dual input defaults and validates explicit overrides", () => {
    expect(parseGlmInputBudgets()).toEqual({ contextMaxInputTokens: 16384, contextMaxWireInputTokens: 24576 });
    expect(parseGlmInputBudgets("8000", "12096")).toEqual({ contextMaxInputTokens: 8000, contextMaxWireInputTokens: 12096 });
    for (const [text, wire] of [["0", "24576"], ["1.5", "24576"], ["16384", "131073"], ["16384", "16000"], ["NaN", "24576"]]) {
      expect(() => parseGlmInputBudgets(text, wire)).toThrow(/GLM input budgets/u);
    }
  });
  it("keeps the existing enabled thinking default and rejects malformed overrides", () => {
    expect(readGlmThinking(undefined)).toBe("enabled");
    expect(readGlmThinking("low")).toBe("low");
    expect(() => readGlmThinking("private-invalid")).toThrow(/GLM_THINKING/u);
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
