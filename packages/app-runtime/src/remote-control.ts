import type { AssetId, AssetRef, JsonValue, ObservationId, RunId, RunOutcome, Viewport } from "@computer-harness/protocol";
import type { AssetReader } from "@computer-harness/runtime";
import type { ApplicationSession } from "./application-session.js";
import type { RunHandle } from "./config.js";
import type { EventFeedNotification, EventFeedSubscription } from "./event-feed.js";

export type RemoteRunStatus = "created" | "starting" | "running" | "waiting_user" | "waiting_approval" | "waiting_window" | "paused" | "finished";
export type RemoteCommandStatus = "accepted" | "applied" | "rejected" | "outcome_unknown";

export interface RemoteWindowCandidate {
  readonly token: string;
  readonly appName?: string;
  readonly title?: string;
}

/** Safe public labels for the explicitly selected initial desktop window. */
export interface RemoteWindowTargetLabel {
  readonly appName?: string;
  readonly title?: string;
}

export interface RemoteWindowTargetSet {
  readonly candidates: readonly RemoteWindowCandidate[];
  readonly expiresAt: string;
}

export interface RemoteApprovalActionPreview {
  /** Tool name bounded by Host; the action kind below is from the guarded action. */
  readonly operation: string;
  readonly kind: string;
  readonly points?: readonly { readonly x: number; readonly y: number }[];
  readonly keys?: readonly string[];
  readonly typedCharacterCount?: number;
}

export interface RemoteApprovalEvidence {
  readonly assetId: AssetId;
  readonly observationId: ObservationId;
  readonly decisionObservationId: ObservationId;
  readonly capturedAt: string;
  readonly viewport: Readonly<Viewport>;
}

export interface RemoteApprovalPreview {
  readonly actions: readonly RemoteApprovalActionPreview[];
  /** Exact request-bound screenshot, fetched through the authenticated run asset route. */
  readonly evidence?: RemoteApprovalEvidence;
  readonly modelDeclaredEffect?: {
    readonly target: string;
    readonly summary: string;
    readonly verified: false;
  };
}

export type RemotePendingRequest =
  | { readonly requestId: string; readonly kind: "approval"; readonly reason: string; readonly requiresVisualReview: boolean; readonly preview?: RemoteApprovalPreview }
  | { readonly requestId: string; readonly kind: "user_input"; readonly question: string }
  | {
      readonly requestId: string;
      readonly kind: "window_handoff";
      readonly reasonCode: "foreground_mismatch" | "new_window_detected";
      readonly candidates: readonly RemoteWindowCandidate[];
    };

export interface RemoteRunCapabilities {
  readonly pause: boolean;
  readonly resume: boolean;
  readonly abort: boolean;
  readonly correct: boolean;
  readonly approval: boolean;
  readonly windowHandoff: boolean;
}

export interface RemoteRunSnapshot {
  readonly runId: RunId;
  readonly goal: string;
  readonly status: RemoteRunStatus;
  /** Monotonic cursor over projected events, never the raw Runtime sequence. */
  readonly sequence: number;
  readonly outcome?: RunOutcome;
  readonly error?: string;
  readonly reply?: string;
  readonly pendingRequest?: RemotePendingRequest;
  readonly target?: RemoteWindowTargetLabel;
  readonly latestAssetId?: AssetId;
  readonly capabilities: RemoteRunCapabilities;
}

export interface RemoteCommandReceipt {
  readonly commandId: string;
  readonly runId: RunId;
  readonly status: RemoteCommandStatus;
  readonly acceptedAt: string;
  readonly completedAt?: string;
  readonly sequence?: number;
  readonly message?: string;
}

export type RemoteCommand =
  | { readonly type: "pause" | "resume" | "abort"; readonly commandId: string; readonly expectedSequence: number }
  | { readonly type: "correct"; readonly commandId: string; readonly expectedSequence: number; readonly requestId?: string; readonly text: string }
  | { readonly type: "respond"; readonly commandId: string; readonly expectedSequence: number; readonly requestId: string; readonly text: string }
  | { readonly type: "approve" | "reject"; readonly commandId: string; readonly expectedSequence: number; readonly requestId: string }
  | { readonly type: "window.confirm"; readonly commandId: string; readonly expectedSequence: number; readonly requestId: string; readonly candidateToken: string }
  | { readonly type: "window.ignore"; readonly commandId: string; readonly expectedSequence: number; readonly requestId: string };

export interface RemoteRunEvent {
  readonly type: "run.event";
  readonly runId: RunId;
  readonly sequence: number;
  readonly data: Readonly<Record<string, JsonValue>>;
}

export interface RemoteResyncRequired {
  readonly type: "resync_required";
  readonly runId: RunId;
  readonly afterSequence: number;
  readonly latestSequence: number;
}

export type RemoteStreamEvent = RemoteRunEvent | RemoteResyncRequired;

export interface RemoteSubscription {
  close(): void;
}

export interface RemoteAsset {
  readonly data: Uint8Array;
  readonly mediaType: string;
}

/** UI-neutral control boundary shared by local HTTP and the authenticated Relay adapter. */
export interface RemoteRunApi {
  listRuns(deviceId: string): Promise<readonly RemoteRunSnapshot[]> | readonly RemoteRunSnapshot[];
  getRun(deviceId: string, runId: string): Promise<RemoteRunSnapshot | undefined> | RemoteRunSnapshot | undefined;
  listWindowTargets(deviceId: string): Promise<RemoteWindowTargetSet>;
  startRun(deviceId: string, commandId: string, goal: string, targetToken: string): Promise<RemoteRunSnapshot>;
  submitCommand(deviceId: string, runId: string, command: RemoteCommand): Promise<RemoteCommandReceipt>;
  getCommandReceipt(deviceId: string, runId: string, commandId: string): Promise<RemoteCommandReceipt | undefined> | RemoteCommandReceipt | undefined;
  subscribe(deviceId: string, runId: string, afterSequence: number, listener: (event: RemoteStreamEvent) => void): RemoteSubscription;
  getAsset(deviceId: string, runId: string, assetId: string): Promise<RemoteAsset | undefined> | RemoteAsset | undefined;
}
