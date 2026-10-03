import type { ToolCallId } from "@computer-harness/protocol";
import { describe, expect, it } from "vitest";
import type { ModelToolSpec } from "./contracts.js";
import { decorateToolsWithActionEffects, encodeToolCallArguments, splitActionEffectArguments } from "./action-effect-projection.js";

const click: ModelToolSpec = {
  name: "click",
  description: "click",
  category: "computer",
  inputSchema: { type: "object", properties: { x: { type: "number" }, y: { type: "number" } }, required: ["x", "y"], additionalProperties: false },
};
const switchWindow: ModelToolSpec = {
  name: "switch_window",
  description: "switch to a listed window",
  category: "computer",
  inputSchema: {
    type: "object",
    properties: { windowRef: { type: "string" } },
    required: ["windowRef"],
    additionalProperties: false,
  },
};

describe("action effect projection", () => {
  it("decorates only Computer schemas and separates metadata from execution arguments", () => {
    const side: ModelToolSpec = { name: "read", description: "read", category: "side", inputSchema: { type: "object", properties: {} } };
    const tools = decorateToolsWithActionEffects([click, side]);
    expect(tools[0]?.inputSchema).toMatchObject({ required: ["x", "y", "_harnessEffect"], properties: { _harnessEffect: { type: "object" } } });
    expect(tools[1]).toEqual(side);
    const separated = splitActionEffectArguments(tools[0], { x: 1, y: 2, _harnessEffect: { effects: ["navigate"], target: "Details", summary: "Open details" } });
    expect(separated).toEqual({ arguments: { x: 1, y: 2 }, declaredEffect: { effects: ["navigate"], target: "Details", summary: "Open details" } });
    expect(encodeToolCallArguments(tools[0], { id: "call-1" as ToolCallId, name: "click", arguments: separated.arguments, declaredEffect: separated.declaredEffect })).toEqual({ x: 1, y: 2, _harnessEffect: separated.declaredEffect });
  });

  it("rejects missing, unknown, or oversized declarations", () => {
    const tool = decorateToolsWithActionEffects([click])[0];
    expect(() => splitActionEffectArguments(tool, { x: 1, y: 2 })).toThrow(/_harnessEffect/);
    expect(() => splitActionEffectArguments(tool, { x: 1, y: 2, _harnessEffect: { effects: ["safe"], target: "x", summary: "x" } })).toThrow(/unknown effect/);
    expect(() => splitActionEffectArguments(tool, { x: 1, y: 2, _harnessEffect: { effects: ["navigate"], target: "x".repeat(121), summary: "x" } })).toThrow(/1-120/);
    expect(() => splitActionEffectArguments(tool, { x: 1, y: 2, _harnessEffect: { effects: ["navigate", "navigate"], target: "x", summary: "x" } })).toThrow(/unique/);
    expect(() => splitActionEffectArguments(tool, { x: 1, y: 2, _harnessEffect: { effects: ["navigate"], target: "x", summary: "x", approved: true } })).toThrow(/unsupported/);
    expect(() => splitActionEffectArguments(tool, { x: 1, y: 2, _harnessEffect: { effects: ["local_edit"], target: "Password", summary: "password=do-not-log-this-value" } })).toThrow(/must not contain/);
  });

  it("does not require or re-encode a model effect declaration for switch_window", () => {
    const tool = decorateToolsWithActionEffects([switchWindow])[0]!;
    expect(tool.inputSchema).not.toMatchObject({ required: expect.arrayContaining(["_harnessEffect"]) });
    expect(tool.inputSchema).not.toMatchObject({ properties: expect.objectContaining({ _harnessEffect: expect.anything() }) });
    const separated = splitActionEffectArguments(tool, { windowRef: "opaque-listed-ref" });
    expect(separated).toEqual({ arguments: { windowRef: "opaque-listed-ref" } });
    expect(encodeToolCallArguments(tool, {
      id: "switch-call" as ToolCallId,
      name: "switch_window",
      arguments: { windowRef: "opaque-listed-ref" },
      declaredEffect: { effects: ["financial"], target: "Submit payment", summary: "Send a password" },
    })).toEqual({ windowRef: "opaque-listed-ref" });
  });
});
