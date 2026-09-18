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
  /** The execution barrier is owned by Runtime; Monitor cannot clear it. */
  executionBarrier?: "unknown_outcome" | "pending_side_effect";
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
  | "help_already_requested";

export type MonitorPolicyProposal =
  | { kind: "none"; reason: MonitorPolicyNoneReason }
  | { kind: "guidance"; text: string; fingerprint: string }
  | { kind: "help_requested"; reason: "candidate_expired" | "guidance_budget_exhausted"; fingerprint: string };

export interface MonitorPolicyState {
  readonly runId?: RunId | undefined;
  readonly partitionKey?: string | undefined;
  readonly lastSequence?: number | undefined;
  readonly lastClock?: MonitorWorkClock | undefined;
  readonly candidateFingerprint?: string | undefined;
  readonly candidateClock?: MonitorWorkClock | undefined;
  readonly lastGuidanceClock?: MonitorWorkClock | undefined;
  readonly lastHelpFingerprint?: string | undefined;
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

  if (options.mode === "off") return { state: sequenceState, proposal: { kind: "none", reason: "disabled" } };
  if (input.sequence < (base.lastSequence ?? -1)) {
    return { state, proposal: { kind: "none", reason: "out_of_order" } };
  }
  if (input.sequence === base.lastSequence) {
    return { state, proposal: { kind: "none", reason: "replayed" } };
  }
  if (input.executionBarrier !== undefined) {
    return {
      state: clearCandidate(sequenceState),
      proposal: { kind: "none", reason: "suppressed_by_execution_barrier" },
    };
  }
  if (input.terminal) {
    return { state: clearCandidate(sequenceState), proposal: { kind: "none", reason: "terminal" } };
  }
  if (!input.monitor.candidate) {
    const expired = candidateExpired(sequenceState, currentClock);
    if (expired !== undefined) {
      return {
        state: markHelpRequested(clearCandidate(sequenceState), expired),
        proposal: { kind: "help_requested", reason: "candidate_expired", fingerprint: expired },
      };
    }
    return { state: sequenceState, proposal: { kind: "none", reason: "no_candidate" } };
  }

  const fingerprint = candidateFingerprint(input.monitor);
  const candidateState = sequenceState.candidateFingerprint === fingerprint
    ? sequenceState
    : {
        ...sequenceState,
        candidateFingerprint: fingerprint,
        candidateClock: currentClock,
        lastHelpFingerprint: sequenceState.lastHelpFingerprint === fingerprint ? sequenceState.lastHelpFingerprint : undefined,
      };
  if (candidateState.lastHelpFingerprint === fingerprint) {
    return { state: candidateState, proposal: { kind: "none", reason: "help_already_requested" } };
  }
  if (candidateState.candidateClock !== undefined && workDistance(candidateState.candidateClock, currentClock) > options.maxCandidateAgeWorkUnits) {
    return {
      state: markHelpRequested(clearCandidate(candidateState), fingerprint),
      proposal: { kind: "help_requested", reason: "candidate_expired", fingerprint },
    };
  }
  if (candidateState.candidateClock?.modelDecisionCount === currentClock.modelDecisionCount
    && candidateState.candidateClock.guiActionCount === currentClock.guiActionCount) {
    return { state: candidateState, proposal: options.mode === "shadow" ? { kind: "none", reason: "shadow" } : { kind: "none", reason: "candidate_observed" } };
  }
  if (options.mode === "shadow") return { state: candidateState, proposal: { kind: "none", reason: "shadow" } };
  if (candidateState.guidanceCount >= options.maxGuidanceCount) {
    return {
      state: markHelpRequested(clearCandidate(candidateState), fingerprint),
      proposal: { kind: "help_requested", reason: "guidance_budget_exhausted", fingerprint },
    };
  }
  if (candidateState.lastGuidanceClock !== undefined && workDistance(candidateState.lastGuidanceClock, currentClock) < options.cooldownWorkUnits) {
    return { state: candidateState, proposal: { kind: "none", reason: "guidance_cooldown" } };
  }

  const text = guidanceText(input.monitor, options.maxGuidanceChars);
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
    : proposal.kind === "help_requested"
      ? { kind: proposal.kind, reason: proposal.reason, fingerprint: proposal.fingerprint }
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
    lastHelpFingerprint: undefined,
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

function markHelpRequested(state: MonitorPolicyState, fingerprint: string): MonitorPolicyState {
  return { ...state, lastHelpFingerprint: fingerprint };
}

function candidateExpired(state: MonitorPolicyState, clock: MonitorWorkClock): string | undefined {
  if (state.candidateFingerprint === undefined || state.candidateClock === undefined) return undefined;
  return workDistance(state.candidateClock, clock) > state.options.maxCandidateAgeWorkUnits
    ? state.candidateFingerprint
    : undefined;
}

function candidateFingerprint(output: ProgressMonitorOutput): string {
  const reasons = [...new Set(output.reasons.map((reason) => {
    if (reason.code === "repeated_proposal" || reason.code === "repeated_action" || reason.code === "action_cycle") return "action_stall";
    if (reason.code === "repeated_refusal" || reason.code === "repeated_failure") return "execution_failure";
    return reason.code;
  }))].sort();
  return createHash("sha256").update(JSON.stringify({ reasons }), "utf8").digest("hex").slice(0, 24);
}

function guidanceText(output: ProgressMonitorOutput, maxChars: number): string {
  const reasons = [...new Set(output.reasons.map((reason) => reason.code))].sort();
  const evidence = [...new Set(output.evidence.map((item) => item.kind))].sort();
  const text = `Monitor candidate; review current state before continuing. Reasons: ${reasons.join(", ") || "unspecified"}. Evidence: ${evidence.join(", ") || "unspecified"}.`;
  return text.slice(0, maxChars);
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
    maxGuidanceChars: boundedOption(options?.maxGuidanceChars, DEFAULTS.maxGuidanceChars, 1_000),
    maxCandidateAgeWorkUnits: boundedOption(options?.maxCandidateAgeWorkUnits, DEFAULTS.maxCandidateAgeWorkUnits, 128),
  };
}

function boundedOption(value: number | undefined, fallback: number, maximum: number): number {
  if (value === undefined || !Number.isSafeInteger(value) || value < 1) return fallback;
  return Math.min(value, maximum);
}
