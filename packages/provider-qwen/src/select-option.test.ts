import { describe, expect, it } from "vitest";
import type { AssetReader, ModelInput } from "@computer-harness/runtime";
import { Qwen38FlashAdapter, type QwenHttpClient } from "./index.js";

class Client implements QwenHttpClient {
  public body: Record<string, unknown> | undefined;

  public async post(_url: string, body: Record<string, unknown>, _headers: Readonly<Record<string, string>>, signal: AbortSignal): Promise<unknown> {
    signal.throwIfAborted();
    this.body = body;
    return {
      choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ calls: [{ id: "qwen-select", name: "select_option", arguments: { elementRef: "dom-1", optionText: "08:00" } }] }) } }],
    };
  }
}

const reader: AssetReader = { async read(_ref, signal) { signal.throwIfAborted(); return new Uint8Array([1]); } };

const input: ModelInput = {
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

describe("Qwen select_option schema", () => {
  it("projects the strict shared tool name and bounded arguments", async () => {
    const client = new Client();
    const adapter = new Qwen38FlashAdapter({ apiKey: "key", assetReader: reader, httpClient: client, thinking: "disabled" });
    await expect(adapter.generate(input, { signal: new AbortController().signal })).resolves.toMatchObject({ type: "tool_calls", calls: [{ name: "select_option", arguments: { elementRef: "dom-1", optionText: "08:00" } }] });
    const responseFormat = client.body?.response_format as { json_schema?: { schema?: { properties?: { calls?: { items?: { properties?: { name?: { enum?: string[] } } } } } } } };
    expect(responseFormat.json_schema?.schema?.properties?.calls?.items?.properties?.name?.enum).toContain("select_option");
    expect(String((client.body?.messages as Array<Record<string, unknown>>)[0]?.content)).toContain("optionText");
    expect(String((client.body?.messages as Array<Record<string, unknown>>)[0]?.content)).toContain("copied exactly");
  });
});
