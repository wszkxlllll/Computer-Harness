import { describe, expect, it, vi } from "vitest";
import type { AssetId, ToolCallId, Viewport } from "@computer-harness/protocol";
import { decorateToolsWithActionEffects, type AssetReader, type ModelInput } from "@computer-harness/runtime";
import { FetchGlmHttpClient, GlmAdapter, type GlmHttpClient, type GlmProfile } from "./index.js";

const viewport: Viewport = { width: 800, height: 600, coordinateSpace: "physical" };
const asset = { assetId: "asset-1" as AssetId, relativePath: "screenshots/asset-1.png", mediaType: "image/png", byteLength: 3 };
const normalizedProfile: GlmProfile = { name: "test-normalized", thinking: "disabled", coordinateMode: "normalized_1000" };

class Reader implements AssetReader {
  public constructor(private readonly bytes = new Uint8Array([1, 2, 3])) {}

  public async read(_ref: typeof asset, signal: AbortSignal): Promise<Uint8Array> {
    signal.throwIfAborted();
    return this.bytes;
  }
}

class Client implements GlmHttpClient {
  public body: Record<string, unknown> | undefined;
  public postCount = 0;
  public constructor(private readonly response: unknown) {}
  public async post(_url: string, body: Record<string, unknown>, _headers: Readonly<Record<string, string>>, signal: AbortSignal): Promise<unknown> {
    signal.throwIfAborted();
    this.postCount += 1;
    this.body = body;
    return this.response;
  }
}

function input(): ModelInput {
  return {
    system: "system",
    messages: [{ role: "user", content: [
      { type: "text", text: "click" },
      { type: "image", asset, viewport },
    ] }],
    tools: [{ name: "click", description: "click", category: "computer", coordinate: { fields: ["x", "y"] }, inputSchema: { type: "object" } }],
  };
}

function inputWithoutImage(): ModelInput {
  return {
    system: "system",
    messages: [{ role: "user", content: [{ type: "text", text: "click" }] }],
    tools: [{ name: "click", description: "click", category: "computer", coordinate: { fields: ["x", "y"] }, inputSchema: { type: "object" } }],
  };
}

function inputWithControls(): ModelInput {
  return {
    ...input(),
    tools: [
      ...input().tools,
      { name: "terminate", description: "finish", category: "control", control: "finish", inputSchema: { type: "object" } },
      { name: "interact", description: "ask", category: "control", control: "user_input_required", inputSchema: { type: "object" } },
    ],
  };
}

function dynamicInput(planAndMemory: string, dynamicViewport = viewport): ModelInput {
  return {
    ...input(),
    messages: [
      { role: "user", content: [{ type: "text", text: "stable user goal" }] },
      { role: "user", content: [{ type: "text", text: planAndMemory }, { type: "image", asset, viewport: dynamicViewport }] },
    ],
  };
}

describe("GLM provider adapter", () => {
  it("keeps prepared wire state private to the creating adapter", async () => {
    const client = new Client({ choices: [{ message: { content: "prepared" } }] });
    const adapter = new GlmAdapter({ apiKey: "key", profile: normalizedProfile, assetReader: new Reader(), httpClient: client });
    const signal = new AbortController().signal;
    const prepared = await adapter.prepare(input(), { signal });
    expect(prepared).toMatchObject({ providerId: "test-normalized", payloadHash: expect.any(String), estimate: { imageCount: 1, estimationMethod: "provider_projection" } });
    expect(prepared.estimate?.estimatedTextTokens).toBeGreaterThan(0);
    expect(Object.isFrozen(prepared)).toBe(true);
    await expect(adapter.generatePrepared(prepared, { signal })).resolves.toMatchObject({ type: "finish", summary: "prepared" });
    const postsBeforeAbort = client.postCount;
    const cancelled = new AbortController();
    cancelled.abort(new Error("cancelled before prepared send"));
    await expect(adapter.generatePrepared(prepared, { signal: cancelled.signal })).rejects.toThrow("cancelled before prepared send");
    expect(client.postCount).toBe(postsBeforeAbort);
    const forged = Object.freeze({ ...prepared });
    await expect(adapter.generatePrepared(forged, { signal })).rejects.toMatchObject({ code: "GLM_INVALID_PREPARED_REQUEST" });
  });

  it("uses an immutable input snapshot when parsing a prepared response", async () => {
    const client = new Client({ choices: [{ message: { content: "", tool_calls: [{ id: "snapshot-call", function: { name: "click", arguments: JSON.stringify({ x: 400, y: 300 }) } }] } }] });
    const adapter = new GlmAdapter({ apiKey: "key", profile: normalizedProfile, assetReader: new Reader(), httpClient: client });
    const mutableInput = input();
    const prepared = await adapter.prepare(mutableInput, { signal: new AbortController().signal });
    mutableInput.tools = [];
    mutableInput.messages = [];
    await expect(adapter.generatePrepared(prepared, { signal: new AbortController().signal })).resolves.toMatchObject({ type: "tool_calls", calls: [{ name: "click", arguments: { x: 320, y: 180 } }] });
  });

  it("keeps the stable wire prefix separate from dynamic history, images, and final payload identity", async () => {
    const capture = async (value: ModelInput, bytes = new Uint8Array([1, 2, 3]), profile: GlmProfile = normalizedProfile) => {
      const client = new Client({ choices: [{ message: { content: "done" } }] });
      const adapter = new GlmAdapter({ apiKey: "key", profile, assetReader: new Reader(bytes), httpClient: client });
      const prepared = await adapter.prepare(value, { signal: new AbortController().signal });
      await adapter.generatePrepared(prepared, { signal: new AbortController().signal });
      return { body: client.body!, prepared };
    };
    const first = await capture(dynamicInput("plan A / memory A"));
    const second = await capture(dynamicInput("plan B / memory B"), new Uint8Array([9, 8, 7, 6]));
    expect((first.body.messages as unknown[])[0]).toEqual((second.body.messages as unknown[])[0]);
    expect(first.body.tools).toEqual(second.body.tools);
    expect(first.body.messages).not.toEqual(second.body.messages);
    expect(first.prepared.payloadHash).not.toBe(second.prepared.payloadHash);
    expect(first.prepared.estimate?.imageCount).toBe(1);
    expect(first.prepared.estimate?.estimatedTextTokens).toBe(second.prepared.estimate?.estimatedTextTokens);

    const schemaInput = {
      ...dynamicInput("same plan"),
      tools: [{ ...input().tools[0]!, inputSchema: { type: "object", properties: { x: { type: "number" }, y: { type: "number" } }, required: ["x", "y"], additionalProperties: false } }],
    };
    const pixelProfile: GlmProfile = { name: "pixel-test", thinking: "disabled", coordinateMode: "actual_pixels" };
    const pixelA = await capture(schemaInput, new Uint8Array([1]), pixelProfile);
    const pixelB = await capture({ ...schemaInput, messages: [{ role: "user", content: [{ type: "image", asset, viewport: { width: 1024, height: 768, coordinateSpace: "physical" } }] }] }, new Uint8Array([1]), pixelProfile);
    expect(pixelA.body.tools).not.toEqual(pixelB.body.tools);
    expect(pixelA.prepared.payloadHash).not.toBe(pixelB.prepared.payloadHash);

    const continuationInput = {
      ...dynamicInput("continuation"),
      messages: [
        ...dynamicInput("continuation").messages,
        { role: "assistant" as const, content: [{ type: "provider_continuation" as const, continuation: { providerId: "test-normalized", kind: "reasoning_content" as const, content: "retain this reasoning" } }] },
      ],
    };
    const continuation = await capture(continuationInput);
    expect(continuation.prepared.estimate!.estimatedTextTokens).toBeGreaterThan(first.prepared.estimate!.estimatedTextTokens);
  });

  it("does not infer cache reads from an unverified GLM usage extension", async () => {
    const client = new Client({
      choices: [{ message: { content: "done" } }],
      usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12, prompt_tokens_details: { cached_tokens: 6 } },
    });
    const adapter = new GlmAdapter({ apiKey: "key", profile: normalizedProfile, assetReader: new Reader(), httpClient: client });
    const turn = await adapter.generate(input(), { signal: new AbortController().signal });
    expect(turn.usage).toEqual({ inputTokens: 10, outputTokens: 2, totalTokens: 12 });
  });

  it("round-trips action effects without leaking metadata into canonical arguments", async () => {
    const guarded = { ...input(), tools: decorateToolsWithActionEffects(input().tools) };
    const client = new Client({ choices: [{ message: { content: "", tool_calls: [{ id: "glm-effect", type: "function", function: { name: "click", arguments: JSON.stringify({ x: 500, y: 250, _harnessEffect: { effects: ["financial"], target: "Confirm payment", summary: "Pay for the order" } }) } }] } }] });
    const adapter = new GlmAdapter({ apiKey: "key", profile: normalizedProfile, assetReader: new Reader(), httpClient: client });
    await expect(adapter.generate(guarded, { signal: new AbortController().signal })).resolves.toMatchObject({ type: "tool_calls", calls: [{ arguments: { x: 400, y: 150 }, declaredEffect: { effects: ["financial"], target: "Confirm payment" } }] });
    expect(client.body?.tools).toMatchObject([{ function: { parameters: { required: expect.arrayContaining(["_harnessEffect"]), properties: { _harnessEffect: { type: "object" } } } } }]);
    const historyClient = new Client({ choices: [{ message: { content: "done" } }] });
    const historyInput: ModelInput = { ...guarded, messages: [...guarded.messages, { role: "assistant", content: [{ type: "tool_call", call: { id: "glm-effect" as ToolCallId, name: "click", arguments: { x: 400, y: 150 }, declaredEffect: { effects: ["financial"], target: "Confirm payment", summary: "Pay for the order" } }, viewport }] }] };
    await new GlmAdapter({ apiKey: "key", profile: normalizedProfile, assetReader: new Reader(), httpClient: historyClient }).generate(historyInput, { signal: new AbortController().signal });
    const historyMessages = historyClient.body?.messages as Array<Record<string, unknown>>;
    const historyCall = (historyMessages.find((message) => Array.isArray(message.tool_calls))?.tool_calls as Array<{ function: { arguments: string } }> | undefined)?.[0];
    expect(JSON.parse(historyCall?.function.arguments ?? "{}")).toMatchObject({ x: 500, y: 250, _harnessEffect: { effects: ["financial"] } });
  });
  it("reads images, sends canonical tools, and maps normalized coordinates", async () => {
    const client = new Client({ choices: [{ message: { content: "", tool_calls: [{ id: "glm-call", type: "function", function: { name: "click", arguments: JSON.stringify({ x: 500, y: 250 }) } }] } }] });
    const adapter = new GlmAdapter({ apiKey: "key", profile: normalizedProfile, assetReader: new Reader(), httpClient: client });
    const turn = await adapter.generate(input(), { signal: new AbortController().signal });
    expect(turn).toEqual({ type: "tool_calls", calls: [{ id: "glm-call", name: "click", arguments: { x: 400, y: 150 } }] });
    expect(client.body?.tools).toMatchObject([{ type: "function", function: { name: "click", description: "click Coordinates x,y are normalized numbers from 0 to 1000.", parameters: { type: "object", properties: { observationAssessment: { type: "object" } } } } }]);
    expect(client.body?.thinking).toEqual({ type: "disabled" });
    const messages = client.body?.messages as Array<Record<string, unknown>>;
    const userContent = messages[1]?.content as Array<Record<string, unknown>>;
    const imageBlock = userContent[1];
    expect((imageBlock?.image_url as { url?: string } | undefined)?.url).toMatch(/^data:image\/png;base64,/);
    expect(String((messages[0] as Record<string, unknown> | undefined)?.content)).toContain("normalized to 0..1000");
    expect(String((messages[0] as Record<string, unknown> | undefined)?.content)).not.toContain("Coordinates are pixels in the current image viewport");
  });

  it("rejects malformed, duplicate, and out-of-range provider output", async () => {
    const duplicate = new Client({ choices: [{ message: { tool_calls: [
      { id: "same", function: { name: "click", arguments: "{\"x\":1,\"y\":1}" } },
      { id: "same", function: { name: "click", arguments: "{\"x\":2,\"y\":2}" } },
    ] } }] });
    const adapter = new GlmAdapter({ apiKey: "key", profile: normalizedProfile, assetReader: new Reader(), httpClient: duplicate });
    await expect(adapter.generate(input(), { signal: new AbortController().signal })).rejects.toMatchObject({ code: "GLM_DUPLICATE_TOOL_CALL", retryable: true });
    const outOfRange = new Client({ choices: [{ message: { tool_calls: [{ id: "bad", function: { name: "click", arguments: "{\"x\":1001,\"y\":1}" } }] } }] });
    const second = new GlmAdapter({ apiKey: "key", profile: normalizedProfile, assetReader: new Reader(), httpClient: outOfRange });
    await expect(second.generate(input(), { signal: new AbortController().signal })).rejects.toThrow(/outside/);
  });

  it("rejects a function that was not offered in this run", async () => {
    const client = new Client({ choices: [{ message: { tool_calls: [{ id: "unknown", function: { name: "drag", arguments: "{}" } }] } }] });
    const adapter = new GlmAdapter({ apiKey: "key", profile: normalizedProfile, assetReader: new Reader(), httpClient: client });
    await expect(adapter.generate(input(), { signal: new AbortController().signal })).rejects.toMatchObject({ code: "GLM_UNAVAILABLE_TOOL" });
  });

  it("returns non-empty text as finish and honors abort before reading", async () => {
    const client = new Client({ choices: [{ message: { content: "finished" } }], usage: { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 } });
    const adapter = new GlmAdapter({ apiKey: "key", profile: "glm-5.3-flash", assetReader: new Reader(), httpClient: client });
    expect(await adapter.generate(input(), { signal: new AbortController().signal })).toEqual({ type: "finish", summary: "finished", usage: { inputTokens: 7, outputTokens: 2, totalTokens: 9 } });
    expect(client.body?.thinking).toEqual({ type: "enabled" });
    const messages = client.body?.messages as Array<Record<string, unknown>>;
    expect(String((messages[0] as Record<string, unknown> | undefined)?.content)).toContain("Coordinates are pixels");
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    await expect(adapter.generate(input(), { signal: controller.signal })).rejects.toThrow("cancelled");
  });

  it("sends forced thinking with an explicit GLM-5.3 reasoning effort", async () => {
    const client = new Client({ choices: [{ message: { content: "finished" } }] });
    const adapter = new GlmAdapter({
      apiKey: "key",
      profile: { name: "glm-5.3-flash", thinking: "low", coordinateMode: "actual_pixels" },
      assetReader: new Reader(),
      httpClient: client,
    });
    await adapter.generate(input(), { signal: new AbortController().signal });
    expect(client.body?.thinking).toEqual({ type: "enabled" });
    expect(client.body?.reasoning_effort).toBe("low");
  });

  it("maps control definitions from the shared tool projection", async () => {
    const observationAssessment = { observationId: "obs-current", actionId: "action-previous", actionOutcome: "expected_change", evidence: "The requested panel is visible." };
    const client = new Client({ choices: [{ message: { tool_calls: [{ id: "finish-call", function: { name: "terminate", arguments: JSON.stringify({ status: "success", text: "Observed control result", observationAssessment }) } }] } }] });
    const adapter = new GlmAdapter({ apiKey: "key", profile: "glm-5.3-flash", assetReader: new Reader(), httpClient: client });
    await expect(adapter.generate(inputWithControls(), { signal: new AbortController().signal })).resolves.toMatchObject({ type: "finish", reportedStatus: "success", summary: "Observed control result", observationAssessment });
    expect((client.body?.tools as Array<Record<string, unknown>>).map((item) => (item.function as Record<string, unknown>).name)).toContain("terminate");
  });

  it("extracts a valid assessment from an action call, drops invalid optional data, and keeps its schema stable", async () => {
    const assessment = {
      observationId: "observation-current",
      actionId: "action-previous",
      actionOutcome: "unexpected_change",
      evidence: "The page changed to an error panel.",
      progress: { kind: "blocked", summary: "A private code 123456 is shown" },
    };
    const client = new Client({ choices: [{ message: { content: "I checked the page.", tool_calls: [{
      id: "assessed-click", function: { name: "click", arguments: JSON.stringify({ x: 500, y: 250, observationAssessment: assessment }) },
    }] } }] });
    const adapter = new GlmAdapter({ apiKey: "key", profile: normalizedProfile, assetReader: new Reader(), httpClient: client });
    await expect(adapter.generate(input(), { signal: new AbortController().signal })).resolves.toMatchObject({
      type: "tool_calls",
      calls: [{ name: "click", arguments: { x: 400, y: 150 } }],
      observationAssessment: assessment,
    });
    expect(JSON.stringify(client.body?.tools)).toContain("observationAssessment");
    const systemText = String((client.body?.messages as Array<Record<string, unknown>>)[0]?.content);
    expect(systemText).toContain("Optional ObservationAssessment");
    expect(systemText).not.toContain("observation-current");
    expect(JSON.stringify(client.body?.tools)).not.toContain("123456");

    const invalid = new Client({ choices: [{ message: { content: "", tool_calls: [{
      id: "invalid-optional-assessment", function: { name: "click", arguments: JSON.stringify({ x: 500, y: 250, observationAssessment: { ...assessment, actionOutcome: "confident" } }) },
    }] } }] });
    const invalidTurn = await new GlmAdapter({ apiKey: "key", profile: normalizedProfile, assetReader: new Reader(), httpClient: invalid }).generate(input(), { signal: new AbortController().signal });
    expect(invalidTurn).toMatchObject({ type: "tool_calls", calls: [{ arguments: { x: 400, y: 150 } }] });
    expect(invalidTurn).not.toHaveProperty("observationAssessment");
  });

  it("keeps the stable system and tool schema prefix unchanged when historical assessment content changes", async () => {
    const capture = async (evidence: string) => {
      const client = new Client({ choices: [{ message: { content: "done" } }] });
      const modelInput = {
        ...input(),
        messages: [
          { role: "user" as const, content: [{ type: "text" as const, text: "continue" }] },
          { role: "assistant" as const, content: [{ type: "text" as const, text: `Prior model-reported ObservationAssessment: ${evidence}` }] },
        ],
      };
      const adapter = new GlmAdapter({ apiKey: "key", profile: normalizedProfile, assetReader: new Reader(), httpClient: client });
      const prepared = await adapter.prepare(modelInput, { signal: new AbortController().signal });
      await adapter.generatePrepared(prepared, { signal: new AbortController().signal });
      return { body: client.body, prepared };
    };
    const first = await capture("no_effect on the current form");
    const second = await capture("unexpected_change to an error screen");
    expect((first.body?.messages as unknown[])[0]).toEqual((second.body?.messages as unknown[])[0]);
    expect(first.body?.tools).toEqual(second.body?.tools);
    expect(first.body?.messages).not.toEqual(second.body?.messages);
    expect(first.prepared.payloadHash).not.toBe(second.prepared.payloadHash);
  });

  it("projects Planning and Memory activation guidance into Function tool schemas", async () => {
    const planDescription = "Handoff-sized current phase for multi-stage/cross-interface/compare/summarize GUI tasks: same ModelTurn before first GUI action, create before the first GUI action, then update or create the next phase at a stage boundary. Describe only this phase and unfinished work; do not copy the original Goal, final deliverables, reasoning, or future stages. skip simple screens/every-click plans.";
    const memoryDescription = "Visible state is not stable. Write only context-loss, cross-stage, or final compare/summary facts; do not copy the original Goal or Plan. If the same ModelTurn creates a task, do not use task retention until task_create returns an id; then pass it in relatedTaskIds. Skip the write or use non-task retention only for a truly run-stable fact. Independent same-turn GUI writes remain allowed; skip clicks.";
    const segmentDescription = "Short-lived local GUI execution segment for the NEXT observations only. This is not task_create/task_update: PlanningTask tracks handoff-sized global phases, while an execution segment contains 2-4 predictable click micro-steps inside the current stable interface. Use it only when the same ModelTurn can describe the current click and at least one later click well enough to replace a future main-provider turn. Call it immediately before the first GUI click. Do not use it for simple one-click screens, type/keypress/scroll/drag/wait, uncertain or open-ended work, cross-application transitions, or sensitive actions. Every step needs observable completion evidence; the segment does not prove progress, authorize actions, or replace re-observation.";
    const base = input();
    const modelInput: ModelInput = {
      ...base,
      tools: [
        ...base.tools,
        { name: "task_create", description: planDescription, category: "planning", inputSchema: { type: "object", properties: { subject: { type: "string", description: "Short title for the current handoff-sized phase; do not restate the original Goal or final delivery." }, description: { type: "string", description: "Only this phase's goal and necessary unfinished work (for example, fill the current form); omit final requirements and future stages." } }, required: ["subject"], additionalProperties: false } },
        { name: "memory_write_fact", description: memoryDescription, category: "side", inputSchema: { type: "object", properties: { key: { type: "string", description: "Key for an observed result, entity, or option needed after recent context; do not restate the original Goal or Plan." }, value: { type: "string", description: "Short observed value for later cross-stage use or final comparison; do not copy Goal/Plan text or click progress." }, retentionClass: { type: "string", description: "Recall policy, not truth or authorization. A task value requires a task id returned by task_create in relatedTaskIds; do not use task retention in that create turn." }, relatedTaskIds: { type: "array", description: "Existing ids returned by task_create/task_list; use them only after the task-create result." } }, required: ["key", "value"], additionalProperties: false } },
        { name: "execution_segment_set", description: segmentDescription, category: "side", inputSchema: { type: "object", properties: { objective: { type: "string" }, steps: { type: "array", minItems: 2, maxItems: 4 } }, required: ["objective", "steps"], additionalProperties: false } },
      ],
    };
    const client = new Client({ choices: [{ message: { content: "done" } }] });
    const adapter = new GlmAdapter({ apiKey: "key", profile: normalizedProfile, assetReader: new Reader(), httpClient: client });
    await expect(adapter.generate(modelInput, { signal: new AbortController().signal })).resolves.toMatchObject({ type: "finish", summary: "done" });
    const tools = client.body?.tools as Array<{ function: { name: string; description: string; parameters: Record<string, unknown> } }>;
    expect(tools.find((tool) => tool.function.name === "task_create")).toMatchObject({ function: { description: planDescription, parameters: { required: ["subject"] } } });
    expect(tools.find((tool) => tool.function.name === "task_create")).toMatchObject({ function: { parameters: { properties: { description: { description: expect.stringContaining("unfinished work") } } } } });
    expect(tools.find((tool) => tool.function.name === "memory_write_fact")).toMatchObject({ function: { description: memoryDescription, parameters: { required: ["key", "value"], properties: { retentionClass: { description: expect.stringContaining("task_create") }, relatedTaskIds: { description: expect.stringContaining("task_create") } } } } });
    expect(tools.find((tool) => tool.function.name === "execution_segment_set")).toMatchObject({ function: { description: segmentDescription, parameters: { required: ["objective", "steps"] } } });
  });

  it("rejects a terminate control with only a status label", async () => {
    const client = new Client({ choices: [{ message: { tool_calls: [{ id: "empty-finish", function: { name: "terminate", arguments: JSON.stringify({ status: "success", text: "done" }) } }] } }] });
    const adapter = new GlmAdapter({ apiKey: "key", profile: "glm-5.3-flash", assetReader: new Reader(), httpClient: client });
    await expect(adapter.generate(inputWithControls(), { signal: new AbortController().signal })).rejects.toMatchObject({ code: "GLM_INVALID_TOOL_CALL" });
  });

  it("adds actual-pixel bounds to the Function Schema when a viewport is available", async () => {
    const client = new Client({ choices: [{ message: { tool_calls: [{ id: "pixel-call", function: { name: "click", arguments: "{\"x\":799,\"y\":599}" } }] } }] });
    const profile: GlmProfile = { name: "test-pixels", thinking: "disabled", coordinateMode: "actual_pixels" };
    const adapter = new GlmAdapter({ apiKey: "key", profile, assetReader: new Reader(), httpClient: client });
    const pixelInput: ModelInput = { ...input(), tools: [{ name: "click", description: "click", category: "computer", coordinate: { fields: ["x", "y"] }, inputSchema: { type: "object", properties: { x: { type: "number" }, y: { type: "number" } }, required: ["x", "y"], additionalProperties: false } }] };
    await expect(adapter.generate(pixelInput, { signal: new AbortController().signal })).resolves.toMatchObject({ calls: [{ arguments: { x: 799, y: 599 } }] });
    expect(client.body?.tools).toMatchObject([{ function: { parameters: { properties: { x: { minimum: 0, maximum: 799 }, y: { minimum: 0, maximum: 599 } } } } }]);
  });

  it("does not pass normalized pixel coordinates through without an image viewport", async () => {
    const client = new Client({ choices: [{ message: { tool_calls: [{ id: "no-viewport", function: { name: "click", arguments: "{\"x\":500,\"y\":250}" } }] } }] });
    const adapter = new GlmAdapter({ apiKey: "key", profile: normalizedProfile, assetReader: new Reader(), httpClient: client });
    await expect(adapter.generate(inputWithoutImage(), { signal: new AbortController().signal })).rejects.toThrow(/image viewport/);
  });

  it("does not treat a truncated response as a normal finish", async () => {
    const client = new Client({ choices: [{ message: { content: "partial" }, finish_reason: "length" }] });
    const adapter = new GlmAdapter({ apiKey: "key", profile: "glm-5.3-flash", assetReader: new Reader(), httpClient: client });
    await expect(adapter.generate(input(), { signal: new AbortController().signal })).rejects.toMatchObject({ code: "GLM_INCOMPLETE_RESPONSE" });
  });

  it("encodes canonical pixel history back into the GLM profile coordinate space", async () => {
    const client = new Client({ choices: [{ message: { content: "done" } }] });
    const call = { id: "history-call" as ToolCallId, name: "click", arguments: { x: 400, y: 150 } };
    const history: ModelInput = {
      ...input(),
      messages: [
        ...input().messages,
        { role: "assistant", content: [{ type: "tool_call", call, viewport }] },
        { role: "tool", content: [{ type: "tool_result", result: { callId: call.id, status: "completed", output: { ok: true } } }] },
      ],
    };
    const adapter = new GlmAdapter({ apiKey: "key", profile: normalizedProfile, assetReader: new Reader(), httpClient: client });
    await adapter.generate(history, { signal: new AbortController().signal });
    const messages = client.body?.messages as Array<Record<string, unknown>>;
    const assistant = messages.find((message) => message.role === "assistant" && message.tool_calls !== undefined);
    const toolCall = (assistant?.tool_calls as Array<Record<string, unknown>> | undefined)?.[0];
    expect(JSON.parse(String((toolCall?.function as Record<string, unknown> | undefined)?.arguments))).toEqual({ x: 500, y: 250 });
    expect(messages.some((message) => message.role === "tool" && message.tool_call_id === call.id)).toBe(true);
  });

  it("preserves reasoning_content through a two-round tool continuation", async () => {
    const firstClient = new Client({
      choices: [{ message: {
        reasoning_content: "reason about the current frame",
        tool_calls: [{ id: "reasoning-call", function: { name: "click", arguments: JSON.stringify({ x: 400, y: 300 }) } }],
      } }],
    });
    const firstAdapter = new GlmAdapter({ apiKey: "key", profile: "glm-5.3-flash", assetReader: new Reader(), httpClient: firstClient });
    const first = await firstAdapter.generate(input(), { signal: new AbortController().signal });
    expect(first).toMatchObject({
      type: "tool_calls",
      continuation: { providerId: "glm-5.3-flash", kind: "reasoning_content", content: "reason about the current frame" },
    });
    if (first.type !== "tool_calls" || first.continuation === undefined) throw new Error("fixture did not produce a continuation");
    const call = first.calls[0];
    if (call === undefined) throw new Error("fixture did not produce a ToolCall");
    const secondClient = new Client({ choices: [{ message: { content: "done" } }] });
    const secondAdapter = new GlmAdapter({ apiKey: "key", profile: "glm-5.3-flash", assetReader: new Reader(), httpClient: secondClient });
    await secondAdapter.generate({
      ...input(),
      messages: [
        ...input().messages,
        { role: "assistant", content: [
          { type: "provider_continuation", continuation: first.continuation },
          { type: "tool_call", call, viewport },
        ] },
        { role: "tool", content: [{ type: "tool_result", result: { callId: call.id, status: "completed", output: { ok: true } } }] },
      ],
    }, { signal: new AbortController().signal });
    const messages = secondClient.body?.messages as Array<Record<string, unknown>>;
    const assistant = messages.find((message) => message.role === "assistant" && message.tool_calls !== undefined);
    expect(assistant?.reasoning_content).toBe("reason about the current frame");
    expect((assistant?.tool_calls as Array<Record<string, unknown>> | undefined)?.[0]).toMatchObject({ id: "reasoning-call" });
  });

  it("classifies the provider's 1305 overload response as retryable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: false,
      status: 503,
      json: async () => ({ error: { code: "1305" } }),
    })));
    try {
      const adapter = new GlmAdapter({ apiKey: "key", profile: normalizedProfile, assetReader: new Reader() });
      await expect(adapter.generate(input(), { signal: new AbortController().signal })).rejects.toMatchObject({
        code: "1305",
        retryable: true,
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("preserves a sanitized network cause code for diagnostics", async () => {
    const cause = Object.assign(new Error("socket reset"), { code: "ECONNRESET" });
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw Object.assign(new TypeError("fetch failed https://user:password@example.test/path?api_key=secret-value Authorization: Bearer synthetic-token-123"), { cause });
    }));
    try {
      const adapter = new GlmAdapter({ apiKey: "key", profile: normalizedProfile, assetReader: new Reader() });
      let caught: unknown;
      try {
        await adapter.generate(input(), { signal: new AbortController().signal });
      } catch (error) {
        caught = error;
      }
      expect(caught).toMatchObject({
        code: "GLM_NETWORK_ERROR",
        retryable: true,
        message: expect.stringContaining("causeCode=ECONNRESET"),
      });
      const message = caught instanceof Error ? caught.message : String(caught);
      expect(message).toContain("api_key=[redacted]");
      expect(message).toContain("Authorization: [redacted]");
      expect(message).not.toContain("synthetic-token-123");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("projects and parses the shared click_element grounding tool", async () => {
    const client = new Client({ choices: [{ message: { content: "", tool_calls: [{ id: "glm-grounding", function: { name: "click_element", arguments: JSON.stringify({ elementRef: "uia-1" }) } }] } }] });
    const groundingInput: ModelInput = {
      ...input(),
      tools: [...input().tools, {
        name: "click_element",
        description: "Click the current UIA element reference.",
        category: "computer",
        inputSchema: { type: "object", properties: { elementRef: { type: "string" } }, required: ["elementRef"], additionalProperties: false },
      }],
    };
    const adapter = new GlmAdapter({ apiKey: "key", profile: normalizedProfile, assetReader: new Reader(), httpClient: client });
    await expect(adapter.generate(groundingInput, { signal: new AbortController().signal })).resolves.toMatchObject({ type: "tool_calls", calls: [{ name: "click_element", arguments: { elementRef: "uia-1" } }] });
    expect((client.body?.tools as Array<Record<string, unknown>>).map((item) => (item.function as Record<string, unknown>).name)).toContain("click_element");
  });

  it("applies one deadline to fetch and response-body reading", async () => {
    let observedSignal: AbortSignal | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, options: { signal: AbortSignal }) => {
      observedSignal = options.signal;
      return {
        ok: true,
        status: 200,
        json: () => new Promise<never>((_resolve, reject) => {
          options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
        }),
      };
    }));
    try {
      const adapter = new GlmAdapter({
        apiKey: "key",
        profile: normalizedProfile,
        assetReader: new Reader(),
        httpClient: new FetchGlmHttpClient({ requestTimeoutMs: 10 }),
      });
      await expect(adapter.generate(input(), { signal: new AbortController().signal })).rejects.toMatchObject({
        code: "GLM_REQUEST_TIMEOUT",
        retryable: true,
        retryMode: "same_input",
      });
      expect(observedSignal?.aborted).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("preserves user cancellation instead of classifying it as a retryable timeout", async () => {
    let observedSignal: AbortSignal | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, options: { signal: AbortSignal }) => {
      observedSignal = options.signal;
      if (options.signal.aborted) return Promise.reject(options.signal.reason);
      return new Promise<never>((_resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
      });
    }));
    try {
      const controller = new AbortController();
      const adapter = new GlmAdapter({
        apiKey: "key",
        profile: normalizedProfile,
        assetReader: new Reader(),
        httpClient: new FetchGlmHttpClient({ requestTimeoutMs: 1_000 }),
      });
      const request = adapter.generate(input(), { signal: controller.signal });
      controller.abort(new Error("user cancelled"));
      await expect(request).rejects.toThrow("user cancelled");
      expect(observedSignal).toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
