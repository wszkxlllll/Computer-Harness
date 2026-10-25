import { describe, expect, it } from "vitest";
import type {
  ActionId,
  ComputerSessionId,
  EventId,
  ObservationAssessment,
  ObservationFrame,
  ObservationId,
  ObservationTransition,
  RunId,
  RuntimeEvent,
  RuntimeEventData,
  SurfaceRef,
  ToolCallId,
} from "@computer-harness/protocol";
import { projectCurrentMonitorGuidance, projectMonitorCandidateGuidance, projectRecentAssessmentGuidance } from "./monitor-guidance.js";
import type { ProgressMonitorOutput } from "./progress-monitor.js";

const runId = "guidance-run" as RunId;
const otherRunId = "other-guidance-run" as RunId;
const baseSurface: SurfaceRef = { surfaceId: "guidance-desktop" as SurfaceRef["surfaceId"], generation: 1, kind: "desktop" };
const otherSurface: SurfaceRef = { ...baseSurface, surfaceId: "other-guidance-desktop" as SurfaceRef["surfaceId"] };
const privateTypedText = "PRIVATE_TYPED_VALUE";

interface GuidanceFixture {
  readonly events: readonly RuntimeEvent[];
  readonly latestObservation: ObservationFrame;
  readonly assessmentResponse: RuntimeEvent;
  readonly currentObservationEvent: RuntimeEvent;
  readonly secondReceipt: RuntimeEvent;
}

function makeEvent(eventRunId: RunId, sequence: number, eventId: string, data: RuntimeEventData): RuntimeEvent {
  return {
    eventId: eventId as EventId,
    runId: eventRunId,
    sequence,
    occurredAt: `2026-10-16T00:00:${String(sequence).padStart(2, "0")}Z`,
    ...data,
  };
}

function makeObservation(
  eventRunId: RunId,
  sequence: number,
  eventId: string,
  id: string,
  surfaceRef: SurfaceRef = baseSurface,
): RuntimeEvent {
  const observation: ObservationFrame = {
    id: id as ObservationId,
    runId: eventRunId,
    computerSessionId: "guidance-session" as ComputerSessionId,
    surfaceRef,
    capturedAt: "2026-10-16T00:00:00Z",
    viewport: { width: 800, height: 600, coordinateSpace: "physical" },
    screenshot: { assetId: `asset-${id}` as ObservationFrame["screenshot"]["assetId"], relativePath: "test.png", mediaType: "image/png", byteLength: 1 },
  };
  return makeEvent(eventRunId, sequence, eventId, { type: "observation.created", observation });
}

function makeFixture(options: {
  readonly interveningTransition?: ObservationTransition;
  readonly crossSurface?: boolean;
  readonly crossRunCurrentObservation?: boolean;
  readonly userCorrection?: boolean;
  readonly mismatchedAssessmentId?: "action" | "observation";
  readonly typedText?: string;
  readonly evidence?: string;
} = {}): GuidanceFixture {
  const obsAEvent = makeObservation(runId, 0, "event-observation-a", "observation-a");
  const actionAEvent = makeEvent(runId, 1, "event-action-a", {
    type: "action.proposed",
    callId: "call-a" as ToolCallId,
    action: {
      actionId: "action-a" as ActionId,
      kind: "type",
      basedOn: "observation-a" as ObservationId,
      text: options.typedText ?? `${privateTypedText}\u0002`,
    },
  });
  const receiptA = makeEvent(runId, 2, "event-receipt-a", {
    type: "action.execution.completed",
    receipt: { actionId: "action-a" as ActionId, status: "completed" },
  });
  const obsOneEvent = makeObservation(runId, 3, "event-observation-o1", "observation-o1");
  const transitionA = makeEvent(runId, 4, "event-transition-a", {
    type: "monitor.transition",
    actionId: "action-a" as ActionId,
    preObservationId: "observation-a" as ObservationId,
    postObservationId: "observation-o1" as ObservationId,
    sourceActionEventId: receiptA.eventId,
    sourceObservationEventId: obsOneEvent.eventId,
    transition: "unchanged",
  });
  const assessment: ObservationAssessment = {
    observationId: (options.mismatchedAssessmentId === "observation" ? "stale-observation" : "observation-o1") as ObservationId,
    actionId: (options.mismatchedAssessmentId === "action" ? "stale-action" : "action-a") as ActionId,
    actionOutcome: "no_effect",
    evidence: options.evidence ?? `Search field remained blank; ${privateTypedText}; owner@example.com; 15551234567`,
  };
  const assessmentResponse = makeEvent(runId, 5, "event-assessment-response", {
    type: "model.response.received",
    turn: { type: "finish", summary: "continue", observationAssessment: assessment },
  });
  const correction = options.userCorrection
    ? [makeEvent(runId, 6, "event-user-correction", { type: "user.input.received", text: "The issue is resolved." })]
    : [];
  const actionBSequence = options.userCorrection ? 7 : 6;
  const actionBEvent = makeEvent(runId, actionBSequence, "event-action-b", {
    type: "action.proposed",
    callId: "call-b" as ToolCallId,
    action: { actionId: "action-b" as ActionId, kind: "click", basedOn: "observation-o1" as ObservationId, point: { x: 12, y: 14 } },
  });
  const receiptBSequence = actionBSequence + 1;
  const receiptB = makeEvent(runId, receiptBSequence, "event-receipt-b", {
    type: "action.execution.completed",
    receipt: { actionId: "action-b" as ActionId, status: "completed" },
  });
  const currentObservationSequence = receiptBSequence + 1;
  const currentObservationRun = options.crossRunCurrentObservation ? otherRunId : runId;
  const currentObservationEvent = makeObservation(
    currentObservationRun,
    currentObservationSequence,
    "event-observation-o2",
    "observation-o2",
    options.crossSurface ? otherSurface : baseSurface,
  );
  const latestObservation = (currentObservationEvent as Extract<RuntimeEvent, { type: "observation.created" }>).observation;
  const transitionB = makeEvent(runId, currentObservationSequence + 1, "event-transition-b", {
    type: "monitor.transition",
    actionId: "action-b" as ActionId,
    preObservationId: "observation-o1" as ObservationId,
    postObservationId: "observation-o2" as ObservationId,
    sourceActionEventId: receiptB.eventId,
    sourceObservationEventId: currentObservationEvent.eventId,
    transition: options.interveningTransition ?? "unchanged",
  });

  return {
    events: [obsAEvent, actionAEvent, receiptA, obsOneEvent, transitionA, assessmentResponse, ...correction, actionBEvent, receiptB, currentObservationEvent, transitionB],
    latestObservation,
    assessmentResponse,
    currentObservationEvent,
    secondReceipt: receiptB,
  };
}

const emptyMonitorOutput: ProgressMonitorOutput = { candidate: false, reasons: [], evidence: [], eventIds: [] };

function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

describe("monitor guidance projection", () => {
  it.each(["user correction", "handoff", "unknown transition", "Surface change"] as const)(
    "starts the declared-target guidance tail after a %s and ignores pre-boundary assessment text",
    (boundaryKind) => {
      const events: RuntimeEvent[] = [];
      let sequence = 0;
      let latestObservationEvent = makeObservation(runId, sequence++, "episode-observation-0", "episode-observation-0");
      events.push(latestObservationEvent);
      let latestObservation = (latestObservationEvent as Extract<RuntimeEvent, { type: "observation.created" }>).observation;

      const attempt = (id: string, evidence?: string, surfaceRef: SurfaceRef = baseSurface): RuntimeEvent => {
        const callId = `episode-call-${id}` as ToolCallId;
        events.push(makeEvent(runId, sequence++, `episode-call-event-${id}`, {
          type: "tool.call.received",
          call: {
            id: callId,
            name: "click",
            arguments: { x: sequence, y: 20 },
            declaredEffect: { effects: ["navigate"], target: "Search field", summary: `Check search attempt ${id}` },
          },
        }));
        const actionId = `episode-action-${id}` as ActionId;
        const proposal = makeEvent(runId, sequence++, `episode-proposal-${id}`, {
          type: "action.proposed",
          callId,
          action: { actionId, kind: "click", basedOn: latestObservation.id, point: { x: sequence, y: 20 } },
        });
        events.push(proposal);
        const receipt = makeEvent(runId, sequence++, `episode-receipt-${id}`, {
          type: "action.execution.completed",
          receipt: { actionId, status: "completed" },
        });
        events.push(receipt);
        if (evidence === undefined) return receipt;

        const postObservationId = `episode-observation-${id}`;
        const postObservationEvent = makeObservation(runId, sequence++, `episode-observation-event-${id}`, postObservationId, surfaceRef);
        events.push(postObservationEvent);
        events.push(makeEvent(runId, sequence++, `episode-transition-${id}`, {
          type: "monitor.transition",
          actionId,
          preObservationId: latestObservation.id,
          postObservationId: postObservationId as ObservationId,
          sourceActionEventId: receipt.eventId,
          sourceObservationEventId: postObservationEvent.eventId,
          transition: "unchanged",
        }));
        events.push(makeEvent(runId, sequence++, `episode-assessment-${id}`, {
          type: "model.response.received",
          turn: {
            type: "finish",
            summary: "continue",
            observationAssessment: {
              observationId: postObservationId as ObservationId,
              actionId,
              actionOutcome: "no_effect",
              evidence,
            },
          },
        }));
        latestObservationEvent = postObservationEvent;
        latestObservation = (postObservationEvent as Extract<RuntimeEvent, { type: "observation.created" }>).observation;
        return receipt;
      };

      attempt("before-1", "OLD_ASSESSMENT_SENTINEL");
      attempt("before-2", "OLD_ASSESSMENT_SENTINEL");
      const oldActionId = "episode-action-before-2" as ActionId;
      if (boundaryKind === "user correction") {
        events.push(makeEvent(runId, sequence++, "episode-user-correction", { type: "user.input.received", text: "Use another approach." }));
      } else if (boundaryKind === "handoff") {
        events.push(makeEvent(runId, sequence++, "episode-handoff", { type: "computer.window.handoff.ignored", sourceActionId: oldActionId }));
      } else if (boundaryKind === "unknown transition") {
        events.push(makeEvent(runId, sequence++, "episode-unknown-transition", {
          type: "monitor.transition",
          actionId: oldActionId,
          preObservationId: latestObservation.id,
          postObservationId: latestObservation.id,
          sourceActionEventId: "episode-old-receipt" as EventId,
          sourceObservationEventId: latestObservationEvent.eventId,
          transition: "unknown",
        }));
      } else {
        latestObservationEvent = makeObservation(runId, sequence++, "episode-partition-observation", "episode-partition-observation", otherSurface);
        events.push(latestObservationEvent);
        latestObservation = (latestObservationEvent as Extract<RuntimeEvent, { type: "observation.created" }>).observation;
      }

      attempt("after-1");
      expect(projectCurrentMonitorGuidance(events, runId, latestObservation)).toBeUndefined();

      attempt("after-2", "Fresh post-boundary no-effect evidence.", latestObservation.surfaceRef);
      attempt("after-3", "Fresh post-boundary no-effect evidence.", latestObservation.surfaceRef);
      const projection = projectCurrentMonitorGuidance(events, runId, latestObservation);
      expect(projection).toBeDefined();
      expect(projection?.text).toContain("Model-declared target");
      expect(projection?.text).toContain("no_effect (unverified)");
      expect(projection?.text).not.toContain("OLD_ASSESSMENT_SENTINEL");
    },
  );

  it("names repeated declared target/effect and preserves only an unverified prior report across changed screens", () => {
    const events: RuntimeEvent[] = [];
    let sequence = 0;
    let previousObservationId = "effect-observation-0";
    events.push(makeObservation(runId, sequence++, "effect-observation-event-0", previousObservationId));
    const repeatedActionIds: EventId[] = [];
    let latestObservation: ObservationFrame | undefined;
    let latestReceipt: RuntimeEvent | undefined;

    for (let index = 1; index <= 3; index += 1) {
      const actionId = `declared-action-${index}` as ActionId;
      const callId = `declared-call-${index}` as ToolCallId;
      const nextObservationId = `effect-observation-${index}`;
      events.push(makeEvent(runId, sequence++, `declared-call-event-${index}`, {
        type: "tool.call.received",
        call: {
          id: callId,
          name: "click",
          arguments: { x: 20 + index, y: 30 },
          declaredEffect: { effects: ["navigate"], target: "Official site search field", summary: `Search attempt ${index}` },
        },
      }));
      const proposal = makeEvent(runId, sequence++, `declared-proposal-${index}`, {
        type: "action.proposed",
        callId,
        action: { actionId, kind: "click", basedOn: previousObservationId as ObservationId, point: { x: 20 + index, y: 30 } },
      });
      events.push(proposal);
      repeatedActionIds.push(proposal.eventId);
      const receipt = makeEvent(runId, sequence++, `declared-receipt-${index}`, {
        type: "action.execution.completed",
        receipt: { actionId, status: "completed" },
      });
      events.push(receipt);
      latestReceipt = receipt;
      const nextObservation = makeObservation(runId, sequence++, `declared-observation-event-${index}`, nextObservationId);
      events.push(nextObservation);
      latestObservation = (nextObservation as Extract<RuntimeEvent, { type: "observation.created" }>).observation;
      events.push(makeEvent(runId, sequence++, `declared-transition-${index}`, {
        type: "monitor.transition",
        actionId,
        preObservationId: previousObservationId as ObservationId,
        postObservationId: nextObservationId as ObservationId,
        sourceActionEventId: receipt.eventId,
        sourceObservationEventId: nextObservation.eventId,
        transition: "changed",
      }));
      if (index < 3) {
        events.push(makeEvent(runId, sequence++, `declared-assessment-${index}`, {
          type: "model.response.received",
          turn: {
            type: "finish",
            summary: "continue",
            observationAssessment: {
              observationId: nextObservationId as ObservationId,
              actionId,
              actionOutcome: "unexpected_change",
              evidence: "The search field still appears blank.",
            },
          },
        }));
      }
      previousObservationId = nextObservationId;
    }

    const latestActionId = `declared-action-3` as ActionId;
    const repeatedReason = {
      code: "repeated_declared_effect" as const,
      eventIds: repeatedActionIds,
    };
    const output: ProgressMonitorOutput = {
      candidate: true,
      reasons: [repeatedReason],
      evidence: [{ kind: "action_receipt", eventIds: [latestReceipt?.eventId as EventId] }],
      eventIds: [latestReceipt?.eventId as EventId],
    };
    const candidate = projectMonitorCandidateGuidance({
      event: latestReceipt!,
      output,
      events,
      runId,
      ...(latestObservation === undefined ? {} : { latestObservation }),
    });
    const current = projectCurrentMonitorGuidance(events, runId, latestObservation);

    expect(candidate.text).toContain("Model-declared target");
    expect(candidate.text).toContain("Official site search field");
    expect(candidate.text).toContain("Search attempt 3");
    expect(candidate.text).toContain("unexpected_change (unverified)");
    expect(candidate.text).toContain("The search field still appears blank");
    expect(candidate.text).toContain("Recheck newest image");
    expect(candidate.text).toContain("pixels alone are not proof");
    expect(candidate.text.length).toBeLessThanOrEqual(240);
    expect(current?.text).toBe(candidate.text);
    expect(events.some((event) => event.type === "action.proposed" && event.action.actionId === latestActionId)).toBe(true);
  });

  it("carries a bounded, untrusted assessment through a later unchanged action on the same Surface", () => {
    const fixture = makeFixture();
    const projection = projectRecentAssessmentGuidance(fixture.events, runId, fixture.latestObservation);

    expect(projection).toBeDefined();
    if (projection === undefined) return;
    expect(projection.text).toContain("Search field remained blank");
    expect(projection.text.toLocaleLowerCase("en-US")).toMatch(/untrusted/iu);
    expect(projection.text.toLocaleLowerCase("en-US")).toMatch(/not verified|unverified|unconfirmed/iu);
    expect(projection.text.toLocaleLowerCase("en-US")).toMatch(/is (?:.*issue|it) resolved\?/iu);
    expect(projection.text.length).toBeLessThanOrEqual(240);
    expect(projection.sourceEventIds).toContain(fixture.assessmentResponse.eventId);
    expect(projection.sourceEventIds).toContain(fixture.currentObservationEvent.eventId);
    expect(projection.sourceEventIds.length).toBeLessThanOrEqual(12);
    expect(projection.text).not.toContain(privateTypedText);
    expect(projection.text).not.toContain("owner@example.com");
    expect(projection.text).not.toContain("15551234567");
    expect(projection.text).not.toMatch(/[\u0000-\u001f\u007f]/u);
  });

  it("preserves short Chinese evidence when it does not contain the short typed value", () => {
    const evidence = "输入框仍为空，未显示查询内容";
    const fixture = makeFixture({ typedText: "上海", evidence });
    const projection = projectRecentAssessmentGuidance(fixture.events, runId, fixture.latestObservation);

    expect(projection).toBeDefined();
    if (projection === undefined) return;
    expect(projection.text).toContain(evidence);
    expect(projection.text).not.toContain("typed text omitted");
  });

  it("masks a long typed sentinel before limiting the evidence quote", () => {
    const typedText = `LONG_TYPED_SENTINEL_${"x".repeat(165)}`;
    const fixture = makeFixture({ typedText, evidence: `${typedText} remained in the field` });
    const projection = projectRecentAssessmentGuidance(fixture.events, runId, fixture.latestObservation);

    expect(projection).toBeDefined();
    if (projection === undefined) return;
    expect(projection.text).toContain("[typed text omitted]");
    expect(projection.text).not.toContain("LONG_TYPED_SENTINEL_");
    expect(projection.text).not.toContain(typedText);
  });

  it("bounds emoji and Chinese evidence by UTF-16 length without splitting a surrogate or losing the resolution prompt", () => {
    const evidence = `输入框仍为空 ${"😀界".repeat(70)}`;
    const fixture = makeFixture({ typedText: "PRIVATE_VALUE_NOT_IN_EVIDENCE", evidence });
    const projection = projectRecentAssessmentGuidance(fixture.events, runId, fixture.latestObservation);

    expect(projection).toBeDefined();
    if (projection === undefined) return;
    expect(projection.text.length).toBeLessThanOrEqual(240);
    expect(hasLoneSurrogate(projection.text)).toBe(false);
    expect(projection.text).toMatch(/is (?:it resolved|.*issue resolved)\?\s*(?:then )?(?:continue(?: or change method)?|change method)\./iu);
  });

  it.each(["changed", "unknown"] as const)("does not reuse assessment guidance after an intervening %s transition", (transition) => {
    const fixture = makeFixture({ interveningTransition: transition });
    expect(projectRecentAssessmentGuidance(fixture.events, runId, fixture.latestObservation)).toBeUndefined();
  });

  it("does not reuse assessment guidance across a Surface change", () => {
    const fixture = makeFixture({ crossSurface: true });
    expect(projectRecentAssessmentGuidance(fixture.events, runId, fixture.latestObservation)).toBeUndefined();
  });

  it("does not reuse assessment guidance when the current observation belongs to another Run", () => {
    const fixture = makeFixture({ crossRunCurrentObservation: true });
    expect(projectRecentAssessmentGuidance(fixture.events, runId, fixture.latestObservation)).toBeUndefined();
  });

  it("drops stale assessment guidance after a user correction", () => {
    const fixture = makeFixture({ userCorrection: true });
    expect(projectRecentAssessmentGuidance(fixture.events, runId, fixture.latestObservation)).toBeUndefined();
  });

  it.each(["action", "observation"] as const)("falls back to safe current-action guidance when the assessment %s ID mismatches", (mismatchedAssessmentId) => {
    const fixture = makeFixture({ mismatchedAssessmentId });
    expect(projectRecentAssessmentGuidance(fixture.events, runId, fixture.latestObservation)).toBeUndefined();

    const fallback = projectMonitorCandidateGuidance({
      event: fixture.secondReceipt,
      output: emptyMonitorOutput,
      events: fixture.events,
      runId,
      latestObservation: fixture.latestObservation,
    });
    expect(fallback.text.toLocaleLowerCase("en-US")).toMatch(/check|inspect/iu);
    expect(fallback.text).not.toContain(privateTypedText);
    expect(fallback.text).not.toContain("owner@example.com");
    expect(fallback.text).not.toContain("15551234567");
    expect(fallback.text).not.toMatch(/[\u0000-\u001f\u007f]/u);
  });
});
