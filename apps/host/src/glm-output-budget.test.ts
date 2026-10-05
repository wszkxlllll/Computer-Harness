import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { glmReasoningEffort, parseGlmInputBudgets, parseGlmOutputBudget, readGlmThinking } from "./glm-output-budget.js";
import { createProvider } from "../../../packages/app-runtime/src/providers.js";

describe("Host GLM output budget", () => {
  it("uses explicit bounded text/wire input defaults and rejects inconsistent values", () => {
    expect(parseGlmInputBudgets()).toEqual({ contextMaxInputTokens: 16384, contextMaxWireInputTokens: 24576 });
    expect(parseGlmInputBudgets("24576", "32768")).toEqual({ contextMaxInputTokens: 24576, contextMaxWireInputTokens: 32768 });
    for (const [text, wire] of [["0", "24576"], ["1.5", "24576"], ["16384", "131073"], ["16384", "16000"], ["NaN", "24576"]]) expect(() => parseGlmInputBudgets(text, wire)).toThrow("GLM input budgets");
  });
  it.each([
    [undefined, "low"], ["", "low"], ["  ", "low"], ["low", "low"],
    ["high", "high"], ["max", "max"], ["enabled", "server_default"], ["disabled", "server_default"],
  ] as const)("passes Host thinking %s through the real factory to HTTP as %s", async (raw, expectedEffort) => {
    let wire: Record<string, unknown> | undefined;
    const thinking = readGlmThinking(raw);
    const provider = await createProvider({
      model: "glm-5.3-flash", credentials: { glmApiKey: "fixture-key" }, outputDir: "unused",
      assetReader: { async read() { return new Uint8Array(); } },
      config: { goal: "fixture", model: "glm-5.3-flash", computer: { kind: "osworld", bridgeUrl: "http://fixture.invalid" }, outputDir: "unused", maxSteps: 1, maxModelRequests: 1, planning: false, memory: "off", batching: "off", contextMode: "recent", contextMaxHistoryEvents: 32, riskProfile: "experiment", riskGuard: "off", riskModel: "off", riskMaxModelRequests: 1, riskTimeoutMs: 100, cleanupDeadlineMs: 100, glmThinking: thinking, glmMaxOutputTokens: parseGlmOutputBudget(), glmRequestTimeoutMs: 90000 },
      httpClients: { glm: { async post(_url, body) { wire = body; return { choices: [{ finish_reason: "stop", message: { content: "fixture complete" } }] }; } } },
    });
    await provider.generate({ system: "fixture", messages: [], tools: [] }, { signal: new AbortController().signal });
    expect(wire).toMatchObject({ thinking: { type: "enabled" }, max_tokens: 8192 });
    expect(glmReasoningEffort(thinking)).toBe(expectedEffort);
    if (expectedEffort === "server_default") expect(wire).not.toHaveProperty("reasoning_effort");
    else expect(wire?.reasoning_effort).toBe(expectedEffort);
  });

  it("fails fast on invalid environment values without echoing them", () => {
    expect(() => readGlmThinking("private-invalid-value")).toThrow("GLM_THINKING must be enabled, disabled, low, high, or max.");
  });
  it("wires the CLI parser result to config and the safe startup audit (source contract)", () => {
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    expect(source).toContain('parseGlmOutputBudget(one("--glm-max-output-tokens"))');
    expect(source).toContain("glmMaxOutputTokens: args.glmMaxOutputTokens");
    expect(source).toContain("max_tokens=${args.glmMaxOutputTokens} thinking=${config.glmThinking} reasoning_effort=${glmReasoningEffort(config.glmThinking)} maxInputTokens=${config.contextMaxInputTokens} maxWireInputTokens=${config.contextMaxWireInputTokens} requestTimeoutMs=90000");
    expect(source).toContain("parseGlmInputBudgets(process.env.GLM_MAX_INPUT_TOKENS, process.env.GLM_MAX_WIRE_INPUT_TOKENS)");
    expect(source).toContain("glmThinking: readGlmThinking(process.env.GLM_THINKING)");
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
