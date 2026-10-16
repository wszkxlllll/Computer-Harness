import { createHash } from "node:crypto";
import type { RunId } from "@computer-harness/protocol";
import type { ProgressMonitorOutput } from "./progress-monitor.js";

const DEFAULTS = {
  mode: "off" as const,
  cooldownWorkUnits: 2,
  maxGuidanceCount: 2,
  maxGuidanceChars: 240,
  maxCandidateAgeWorkUnits: 4,
};

export type MonitorPolicyMode = "off" | "shadow" | "guidance";

export interface MonitorPolicyOptions {
  mode?: MonitorPolicyMode;
  /** Number of model-decision/GUI-action work units between proposals. */
  cooldownWorkUnits?: number;
  maxGuidanceCount?: number;
  maxGuidanceChars?: number;
  /** Candidate age in work units, not committed-event sequence numbers. */
  maxCandidateAgeWorkUnits?: number;
}

export interface MonitorWorkClock {
  modelDecisionCount: number;
  guiActionCount: number;
}

export interface MonitorPolicyInput {
  runId: RunId;
  /** Stable committed session/window partition supplied by the future consumer. */
  partitionKey: string;
  sequence: number;
  clock: MonitorWorkClock;
  monitor: ProgressMonitorOutput;
  /** Ephemeral, already-redacted candidate text. It is persisted in shadow and consumed in guidance only. */
  guidanceText?: string;
  /** The execution barrier is owned by Runtime; Monitor cannot clear it. */
  executionBarrier?: "unknown_outcome" | "pending_side_effect" | "action_in_flight";
  terminal?: boolean;
}

export type MonitorPolicyNoneReason =
  | "disabled"
  | "shadow"
  | "candidate_observed"
  | "guidance_cooldown"
  | "no_candidate"
  | "replayed"
  | "out_of_order"
  | "partition_changed"
  | "terminal"
  | "suppressed_by_execution_barrier"
  | "guidance_budget_exhausted";

export type MonitorPolicyProposal =
  | { kind: "none"; reason: MonitorPolicyNoneReason }
  | { kind: "guidance"; text: string; fingerprint: string };

export interface MonitorPolicyState {
  readonly runId?: RunId | undefined;
  readonly partitionKey?: string | undefined;
  readonly lastSequence?: number | undefined;
  readonly lastClock?: MonitorWorkClock | undefined;
  readonly candidateFingerprint?: string | undefined;
  readonly candidateClock?: MonitorWorkClock | undefined;
  readonly lastGuidanceClock?: MonitorWorkClock | undefined;
  readonly guidanceCount: number;
  readonly options: Readonly<Required<MonitorPolicyOptions>>;
}

export interface MonitorPolicyUpdate {
  readonly state: MonitorPolicyState;
  readonly proposal: MonitorPolicyProposal;
}

export function createMonitorPolicyState(options?: MonitorPolicyOptions): MonitorPolicyState {
  return {
    guidanceCount: 0,
    options: normalizeOptions(options),
  };
}

/**
 * Pure, bounded policy proposal reducer. It never schedules work, changes a
 * Runtime decision, executes a tool, retries a run, or writes a RuntimeEvent.
 */
export function reduceMonitorPolicy(state: MonitorPolicyState, input: MonitorPolicyInput): MonitorPolicyUpdate {
  const options = state.options;
  const base = resetForRunOrPartition(state, input);
  const currentClock = normalizeClock(input.clock, base.lastClock);
  const sequenceState: MonitorPolicyState = {
    ...base,
    lastSequence: input.sequence,
    lastClock: currentClock,
  };
  const episodeState = hasEvidence(input.monitor, "visual_transition_changed")
    ? resetCandidateEpisode(sequenceState)
    : sequenceState;

  if (options.mode === "off") return { state: sequenceState, proposal: { kind: "none", reason: "disabled" } };
  if (input.sequence < (base.lastSequence ?? -1)) {
    return { state, proposal: { kind: "none", reason: "out_of_order" } };
  }
  if (input.sequence === base.lastSequence) {
    return { state, proposal: { kind: "none", reason: "replayed" } };
  }
  if (input.executionBarrier !== undefined) {
    return {
      // A routine action being executed suppresses Monitor output but is not
      // an episode reset. Approval/input/abort barriers and unknown outcomes
      // still clear the candidate; spent prompt budget remains in all cases.
      state: input.executionBarrier === "action_in_flight" ? episodeState : clearCandidate(episodeState),
      proposal: { kind: "none", reason: "suppressed_by_execution_barrier" },
    };
  }
  if (input.terminal) {
    return { state: clearCandidate(episodeState), proposal: { kind: "none", reason: "terminal" } };
  }
  if (!input.monitor.candidate) {
    // A changed image invalidates the old diagnostic episode. It does not
    // establish business progress or success. Unknown evidence drops only the
    // pending recommendation and retains the episode's spent prompt budget.
    if (hasEvidence(input.monitor, "visual_transition_changed")) {
      return { state: episodeState, proposal: { kind: "none", reason: "no_candidate" } };
    }
    if (hasEvidence(input.monitor, "visual_transition_unknown")) {
      return { state: clearCandidate(episodeState), proposal: { kind: "none", reason: "no_candidate" } };
    }
    const candidateAge = episodeState.candidateClock === undefined
      ? 0
      : workDistance(episodeState.candidateClock, currentClock);
    if (episodeState.candidateFingerprint !== undefined && candidateAge > options.maxCandidateAgeWorkUnits) {
      // Ordinary events may sit between two candidate observations, so retain
      // a young candidate for correlation. Once stale, clear the episode and
      // restore its bounded prompt budget; clock movement alone emits nothing.
      return { state: resetCandidateEpisode(episodeState), proposal: { kind: "none", reason: "no_candidate" } };
    }
    return { state: episodeState, proposal: { kind: "none", reason: "no_candidate" } };
  }

  const fingerprint = candidateFingerprint(input.monitor);
  const candidateState = episodeState.candidateFingerprint === fingerprint
    ? episodeState
    : {
        ...episodeState,
        candidateFingerprint: fingerprint,
        // A reason/fingerprint change updates what is being diagnosed, not
        // the age of the unresolved candidate episode or its spent budget.
        candidateClock: episodeState.candidateClock ?? currentClock,
      };
  if (candidateState.candidateClock !== undefined && workDistance(candidateState.candidateClock, currentClock) > options.maxCandidateAgeWorkUnits) {
    // Requiring a fresh candidate observation prevents an old fingerprint
    // from escalating solely because the work clock advanced.  Guidance/help
    // budget is consumed only by a currently observed, sustained candidate.
    return { state: resetCandidateEpisode(candidateState), proposal: { kind: "none", reason: "no_candidate" } };
  }
  // New reason codes within one unresolved episode do not refresh its prompt
  // budget or make a missing/stale assessment an immediate stall.
  const hasSemanticAssessment = hasEvidence(input.monitor, "semantic_assessment");
  if (candidateState.candidateClock?.modelDecisionCount === currentClock.modelDecisionCount
    && candidateState.candidateClock.guiActionCount === currentClock.guiActionCount
    && !hasSemanticAssessment) {
    return { state: candidateState, proposal: options.mode === "shadow" ? { kind: "none", reason: "shadow" } : { kind: "none", reason: "candidate_observed" } };
  }
  if (options.mode === "shadow") return { state: candidateState, proposal: { kind: "none", reason: "shadow" } };
  if (input.monitor.assessmentOutcome === "uncertain"
    && input.monitor.reasons.length > 0
    && input.monitor.reasons.every((reason) => reason.code === "assessment_uncertain")) {
    return { state: candidateState, proposal: { kind: "none", reason: "candidate_observed" } };
  }
  if (candidateState.guidanceCount >= options.maxGuidanceCount) {
    return { state: candidateState, proposal: { kind: "none", reason: "guidance_budget_exhausted" } };
  }
  const freshBoundNoEffectAssessment = hasSemanticAssessment
    && input.monitor.assessmentOutcome === "no_effect"
    && hasEvidence(input.monitor, "visual_transition_unchanged");
  if (candidateState.lastGuidanceClock !== undefined
    && workDistance(candidateState.lastGuidanceClock, currentClock) < options.cooldownWorkUnits
    && !freshBoundNoEffectAssessment) {
    return { state: candidateState, proposal: { kind: "none", reason: "guidance_cooldown" } };
  }

  const text = boundedText(input.guidanceText ?? fallbackGuidanceText(input.monitor), options.maxGuidanceChars);
  return {
    state: {
      ...candidateState,
      guidanceCount: candidateState.guidanceCount + 1,
      lastGuidanceClock: currentClock,
    },
    proposal: { kind: "guidance", text, fingerprint },
  };
}

export function serializeMonitorProposal(proposal: MonitorPolicyProposal): Readonly<Record<string, unknown>> {
  return proposal.kind === "guidance"
    ? { kind: proposal.kind, text: proposal.text, fingerprint: proposal.fingerprint }
    : { kind: proposal.kind, reason: proposal.reason };
}

function resetForRunOrPartition(state: MonitorPolicyState, input: MonitorPolicyInput): MonitorPolicyState {
  if (state.runId === undefined && state.partitionKey === undefined) {
    return { ...state, runId: input.runId, partitionKey: input.partitionKey };
  }
  if (state.runId === input.runId && state.partitionKey === input.partitionKey) return state;
  return {
    ...state,
    runId: input.runId,
    partitionKey: input.partitionKey,
    lastSequence: undefined,
    lastClock: undefined,
    candidateFingerprint: undefined,
    candidateClock: undefined,
    lastGuidanceClock: undefined,
    guidanceCount: 0,
  };
}

function clearCandidate(state: MonitorPolicyState): MonitorPolicyState {
  return {
    ...state,
    candidateFingerprint: undefined,
    candidateClock: undefined,
    lastGuidanceClock: undefined,
  };
}

function resetCandidateEpisode(state: MonitorPolicyState): MonitorPolicyState {
  return { ...clearCandidate(state), guidanceCount: 0 };
}

function candidateFingerprint(output: ProgressMonitorOutput): string {
  const reasons = [...new Set(output.reasons.map((reason) => {
    if (reason.code === "repeated_proposal" || reason.code === "repeated_action" || reason.code === "action_cycle") return "action_stall";
    if (reason.code === "repeated_refusal" || reason.code === "repeated_failure") return "execution_failure";
    return reason.code;
  }))].sort();
  return createHash("sha256").update(JSON.stringify({ reasons }), "utf8").digest("hex").slice(0, 24);
}

function fallbackGuidanceText(output: ProgressMonitorOutput): string {
  if (hasEvidence(output, "visual_transition_unchanged")) {
    return "The screenshot appeared unchanged after the preceding action. Inspect the newest image and choose the next step from visible state; unchanged pixels do not prove the action was missed.";
  }
  if (output.assessmentOutcome === "unexpected_change") {
    return "The newest screenshot changed. Inspect what is visible before deciding what it means; a changed screen does not confirm the requested result.";
  }
  return "Monitor evidence is incomplete for this action. Inspect the newest image and choose the next step from visible state; do not infer that the action was missed.";
}

function boundedText(text: string, maximum: number): string {
  const boundedMaximum = Math.min(maximum, DEFAULTS.maxGuidanceChars);
  if (text.length <= boundedMaximum) return text;
  // Keep the recovery instruction at the tail and spend the remaining budget
  // on the action/observation/evidence prefix. The final fallback is short
  // enough for the configured 240 UTF-16-unit ceiling.
  const advice = "Inspect the newest image and choose the next step from visible state.";
  if (boundedMaximum <= advice.length) return truncateUtf16(advice, boundedMaximum);
  const prefixBudget = boundedMaximum - advice.length - 1;
  return `${truncateUtf16(text, Math.max(0, prefixBudget)).trimEnd()} ${advice}`;
}

function truncateUtf16(value: string, maximumUnits: number): string {
  const output: string[] = [];
  let units = 0;
  for (const point of value) {
    if (units + point.length > maximumUnits) break;
    output.push(point);
    units += point.length;
  }
  return output.join("");
}

function hasEvidence(output: ProgressMonitorOutput, kind: string): boolean {
  return output.evidence.some((evidence) => evidence.kind === kind);
}

function normalizeClock(clock: MonitorWorkClock, previous?: MonitorWorkClock): MonitorWorkClock {
  const modelDecisionCount = boundedCounter(clock.modelDecisionCount);
  const guiActionCount = boundedCounter(clock.guiActionCount);
  return {
    modelDecisionCount: Math.max(modelDecisionCount, previous?.modelDecisionCount ?? 0),
    guiActionCount: Math.max(guiActionCount, previous?.guiActionCount ?? 0),
  };
}

function boundedCounter(value: number): number {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function workDistance(from: MonitorWorkClock, to: MonitorWorkClock): number {
  return Math.max(to.modelDecisionCount - from.modelDecisionCount, to.guiActionCount - from.guiActionCount, 0);
}

function normalizeOptions(options?: MonitorPolicyOptions): Readonly<Required<MonitorPolicyOptions>> {
  return {
    mode: options?.mode ?? DEFAULTS.mode,
    cooldownWorkUnits: boundedOption(options?.cooldownWorkUnits, DEFAULTS.cooldownWorkUnits, 64),
    maxGuidanceCount: boundedOption(options?.maxGuidanceCount, DEFAULTS.maxGuidanceCount, 16),
    maxGuidanceChars: boundedOption(options?.maxGuidanceChars, DEFAULTS.maxGuidanceChars, DEFAULTS.maxGuidanceChars),
    maxCandidateAgeWorkUnits: boundedOption(options?.maxCandidateAgeWorkUnits, DEFAULTS.maxCandidateAgeWorkUnits, 128),
  };
}

function boundedOption(value: number | undefined, fallback: number, maximum: number): number {
  if (value === undefined || !Number.isSafeInteger(value) || value < 1) return fallback;
  return Math.min(value, maximum);
}
