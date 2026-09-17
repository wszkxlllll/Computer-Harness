import { describe, expect, it } from "vitest";
import { providerToolNames, summarizeProviderResponse, summarizeStructuredContent } from "./provider-summary.js";

describe("provider summary extraction", () => {
  it("can be imported without starting the CLI or reading environment state", () => {
    expect(providerToolNames([
      { type: "function", function: { name: "click" } },
      { type: "function", function: { name: "type" } },
      { type: "not-a-tool" },
    ])).toEqual(["click", "type"]);
  });

  it("preserves the existing native response projection during extraction", () => {
    expect(summarizeProviderResponse({
      model: "glm-5.3-flash",
      choices: [{
        finish_reason: "tool_calls",
        message: {
          content: "",
          reasoning_content: "inspect target",
          tool_calls: [{ id: "native-1", type: "function", function: { name: "click", arguments: "{\"x\":10,\"y\":20}" } }],
        },
      }],
      usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
    })).toEqual({
      model: "glm-5.3-flash",
      finishReason: "tool_calls",
      contentLength: 0,
      reasoningContentLength: 14,
      toolCalls: [{ id: "native-1", type: "function", name: "click", arguments: "{\"x\":10,\"y\":20}" }],
      structuredContent: { json: false },
      usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
    });
  });

  it("preserves the existing structured-content projection for a flat calls envelope", () => {
    const flatContent = JSON.stringify({ calls: [{ id: "flat-1", name: "type", arguments: { text: "hello" } }] });
    expect(summarizeStructuredContent(flatContent)).toEqual({
      json: true,
      kind: null,
      id: null,
      name: null,
      arguments: null,
      textLength: 0,
    });
    expect(summarizeProviderResponse({ choices: [{ message: { content: flatContent } }] })).toMatchObject({ toolCalls: [] });
  });
});
