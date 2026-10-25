/**
 * Pure metrics for the GLM execution-segment conformance probe.
 *
 * The probe deliberately keeps provider payloads and image bytes out of its
 * rows. This module only consumes already-redacted row summaries, so it is
 * safe to reuse from offline tests and later report generation.
 */

export function summarizeExecutionSegmentRows(rows) {
  const safeRows = Array.isArray(rows) ? rows : [];
  const attempted = safeRows.filter((row) => row && row.status !== "skipped");
  const positive = attempted.filter((row) => row.expectedCreate === true);
  const negative = attempted.filter((row) => row.expectedCreate === false);
  const observedSegment = attempted.filter((row) => Number(row.segmentCallCount ?? 0) > 0);
  const validSegment = observedSegment.filter((row) => row.segmentArgsValid === true);
  const createdPositive = positive.filter((row) => Number(row.segmentCallCount ?? 0) > 0);
  const falseCreated = negative.filter((row) => Number(row.segmentCallCount ?? 0) > 0);
  const errors = attempted.filter((row) => row.status === "error");
  const withOtherCalls = attempted.filter((row) => Array.isArray(row.otherCallNames) && row.otherCallNames.length > 0);

  return {
    probe: "glm-execution-segment-api-conformance-v1",
    rows: safeRows.length,
    attemptedRequests: attempted.length,
    positiveScenarios: positive.length,
    negativeScenarios: negative.length,
    requestsWithSegment: observedSegment.length,
    segmentCreationRecall: positive.length === 0 ? null : createdPositive.length / positive.length,
    falseCreationRate: negative.length === 0 ? null : falseCreated.length / negative.length,
    validArgsRate: observedSegment.length === 0 ? null : validSegment.length / observedSegment.length,
    validSegmentCalls: validSegment.length,
    invalidSegmentCalls: observedSegment.length - validSegment.length,
    providerErrors: errors.length,
    rowsWithOtherCalls: withOtherCalls.length,
    promptVariants: Object.fromEntries(
      [...new Set(safeRows.map((row) => typeof row.promptVariant === "string" ? row.promptVariant : "unknown"))]
        .map((variant) => {
          const subset = safeRows.filter((row) => row.promptVariant === variant);
          return [variant, {
            rows: subset.length,
            segmentCalls: subset.filter((row) => Number(row.segmentCallCount ?? 0) > 0).length,
            errors: subset.filter((row) => row.status === "error").length,
          }];
        }),
    ),
    latencyMs: summarizeNumbers(attempted.map((row) => row.latencyMs)),
    usage: {
      inputTokens: sumNumbers(attempted.map((row) => row.usage?.inputTokens)),
      outputTokens: sumNumbers(attempted.map((row) => row.usage?.outputTokens)),
      totalTokens: sumNumbers(attempted.map((row) => row.usage?.totalTokens)),
    },
  };
}

function sumNumbers(values) {
  const finite = values.filter((value) => Number.isFinite(value));
  return finite.length === 0 ? null : finite.reduce((sum, value) => sum + value, 0);
}

function summarizeNumbers(values) {
  const finite = values.filter((value) => Number.isFinite(value));
  if (finite.length === 0) return { count: 0, min: null, max: null, average: null };
  return {
    count: finite.length,
    min: Math.min(...finite),
    max: Math.max(...finite),
    average: Math.round((finite.reduce((sum, value) => sum + value, 0) / finite.length) * 100) / 100,
  };
}

