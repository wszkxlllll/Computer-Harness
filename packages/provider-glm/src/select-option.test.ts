import { describe, expect, it } from "vitest";
import type { AssetReader, ModelInput } from "@computer-harness/runtime";
import { GlmAdapter, type GlmHttpClient } from "./index.js";

class Client implements GlmHttpClient {
  public body: Record<string, unknown> | undefined;

  public async post(_url: string, body: Record<string, unknown>, _headers: Readonly<Record<string, string>>, signal: AbortSignal): Promise<unknown> {
    signal.throwIfAborted();
    this.body = body;
    return {
      choices: [{
        finish_reason: "tool_calls",
        message: {
          content: "",
          tool_calls: [{ id: "glm-select", function: { name: "select_option", arguments: JSON.stringify({ elementRef: "dom-1", optionText: "08:00" }) } }],
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

describe("GLM select_option schema", () => {
  it("projects the ToolRegistry-shaped observation-bound arguments", async () => {
    const client = new Client();
    const adapter = new GlmAdapter({ apiKey: "key", profile: { name: "test", thinking: "disabled", coordinateMode: "actual_pixels" }, assetReader: reader, httpClient: client });
    await expect(adapter.generate(input(), { signal: new AbortController().signal })).resolves.toMatchObject({ type: "tool_calls", calls: [{ name: "select_option", arguments: { elementRef: "dom-1", optionText: "08:00" } }] });
    const functionTool = (client.body?.tools as Array<Record<string, unknown>>)[0]?.function as Record<string, unknown>;
    expect(functionTool.name).toBe("select_option");
    expect(functionTool.description).toEqual(expect.stringContaining("copied exactly"));
    expect(functionTool.parameters).toMatchObject({ required: ["elementRef", "optionText"], additionalProperties: false, properties: { elementRef: { maxLength: 96 }, optionText: { minLength: 1, maxLength: 160 } } });
  });
});
