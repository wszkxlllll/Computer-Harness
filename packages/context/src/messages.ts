import type { ModelContentBlock, ModelMessage } from "@computer-harness/runtime";
import type { ObservationFrame, ModelTurn, RuntimeEvent, ToolResult, Viewport } from "@computer-harness/protocol";
import { isGroundingWebUrl } from "@computer-harness/protocol";

export function observedPageUrlText(observation: ObservationFrame): string | undefined {
  const grounding = observation.grounding;
  if (grounding === undefined || grounding.observationId !== observation.id ||
      grounding.computerSessionId !== observation.computerSessionId ||
      grounding.surfaceRef.surfaceId !== observation.surfaceRef.surfaceId ||
      grounding.surfaceRef.generation !== observation.surfaceRef.generation ||
      grounding.surfaceRef.kind !== observation.surfaceRef.kind ||
      grounding.surfaceRef.parentSurfaceId !== observation.surfaceRef.parentSurfaceId ||
      grounding.surfaceRef.admissionSource !== observation.surfaceRef.admissionSource) return undefined;
  const pageUrl = grounding.pageUrl;
  if (!isGroundingWebUrl(pageUrl)) return undefined;
  return `Observed page URL source data: ${JSON.stringify({
    observationId: observation.id,
    capturedAt: observation.capturedAt,
    pageUrl,
  })}`;
}

export function modelTurnMessage(
  turn: ModelTurn,
  viewport: Viewport | undefined,
): ModelMessage {
  switch (turn.type) {
    case "tool_calls": {
      const content: ModelContentBlock[] = [];
      if (turn.assistantText !== undefined && turn.assistantText.trim().length > 0) {
        content.push({ type: "text", text: turn.assistantText });
      }
      if (turn.continuation !== undefined) {
        content.push({ type: "provider_continuation", continuation: turn.continuation });
      }
      if (turn.observationAssessment !== undefined) {
        content.push({ type: "text", text: `Prior model-reported ObservationAssessment (untrusted evidence): ${JSON.stringify(turn.observationAssessment)}` });
      }
      for (const call of turn.calls) {
        content.push({ type: "tool_call", call, ...(viewport === undefined ? {} : { viewport }) });
      }
      return { role: "assistant", content };
    }
    case "user_input_required":
      return {
        role: "assistant",
        content: [
          { type: "text", text: turn.question },
          ...(turn.observationAssessment === undefined ? [] : [{ type: "text" as const, text: `Prior model-reported ObservationAssessment (untrusted evidence): ${JSON.stringify(turn.observationAssessment)}` }]),
        ],
      };
    case "finish":
      return {
        role: "assistant",
        content: [
          { type: "text", text: turn.reportedStatus === undefined ? turn.summary : `${turn.summary} [reportedStatus=${turn.reportedStatus}]` },
          ...(turn.observationAssessment === undefined ? [] : [{ type: "text" as const, text: `Prior model-reported ObservationAssessment (untrusted evidence): ${JSON.stringify(turn.observationAssessment)}` }]),
        ],
      };
  }
}

export function toolResultMessage(result: ToolResult): ModelMessage {
  return { role: "tool", content: [{ type: "tool_result", result }] };
}

export function findLatestObservation(events: readonly RuntimeEvent[]): ObservationFrame | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type === "observation.created") {
      return event.observation;
    }
  }
  return undefined;
}
