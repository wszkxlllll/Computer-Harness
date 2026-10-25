import { describe, expect, it } from "vitest";
import { decorateToolsWithActionEffects, groundingComputerTools, HARNESS_EFFECT_KEY, ToolRegistry, type AssetReader, type ModelInput } from "@computer-harness/runtime";
import { GlmAdapter, type GlmHttpClient } from "./index.js";

class Client implements GlmHttpClient {
  public body: Record<string, unknown> | undefined;
  public postCount = 0;
  public constructor(private readonly argumentsValue: unknown = { elementRef: "dom-1", optionText: "08:00" }) {}

  public async post(_url: string, body: Record<string, unknown>, _headers: Readonly<Record<string, string>>, signal: AbortSignal): Promise<unknown> {
    signal.throwIfAborted();
    this.postCount += 1;
    this.body = body;
    return {
      choices: [{
        finish_reason: "tool_calls",
        message: {
          content: "",
          tool_calls: [{ id: "glm-select", function: { name: "select_option", arguments: JSON.stringify(this.argumentsValue) } }],
        },
      }],
    };
  }
}

const reader: AssetReader = { async read(_ref, signal) { signal.throwIfAborted(); return new Uint8Array([1]); } };

function input(): ModelInput {
  return {
    system: "system",
    messages: [{ role: "user", content: [{ type: "text", text: "choose" }] }],
    tools: [{
      name: "select_option",
      description: "Select optionText copied exactly from the current observation's native-select options list; never guess.",
      category: "computer",
      inputSchema: {
        type: "object",
        properties: {
          elementRef: { type: "string", minLength: 1, maxLength: 96 },
          optionText: { type: "string", minLength: 1, maxLength: 160 },
        },
        required: ["elementRef", "optionText"],
        additionalProperties: false,
      },
    }],
  };
}

function registryInput(layered = true): { input: ModelInput; registry: ToolRegistry } {
  const registry = new ToolRegistry();
  registry.registerMany(groundingComputerTools({ includeSelectOption: true }));
  const tools = registry.modelTools();
  return { input: { ...input(), tools: layered ? decorateToolsWithActionEffects(tools) : tools }, registry };
}

function adapter(client: Client): GlmAdapter {
  return new GlmAdapter({ apiKey: "key", profile: { name: "test", thinking: "disabled", coordinateMode: "actual_pixels" }, assetReader: reader, httpClient: client });
}

function projectedTool(client: Client, name = "select_option"): Record<string, unknown> {
  const tool = (client.body?.tools as Array<{ function: Record<string, unknown> }>).find((entry) => entry.function.name === name);
  if (tool === undefined) throw new Error(`missing fixture tool ${name}`);
  return tool.function;
}

describe("GLM select_option schema", () => {
  it("projects the ToolRegistry-shaped observation-bound arguments", async () => {
    const client = new Client();
    const adapter = new GlmAdapter({ apiKey: "key", profile: { name: "test", thinking: "disabled", coordinateMode: "actual_pixels" }, assetReader: reader, httpClient: client });
    await expect(adapter.generate(input(), { signal: new AbortController().signal })).resolves.toMatchObject({ type: "tool_calls", calls: [{ name: "select_option", arguments: { elementRef: "dom-1", optionText: "08:00" } }] });
    const functionTool = (client.body?.tools as Array<Record<string, unknown>>)[0]?.function as Record<string, unknown>;
    expect(functionTool.name).toBe("select_option");
    expect(functionTool.description).toEqual(expect.stringContaining("copied exactly"));
    expect(functionTool.description).toBe(input().tools[0]!.description);
    expect(functionTool.parameters).toMatchObject({ required: ["elementRef", "optionText"], additionalProperties: false, properties: { elementRef: { maxLength: 96 }, optionText: { minLength: 1, maxLength: 160 } } });
  });

  it.each(["navigate", "unknown", "external_commitment"] as const)("projects the real layered registry, separates %s metadata, and restores it in history", async (effect) => {
    const fixture = registryInput();
    const declaredEffect = { effects: [effect], target: "Observed native select", summary: "Apply the observed option with its immediate effect" };
    const args = { elementRef: "dom-1", optionText: "08:00", [HARNESS_EFFECT_KEY]: declaredEffect };
    const client = new Client(args);
    const turn = await adapter(client).generate(fixture.input, { signal: new AbortController().signal });
    expect(turn.type).toBe("tool_calls");
    if (turn.type !== "tool_calls") throw new Error("fixture did not return its select call");
    const call = turn.calls[0]!;
    expect(call.arguments).toEqual({ elementRef: "dom-1", optionText: "08:00" });
    expect(call.arguments).not.toHaveProperty(HARNESS_EFFECT_KEY);
    expect(call.declaredEffect).toEqual(declaredEffect);
    // These are the actual Runtime tool definitions, not a duplicated schema.
    // Their pure validation receives only the canonical business arguments.
    expect(() => fixture.registry.get("select_option")!.validate(call.arguments)).not.toThrow();
    expect(client.postCount).toBe(1);
    for (const name of ["click_element", "select_option"]) {
      const wire = projectedTool(client, name);
      expect(wire.description).toEqual(expect.stringContaining(`Include required ${HARNESS_EFFECT_KEY} in this call's JSON arguments`));
      expect(wire.description).toEqual(expect.stringContaining("effects (non-empty array of schema-listed effects), target (non-empty string) and summary (non-empty string)"));
      expect(wire.description).toEqual(expect.stringContaining("actual immediate consequences honestly; use unknown when uncertain"));
      expect(wire.description).toEqual(expect.stringContaining("Never omit these fields or assume approval"));
    }
    expect(projectedTool(client).parameters).toMatchObject({
      required: ["elementRef", "optionText", HARNESS_EFFECT_KEY], additionalProperties: false,
      properties: { [HARNESS_EFFECT_KEY]: { type: "object", required: ["effects", "target", "summary"], additionalProperties: false } },
    });
    const historyClient = new Client(args);
    await adapter(historyClient).generate({
      ...fixture.input,
      messages: [...fixture.input.messages, { role: "assistant", content: [{ type: "tool_call", call }] }],
    }, { signal: new AbortController().signal });
    const messages = historyClient.body?.messages as Array<{ role: string; tool_calls?: Array<{ function: { name: string; arguments: string } }> }>;
    const replayed = messages.find((message) => message.role === "assistant")?.tool_calls?.[0];
    expect(replayed?.function.name).toBe("select_option");
    expect(JSON.parse(replayed!.function.arguments)).toEqual(args);
  });

  it.each([
    undefined,
    null,
    {},
    { effects: [], target: "Select", summary: "Choose" },
    { effects: ["safe"], target: "Select", summary: "Choose" },
    { effects: ["navigate"], target: "", summary: "Choose" },
    { effects: ["navigate"], target: "Select" },
    { effects: ["navigate"], target: "Select", summary: "Choose", approved: true },
  ])("continues to reject missing or invalid layered metadata: %j", async (metadata) => {
    const fixture = registryInput();
    const args = { elementRef: "dom-1", optionText: "08:00", ...(metadata === undefined ? {} : { [HARNESS_EFFECT_KEY]: metadata }) };
    const client = new Client(args);
    // Only an in-memory HTTP fixture is present. A rejection produces no
    // ModelTurn for Runtime/Computer dispatch and performs no repair/retry.
    await expect(adapter(client).generate(fixture.input, { signal: new AbortController().signal }))
      .rejects.toMatchObject({ code: "GLM_INVALID_TOOL_CALL" });
    expect(client.postCount).toBe(1);
  });

  it("preserves unlayered registry descriptions and legacy select arguments", async () => {
    const fixture = registryInput(false);
    const client = new Client();
    await expect(adapter(client).generate(fixture.input, { signal: new AbortController().signal }))
      .resolves.toMatchObject({ type: "tool_calls", calls: [{ arguments: { elementRef: "dom-1", optionText: "08:00" } }] });
    for (const tool of fixture.input.tools) expect(projectedTool(client, tool.name).description).toBe(tool.description);
    expect(projectedTool(client).parameters).toMatchObject({ required: ["elementRef", "optionText"] });
    expect(projectedTool(client).description).not.toEqual(expect.stringContaining("Include required _harnessEffect"));
  });

  it("does not infer a required metadata hint from an optional schema property", async () => {
    const fixture = registryInput();
    const schema = fixture.input.tools.find((tool) => tool.name === "select_option")!.inputSchema;
    if (schema === null || typeof schema !== "object" || Array.isArray(schema)) throw new Error("fixture schema is not an object");
    schema.required = ["elementRef", "optionText"];
    const client = new Client({ elementRef: "dom-1", optionText: "08:00", [HARNESS_EFFECT_KEY]: { effects: ["unknown"], target: "Select", summary: "Uncertain immediate consequences" } });
    await adapter(client).generate(fixture.input, { signal: new AbortController().signal });
    expect(projectedTool(client).description).toBe(fixture.registry.get("select_option")!.description);
  });
});
