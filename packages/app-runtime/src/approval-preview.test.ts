import { describe, expect, it } from "vitest";
import type { EventId, RunId, RuntimeEvent, ToolCallId } from "@computer-harness/protocol";
import { projectApprovalPreview } from "./approval-preview.js";

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
