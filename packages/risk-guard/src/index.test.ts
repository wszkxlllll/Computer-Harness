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

  it("does not treat a risk word quoted in typed content as an external commitment", async () => {
    const guard = new LayeredRiskGuard();
    await expect(guard.evaluate(context("local_edit", "Draft", "Write the phrase do not send", "type"), new AbortController().signal)).resolves.toMatchObject({ decision: "allow", modelRequestCount: 0 });
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
