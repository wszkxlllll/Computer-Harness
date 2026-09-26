import { describe, expect, it } from "vitest";
import type { AssetId, ComputerSessionId, EventId, ObservationId, RunId, RuntimeEvent, ToolCallId } from "@computer-harness/protocol";
import { approvalRequiresVisualReview, projectApprovalPreview } from "./approval-preview.js";

function event(sequence: number, data: Record<string, unknown>): RuntimeEvent {
  return {
    runId: "approval-preview-test" as RunId,
    eventId: `approval-preview-event-${sequence}` as EventId,
    sequence,
    occurredAt: "2026-09-26T00:00:00.000Z",
    ...data,
  } as RuntimeEvent;
}

describe("projectApprovalPreview", () => {
  it("uses an authoritative discriminator and fails closed for legacy or contradictory approvals", () => {
    const nonComputer = event(1, {
      type: "approval.requested",
      requestId: "non-computer-approval",
      callId: "side-call" as ToolCallId,
      reason: "Confirm the side effect.",
      requiresVisualReview: false,
    });
    const legacyUnknown = event(2, {
      type: "approval.requested",
      requestId: "legacy-approval",
      callId: "legacy-call" as ToolCallId,
      reason: "Legacy request.",
    });
    const contradictory = event(3, {
      type: "approval.requested",
      requestId: "contradictory-approval",
      callId: "computer-call" as ToolCallId,
      reason: "Computer action.",
      requiresVisualReview: false,
      actions: [{ actionId: "computer-action", basedOn: "decision" as ObservationId, kind: "click", point: { x: 10, y: 10 } }],
    });

    expect(approvalRequiresVisualReview([nonComputer], "non-computer-approval", "side-call" as ToolCallId)).toBe(false);
    expect(approvalRequiresVisualReview([legacyUnknown], "legacy-approval", "legacy-call" as ToolCallId)).toBe(true);
    expect(approvalRequiresVisualReview([contradictory], "contradictory-approval", "computer-call" as ToolCallId)).toBe(true);
    expect(approvalRequiresVisualReview([], "missing-approval", "missing-call" as ToolCallId)).toBe(true);
  });

  it("projects the exact request-bound screenshot and action when no Guard event exists", () => {
    const privateText = "do-not-project-this-input";
    const evidence = {
      assetId: "approval-frame-asset" as AssetId,
      observationId: "approval-frame" as ObservationId,
      decisionObservationId: "decision-frame" as ObservationId,
      capturedAt: "2026-09-26T12:00:00.000Z",
      viewport: { width: 900, height: 700, coordinateSpace: "physical" as const },
    };
    const events: RuntimeEvent[] = [
      event(1, {
        type: "observation.created",
        observation: {
          id: evidence.decisionObservationId,
          runId: "approval-preview-test" as RunId,
          computerSessionId: "approval-preview-session" as ComputerSessionId,
          capturedAt: "2026-09-26T11:59:00.000Z",
          viewport: evidence.viewport,
          screenshot: { assetId: "decision-frame-asset" as AssetId, relativePath: "screenshots/decision-frame.png", mediaType: "image/png", byteLength: 4 },
        },
      }),
      event(2, {
        type: "observation.created",
        observation: {
          id: evidence.observationId,
          runId: "approval-preview-test" as RunId,
          computerSessionId: "approval-preview-session" as ComputerSessionId,
          capturedAt: evidence.capturedAt,
          viewport: evidence.viewport,
          screenshot: { assetId: evidence.assetId, relativePath: "screenshots/approval-frame.png", mediaType: "image/png", byteLength: 4 },
        },
      }),
      event(3, {
        type: "tool.call.received",
        call: {
          id: "pending-type" as ToolCallId,
          name: "type",
          arguments: { text: privateText },
          declaredEffect: { effects: ["external_commitment"], target: "Message editor", summary: "Send the prepared message" },
        },
      }),
      event(4, {
        type: "approval.requested",
        requestId: "approval-fresh-frame",
        callId: "pending-type" as ToolCallId,
        reason: "Review the exact current frame.",
        evidence,
        actions: [{ actionId: "pending-type-action", basedOn: "decision-frame", kind: "type", textLength: privateText.length }],
      }),
    ];

    const preview = projectApprovalPreview(events, "approval-fresh-frame", "pending-type" as ToolCallId);
    expect(preview).toEqual({
      actions: [{ operation: "type", kind: "type", typedCharacterCount: privateText.length }],
      evidence,
      modelDeclaredEffect: { target: "Message editor", summary: "Send the prepared message", verified: false },
    });
    expect(JSON.stringify(preview)).not.toContain(privateText);
  });

  it("binds to the request call, keeps all guarded batch actions in order, and ignores a later unrelated guard event", () => {
    const privateText = "do-not-project-batch-text";
    const events: RuntimeEvent[] = [
      event(1, {
        type: "tool.call.received",
        call: { id: "older-call", name: "click", arguments: { x: 10, y: 20 }, declaredEffect: { effects: ["navigate"], target: "Old page", summary: "Open old page" } },
      }),
      event(2, {
        type: "action.guard.evaluated",
        callIds: ["older-call"],
        actions: [{ actionId: "older-action", kind: "click", basedOn: "old-observation", point: { x: 10, y: 20 } }],
        decision: "allow",
        categories: [],
        reasonCode: "low_risk",
        reason: "Allowed.",
        path: "local",
        policyVersion: "fixture-v1",
        modelRequestCount: 0,
      }),
      event(3, {
        type: "tool.call.received",
        call: { id: "pending-call", name: "click", arguments: { x: 408, y: 667 }, declaredEffect: { effects: ["navigate"], target: "查询", summary: "点击查询按钮" } },
      }),
      event(4, {
        type: "tool.call.received",
        call: { id: "batch-call", name: "type", arguments: { text: privateText }, declaredEffect: { effects: ["sensitive_disclosure"], target: "Unrelated claim", summary: "Do not attach this claim" } },
      }),
      event(5, {
        type: "action.guard.evaluated",
        callIds: ["pending-call", "batch-call"],
        actions: [
          { actionId: "pending-action", kind: "click", basedOn: "observation", point: { x: 408, y: 667 } },
          { actionId: "batch-action", kind: "type", basedOn: "observation", textLength: privateText.length },
        ],
        decision: "require_approval",
        categories: ["external_commitment"],
        reasonCode: "generic_guard_reason",
        reason: "This action requires approval.",
        path: "local",
        policyVersion: "fixture-v1",
        modelRequestCount: 0,
      }),
      event(6, {
        type: "action.guard.evaluated",
        callIds: ["older-call"],
        actions: [{ actionId: "unrelated-later-action", kind: "click", basedOn: "later-observation", point: { x: 1, y: 2 } }],
        decision: "require_approval",
        categories: ["external_commitment"],
        reasonCode: "unrelated_guard",
        reason: "Unrelated later guard event.",
        path: "local",
        policyVersion: "fixture-v1",
        modelRequestCount: 0,
      }),
      event(7, { type: "approval.requested", requestId: "approval-current", callId: "pending-call", reason: "This action requires approval." }),
    ];

    const preview = projectApprovalPreview(events, "approval-current", "pending-call" as ToolCallId);
    expect(preview).toEqual({
      actions: [
        { operation: "click", kind: "click", points: [{ x: 408, y: 667 }] },
        { operation: "type", kind: "type", typedCharacterCount: privateText.length },
      ],
      modelDeclaredEffect: { target: "查询", summary: "点击查询按钮", verified: false },
    });
    expect(JSON.stringify(preview)).not.toContain(privateText);
    expect(JSON.stringify(preview)).not.toContain("Unrelated claim");
    expect(projectApprovalPreview(events, "another-request", "pending-call" as ToolCallId)).toBeUndefined();
    expect(projectApprovalPreview(events, "approval-current", "older-call" as ToolCallId)).toBeUndefined();
  });
});
