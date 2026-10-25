import assert from "node:assert/strict";
import test from "node:test";

import { summarizeExecutionSegmentRows } from "./execution-segment-api-conformance-metrics.mjs";

test("summarizes segment recall, false creation, validation, and prompt variants", () => {
  const result = summarizeExecutionSegmentRows([
    { scenario: "positive-a", promptVariant: "production", expectedCreate: true, status: "ok", segmentCallCount: 1, segmentArgsValid: true, latencyMs: 100, usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 }, otherCallNames: [] },
    { scenario: "positive-b", promptVariant: "production", expectedCreate: true, status: "ok", segmentCallCount: 0, segmentArgsValid: null, latencyMs: 300, usage: { inputTokens: 20, outputTokens: 3, totalTokens: 23 }, otherCallNames: ["click"] },
    { scenario: "negative-a", promptVariant: "production", expectedCreate: false, status: "ok", segmentCallCount: 1, segmentArgsValid: false, latencyMs: 200, usage: { inputTokens: 15, outputTokens: 4, totalTokens: 19 }, otherCallNames: [] },
    { scenario: "negative-b", promptVariant: "ab", expectedCreate: false, status: "error", segmentCallCount: 0, segmentArgsValid: null, latencyMs: 400, usage: {}, otherCallNames: [] },
  ]);

  assert.equal(result.segmentCreationRecall, 0.5);
  assert.equal(result.falseCreationRate, 0.5);
  assert.equal(result.validArgsRate, 0.5);
  assert.equal(result.validSegmentCalls, 1);
  assert.equal(result.invalidSegmentCalls, 1);
  assert.equal(result.providerErrors, 1);
  assert.equal(result.rowsWithOtherCalls, 1);
  assert.deepEqual(result.latencyMs, { count: 4, min: 100, max: 400, average: 250 });
  assert.deepEqual(result.usage, { inputTokens: 45, outputTokens: 9, totalTokens: 54 });
  assert.equal(result.promptVariants.production.rows, 3);
  assert.equal(result.promptVariants.ab.rows, 1);
});

test("returns null rates when no usable rows exist", () => {
  const result = summarizeExecutionSegmentRows([{ status: "skipped", promptVariant: "production" }]);
  assert.equal(result.attemptedRequests, 0);
  assert.equal(result.segmentCreationRecall, null);
  assert.equal(result.falseCreationRate, null);
  assert.equal(result.validArgsRate, null);
  assert.deepEqual(result.latencyMs, { count: 0, min: null, max: null, average: null });
});

