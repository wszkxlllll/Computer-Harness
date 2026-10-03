/**
 * Structural SDK contracts consumed by the adapter. The 0.22.2 and 0.32.0
 * packages are loaded lazily through cua-sdk-platform.ts; keep this surface
 * limited to the fields used by the adapter.
 */

export type ToolResult = {
  text: string;
  images: Array<ImageContent>;
  structuredJson?: string;
  isError: boolean;
  errorCode?: string;
  action?: unknown;
  verification?: VerifyStateOutput;
  degraded: boolean;
  rawJson: string;
};

export type ImageContent = {
  mimeType: string;
  dataBase64: string;
};

export type DriverMetadata = {
  driverVersion: string;
  contractVersion: string;
  toolsListSchemaVersion: string;
  capabilityVersion: string;
  mcpProtocolVersion: string;
  pid: number;
  embedded: boolean;
  hostBundleId?: string;
};

export type StartSessionOutput = {
  state: SessionStateOutput;
  active: boolean;
  revived: boolean;
};

export type EndSessionOutput = {
  active: boolean;
};

export type SessionOutput = {
  session?: string;
  implicit: boolean;
  state: number;
  clientKind: number;
  transport: number;
  cursorVisible: boolean;
  recordingActive: boolean;
  idleSeconds: bigint;
  expiresInSeconds: bigint;
};

export type SessionStateOutput = {
  session: string;
  captureScope: number;
  effectiveScope: number;
  desktopUnlocked: boolean;
  desktopCaptureAuthorized?: boolean;
  escalationReason?: number;
  escalationDetail?: string;
};

export type VerifyStateOutput = {
  status: number;
  stable: boolean;
  elapsedMs?: bigint;
  samples?: bigint;
  predicates?: Array<unknown>;
  images?: Array<ImageContent>;
  structuredJson?: string;
  [key: string]: unknown;
};

export type BoundsExpectation = {
  x: number;
  y: number;
  width: number;
  height: number;
  tolerancePx?: number;
};

export type WindowPredicate = {
  exists?: boolean;
  bounds?: BoundsExpectation;
};

export type ElementSelector = {
  role?: string;
  labelContains?: string;
};

export type ElementPredicate = {
  selector: ElementSelector;
  exists?: boolean;
  valueEquals?: string;
  enabled?: boolean;
  selected?: boolean;
};

export type StatePredicate = {
  window?: WindowPredicate;
  element?: ElementPredicate;
};

export interface StartSessionInput {
  session?: string;
  captureScope?: number;
  cursorTheme?: unknown;
}

export interface EndSessionInput {
  session: string;
}

export interface GetSessionInput {
  session: string;
}

export interface GetSessionStateInput {
  session: string;
}

export interface VerifyStateInput {
  pid: bigint;
  windowId: bigint;
  expect: Array<StatePredicate>;
  session?: string;
  timeoutMs?: bigint;
  stableSamples?: bigint;
  includeScreenshot: boolean;
}

/** Minimal driver surface the computer adapter and capability doctor use. */
export type CuaDriverLike = {
  callTool(name: string, argumentsJson: string, asyncOpts?: { signal?: AbortSignal }): Promise<ToolResult>;
  metadata(asyncOpts?: { signal?: AbortSignal }): Promise<DriverMetadata>;
  listToolsJson(asyncOpts?: { signal?: AbortSignal }): Promise<string>;
  startSession(input: StartSessionInput, asyncOpts?: { signal?: AbortSignal }): Promise<StartSessionOutput>;
  endSession(input: EndSessionInput, asyncOpts?: { signal?: AbortSignal }): Promise<EndSessionOutput>;
  getSession(input: GetSessionInput, asyncOpts?: { signal?: AbortSignal }): Promise<SessionOutput>;
  getSessionState(input: GetSessionStateInput, asyncOpts?: { signal?: AbortSignal }): Promise<SessionStateOutput>;
  verifyState(input: VerifyStateInput, asyncOpts?: { signal: AbortSignal }): Promise<ToolResult>;
  shutdown(asyncOpts?: { signal?: AbortSignal }): Promise<void>;
  free?(): void;
};
