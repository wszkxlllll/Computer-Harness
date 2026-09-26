import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_REQUESTS,
  PROMPT_SENTENCE,
  assertABBodiesDifferOnlyByPromptSentence,
  buildRunPlan,
  callMatchesExpected,
  createScenarios,
  extractFormatLabels,
  metricSnapshot,
  parseEnv,
  redactRequestBody,
} from "./glm-assistant-text-ab-probe.mjs";

test("probe scenarios cover three predictable and three uncertain next actions", () => {
  const scenarios = createScenarios();
  assert.equal(scenarios.length, 6);
  assert.equal(scenarios.filter((scenario) => scenario.nextStepPredictable).length, 3);
  assert.equal(scenarios.filter((scenario) => !scenario.nextStepPredictable).length, 3);
  assert.ok(scenarios.every((scenario) => scenario.expectedCurrent.toolName));
  assert.equal(scenarios.filter((scenario) => scenario.expectedNext !== null).length, 3);
});

test("environment parser handles quoted values without exposing them", () => {
  assert.deepEqual(parseEnv("# comment\nGLM_API_KEY='sample-secret'\nGLM_ENDPOINT=https://example.invalid/chat\nnot an assignment\n"), {
    GLM_API_KEY: "sample-secret",
    GLM_ENDPOINT: "https://example.invalid/chat",
  });
});

test("format inspection is mechanical and distinguishes explicit abstention", () => {
  assert.deepEqual(extractFormatLabels("Current: click Search; Next: open the first matching result."), {
    hasCurrentLabel: true,
    hasNextLabel: true,
    nextSaysObserve: false,
    nextStartsWithObserve: false,
    nextText: "open the first matching result.",
  });
  assert.deepEqual(extractFormatLabels("Current: run Search; Next: observe the results."), {
    hasCurrentLabel: true,
    hasNextLabel: true,
    nextSaysObserve: false,
    nextStartsWithObserve: true,
    nextText: "observe the results.",
  });
  assert.deepEqual(extractFormatLabels("Current: run Search; Next: observe"), {
    hasCurrentLabel: true,
    hasNextLabel: true,
    nextSaysObserve: true,
    nextStartsWithObserve: true,
    nextText: "observe",
  });
  assert.deepEqual(extractFormatLabels(""), { hasCurrentLabel: false, hasNextLabel: false, nextSaysObserve: false, nextStartsWithObserve: false, nextText: null });
  assert.deepEqual(extractFormatLabels(null), { hasCurrentLabel: false, hasNextLabel: false, nextSaysObserve: false, nextStartsWithObserve: false, nextText: null });
});

test("tool-call comparison checks exact text, expected click target bounds, and scroll direction", () => {
  const [typing, clicking, , , scrolling] = createScenarios();
  assert.ok(typing && clicking && scrolling);
  assert.equal(callMatchesExpected({ name: "type", arguments: { text: "open-source licenses" } }, typing.expectedCurrent, typing.elements), true);
  assert.equal(callMatchesExpected({ name: "type", arguments: { text: "wrong" } }, typing.expectedCurrent, typing.elements), false);
  assert.equal(callMatchesExpected({ name: "click", arguments: { x: 200, y: 250 } }, clicking.expectedCurrent, clicking.elements), true);
  assert.equal(callMatchesExpected({ name: "click", arguments: { x: 1090, y: 710 } }, clicking.expectedCurrent, clicking.elements), false);
  assert.equal(callMatchesExpected({ name: "scroll", arguments: { x: 500, y: 400, direction: "down", ticks: 2 } }, scrolling.expectedCurrent, scrolling.elements), true);
  assert.equal(callMatchesExpected({ name: "scroll", arguments: { x: 500, y: 400, direction: "up", ticks: 2 } }, scrolling.expectedCurrent, scrolling.elements), false);
});

test("metrics expose mechanical rates and leave semantic accuracy for manual review", () => {
  const rows = [
    { status: "ok", finishReason: "tool_calls", toolCallCount: 1, variant: "A", assistantText: "Current: type the query; Next: click Search.", formatLabels: { hasCurrentLabel: true, hasNextLabel: true, nextSaysObserve: false }, nextStepPredictable: true, currentToolNameMatch: true, currentToolArgumentsMatch: true, usage: { total_tokens: 120 }, latencyMs: 800 },
    { status: "ok", finishReason: "tool_calls", toolCallCount: 1, variant: "A", assistantText: "Current: scroll the feed; Next: observe.", formatLabels: { hasCurrentLabel: true, hasNextLabel: true, nextSaysObserve: true, nextStartsWithObserve: true }, nextStepPredictable: false, currentToolNameMatch: false, currentToolArgumentsMatch: false, usage: { total_tokens: 140 }, latencyMs: 1000 },
    { status: "timeout", variant: "A", assistantText: null, nextStepPredictable: true },
  ];
  const metrics = metricSnapshot(rows);
  assert.equal(metrics.attemptedRequestCount, 3);
  assert.equal(metrics.httpSuccessRequestCount, 2);
  assert.equal(metrics.nativeToolCallCount, 2);
  assert.equal(metrics.httpSuccessMetrics.contentPresenceRate, 1);
  assert.equal(metrics.nativeToolCallMetrics.contentPresenceRate, 1);
  assert.equal(metrics.nativeToolCallMetrics.formatComplianceRate, 1);
  assert.equal(metrics.nativeToolCallMetrics.predictableScenarioNextLabelPresenceRate, 1);
  assert.equal(metrics.nativeToolCallMetrics.uncertainScenarioExactObserveLabelRate, 1);
  assert.equal(metrics.nativeToolCallMetrics.uncertainScenarioObservePrefixRate, 1);
  assert.equal(metrics.nativeToolCallMetrics.safeAbstentionSemanticAccuracy, null);
  assert.equal(metrics.nativeToolCallMetrics.currentToolNameMatchRate, 0.5);
  assert.equal(metrics.nativeToolCallMetrics.currentToolArgumentsMatchRate, 0.5);
  assert.equal(metrics.nativeToolCallMetrics.averageTotalTokens, 130);
  assert.equal(metrics.nativeToolCallMetrics.medianLatencyMs, 900);
  assert.equal(metrics.semanticCurrentActionAccuracy, null);
  assert.equal(metrics.semanticNextActionAccuracy, null);
});

test("request redaction omits image payloads and credential-shaped fields", () => {
  const redacted = redactRequestBody({
    model: "glm-5.3-flash",
    authorization: "Bearer do-not-save",
    messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,AQID" } }] }],
  });
  assert.equal(redacted.authorization, "[redacted]");
  assert.match(redacted.messages[0].content[0].image_url.url, /omitted synthetic image payload/u);
  assert.doesNotMatch(JSON.stringify(redacted), /do-not-save|AQID/u);
});

test("the pair validator accepts only the requested single system-sentence difference", () => {
  const bodyA = { model: "glm-5.3-flash", messages: [{ role: "system", content: "Base prompt\nProvider prompt" }, { role: "user", content: "Same request" }], tools: [], thinking: { type: "enabled" }, stream: false, tool_choice: "auto" };
  const bodyB = structuredClone(bodyA);
  bodyB.messages[0].content = `Base prompt ${PROMPT_SENTENCE}\nProvider prompt`;
  assert.equal(assertABBodiesDifferOnlyByPromptSentence(bodyA, bodyB), true);
  bodyB.messages[1].content = "Changed request";
  assert.throws(() => assertABBodiesDifferOnlyByPromptSentence(bodyA, bodyB), /differ beyond/u);
});

test("production compiler and Provider build paired complete GLM requests locally", async () => {
  const result = await buildRunPlan(1);
  assert.equal(result.scenarios.length, 6);
  assert.equal(result.plannedRequestCount, 12);
  assert.ok(result.plannedRequestCount <= MAX_REQUESTS);
  for (const item of result.plan) {
    const { A, B } = item.bodies;
    assert.equal(A.model, "glm-5.3-flash");
    assert.deepEqual(A.thinking, { type: "enabled" });
    assert.equal(A.stream, false);
    assert.equal(A.tool_choice, "auto");
    assert.deepEqual(A.tools.map((tool) => tool.function.name).sort(), ["click", "scroll", "terminate", "type"]);
    assert.equal(assertABBodiesDifferOnlyByPromptSentence(A, B), true);
    assert.equal(A.messages.some((message) => message.role === "user" && Array.isArray(message.content) && message.content.some((block) => block.type === "image_url")), true);
  }
  await assert.rejects(buildRunPlan(3), /hard limit/u);
});
