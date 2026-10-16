import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  collectUsageNumbers,
  createSyntheticUiPng,
  hasSuccessfulThreeActionBatch,
  matchesScenarioFirstTurn,
  mentionsFixtureControls,
  parseArkApiKeyEnv,
  parseProviderApiKeyEnv,
  parseProbeArgs,
  probeStatusFromChecks,
  reportedNetworkCallsOnFailure,
  runOfflineProbe,
  safeErrorCode,
  summarizeRequestBody,
} from "./provider-ark-conformance.mjs";

describe("Ark protocol conformance probe", () => {
  it("defaults to offline and requires explicit live mode plus an env file", () => {
    assert.deepEqual(parseProbeArgs([]), { mode: "offline", scenario: "composite" });
    assert.deepEqual(parseProbeArgs(["--offline"]), { mode: "offline", scenario: "composite" });
    assert.deepEqual(parseProbeArgs(["--scenario", "baseline"]), { mode: "offline", scenario: "baseline" });
    assert.throws(() => parseProbeArgs(["--live"]), { code: "ENV_FILE_REQUIRED" });
    assert.throws(() => parseProbeArgs(["--env-file", "private.env"]), { code: "LIVE_REQUIRED_FOR_ENV_FILE" });
    assert.throws(() => parseProbeArgs(["--live", "--offline", "--env-file", "private.env"]), { code: "CONFLICTING_MODE" });
    assert.deepEqual(parseProbeArgs(["--live", "--env-file", "private.env"]), {
      mode: "live",
      envFile: join(process.cwd(), "private.env"),
      keyEnv: "ARK_API_KEY",
      scenario: "composite",
    });
    assert.deepEqual(parseProbeArgs(["--live", "--env-file", "private.env", "--key-env", "HUOSHAN_API_KEY"]), {
      mode: "live",
      envFile: join(process.cwd(), "private.env"),
      keyEnv: "HUOSHAN_API_KEY",
      scenario: "composite",
    });
    assert.deepEqual(parseProbeArgs(["--live", "--env-file", "private.env", "--scenario", "baseline"]), {
      mode: "live",
      envFile: join(process.cwd(), "private.env"),
      keyEnv: "ARK_API_KEY",
      scenario: "baseline",
    });
    assert.throws(() => parseProbeArgs(["--key-env", "HUOSHAN_API_KEY"]), { code: "LIVE_REQUIRED_FOR_KEY_ENV" });
    assert.throws(() => parseProbeArgs(["--live", "--env-file", "private.env", "--key-env", "DEEPSEEK_API_KEY"]), { code: "INVALID_KEY_ENV" });
    assert.throws(() => parseProbeArgs(["--scenario", "other"]), { code: "INVALID_SCENARIO" });
  });

  it("extracts only ARK_API_KEY and rejects ambiguous duplicates without echoing values", () => {
    const key = "local-offline-ark-key-do-not-log";
    const parsed = parseArkApiKeyEnv(`UNRELATED_API_KEY=private-other-value\nexport ARK_API_KEY='${key}'\nALSO_SECRET=private-third-value\n`);
    assert.equal(parsed, key);
    assert.throws(() => parseArkApiKeyEnv("ARK_API_KEY=one\nARK_API_KEY=two"), { code: "DUPLICATE_ARK_API_KEY" });
    assert.throws(() => parseArkApiKeyEnv("DEEPSEEK_API_KEY=ignored"), { code: "ARK_API_KEY_MISSING" });
    const envFile = "ARK_API_KEY=ark-value\nHUOSHAN_API_KEY=huoshan-value\nDEEPSEEK_API_KEY=ignored";
    assert.equal(parseProviderApiKeyEnv(envFile), "ark-value");
    assert.equal(parseProviderApiKeyEnv(envFile, "HUOSHAN_API_KEY"), "huoshan-value");
    assert.throws(() => parseProviderApiKeyEnv("HUOSHAN_API_KEY=only-this-value"), { code: "ARK_API_KEY_MISSING" });
    assert.throws(() => parseProviderApiKeyEnv("ARK_API_KEY=one\nARK_API_KEY=two", "ARK_API_KEY"), { code: "DUPLICATE_ARK_API_KEY" });
    assert.throws(() => parseProviderApiKeyEnv("HUOSHAN_API_KEY=one\nHUOSHAN_API_KEY=two", "HUOSHAN_API_KEY"), { code: "DUPLICATE_HUOSHAN_API_KEY" });
  });

  it("generates only deterministic non-sensitive synthetic UI screenshots", () => {
    const initial = createSyntheticUiPng("SAMPLE");
    const initialFocused = createSyntheticUiPng("SAMPLE", true);
    const updated = createSyntheticUiPng("probe");
    const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    assert.deepEqual(initial.subarray(0, 8), signature);
    assert.deepEqual(updated.subarray(0, 8), signature);
    assert.notDeepEqual(initial, updated);
    assert.notDeepEqual(initial, initialFocused);
    assert.throws(() => createSyntheticUiPng("not-a-fixture-value"), { code: "INVALID_FIXTURE_VALUE" });
  });

  it("projects request shape and usage counters without prompts, image payloads, URLs, or raw response text", () => {
    const summary = summarizeRequestBody({
      model: "deepseek-v4.1-flash",
      thinking: { type: "disabled" },
      tools: [
        { type: "function", function: { name: "click", parameters: { type: "object" } } },
        { type: "function", function: { name: "terminate", parameters: { type: "object" } } },
      ],
      messages: [
        { role: "user", content: [{ type: "text", text: "PRIVATE_PROMPT" }, { type: "image_url", image_url: { url: "https://private.invalid/image?secret=abc" } }] },
        { role: "assistant", tool_calls: [{ function: { name: "type", arguments: "PRIVATE_TYPED_TEXT" } }] },
        { role: "tool", content: "PRIVATE_TOOL_RESULT" },
      ],
    });
    assert.deepEqual(summary, {
      model: "deepseek-v4.1-flash",
      thinking: "disabled",
      nativeFunctionToolCount: 2,
      toolNames: ["click", "terminate"],
      messageRoles: ["user", "assistant", "tool"],
      imageCount: 1,
      assistantToolCallCount: 1,
      priorToolCallNames: ["type"],
      toolResultCount: 1,
    });
    assert.doesNotMatch(JSON.stringify(summary), /PRIVATE_|private\.invalid|secret=abc/u);

    const counters = collectUsageNumbers({
      usage: {
        prompt_tokens: 80,
        completion_tokens: 12,
        total_tokens: 92,
        prompt_cache_hit_tokens: 40,
        prompt_tokens_details: { cached_tokens: 35, cache_miss_tokens: 45 },
        completion_tokens_details: { reasoning_tokens: 7 },
        reasoning_content: "DO_NOT_INCLUDE",
        api_key: "DO_NOT_INCLUDE",
        hidden_count: "not numeric",
      },
      choices: [{ message: { reasoning_content: "DO_NOT_INCLUDE" } }],
    });
    assert.deepEqual(counters, {
      completion_tokens: 12,
      prompt_cache_hit_tokens: 40,
      prompt_tokens: 80,
      "prompt_tokens_details.cache_miss_tokens": 45,
      "prompt_tokens_details.cached_tokens": 35,
      total_tokens: 92,
    });
    assert.doesNotMatch(JSON.stringify(counters), /DO_NOT_INCLUDE|api_key/u);
    assert.doesNotMatch(JSON.stringify(counters), /reasoning/u);
  });

  it("keeps transport errors to safe codes", () => {
    assert.equal(safeErrorCode(Object.assign(new Error("Authorization: private token"), { code: "ARK_HTTP_429" })), "ARK_HTTP_429");
    assert.equal(safeErrorCode(new Error("private provider body")), "PROBE_REQUEST_FAILED");
  });

  it("recognizes a concise fixture description in English or Chinese without storing its text", () => {
    assert.equal(mentionsFixtureControls("The screenshot shows an input beside a Search button."), true);
    assert.equal(mentionsFixtureControls("截图里有一个输入框，旁边是搜索按钮。"), true);
    assert.equal(mentionsFixtureControls("A button is visible."), false);
  });

  it("does not report zero live requests after a live run started without a report", () => {
    assert.equal(reportedNetworkCallsOnFailure("offline", true, { requestCount: 5 }), 0);
    assert.equal(reportedNetworkCallsOnFailure("live", false, undefined), 0);
    assert.equal(reportedNetworkCallsOnFailure("live", true, { requestCount: 3 }), 3);
    assert.equal(reportedNetworkCallsOnFailure("live", true, undefined), "unknown");
  });

  it("requires click, select-all, and type in one response with their own successful receipts", () => {
    const plan = { id: "plan-call", name: "task_create" };
    const memory = { id: "memory-call", name: "memory_write_fact" };
    const click = { id: "click-call", name: "click" };
    const hotkey = { id: "hotkey-call", name: "hotkey" };
    const type = { id: "type-call", name: "type" };
    const calls = [plan, memory, click, hotkey, type];
    const actionCalls = [click, hotkey, type];
    const events = [
      ...calls.map((call) => ({ type: "tool.call.completed", result: { callId: call.id, status: "completed" } })),
      ...actionCalls.flatMap((call) => [
        { type: "action.proposed", callId: call.id, action: { actionId: `action-${call.id}` } },
        { type: "action.execution.completed", receipt: { actionId: `action-${call.id}`, status: "completed" } },
      ]),
    ];
    const completedCallIds = new Set(calls.map((call) => call.id));
    const response = (turnCalls) => ({ type: "model.response.received", turn: { type: "tool_calls", calls: turnCalls } });

    assert.equal(hasSuccessfulThreeActionBatch([response(calls)], events, completedCallIds), true);
    assert.equal(hasSuccessfulThreeActionBatch([
      response([plan, memory, click]),
      response([hotkey, type]),
    ], events, completedCallIds), false);
  });

  it("accepts only the baseline first-turn calls and rejects a wrong or missing call", () => {
    const baselineCalls = ["task_create", "memory_write_fact", "click"].map((name) => ({ name }));
    assert.equal(matchesScenarioFirstTurn("baseline", baselineCalls), true);
    assert.equal(matchesScenarioFirstTurn("baseline", [baselineCalls[0], baselineCalls[2], baselineCalls[1]]), false);
    assert.equal(matchesScenarioFirstTurn("baseline", baselineCalls.slice(0, 2)), false);
    assert.equal(matchesScenarioFirstTurn("composite", ["task_create", "memory_write_fact", "click", "hotkey", "type"].map((name) => ({ name }))), true);
  });

  it("runs actual Ark factory, Registry, Runtime, composite batch, receipt continuation, and separate terminate offline", { timeout: 60_000 }, async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "ark-conformance-offline-"));
    try {
      const report = await runOfflineProbe({ outputDir });
      assert.equal(report.status, "passed", JSON.stringify(report.checks));
      assert.equal(report.protocolConformance, "passed");
      assert.equal(report.businessTaskOutcome, "not_assessed");
      assert.equal(report.requestCount, 2);
      assert.equal(report.runtime.modelRequestCount, 2);
      assert.deepEqual(report.runtime.responseTurnTypes, ["tool_calls", "finish"]);
      assert.deepEqual(report.runtime.computerActionKinds, ["click", "keypress", "type"]);
      assert.deepEqual(report.runtime.firstTurnToolNames, ["task_create", "memory_write_fact", "click", "hotkey", "type"]);
      assert.ok(report.runtime.planningTaskCount >= 1);
      assert.ok(report.runtime.memoryFactCount >= 1);
      assert.ok(Object.values(report.checks).every(Boolean));
      assert.deepEqual(report.requests[0]?.summary.priorToolCallNames, []);
      assert.ok((report.requests[1]?.summary.assistantToolCallCount ?? 0) >= 5);
      assert.ok((report.requests[1]?.summary.toolResultCount ?? 0) >= 5);
      assert.equal(report.requests[0]?.usageNumericFields["prompt_tokens_details.cached_tokens"], 96);
      const serialized = JSON.stringify(report);
      assert.doesNotMatch(serialized, /offline-placeholder|PRIVATE_|https?:\/\/|reasoning_content|data:image\/png/u);
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("runs the separate baseline protocol with Planning/Memory plus one click and allows a later task update", { timeout: 60_000 }, async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "ark-conformance-baseline-"));
    try {
      const report = await runOfflineProbe({ scenario: "baseline", outputDir });
      assert.equal(report.status, "passed", JSON.stringify(report.checks));
      assert.equal(report.scenario, "baseline");
      assert.equal(report.requestCount, 3);
      assert.deepEqual(report.runtime.responseTurnTypes, ["tool_calls", "tool_calls", "finish"]);
      assert.deepEqual(report.runtime.firstTurnToolNames, ["task_create", "memory_write_fact", "click"]);
      assert.deepEqual(report.runtime.computerActionKinds, ["click"]);
      assert.equal(report.checks.oneCompletedFirstTurnClickReceipt, true);
      assert.equal(report.checks.runtimeAcceptedThreeActionBatch, undefined);
      assert.ok(report.checks.continuationContainsPriorCallsAndReceipts);
      assert.ok(report.checks.terminateIsSeparateFinalDecision);
      for (const name of [
        "liveRequestsBounded",
        "requestCountMatchesRuntime",
        "defaultArkModelAndThinkingDisabled",
        "nativeFunctionToolProjection",
        "initialAndFollowUpSyntheticScreenshots",
        "planningTaskPersisted",
        "memoryFactPersisted",
        "modelResponseMentionsFixtureControls",
        "noToolRejections",
        "noRuntimeErrors",
        "syntheticComputerOnly",
        "runtimeProtocolOutcomeSucceeded",
      ]) {
        assert.equal(report.checks[name], true, `missing or failed baseline check: ${name}`);
      }
      for (const name of ["runtimeProtocolOutcomeSucceeded", "noToolRejections", "noRuntimeErrors", "memoryFactPersisted", "initialAndFollowUpSyntheticScreenshots"]) {
        assert.equal(probeStatusFromChecks({ ...report.checks, [name]: false }), "failed", `baseline should fail when ${name} is false`);
      }
      assert.ok(Object.values(report.checks).every(Boolean));
      assert.equal(report.businessTaskOutcome, "not_assessed");
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });
});
