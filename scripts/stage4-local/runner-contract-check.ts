import {
  foregroundConfirmed,
  parseEvaluationResult,
  parseRuntimeResult,
} from "../../spikes/cua-driver/stage4-local-runner.ts";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

const evaluationCases = [
  { value: { success: true, reason: "exact match" }, success: true },
  { value: { success: false, reason: "text mismatch" }, success: false },
  { value: { reason: "missing success" }, success: null },
  { value: "corrupt JSON root", success: null },
] as const;

for (const [index, testCase] of evaluationCases.entries()) {
  const result = parseEvaluationResult(testCase.value);
  assert(
    result.status === "available"
      ? result.success === testCase.success
      : testCase.success === null,
    `evaluation case ${index} was classified incorrectly`,
  );
}

assert(parseRuntimeResult({ runtimeOutcome: "failed" }).status === "available", "runtime failure must remain available");
assert(parseRuntimeResult({ runtimeOutcome: 3 }).status === "unavailable", "invalid runtime outcome must be unavailable");
assert(foregroundConfirmed({ structuredJson: JSON.stringify({ landed_on_target: true }) }), "foreground true was not accepted");
assert(!foregroundConfirmed({ structuredJson: JSON.stringify({ landed_on_target: false }) }), "foreground false was accepted");
assert(!foregroundConfirmed({ structuredJson: JSON.stringify({}) }), "missing foreground confirmation was accepted");

process.stdout.write("stage4 runner contract checks passed\n");
