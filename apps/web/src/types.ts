export type RunStatus =
  | "created"
  | "running"
  | "waiting_user"
  | "waiting_window"
  | "waiting_approval"
  | "paused"
  | "finished";

export type RunOutcome = "succeeded" | "failed" | "cancelled" | "budget_exhausted" | "outcome_unknown";

export interface RunSummary {
  runId: string;
  goal: string;
  status: RunStatus;
  outcome?: RunOutcome;
  sequence?: number;
  latestAssetId?: string;
  reply?: string;
  target?: WindowTargetLabel;
  updatedAt?: string;
}

export interface WindowTargetLabel {
  appName?: string;
  title?: string;
  provenance?: "starting_target" | "selected_target" | "unknown_after_switch";
}

export interface WindowTarget {
  token: string;
  appName?: string;
  title?: string;
}

export interface WindowTargetList {
  candidates: WindowTarget[];
  expiresAt: string;
}

export type RunTarget =
  | { mode: "auto"; switchWindows?: boolean }
  | { mode: "desktop"; switchWindows?: boolean }
  | { mode: "window"; targetToken: string; switchWindows?: boolean }
  | { mode: "browser"; url?: string; switchWindows?: boolean };

export type ManagedBrowserProfileStatus = "unprepared" | "preparing" | "ready" | "in_use" | "relogin_required" | "cleanup_failed";
export type ManagedBrowserDefaultSession = "saved" | "temporary";

export interface ManagedBrowserProfileSettings {
  status: ManagedBrowserProfileStatus;
  defaultSession: ManagedBrowserDefaultSession;
  commands: { prepare: string; complete: string; relogin: string };
  operationId?: string;
}

export interface BrowserSiteChoice {
  label: string;
  url: string;
}

export interface RunCapabilities {
  pause?: boolean;
  resume?: boolean;
  abort?: boolean;
  correct?: boolean;
  approval?: boolean;
  windowHandoff?: boolean;
  [key: string]: boolean | undefined;
}

export interface PendingRequestBase {
  requestId: string;
  kind: "approval" | "user_input" | "window_handoff" | string;
  title?: string;
  description?: string;
  reason?: string;
  question?: string;
  reasonCode?: "foreground_mismatch" | "new_window_detected" | string;
  requiresVisualReview?: boolean;
  preview?: ApprovalActionPreview;
  candidates?: WindowCandidate[];
}

export interface ApprovalActionPreview {
  actions: ApprovalActionPreviewItem[];
  selectedWindowLabel?: {
    status: "matched" | "unavailable";
    appName?: string;
    title?: string;
    source: "latest_list_windows_inventory" | "unavailable";
  };
  modelDeclaredEffect?: {
    target: string;
    summary: string;
    verified: false;
  };
  evidence?: ApprovalEvidence;
}

export interface ApprovalEvidence {
  assetId: string;
  observationId: string;
  capturedAt: string;
  viewport: {
    width: number;
    height: number;
    coordinateSpace: "physical" | "logical" | "reference";
  };
  decisionObservationId: string;
  surfaceRef: {
    surfaceId: string;
    generation: number;
    kind: "desktop" | "native_window" | "browser_tab" | "dom" | "overlay" | "unknown";
    parentSurfaceId?: string;
  };
}

export interface ApprovalActionPreviewItem {
  operation: string;
  kind: string;
  points?: Array<{ x: number; y: number }>;
  keys?: string[];
  typedCharacterCount?: number;
}

export interface WindowCandidate {
  token: string;
  appName?: string;
  title?: string;
  description?: string;
}

export interface RunSnapshot extends RunSummary {
  sequence: number;
  capabilities: RunCapabilities;
  pendingRequest?: PendingRequestBase;
  error?: string;
}

export interface RemoteEvent {
  runId: string;
  sequence: number;
  type: string;
  data?: Record<string, unknown>;
}

export type RunNoticeKind = "progress" | "approval" | "question" | "handoff" | "error" | "result";
export type RunNoticeDelivery = "polite" | "interrupt";

/** Minimal public notice projection carried inside an ordered `run.event`. */
export interface RunNotice {
  noticeId: string;
  kind: RunNoticeKind;
  text: string;
  delivery: RunNoticeDelivery;
  eventSequence: number;
  /** Remote SSE cursor used locally to defer interaction notices until their snapshot is current. */
  feedSequence?: number;
  pendingRequestId?: string;
}

export type CommandReceiptStatus = "accepted" | "applied" | "rejected" | "outcome_unknown";

export interface CommandReceipt {
  commandId: string;
  status: CommandReceiptStatus;
  runId?: string;
  message?: string;
  code?: string;
  acceptedAt?: string;
  completedAt?: string;
}

export interface PairSession {
  csrfToken: string;
  expiresAt: string;
  deviceName?: string;
  deviceId?: string;
}

export interface PairRequestReceipt {
  requestId: string;
  status: "pending_local_confirmation";
  expiresAt: string;
}

export interface PairRequestStatus {
  requestId: string;
  status: "pending_local_confirmation" | "approved" | "rejected" | "expired";
  expiresAt: string;
  deviceId?: string;
}

export interface PairingChallenge {
  challengeId: string;
  pairingUrl: string;
  expiresAt: string;
}

export interface PairingRequest {
  requestId: string;
  clientName?: string;
  createdAt?: string;
  expiresAt?: string;
  status: "pending" | "approved" | "rejected" | "expired";
}

export interface PairedDevice {
  deviceId: string;
  label?: string;
  createdAt?: string;
  lastSeenAt?: string;
}

export interface LocalPairingState {
  activeChallenge?: { challengeId: string; expiresAt: string } | null;
  requests?: PairingRequest[];
}

export interface DeviceList {
  devices: PairedDevice[];
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}
