#!/usr/bin/env node

import assert from "node:assert/strict";
import { parseProbeArgs, runOfflineSelfTest, sanitizeForArtifact } from "./provider-description-probe.mjs";

assert.throws(() => parseProbeArgs(["--live"]), { code: "ROOT_GO_REQUIRED" });
assert.throws(() => parseProbeArgs(["--live", "--root-go-after-review"]), { code: "SYNTHETIC_FIXTURE_CONFIRMATION_REQUIRED" });
const liveOptions = parseProbeArgs(["--live", "--root-go-after-review", "--confirm-synthetic-only"]);
assert.equal(liveOptions.maxRequestsPerScenarioProvider, 6);
assert.deepEqual(liveOptions.contexts, ["raw"]);
assert.deepEqual(liveOptions.scenarios, ["native_browser_return", "browser_to_wps", "desktop_to_wps"]);
assert.deepEqual(parseProbeArgs([
  "--live", "--root-go-after-review", "--confirm-synthetic-only", "--scenario", "desktop_to_wps",
]).scenarios, ["desktop_to_wps"]);
assert.throws(() => parseProbeArgs([
  "--live", "--root-go-after-review", "--confirm-synthetic-only", "--scenario", "unknown",
]), { code: "INVALID_SCENARIO" });
const sanitizedRecord = sanitizeForArtifact({
  Authorization: "Bearer local-test-secret",
  message: "token=local-test-secret",
  screenshot: "data:image/png;base64,AAECAw==",
  usage: {
    prompt_tokens: 91,
    completion_tokens: 11,
    total_tokens: 102,
    inputTokens: 91,
    outputTokens: 11,
    api_tokens: "local-test-secret",
  },
}, ["local-test-secret"]);
const sanitized = JSON.stringify(sanitizedRecord);
assert.doesNotMatch(sanitized, /local-test-secret|AAECAw==/u);
assert.deepEqual(sanitizedRecord.usage, {
  prompt_tokens: 91,
  completion_tokens: 11,
  total_tokens: 102,
  inputTokens: 91,
  outputTokens: 11,
  api_tokens: "[REDACTED]",
});

const originalFetch = globalThis.fetch;
let attemptedNetworkCalls = 0;
let report;
globalThis.fetch = async () => { attemptedNetworkCalls += 1; throw new Error("Offline self-test attempted a network request"); };
try { report = await runOfflineSelfTest(); }
finally { globalThis.fetch = originalFetch; }
assert.equal(attemptedNetworkCalls, 0);
assert.equal(report.status, "passed");
assert.equal(report.networkCalls, 0);
assert.deepEqual(report.transport, {
  hungFetch: "PROVIDER_REQUEST_TIMEOUT",
  hungResponseBody: "PROVIDER_REQUEST_TIMEOUT",
  callerAbort: "REQUEST_ABORTED",
  httpStatus: "HTTP_STATUS_429",
  invalidEnvelopeClassification: {
    classification: "provider_response_invalid",
    modelDescriptionAssessment: "not_scored",
  },
  timeoutClassification: "not_observed/inconclusive",
  maxDefaultMs: 120000,
});
assert.deepEqual(report.runs.map((run) => `${run.provider}/${run.scenarioId}`), [
  "glm/native_browser_return",
  "glm/browser_to_wps",
  "glm/desktop_to_wps",
  "qwen/native_browser_return",
  "qwen/browser_to_wps",
  "qwen/desktop_to_wps",
]);
assert.deepEqual(report.runs.map((run) => run.requests), [5, 3, 3, 5, 3, 3]);
assert.deepEqual(report.runs.map((run) => run.requestLimit), [6, 4, 4, 6, 4, 4]);
assert.ok(report.runs.every((run) => run.contextMode === "raw" && run.outcome === "succeeded"));
for (const run of report.runs) {
  const expectedKinds = run.scenarioId === "native_browser_return" ? ["native_window", "browser_tab", "native_window"]
    : run.scenarioId === "browser_to_wps" ? ["browser_tab", "native_window"] : ["desktop", "native_window"];
  assert.deepEqual(run.observedSurfaces.map((surface) => surface.kind), expectedKinds);
  assert.deepEqual(run.observedSurfaces.map((surface) => surface.generation), expectedKinds.map((_kind, index) => index + 1));
  assert.ok(run.observedSurfaces.filter((surface) => surface.kind === "browser_tab").every((surface) => surface.parentSurfaceId && surface.parentSurfaceId !== surface.surfaceId));
  if (run.scenarioId === "native_browser_return") assert.equal(run.observedSurfaces[0].surfaceId, run.observedSurfaces[2].surfaceId);
}
for (const provider of ["glm", "qwen"]) {
  const providerRuns = report.runs.filter((run) => run.provider === provider);
  assert.equal(providerRuns.reduce((sum, run) => sum + run.requests, 0), 11);
  assert.ok(providerRuns.every((run) => run.requests <= run.requestLimit));
  assert.ok(providerRuns.find((run) => run.scenarioId === "native_browser_return").requestLimit >= 5);
}
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
