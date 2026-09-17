import type { ActionId, AssetId, ComputerSessionId, ObservationId, RunId, ToolCallId } from "@computer-harness/protocol";
import { describe, expect, it } from "vitest";
import type { ActionPolicyContext, ProviderAdapter } from "@computer-harness/runtime";
import { initialRunSnapshot } from "@computer-harness/trajectory";
import { LayeredRiskGuard, ProviderRiskAssessor, ScriptedRiskAssessor } from "./index.js";

const runId = "risk-run" as RunId;
const observation = {
  id: "observation-1" as ObservationId,
  runId,
  computerSessionId: "computer-1" as ComputerSessionId,
  capturedAt: "2026-09-16T00:00:00.000Z",
  viewport: { width: 800, height: 600, coordinateSpace: "physical" as const },
  screenshot: { assetId: "asset-1" as AssetId, relativePath: "screenshots/one.png", mediaType: "image/png", byteLength: 1 },
};
const session = { id: observation.computerSessionId, backend: "fake", viewport: observation.viewport, capabilities: { screenshot: true, pointer: true, keyboard: true, accessibility: false }, openedAt: observation.capturedAt };

function context(effect: "navigate" | "financial" | "local_edit" | "unknown", target = "Details", summary = "Open details", kind: "click" | "type" = "click"): ActionPolicyContext {
  const call = { id: "call-1" as ToolCallId, name: kind, arguments: kind === "click" ? { x: 10, y: 20 } : { text: "hello" }, declaredEffect: { effects: [effect], target, summary } };
  const action = kind === "click"
    ? { actionId: "action-1" as ActionId, basedOn: observation.id, kind: "click" as const, point: { x: 10, y: 20 } }
    : { actionId: "action-1" as ActionId, basedOn: observation.id, kind: "type" as const, text: "hello" };
  const snapshot = initialRunSnapshot(runId);
  return { runId, goal: "Inspect a product and buy it only after confirmation", recentUserInputs: [], candidate: { calls: [call], actions: [action], decisionObservation: observation, session }, snapshot };
}

function protectedContext(
  effect: "observe" | "local_edit" | "unknown",
  target: string,
  summary: string,
): ActionPolicyContext {
  const call = {
    id: "protected-call" as ToolCallId,
    name: "type",
    arguments: { text: "password=SYNTHETIC_ONLY" },
    declaredEffect: { effects: [effect], target, summary },
  };
  const snapshot = initialRunSnapshot(runId);
  return {
    runId,
    goal: "Fill the requested field",
    recentUserInputs: [],
    candidate: {
      calls: [call],
      actions: [{ actionId: "protected-action" as ActionId, basedOn: observation.id, kind: "type", text: "password=SYNTHETIC_ONLY" }],
      decisionObservation: observation,
      session,
    },
    snapshot,
  };
}

function keypressContext(effect: "unknown" | "navigate" = "unknown"): ActionPolicyContext {
  const snapshot = initialRunSnapshot(runId);
  return {
    runId,
    goal: "Use the configured shortcut",
    recentUserInputs: [],
    candidate: {
      calls: [{
        id: "shortcut-call" as ToolCallId,
        name: "hotkey",
        arguments: { keys: ["CTRL", "ALT", "DELETE"] },
        declaredEffect: { effects: [effect], target: "System shortcut", summary: "Use the shortcut" },
      }],
      actions: [{ actionId: "shortcut-action" as ActionId, basedOn: observation.id, kind: "keypress", keys: ["CTRL", "ALT", "DELETE"] }],
      decisionObservation: observation,
      session,
    },
    snapshot,
  };
}

describe("LayeredRiskGuard", () => {
  it("allows declared low-impact actions and requires approval for declared financial actions without a reviewer", async () => {
    const guard = new LayeredRiskGuard();
    await expect(guard.evaluate(context("navigate"), new AbortController().signal)).resolves.toMatchObject({ decision: "allow", path: "local", modelRequestCount: 0 });
    await expect(guard.evaluate(context("financial", "Confirm payment", "Pay for order"), new AbortController().signal)).resolves.toMatchObject({ decision: "require_approval", path: "local", modelRequestCount: 0, categories: ["financial"] });
  });

  it("reviews a low-risk declaration whose target implies an undeclared commitment", async () => {
    const assessor = new ScriptedRiskAssessor({ effects: ["external_commitment"], alignment: "aligned", evidence: "The target submits the form." });
    const guard = new LayeredRiskGuard({ assessor });
    await expect(guard.evaluate(context("navigate", "Submit order", "Submit this order"), new AbortController().signal)).resolves.toMatchObject({ decision: "require_approval", path: "model", modelRequestCount: 1, categories: ["external_commitment"] });
  });

  it("reviews risk words quoted in typed content", async () => {
    const guard = new LayeredRiskGuard();
    await expect(guard.evaluate(context("local_edit", "Draft", "Write the phrase \"do not send\"", "type"), new AbortController().signal)).resolves.toMatchObject({ decision: "require_approval", path: "fallback", reasonCode: "semantic_review_unavailable" });
  });

  it.each([
    ["unknown", protectedContext("unknown", "Input", "Fill the field")],
    ["contradiction", protectedContext("observe", "Input", "Observe the field")],
    ["text ambiguity", protectedContext("local_edit", "Confirm payment", "Click Confirm payment")],
  ] as const)("keeps protected input mandatory when %s would otherwise enter semantic review", async (_label, candidate) => {
    let reviewerCalls = 0;
    const assessor = {
      id: "low-risk-reviewer",
      async classify() {
        reviewerCalls += 1;
        return { effects: ["local_edit"] as const, alignment: "aligned" as const, evidence: "Synthetic low-risk review" };
      },
    };
    await expect(new LayeredRiskGuard({ assessor }).evaluate(candidate, new AbortController().signal)).resolves.toMatchObject({
      decision: "require_approval",
      path: "local",
      reasonCode: "protected_input",
      modelRequestCount: 0,
    });
    expect(reviewerCalls).toBe(0);
  });

  it("keeps host deny above reviewer allow", async () => {
    let reviewerCalls = 0;
    const assessor = {
      id: "low-risk-reviewer",
      async classify() {
        reviewerCalls += 1;
        return { effects: ["local_edit"] as const, alignment: "aligned" as const, evidence: "Synthetic low-risk review" };
      },
    };
    await expect(new LayeredRiskGuard({ assessor, forbiddenShortcuts: ["CTRL+ALT+DELETE"] }).evaluate(keypressContext(), new AbortController().signal)).resolves.toMatchObject({
      decision: "deny",
      path: "local",
      reasonCode: "forbidden_shortcut",
      modelRequestCount: 0,
    });
    expect(reviewerCalls).toBe(0);
  });

  it("keeps semantic review available for non-mandatory uncertainty", async () => {
    const assessor = new ScriptedRiskAssessor({ effects: ["local_edit"], alignment: "aligned", evidence: "Synthetic low-risk review" });
    await expect(new LayeredRiskGuard({ assessor }).evaluate(context("unknown"), new AbortController().signal)).resolves.toMatchObject({ decision: "allow", path: "model", modelRequestCount: 1 });
    await expect(new LayeredRiskGuard({ assessor }).evaluate(context("navigate", "Confirm payment", "Click Confirm payment"), new AbortController().signal)).resolves.toMatchObject({ decision: "allow", path: "model", modelRequestCount: 1 });
  });

  it("fails closed when semantic review errors, times out, or exhausts its budget", async () => {
    await expect(new LayeredRiskGuard({ assessor: new ScriptedRiskAssessor(new Error("synthetic reviewer failure")) }).evaluate(context("unknown"), new AbortController().signal)).resolves.toMatchObject({
      decision: "require_approval",
      path: "fallback",
      reasonCode: "risk_model_failed",
      modelRequestCount: 1,
    });

    const timeoutAssessor = {
      id: "timeout-reviewer",
      async classify(_input: ActionPolicyContext, signal: AbortSignal) {
        return await new Promise<never>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason ?? new Error("synthetic review timeout")), { once: true });
        });
      },
    };
    await expect(new LayeredRiskGuard({ assessor: timeoutAssessor, timeoutMs: 5 }).evaluate(context("unknown"), new AbortController().signal)).resolves.toMatchObject({
      decision: "require_approval",
      path: "fallback",
      reasonCode: "risk_model_failed",
      modelRequestCount: 1,
    });

    await expect(new LayeredRiskGuard({ assessor: new ScriptedRiskAssessor({ effects: ["local_edit"], alignment: "aligned", evidence: "low" }), maxModelRequests: 0 }).evaluate(context("unknown"), new AbortController().signal)).resolves.toMatchObject({
      decision: "require_approval",
      path: "fallback",
      reasonCode: "risk_model_budget_exhausted",
      modelRequestCount: 0,
    });
  });

  it("does not let view/draft words suppress a mixed payment signal", async () => {
    await expect(new LayeredRiskGuard().evaluate(context("navigate", "Confirm payment", "View the bill then click Confirm payment"), new AbortController().signal)).resolves.toMatchObject({
      decision: "require_approval",
      path: "fallback",
      reasonCode: "semantic_review_unavailable",
    });
    await expect(new LayeredRiskGuard().evaluate(context("navigate", "Payment history", "View payment history"), new AbortController().signal)).resolves.toMatchObject({
      decision: "allow",
      path: "local",
      reasonCode: "declared_low_impact",
      modelRequestCount: 0,
    });
    await expect(new LayeredRiskGuard().evaluate(context("local_edit", "Payment history", "View payment history"), new AbortController().signal)).resolves.toMatchObject({
      decision: "require_approval",
      path: "fallback",
      reasonCode: "semantic_review_unavailable",
    });
    await expect(new LayeredRiskGuard().evaluate(context("local_edit", "Draft", "Draft an email to send"), new AbortController().signal)).resolves.toMatchObject({
      decision: "require_approval",
      path: "fallback",
      reasonCode: "semantic_review_unavailable",
    });
  });

  it.each([
    ["view payment history followed by purchase", context("navigate", "Payment history", "View payment history, then purchase item")],
    ["do not send draft followed by submit", context("local_edit", "Draft", "Do not send the draft; submit the order")],
    ["查看支付历史后购买商品", context("navigate", "支付历史", "查看支付历史后购买商品")],
    ["不要发送草稿随后提交订单", context("local_edit", "草稿", "不要发送草稿，随后提交订单")],
  ] as const)("does not exempt a later high-impact action after %s", async (_label, candidate) => {
    await expect(new LayeredRiskGuard().evaluate(candidate, new AbortController().signal)).resolves.toMatchObject({
      decision: "require_approval",
      path: "fallback",
      reasonCode: "semantic_review_unavailable",
    });
  });

  it.each([
    ["do not send draft but submit order", context("local_edit", "Draft", "Do not send the draft but submit the order")],
    ["do not pay old invoice but transfer funds", context("navigate", "Old invoice", "Do not pay the old invoice but transfer the funds")],
    ["不要发送草稿但提交订单", context("local_edit", "草稿", "不要发送草稿但提交订单")],
  ] as const)("does not let an unpunctuated conjunction extend a negation exemption: %s", async (_label, candidate) => {
    await expect(new LayeredRiskGuard().evaluate(candidate, new AbortController().signal)).resolves.toMatchObject({
      decision: "require_approval",
      path: "fallback",
      reasonCode: "semantic_review_unavailable",
    });
  });

  it("reviews ordinary unquoted negated risk wording", async () => {
    await expect(new LayeredRiskGuard().evaluate(context("local_edit", "Draft", "Write the phrase do not send", "type"), new AbortController().signal)).resolves.toMatchObject({
      decision: "require_approval",
      path: "fallback",
      reasonCode: "semantic_review_unavailable",
    });
  });

  it.each([
    ["quoted submit", context("navigate", "Button", "Click \"submit\"")],
    ["apostrophe before submit", context("navigate", "Order", "Don't wait, submit user's order")],
  ] as const)("does not treat quoted punctuation as a risk exemption: %s", async (_label, candidate) => {
    await expect(new LayeredRiskGuard().evaluate(candidate, new AbortController().signal)).resolves.toMatchObject({
      decision: "require_approval",
      path: "fallback",
      reasonCode: "semantic_review_unavailable",
    });
  });

  it("fails closed for missing declarations and unavailable ambiguous review", async () => {
    const missing = context("navigate");
    missing.candidate.calls[0]!.declaredEffect = undefined;
    const guard = new LayeredRiskGuard();
    await expect(guard.evaluate(missing, new AbortController().signal)).resolves.toMatchObject({ decision: "deny", reasonCode: "missing_effect_declaration" });
    await expect(guard.evaluate(context("unknown"), new AbortController().signal)).resolves.toMatchObject({ decision: "require_approval", path: "fallback", modelRequestCount: 0 });
  });

  it("redacts likely secrets from provider review evidence", async () => {
    const provider: ProviderAdapter = { id: "fake-reviewer", async generate() { return { type: "tool_calls", calls: [{ id: "risk-1" as ToolCallId, name: "risk_classification", arguments: { effects: ["unknown"], alignment: "unclear", evidence: "password=top-secret-value card 1234567890123456" } }] }; } };
    await expect(new ProviderRiskAssessor(provider).classify(context("unknown"), new AbortController().signal)).resolves.toMatchObject({ evidence: "password=[redacted] card [redacted-number]" });
  });
});
