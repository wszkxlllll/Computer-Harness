import { lstat, mkdir, mkdtemp, open, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  currentObservationAssessmentBinding,
  type Computer,
  type ComputerSession,
  type ContextCompiler,
  type ModelInput,
  type ProviderAdapter,
  type ActionPolicyDecision,
  type MonitorPolicyMode,
} from "@computer-harness/runtime";
import type { GroundingCatalog, ObservationId, RuntimeEvent, ActionIntent, ActionReceipt, AssetId, AssetRef, ComputerSessionId, ComputerWindowCandidate, ComputerWindowOption, ModelTurn, RunId, SurfaceId, SurfaceRef, ToolCall, ToolCallId, Viewport } from "@computer-harness/protocol";
import { BoundWindowMissingError, MAX_WINDOW_PREVIEW_BYTES } from "@computer-harness/protocol";
import type { WindowTargetInfo, WindowTargetPreview } from "./application-session.js";
import type { WindowSelectionStrategy } from "./window-selection-jev.js";
import { createFileRemoteAssetReader, type ApplicationSessionConfig } from "./index.js";
import { ApplicationSession } from "./application-session.js";
import { InProcessEnvironmentOwner } from "./environment-owner.js";
import { ApplicationRemoteRunApi, RemoteRunApiError, type ManagedBrowserProfileRunCoordinator } from "./remote-run-api.js";
import { ProviderConfigurationError } from "./providers.js";

const viewport: Viewport = { width: 8, height: 8, coordinateSpace: "physical" };
const surfaceRef: SurfaceRef = { surfaceId: "remote-run-api-desktop" as SurfaceId, generation: 1, kind: "desktop" };
const nativeWindowSurfaceRef: SurfaceRef = { surfaceId: "remote-run-api-native-window" as SurfaceId, generation: 1, kind: "native_window" };

interface FixturePngRaster {
  readonly width: number;
  readonly height: number;
  readonly data: Buffer;
}

interface FixturePngModule {
  readonly PNG: {
    readonly sync: {
      read(data: Buffer): FixturePngRaster;
      write(image: FixturePngRaster, options?: { readonly deflateLevel?: number }): Buffer;
    };
  };
}

const pngjs = createRequire(import.meta.url)("pngjs") as FixturePngModule;

function containsWindowIdentityKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsWindowIdentityKey);
  if (typeof value !== "object" || value === null) return false;
  return Object.entries(value).some(([key, child]) => /pid|windowid/iu.test(key) || containsWindowIdentityKey(child));
}

describe("window target identity serialization assertions", () => {
  it("checks nested keys without treating opaque token values as identity fields", () => {
    expect(containsWindowIdentityKey({ candidates: [{ token: "opaque-HpId-windowId-token" }] })).toBe(false);
    expect(containsWindowIdentityKey({ nested: [{ target: { pid: 42 } }] })).toBe(true);
    expect(containsWindowIdentityKey({ candidates: [{ windowId: 7 }] })).toBe(true);
  });
});
function createNoisyPng(width: number, height: number): Buffer {
  const data = Buffer.allocUnsafe(width * height * 4);
  let state = 0x7191a5d3;
  for (let index = 0; index < data.length; index += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    data[index] = state & 0xff;
  }
  return pngjs.PNG.sync.write({ width, height, data }, { deflateLevel: 1 });
}
function createPngAtByteLength(width: number, height: number, byteLength: number): Buffer {
  const base = pngjs.PNG.sync.write({ width, height, data: Buffer.alloc(width * height * 4, 0x7f) });
  const ancillaryDataLength = byteLength - base.byteLength - 12;
  if (ancillaryDataLength < 8) throw new Error("PNG fixture target size is too small for one text chunk");
  const chunk = Buffer.alloc(ancillaryDataLength + 12, 0x41);
  chunk.writeUInt32BE(ancillaryDataLength, 0);
  chunk.write("tEXt", 4, "ascii");
  chunk.write("Comment\0", 8, "ascii");
  const crcOffset = 8 + ancillaryDataLength;
  chunk.writeUInt32BE(crc32(chunk.subarray(4, crcOffset)), crcOffset);
  const endChunkOffset = base.byteLength - 12;
  return Buffer.concat([base.subarray(0, endChunkOffset), chunk, base.subarray(endChunkOffset)]);
}

function crc32(data: Uint8Array): number {
  let crc = 0xffff_ffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) === 0 ? 0 : 0xedb8_8320);
  }
  return (crc ^ 0xffff_ffff) >>> 0;
}

function config(outputDir: string): ApplicationSessionConfig {
  return {
    model: "glm-5.3-flash",
    computer: { kind: "cua", socketPath: "fixture-cua.sock", screenshotDir: join(outputDir, "driver-screenshots"), grounding: "off" },
    outputDir,
    maxSteps: 4,
    maxModelRequests: 4,
    planning: false,
    memory: "off",
    memoryRetrieval: "off",
    batching: "off",
    contextMode: "raw",
    contextMaxHistoryEvents: 8,
    riskProfile: "experiment",
    riskGuard: "off",
    riskModel: "off",
    riskMaxModelRequests: 1,
    riskTimeoutMs: 100,
    cleanupDeadlineMs: 100,
  };
}

function fixtureComputer(
  screen: Viewport = viewport,
  closeComputer: () => Promise<void> = async () => undefined,
  windowInventory: readonly ComputerWindowOption[] = [],
  switchWindowReceiptStatus: "completed" | "failed" | "refused" | "cancelled" | undefined = undefined,
  computerSessionId = "remote-api-session",
  onObserve: (computerSessionId: string) => void = () => undefined,
  executeAction?: (action: ActionIntent) => Promise<ActionReceipt> | ActionReceipt,
  handoffCandidates: readonly ComputerWindowCandidate[] = [],
  listHandoffCandidates?: (signal: AbortSignal) => Promise<readonly ComputerWindowCandidate[]> | readonly ComputerWindowCandidate[],
  initialSurfaceRef: SurfaceRef = surfaceRef,
  missingHandoff?: (candidate: ComputerWindowCandidate) => void,
  groundingOptions?: readonly string[],
): Computer {
  let sequence = 0;
  let lastAction: ActionIntent | undefined;
  const session: ComputerSession = {
    id: computerSessionId as ComputerSessionId,
    backend: "fixture",
    viewport: screen,
    capabilities: { screenshot: true, pointer: true, keyboard: true, accessibility: false },
    openedAt: "2026-09-26T00:00:00.000Z",
  };
  return {
    async open() { return session; },
    async observe(_session, observationId: ObservationId) {
      sequence += 1;
      onObserve(String(session.id));
      return {
        capturedAt: "2026-09-26T00:00:0" + String(sequence) + ".000Z",
        viewport: screen,
        surfaceRef: initialSurfaceRef,
        screenshot: { mediaType: "image/png" as const, data: new Uint8Array([3, 1, 4, sequence]) },
        ...(groundingOptions === undefined ? {} : { grounding: {
          version: "grounding-catalog-v2",
          source: "dom",
          observationId,
          computerSessionId: session.id,
          surfaceRef,
          completeness: "partial",
          degraded: false,
          maxElements: 16,
          elements: [{ elementRef: "dom-ref", role: "combobox", source: "dom", name: "Fixture variant", bbox: { x: 1, y: 1, width: 4, height: 3 }, state: { enabled: true }, options: groundingOptions.map((text) => ({ text, enabled: true })) }],
        } satisfies GroundingCatalog }),
      };
    },
    async execute(_session, action) {
      lastAction = action;
      if (executeAction !== undefined) return executeAction(action);
      if (action.kind === "switch_window" && switchWindowReceiptStatus !== undefined) {
        if (switchWindowReceiptStatus === "completed") {
          return {
            actionId: action.actionId,
            status: "completed" as const,
            sessionAfter: {
              ...session,
            },
          };
        }
        return { actionId: action.actionId, status: switchWindowReceiptStatus };
      }
      return { actionId: action.actionId, status: "completed" as const };
    },
    async listWindows() { return { options: windowInventory, truncated: false, omittedCount: 0 }; },
    async listWindowHandoffCandidates(_session, signal) {
      return listHandoffCandidates === undefined ? handoffCandidates : listHandoffCandidates(signal);
    },
    async detectNewWindowHandoffCandidates() {
      if (missingHandoff !== undefined && lastAction !== undefined) throw new BoundWindowMissingError(lastAction.actionId);
      return [];
    },
    async handoffWindow(currentSession, candidate) { missingHandoff?.(candidate); return currentSession; },
    async close() { await closeComputer(); },
  };
}

function providerFor(options: {
  failAfterTurns?: boolean;
  askFirst?: boolean;
  summary: string;
  turns?: readonly ModelTurn[];
  onModelInput?: (input: ModelInput) => void;
  turnFactory?: (turnNumber: number, input: ModelInput, events: readonly RuntimeEvent[]) => ModelTurn | undefined;
}, getEvents: () => readonly RuntimeEvent[]): ProviderAdapter {
  let turns = 0;
  return {
    id: "remote-api-provider",
    async generate(input: ModelInput) {
      options.onModelInput?.(input);
      turns += 1;
      const generatedTurn = options.turnFactory?.(turns, input, getEvents());
      if (generatedTurn !== undefined) return structuredClone(generatedTurn);
      const scriptedTurn = options.turns?.[turns - 1];
      if (scriptedTurn !== undefined) return structuredClone(scriptedTurn);
      if (options.failAfterTurns === true) throw Object.assign(new Error("fixture request deadline"), { code: "GLM_REQUEST_TIMEOUT", retryable: false, retryMode: "feedback" });
      if (options.askFirst === true && turns === 1) return { type: "user_input_required", question: "Which date should I check?" };
      return { type: "finish", summary: options.summary };
    },
  } as unknown as ProviderAdapter;
}

function createFixture(
  outputDir: string,
  options: {
    askFirst?: boolean;
    summary: string;
    turns?: readonly ModelTurn[];
    failAfterTurns?: boolean;
    guardDecisions?: readonly ActionPolicyDecision[];
    screen?: Viewport;
    windowSnapshots?: readonly (readonly WindowTargetInfo[])[];
    allWindows?: readonly WindowTargetInfo[];
    windowPreviewOverride?: WindowTargetPreview;
    windowPreviewError?: unknown;
    windowPreviewCapture?: (target: WindowTargetInfo, signal: AbortSignal) => Promise<WindowTargetPreview> | WindowTargetPreview;
    windowDiscoveryAvailable?: boolean;
    onActivateWindow?: (target: { pid: number; windowId: number }, showWindow: (window: WindowTargetInfo) => void) => void;
    managedBrowserProfile?: { readonly profileLabel: string; readonly profileRoot: string };
    managedBrowserProfileCoordinator?: ManagedBrowserProfileRunCoordinator;
    inspectManagedBrowserProfile?: (profileRoot: string, profileLabel: string) => Promise<{ state: "ready" | "active" | "stale" | "unknown" | "unsafe"; markers: readonly ("profile_lock" | "devtools_port")[] }>;
    readManagedBrowserStartupUrls?: () => Promise<readonly string[]>;
    closeComputer?: () => Promise<void>;
    runNotices?: boolean;
    runNoticeDynamicContent?: boolean;
    onModelInput?: (input: ModelInput) => void;
    turnFactory?: (turnNumber: number, input: ModelInput, events: readonly RuntimeEvent[]) => ModelTurn | undefined;
    monitor?: MonitorPolicyMode;
    windowInventory?: readonly ComputerWindowOption[];
    switchWindowReceiptStatus?: "completed" | "failed" | "refused" | "cancelled";
    executeAction?: (action: ActionIntent) => Promise<ActionReceipt> | ActionReceipt;
    windowSelector?: WindowSelectionStrategy;
    windowHandoff?: "off" | "confirm-v1";
    windowHandoffCandidates?: readonly ComputerWindowCandidate[];
    listWindowHandoffCandidates?: (signal: AbortSignal) => Promise<readonly ComputerWindowCandidate[]> | readonly ComputerWindowCandidate[];
    missingHandoff?: (candidate: ComputerWindowCandidate) => void;
    groundingOptions?: readonly string[];
    initialWindows?: readonly WindowTargetInfo[];
    listWindowsOverride?: (signal: AbortSignal) => Promise<readonly WindowTargetInfo[]>;
  },
  limits: { maxStartRequests?: number; maxCommandsPerRun?: number; now?: () => number } = {},
) {
  let windows: readonly WindowTargetInfo[] = options.initialWindows ?? [{ pid: 42, windowId: 1001, appName: "Fixture app", title: "Fixture window" }];
  let windowReadIndex = 0;
  let guardDecisionIndex = 0;
  const createdComputerConfigs: Array<Extract<ApplicationSessionConfig["computer"], { kind: "cua" }>> = [];
  const observedComputerSessionIds: string[] = [];
  let computerSessionCounter = 0;
  const windowDiscoveryCalls: Array<{ type: "visible" | "all" | "activate"; pid?: number; windowId?: number }> = [];
  const windowPreviewCalls: Array<{ pid: number; windowId: number }> = [];
  const baseConfig = config(outputDir);
  const baseComputer = baseConfig.computer;
  if (baseComputer.kind !== "cua") throw new Error("fixture requires CUA");
  // Saved-browser tests use a Host-owned profile path, but the profile
  // lifecycle itself is covered by computer-cua tests. Keep this fixture
  // deterministic across CI hosts: do not let the test consult the real
  // process inventory (or reject a platform-specific fake path).
  const inspectManagedBrowserProfile = options.inspectManagedBrowserProfile ?? (
    options.managedBrowserProfile === undefined
      ? undefined
      : async () => ({ state: "ready" as const, markers: [] as const })
  );
  const sessionConfig: ApplicationSessionConfig = {
    ...baseConfig,
    ...(options.windowHandoff === undefined ? {} : { windowHandoff: options.windowHandoff }),
    ...(options.monitor === undefined ? {} : { monitor: options.monitor }),
    computer: options.managedBrowserProfile === undefined ? baseComputer : {
      ...baseComputer,
      managedBrowserProfileMode: "persistent",
      managedBrowserProfileLabel: options.managedBrowserProfile.profileLabel,
      managedBrowserProfileRoot: options.managedBrowserProfile.profileRoot,
    },
  };
  let session!: ApplicationSession;
  session = new ApplicationSession({
    config: sessionConfig,
    owner: new InProcessEnvironmentOwner(),
    ...(options.windowDiscoveryAvailable === false ? {} : { windowDiscovery: {
      listWindows: async (signal) => {
        windowDiscoveryCalls.push({ type: "visible" });
        const snapshot = options.windowSnapshots?.[windowReadIndex++];
        return snapshot ?? (options.listWindowsOverride === undefined ? windows : options.listWindowsOverride(signal));
      },
      listAllWindows: async () => {
        windowDiscoveryCalls.push({ type: "all" });
        return options.allWindows ?? options.windowSnapshots?.[0] ?? windows;
      },
      activateWindow: async (target) => {
        windowDiscoveryCalls.push({ type: "activate", pid: target.pid, windowId: target.windowId });
        options.onActivateWindow?.(target, (window) => { windows = [...windows.filter((item) => item.pid !== window.pid || item.windowId !== window.windowId), window]; });
      },
      captureWindowPreview: async (target, signal) => {
        windowPreviewCalls.push({ pid: target.pid, windowId: target.windowId });
        if (options.windowPreviewError !== undefined) throw options.windowPreviewError;
        const selected = windows.find((window) => window.pid === target.pid && window.windowId === target.windowId);
        if (selected === undefined) throw new Error("preview target is stale");
        if (options.windowPreviewCapture !== undefined) return options.windowPreviewCapture(selected, signal);
        if (options.windowPreviewOverride !== undefined) return options.windowPreviewOverride;
        return {
          target: selected,
          capturedAt: "2026-10-04T00:00:00.000Z",
          viewport: { width: options.screen?.width ?? viewport.width, height: options.screen?.height ?? viewport.height },
          mediaType: "image/png" as const,
          data: new Uint8Array([137, 80, 78, 71]),
        };
      },
    } }),
    dependencies: {
      createProvider: () => providerFor(options, () => session.activeRun?.controller.getEvents() ?? []),
      createComputer: async ({ config: computerConfig }) => {
        if (computerConfig.kind === "cua") createdComputerConfigs.push(computerConfig);
        computerSessionCounter += 1;
        const initialSurfaceRef = computerConfig.kind === "cua" && computerConfig.windowTarget !== undefined
          ? nativeWindowSurfaceRef
          : surfaceRef;
        return fixtureComputer(
          options.screen,
          options.closeComputer,
          options.windowInventory,
          options.switchWindowReceiptStatus,
          `remote-api-session-${computerSessionCounter}`,
          (computerSessionId) => observedComputerSessionIds.push(computerSessionId),
          options.executeAction,
          options.windowHandoffCandidates,
          options.listWindowHandoffCandidates,
          initialSurfaceRef,
          options.missingHandoff,
          options.groundingOptions,
        );
      },
      ...(options.guardDecisions === undefined ? {} : {
        createActionPolicy: () => ({
          async evaluate() {
            const decision = options.guardDecisions?.[guardDecisionIndex];
            if (decision === undefined) throw new Error("fixture action policy has no decision for this action");
            guardDecisionIndex += 1;
            return structuredClone(decision);
          },
        }),
      }),
    },
  });
  const api = new ApplicationRemoteRunApi({
    session,
    capabilities: { pause: true, resume: true, abort: true, correct: true, approval: true, windowHandoff: true },
    ...(options.runNotices === true ? { runNotices: { enabled: true, dynamicContentEnabled: options.runNoticeDynamicContent === true } } : {}),
    assetReaderForRun: (_runId, handle) => createFileRemoteAssetReader(resolve(handle.config.outputDir, "assets")),
    ...(options.managedBrowserProfile === undefined ? {} : { managedBrowserProfile: options.managedBrowserProfile }),
    ...(options.managedBrowserProfileCoordinator === undefined ? {} : { managedBrowserProfileCoordinator: options.managedBrowserProfileCoordinator }),
    ...(inspectManagedBrowserProfile === undefined ? {} : { inspectManagedBrowserProfile }),
    ...(options.readManagedBrowserStartupUrls === undefined ? {} : { readManagedBrowserStartupUrls: options.readManagedBrowserStartupUrls }),
    ...(options.windowSelector === undefined ? {} : { windowSelector: options.windowSelector }),
    ...limits,
  });
  return { api, session, createdComputerConfigs, observedComputerSessionIds, windowDiscoveryCalls, windowPreviewCalls, setWindows: (value: readonly WindowTargetInfo[]) => { windows = value; } };
}

function fixtureGuardDecision(decision: "allow" | "require_approval", reason: string): ActionPolicyDecision {
  return {
    decision,
    categories: decision === "allow" ? [] : ["external_commitment"],
    reasonCode: "fixture_guard_decision",
    reason,
    path: "local",
    policyVersion: "fixture-v1",
    modelRequestCount: 0,
  };
}

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise((resolveWait) => setTimeout(resolveWait, 5));
  }
}

function temporarilySetProcessPlatform(platform: NodeJS.Platform): () => void {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  if (originalPlatform === undefined || originalPlatform.configurable !== true) {
    throw new Error("test runtime does not allow restoring a temporary process.platform override");
  }
  Object.defineProperty(process, "platform", { ...originalPlatform, value: platform });
  return () => {
    Object.defineProperty(process, "platform", originalPlatform);
    expect(process.platform).toBe(originalPlatform.value);
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function startHandoffWithCandidates(outputDir: string, candidates: readonly ComputerWindowCandidate[], suffix: string) {
  const root = { pid: 780, windowId: 7801, appName: "Editor.exe", title: "Main window" };
  const click: ToolCall = {
    id: `handoff-deduplicate-${suffix}` as ToolCallId,
    name: "click",
    arguments: { x: 4, y: 4 },
    declaredEffect: { effects: ["navigate"], target: "dialog", summary: "Open the dialog" },
  };
  const { api, session, setWindows } = createFixture(outputDir, {
    summary: "Done.",
    windowHandoff: "confirm-v1",
    listWindowHandoffCandidates: () => candidates,
    turnFactory: (turnNumber) => turnNumber === 1
      ? { type: "tool_calls", calls: [click] }
      : { type: "finish", summary: "Done." },
    executeAction: (action) => ({
      actionId: action.actionId,
      status: "refused",
      driverCode: "WINDOW_FOREGROUND_MISMATCH",
      message: "The foreground target changed before input.",
    }),
  });
  setWindows([root]);
  const initial = await api.listWindowTargets("device-one");
  const rootChoice = initial.candidates.find((choice) => choice.appName === root.appName);
  if (rootChoice === undefined) throw new Error("root window was not listed");
  const started = await api.startRun("device-one", `handoff-deduplicate-${suffix}`, "Continue in the dialog", {
    mode: "window",
    targetToken: rootChoice.token,
  });
  await waitFor(() => api.getRun("device-one", started.runId)?.pendingRequest?.kind === "window_handoff",
    "handoff candidate refresh did not publish its pending request");
  const pending = api.getRun("device-one", started.runId)?.pendingRequest;
  if (pending?.kind !== "window_handoff") throw new Error("window handoff request was not available");
  return { api, session, started, pending };
}

describe("ApplicationRemoteRunApi", () => {
  it("returns an existing idempotent result before rechecking provider configuration", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "harness-provider-preflight-idempotency-"));
    const { api, session } = createFixture(outputDir, { summary: "The existing Run completed." });
    try {
      const first = await api.startRun("device-preflight", "existing-result", "Read the fixture", { mode: "browser", url: "about:blank" });
      const preflight = vi.spyOn(session, "assertRunProviderConfiguration").mockImplementation(() => { throw new ProviderConfigurationError(); });
      await expect(api.startRun("device-preflight", "existing-result", "Read the fixture", { mode: "browser", url: "about:blank" }))
        .resolves.toMatchObject({ runId: first.runId });
      expect(preflight).not.toHaveBeenCalled();
    } finally {
      await session.close();
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("rejects missing credentials before auto discovery and leaves a window token reusable", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-provider-preflight-window-token-"));
    const outputDir = join(root, "runs");
    const credentials: { deepseekApiKey?: string } = {};
    const targetWindow = { pid: 72, windowId: 901, appName: "Fixture app", title: "Fixture window" };
    const listWindows = vi.fn(async () => [targetWindow]);
    const listAllWindows = vi.fn(async () => [targetWindow]);
    const activateWindow = vi.fn(async () => undefined);
    const session = new ApplicationSession({
      config: { ...config(outputDir), model: "deepseek-flash" }, owner: new InProcessEnvironmentOwner(), dependencies: { credentials },
      windowDiscovery: { listWindows, listAllWindows, activateWindow },
    });
    const api = new ApplicationRemoteRunApi({
      session, capabilities: { pause: true, resume: true, abort: true, correct: true, approval: true, windowHandoff: true },
    });
    try {
      await expect(api.startRun("device-window-token", "auto-no-key", "Read the fixture", { mode: "auto" }))
        .rejects.toMatchObject({ code: "PROVIDER_CREDENTIALS_MISSING" });
      expect(listWindows).not.toHaveBeenCalled();
      expect(listAllWindows).not.toHaveBeenCalled();
      expect(activateWindow).not.toHaveBeenCalled();

      const choices = await api.listWindowTargets("device-window-token");
      const token = choices.candidates[0]!.token;
      await expect(api.startRun("device-window-token", "window-token-no-key", "Read the fixture", { mode: "window", targetToken: token }))
        .rejects.toMatchObject({ code: "PROVIDER_CREDENTIALS_MISSING" });
      expect(listWindows).toHaveBeenCalledTimes(1);
      expect(activateWindow).not.toHaveBeenCalled();
      expect(session.lastRun).toBeUndefined();
      await expect(readdir(outputDir)).rejects.toMatchObject({ code: "ENOENT" });

      credentials.deepseekApiKey = "fixture-provider-key";
      vi.spyOn(session, "startRun").mockRejectedValue(new Error("fixture stop after token validation"));
      await expect(api.startRun("device-window-token", "window-token-no-key", "Read the fixture", { mode: "window", targetToken: token }))
        .rejects.toThrow("fixture stop after token validation");
      expect(session.startRun).toHaveBeenCalledOnce();
      expect(activateWindow).not.toHaveBeenCalled();
    } finally {
      await session.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("projects real filtered visible and redacted option approvals identically through GET and SSE", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "harness-remote-api-option-preview-contract-"));
    const visibleText = "Observed fixture variant";
    const secretText = "token=PRIVATE_SYNTHETIC_SECRET";
    const calls: ToolCall[] = [visibleText, secretText].map((optionText, index) => ({
      id: `option-approval-${index}` as ToolCallId,
      name: "select_option",
      arguments: { elementRef: "dom-ref", optionText },
    }));
    const { api, session } = createFixture(outputDir, {
      summary: "The fixture approvals were rejected.",
      turnFactory: (turnNumber, _input, events) => {
        const call = calls[turnNumber - 1];
        return call === undefined ? { type: "finish", summary: "Done" } : { type: "tool_calls", calls: [call] };
      },
      guardDecisions: [fixtureGuardDecision("require_approval", "Review this option."), fixtureGuardDecision("require_approval", "Review this option.")],
      groundingOptions: [visibleText, secretText],
    });
    const streamedPendingRequest = (runId: string, requestId: string): Record<string, unknown> => {
      const events: unknown[] = [];
      const subscription = api.subscribe("device-one", runId, 0, (event) => events.push(event));
      subscription.close();
      const pendingEvent = events.filter((event) => {
        if (typeof event !== "object" || event === null || !("data" in event)) return false;
        const data = event.data;
        return typeof data === "object" && data !== null && "type" in data && data.type === "run.pending_request" && "request" in data && typeof data.request === "object" && data.request !== null && "requestId" in data.request && data.request.requestId === requestId;
      }).at(-1) as { data: { request: Record<string, unknown> } } | undefined;
      if (pendingEvent === undefined) throw new Error("pending approval SSE event was not found");
      return pendingEvent.data.request;
    };
    try {
      const started = await api.startRun("device-one", "option-preview-contract", "Select a fixture variant", { mode: "browser", url: "about:blank" });
      await waitFor(() => ["waiting_approval", "finished"].includes(api.getRun("device-one", started.runId)?.status ?? ""), "Run did not reach a terminal or approval state");
      expect(api.getRun("device-one", started.runId)?.status).toBe("waiting_approval");
      const visibleGet = api.getRun("device-one", started.runId)!;
      const visibleRequest = visibleGet.pendingRequest;
      if (visibleRequest?.kind !== "approval") throw new Error("expected visible option approval request");
      const visibleSse = streamedPendingRequest(started.runId, visibleRequest.requestId);
      expect(visibleSse.requestId).toBe(visibleRequest.requestId);
      expect((visibleSse.preview as { actions: unknown[] }).actions[0]).toEqual(visibleRequest.preview?.actions[0]);
      expect(visibleRequest.preview?.actions[0]).toMatchObject({ groundingRef: "dom-ref", optionText: visibleText, optionCharacterCount: [...visibleText].length, optionTextStatus: "visible" });
      expect(JSON.stringify(visibleGet)).not.toContain(secretText);
      expect(visibleRequest.preview?.actions[0]).not.toHaveProperty("arguments");
      expect(JSON.stringify(visibleSse)).not.toContain(secretText);
      await api.submitCommand("device-one", started.runId, { commandId: "reject-visible-option", expectedSequence: visibleGet.sequence, type: "reject", requestId: visibleRequest.requestId });
      await waitFor(() => {
        const request = api.getRun("device-one", started.runId)?.pendingRequest;
        return request?.kind === "approval" && request.requestId !== visibleRequest.requestId;
      }, "Run did not request redacted option approval");

      const redactedGet = api.getRun("device-one", started.runId)!;
      const redactedRequest = redactedGet.pendingRequest;
      if (redactedRequest?.kind !== "approval") throw new Error("expected redacted option approval request");
      const redactedSse = streamedPendingRequest(started.runId, redactedRequest.requestId);
      expect(redactedSse.requestId).toBe(redactedRequest.requestId);
      expect((redactedSse.preview as { actions: unknown[] }).actions[0]).toEqual(redactedRequest.preview?.actions[0]);
      expect(redactedRequest.preview?.actions[0]).toMatchObject({ optionCharacterCount: [...secretText].length, optionTextStatus: "redacted" });
      expect(redactedRequest.preview?.actions[0]).toHaveProperty("groundingRef", "dom-ref");
      expect(redactedRequest.preview?.actions[0]).not.toHaveProperty("optionText");
      expect(redactedRequest.preview?.actions[0]).not.toHaveProperty("arguments");
      expect(JSON.stringify(redactedGet)).not.toContain(secretText);
      expect(JSON.stringify(redactedSse)).not.toContain(secretText);
      await api.submitCommand("device-one", started.runId, { commandId: "reject-redacted-option", expectedSequence: redactedGet.sequence, type: "reject", requestId: redactedRequest.requestId });
      await session.waitForActiveRun();
    } finally {
      session.activeRun?.controller.cancel("option preview contract test cleanup");
      await session.waitForActiveRun();
      await session.close();
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("keeps native recovery profiles out of the remote target API", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "harness-native-profile-removed-"));
    const { api, session, createdComputerConfigs } = createFixture(outputDir, { summary: "Ordinary Run finished." });
    const preflight = vi.spyOn(session, "assertRunProviderConfiguration");
    try {
      const targets = await api.listWindowTargets("device-native");
      expect(targets).not.toHaveProperty("nativeRecoveryProfile");
      expect(targets).not.toHaveProperty("nativeWebDocumentProfile");
      for (const mode of ["native-recovery", "native-web-document"] as const) {
        const retiredTarget = { mode, profileId: "Opaque_Profile_1234567890" } as unknown as Parameters<typeof api.startRun>[3];
        await expect(api.startRun("device-native", `retired-${mode}`, "Save the document", retiredTarget))
          .rejects.toMatchObject({ code: "INVALID_TARGET" });
      }
      expect(createdComputerConfigs).toEqual([]);
      expect(preflight).not.toHaveBeenCalled();
    } finally {
      await session.close();
      await rm(outputDir, { recursive: true, force: true });
    }
  });


  it("F045 rotates same-pair remote tokens, rejects old tokens and preserves exact source/token through structuredClone", async () => {
    const directory = await mkdtemp(join(tmpdir(), "harness-remote-f045-"));
    const root = { pid: 731, windowId: 7311, appName: "Editor", title: "Fixture" };
    const candidate: ComputerWindowCandidate = { pid: 731, windowId: 7312, appName: "Editor", title: "Output", handoffToken: "issued-epoch-token" };
    let issuedCandidate = candidate;
    const selected: ComputerWindowCandidate[] = [];
    const click: ToolCall = { id: "f045-call" as ToolCallId, name: "click", arguments: { x: 4, y: 4 } };
    const { api, session, setWindows } = createFixture(directory, {
      summary: "Done", windowHandoff: "confirm-v1", listWindowHandoffCandidates: () => [issuedCandidate],
      missingHandoff: value => { selected.push(value); },
      turnFactory: n => n === 1 ? { type: "tool_calls", calls: [click] } : { type: "finish", summary: "Done" },
    });
    setWindows([root]);
    try {
      const initial = await api.listWindowTargets("device-one");
      const started = await api.startRun("device-one", "f045-remote", "Continue after exact host confirmation", { mode: "window", targetToken: initial.candidates[0]!.token });
      await waitFor(() => api.getRun("device-one", started.runId)?.pendingRequest?.kind === "window_handoff", "missing request not published");
      const waiting = api.getRun("device-one", started.runId)!;
      const pending = waiting.pendingRequest;
      if (pending?.kind !== "window_handoff") throw new Error("wrong request kind");
      expect(pending.reasonCode).toBe("bound_window_missing");
      const controller = session.activeRun!.controller;
      const handoff = vi.spyOn(controller, "handoffWindow");
      await expect(api.submitCommand("device-one", started.runId, { commandId: "wrong-source", expectedSequence: waiting.sequence, type: "window.confirm", requestId: "old-action", candidateToken: pending.candidates[0]!.token })).rejects.toMatchObject({ code: "STALE_REQUEST" });
      expect(selected).toEqual([]); expect(handoff).not.toHaveBeenCalled();
      issuedCandidate = { ...candidate, handoffToken: "refreshed-same-pair-token" };
      // Deliberately exercise the existing private refresh seam for the SAME
      // pending sourceActionId. There is no public refresh command to invent;
      // a new requestID would hide a missing token-sensitive fingerprint.
      const internal = api as unknown as {
        runs: Map<string, { windowCandidateRefresh: object }>;
        refreshWindowCandidates(record: unknown, refresh: unknown): Promise<void>;
      };
      const record = internal.runs.get(started.runId)!;
      await internal.refreshWindowCandidates(record, record.windowCandidateRefresh);
      const refreshed = api.getRun("device-one", started.runId)!;
      const refreshedPending = refreshed.pendingRequest;
      if (refreshedPending?.kind !== "window_handoff") throw new Error("refreshed request missing");
      expect(refreshedPending.requestId).toBe(pending.requestId);
      const choice = refreshedPending.candidates[0]!;
      expect(choice.token).not.toBe(pending.candidates[0]!.token);
      await expect(api.submitCommand("device-one", started.runId, { commandId: "expired-remote-token", expectedSequence: refreshed.sequence, type: "window.confirm", requestId: pending.requestId, candidateToken: pending.candidates[0]!.token })).rejects.toMatchObject({ code: "STALE_REQUEST" });
      await expect(api.submitCommand("device-one", started.runId, { commandId: "request-id-bypass", expectedSequence: refreshed.sequence, type: "window.confirm", candidateToken: choice.token } as Parameters<typeof api.submitCommand>[2])).rejects.toBeDefined();
      expect(selected).toEqual([]); expect(handoff).not.toHaveBeenCalled();
      const previewToken = choice.previewRequired ? (await api.previewWindowHandoffCandidate("device-one", started.runId, pending.requestId, choice.token)).previewToken : undefined;
      const current = api.getRun("device-one", started.runId)!;
      await api.submitCommand("device-one", started.runId, { commandId: "current-source", expectedSequence: current.sequence, type: "window.confirm", requestId: pending.requestId, candidateToken: choice.token, ...(previewToken === undefined ? {} : { previewToken }) });
      await session.waitForActiveRun();
      expect(selected).toEqual([issuedCandidate]); expect(selected[0]).not.toBe(issuedCandidate);
      expect(handoff).toHaveBeenCalledTimes(1); expect(handoff).toHaveBeenCalledWith(issuedCandidate, pending.requestId);
    } finally {
      session.activeRun?.controller.cancel("test cleanup"); await session.waitForActiveRun().catch(() => undefined); await session.close(); await rm(directory, { recursive: true, force: true });
    }
  });
  it("requires an exact one-window preview proof before selecting repeated labels manually", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "harness-remote-api-window-preview-required-"));
    const first = { pid: 701, windowId: 7011, appName: "Notepad.exe", title: "Untitled - Notepad" };
    const second = { pid: 702, windowId: 7021, appName: "Notepad.exe", title: "Untitled - Notepad" };
    const { api, session, createdComputerConfigs, windowPreviewCalls, setWindows } = createFixture(outputDir, { summary: "The selected window task completed." });
    setWindows([first, second]);
    try {
      const choices = await api.listWindowTargets("device-one");
      expect(choices.candidates).toHaveLength(2);
      expect(choices.candidates.every((candidate) => candidate.previewRequired === true)).toBe(true);
      expect(containsWindowIdentityKey(choices)).toBe(false);

      await expect(api.startRun("device-one", "preview-required-no-proof", "Inspect the intended Notepad window", {
        mode: "window",
        targetToken: choices.candidates[0]!.token,
      })).rejects.toMatchObject({ code: "WINDOW_PREVIEW_REQUIRED" });
      expect(session.activeRun).toBeUndefined();
      expect(createdComputerConfigs).toEqual([]);
      expect(windowPreviewCalls).toEqual([]);

      const preview = await api.previewWindowTarget("device-one", choices.candidates[0]!.token);
      expect(preview).toMatchObject({
        previewToken: expect.stringMatching(/^[A-Za-z0-9_-]{32}$/u),
        appName: "Notepad.exe",
        title: "Untitled - Notepad",
        mediaType: "image/png",
        dataBase64: expect.any(String),
      });
      expect(windowPreviewCalls).toEqual([{ pid: first.pid, windowId: first.windowId }]);
      expect(session.activeRun).toBeUndefined();
      expect(createdComputerConfigs).toEqual([]);
      expect(await readdir(outputDir)).toEqual([]);
      await expect(api.startRun("device-one", "preview-required-wrong-proof", "Inspect the intended Notepad window", {
        mode: "window",
        targetToken: choices.candidates[0]!.token,
        previewToken: "X".repeat(32),
      })).rejects.toMatchObject({ code: "WINDOW_PREVIEW_REQUIRED" });

      const run = await api.startRun("device-one", "preview-required-valid-proof", "Inspect the intended Notepad window", {
        mode: "window",
        targetToken: choices.candidates[0]!.token,
        previewToken: preview.previewToken,
      });
      expect(run.target).toMatchObject({ appName: "Notepad.exe", title: "Untitled - Notepad", provenance: "starting_target" });
      expect(JSON.stringify(run.target)).not.toContain(preview.previewToken);
      await session.waitForActiveRun();
      expect(createdComputerConfigs[0]).toMatchObject({ windowTarget: { pid: first.pid, windowId: first.windowId } });
    } finally {
      await session.close();
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("allows a requested preview of a unique candidate without making preview a selection requirement", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "harness-remote-api-window-preview-optional-"));
    const target = { pid: 705, windowId: 7051, appName: "Notepad.exe", title: "Notes" };
    const { api, session, createdComputerConfigs, windowPreviewCalls, setWindows } = createFixture(outputDir, { summary: "The selected window task completed." });
    setWindows([target]);
    try {
      const choices = await api.listWindowTargets("device-one");
      const candidate = choices.candidates[0]!;
      expect(candidate.previewRequired).toBeUndefined();

      const preview = await api.previewWindowTarget("device-one", candidate.token);
      expect(preview).toMatchObject({
        previewToken: expect.stringMatching(/^[A-Za-z0-9_-]{32}$/u),
        appName: target.appName,
        title: target.title,
        mediaType: "image/png",
      });
      expect(windowPreviewCalls).toEqual([{ pid: target.pid, windowId: target.windowId }]);

      const started = await api.startRun("device-one", "optional-preview-does-not-gate", "Inspect this window", {
        mode: "window",
        targetToken: candidate.token,
      });
      expect(started.target).toMatchObject({ appName: target.appName, title: target.title, provenance: "starting_target" });
      await session.waitForActiveRun();
      expect(createdComputerConfigs[0]).toMatchObject({ windowTarget: { pid: target.pid, windowId: target.windowId } });
    } finally {
      await session.close();
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("accepts an image at the exact shared preview byte limit and returns a candidate-bound proof", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "harness-remote-api-window-preview-limit-"));
    const first = { pid: 721, windowId: 7211, appName: "Notepad.exe", title: "Untitled - Notepad" };
    const { api, session, setWindows } = createFixture(outputDir, {
      summary: "The selected window task completed.",
      windowPreviewOverride: {
        target: first,
        capturedAt: "2026-10-04T00:00:00.000Z",
        viewport: { width: 320, height: 240 },
        mediaType: "image/png",
        data: createPngAtByteLength(320, 240, MAX_WINDOW_PREVIEW_BYTES),
      },
    });
    setWindows([first, { ...first, pid: 722, windowId: 7221 }]);
    try {
      const choices = await api.listWindowTargets("device-one");
      const preview = await api.previewWindowTarget("device-one", choices.candidates[0]!.token);
      expect(preview.previewToken).toMatch(/^[A-Za-z0-9_-]{32}$/u);
      const image = Buffer.from(preview.dataBase64, "base64");
      expect(image).toHaveLength(MAX_WINDOW_PREVIEW_BYTES);
      expect(pngjs.PNG.sync.read(image)).toMatchObject({ width: preview.viewport.width, height: preview.viewport.height });
    } finally {
      await session.close();
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("normalizes an oversized same-title preview while keeping the proof bound to its exact candidate", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "harness-remote-api-window-preview-thumbnail-"));
    const first = { pid: 721, windowId: 7211, appName: "Notepad.exe", title: "Untitled - Notepad" };
    const second = { pid: 722, windowId: 7221, appName: "Notepad.exe", title: "Untitled - Notepad" };
    const source = createNoisyPng(2_048, 1_200);
    expect(source.byteLength).toBeGreaterThan(MAX_WINDOW_PREVIEW_BYTES);
    const { api, session, windowPreviewCalls, createdComputerConfigs, setWindows } = createFixture(outputDir, {
      summary: "The selected window task completed.",
      windowPreviewOverride: {
        target: first,
        capturedAt: "2026-10-06T00:00:00.000Z",
        viewport: { width: 2_048, height: 1_200 },
        mediaType: "image/png",
        data: source,
      },
    });
    setWindows([first, second]);
    try {
      const choices = await api.listWindowTargets("device-one");
      expect(choices.candidates).toHaveLength(2);
      expect(choices.candidates.every((candidate) => candidate.previewRequired === true)).toBe(true);
      const preview = await api.previewWindowTarget("device-one", choices.candidates[0]!.token);
      const thumbnail = Buffer.from(preview.dataBase64, "base64");
      const decoded = pngjs.PNG.sync.read(thumbnail);

      expect(windowPreviewCalls).toEqual([{ pid: first.pid, windowId: first.windowId }]);
      expect(thumbnail.byteLength).toBeLessThanOrEqual(MAX_WINDOW_PREVIEW_BYTES);
      expect(preview.viewport).toEqual({ width: decoded.width, height: decoded.height });
      expect(preview.viewport.width).toBeLessThan(2_048);
      expect(preview.viewport.height).toBeLessThan(1_200);
      await expect(api.startRun("device-one", "thumbnail-wrong-proof", "Inspect the intended Notepad window", {
        mode: "window",
        targetToken: choices.candidates[0]!.token,
        previewToken: "X".repeat(32),
      })).rejects.toMatchObject({ code: "WINDOW_PREVIEW_REQUIRED" });

      const run = await api.startRun("device-one", "thumbnail-exact-proof", "Inspect the intended Notepad window", {
        mode: "window",
        targetToken: choices.candidates[0]!.token,
        previewToken: preview.previewToken,
      });
      expect(run.target).toMatchObject({ appName: first.appName, title: first.title, provenance: "starting_target" });
      await session.waitForActiveRun();
      expect(createdComputerConfigs[0]).toMatchObject({ windowTarget: { pid: first.pid, windowId: first.windowId } });
    } finally {
      await session.close();
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("allows a requested preview of a unique handoff candidate without requiring its preview token", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "harness-remote-api-handoff-preview-optional-"));
    const root = { pid: 715, windowId: 7151, appName: "WPS Office", title: "Budget.docx" };
    const candidate = { pid: 716, windowId: 7161, appName: "Notepad.exe", title: "Notes" };
    const click: ToolCall = {
      id: "handoff-optional-preview-click" as ToolCallId,
      name: "click",
      arguments: { x: 4, y: 4 },
      declaredEffect: { effects: ["navigate"], target: "dialog", summary: "Open the dialog" },
    };
    const { api, session, windowPreviewCalls, setWindows } = createFixture(outputDir, {
      summary: "The selected dialog task completed.",
      windowHandoff: "confirm-v1",
      windowHandoffCandidates: [candidate],
      turnFactory: (turnNumber) => turnNumber === 1 ? { type: "tool_calls", calls: [click] } : { type: "finish", summary: "The selected dialog task completed." },
      executeAction: (action) => ({
        actionId: action.actionId,
        status: "refused",
        driverCode: "WINDOW_FOREGROUND_MISMATCH",
        message: "The foreground target changed before input.",
      }),
    });
    setWindows([root, candidate]);
    try {
      const initial = await api.listWindowTargets("device-one");
      const rootChoice = initial.candidates.find((choice) => choice.appName === root.appName);
      if (rootChoice === undefined) throw new Error("root candidate was not listed");
      const started = await api.startRun("device-one", "handoff-optional-preview-run", "Save from the dialog", {
        mode: "window",
        targetToken: rootChoice.token,
      });
      await waitFor(() => api.getRun("device-one", started.runId)?.pendingRequest?.kind === "window_handoff", "Run did not request window handoff");
      const waiting = api.getRun("device-one", started.runId)!;
      const requestId = waiting.pendingRequest!.requestId;
      const handoffCandidates = waiting.pendingRequest?.kind === "window_handoff" ? waiting.pendingRequest.candidates : [];
      expect(handoffCandidates).toHaveLength(1);
      expect(handoffCandidates[0]?.previewRequired).toBeUndefined();

      const preview = await api.previewWindowHandoffCandidate("device-one", started.runId, requestId, handoffCandidates[0]!.token);
      expect(preview).toMatchObject({ appName: candidate.appName, title: candidate.title, mediaType: "image/png" });
      expect(windowPreviewCalls).toEqual([{ pid: candidate.pid, windowId: candidate.windowId }]);

      const current = api.getRun("device-one", started.runId)!;
      await api.submitCommand("device-one", started.runId, {
        commandId: "handoff-optional-preview-no-proof",
        expectedSequence: current.sequence,
        type: "window.confirm",
        requestId,
        candidateToken: handoffCandidates[0]!.token,
      });
      await session.waitForActiveRun();
      expect(api.getRun("device-one", started.runId)?.pendingRequest).toBeUndefined();
    } finally {
      if (session.activeRun?.controller.getSnapshot().status !== "finished") session.activeRun?.controller.cancel("test cleanup");
      await session.waitForActiveRun().catch(() => undefined);
      await session.close();
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it.each([
    {
      label: "a bounded CUA timeout",
      error: Object.assign(new Error("private title and native details"), { name: "WindowContractError", code: "WINDOW_CAPTURE_DEADLINE" }),
      code: "WINDOW_PREVIEW_TIMEOUT",
    },
    {
      label: "a known capture schema failure",
      error: Object.assign(new Error("private title and native details"), { name: "WindowContractError", code: "WINDOW_CAPTURE_SCHEMA" }),
      code: "WINDOW_PREVIEW_CAPTURE_FAILED",
    },
    {
      label: "an unconfirmed temporary-session cleanup",
      error: Object.assign(new Error("private title and native details"), { name: "CuaWindowDiscoveryCleanupError", cleanupErrors: ["private cleanup detail"] }),
      code: "WINDOW_PREVIEW_CLEANUP_PENDING",
    },
    {
      label: "an error whose message only resembles a known CUA code",
      error: new Error("WINDOW_CAPTURE_DEADLINE private title and native details"),
      code: "WINDOW_PREVIEW_UNAVAILABLE",
    },
    {
      label: "an exact target that disappeared before capture",
      error: Object.assign(new Error("private title and native details"), { name: "WindowContractError", code: "WINDOW_TARGET_NOT_FOUND" }),
      code: "WINDOW_TARGET_STALE",
    },
  ])("projects $label as a safe preview response without leaking adapter details", async ({ error, code }) => {
    const outputDir = await mkdtemp(join(tmpdir(), "harness-remote-api-window-preview-failure-"));
    const first = { pid: 731, windowId: 7311, appName: "Notepad.exe", title: "Notes" };
    const { api, session, setWindows } = createFixture(outputDir, {
      summary: "The selected window task completed.",
      windowPreviewError: error,
    });
    setWindows([first, { ...first, pid: 732, windowId: 7321 }]);
    try {
      const choices = await api.listWindowTargets("device-one");
      let failure: unknown;
      try {
        await api.previewWindowTarget("device-one", choices.candidates[0]!.token);
      } catch (caught) {
        failure = caught;
      }
      expect(failure).toBeInstanceOf(RemoteRunApiError);
      expect(failure).toMatchObject({ code });
      expect((failure as Error).message).not.toContain("private title");
      expect((failure as Error).message).not.toContain("private cleanup detail");
      await expect(api.startRun("device-one", "preview-failure-no-proof", "Inspect the intended Notepad window", {
        mode: "window",
        targetToken: choices.candidates[0]!.token,
      })).rejects.toMatchObject({ code: "WINDOW_PREVIEW_REQUIRED" });
      expect(session.activeRun).toBeUndefined();
    } finally {
      await session.close();
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("binds handoff previews and confirmation proofs to the current Run request and exact candidate", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "harness-remote-api-handoff-preview-"));
    const root = { pid: 710, windowId: 7101, appName: "Notepad.exe", title: "Notes - Notepad" };
    const first: ComputerWindowCandidate = {
      pid: 711,
      windowId: 7111,
      appName: "Notepad.exe",
      title: "Untitled - Notepad",
      relationship: { kind: "owned_child", owner: { pid: root.pid, windowId: root.windowId }, rootRole: "dialog" },
    };
    const second = { pid: 712, windowId: 7121, appName: "Notepad.exe", title: "Untitled - Notepad" };
    const click: ToolCall = {
      id: "handoff-preview-click" as ToolCallId,
      name: "click",
      arguments: { x: 4, y: 4 },
      declaredEffect: { effects: ["navigate"], target: "dialog", summary: "Open the dialog" },
    };
    const { api, session, createdComputerConfigs, windowPreviewCalls, setWindows } = createFixture(outputDir, {
      summary: "The selected dialog task completed.",
      windowHandoff: "confirm-v1",
      windowHandoffCandidates: [first, second],
      windowPreviewOverride: {
        target: first,
        capturedAt: "2026-10-06T00:00:00.000Z",
        viewport: { width: 2_048, height: 1_200 },
        mediaType: "image/png",
        data: createNoisyPng(2_048, 1_200),
      },
      turnFactory: (turnNumber) => turnNumber === 1 ? { type: "tool_calls", calls: [click] } : { type: "finish", summary: "The selected dialog task completed." },
      executeAction: (action) => ({
        actionId: action.actionId,
        status: "refused",
        driverCode: "WINDOW_FOREGROUND_MISMATCH",
        message: "The foreground target changed before input.",
      }),
    });
    setWindows([root, first, second]);
    try {
      const initial = await api.listWindowTargets("device-one");
      const rootChoice = initial.candidates.find((candidate) => candidate.appName === root.appName);
      if (rootChoice === undefined) throw new Error("root candidate was not listed");
      const started = await api.startRun("device-one", "handoff-preview-run", "Save from the dialog", { mode: "window", targetToken: rootChoice.token });
      await waitFor(() => api.getRun("device-one", started.runId)?.pendingRequest?.kind === "window_handoff", "Run did not request window handoff");
      const waiting = api.getRun("device-one", started.runId)!;
      const candidates = waiting.pendingRequest?.kind === "window_handoff" ? waiting.pendingRequest.candidates : [];
      expect(candidates).toHaveLength(2);
      expect(candidates?.every((candidate) => candidate.previewRequired === true)).toBe(true);
      const candidate = candidates![0]!;
      const requestId = waiting.pendingRequest!.requestId;

      await expect(api.submitCommand("device-one", started.runId, {
        commandId: "handoff-preview-no-proof",
        expectedSequence: waiting.sequence,
        type: "window.confirm",
        requestId,
        candidateToken: candidate.token,
      })).rejects.toMatchObject({ code: "WINDOW_PREVIEW_REQUIRED" });

      await expect(api.previewWindowHandoffCandidate("device-one", started.runId, "stale-window-request", candidate.token))
        .rejects.toMatchObject({ code: "STALE_REQUEST" });
      const sequenceBeforePreview = waiting.sequence;
      const preview = await api.previewWindowHandoffCandidate("device-one", started.runId, requestId, candidate.token);
      expect(preview).toMatchObject({
        previewToken: expect.stringMatching(/^[A-Za-z0-9_-]{32}$/u),
        appName: "Notepad.exe",
        title: "Untitled - Notepad",
        relationship: { kind: "owned_child", rootRole: "dialog" },
        mediaType: "image/png",
      });
      const previewBytes = Buffer.from(preview.dataBase64, "base64");
      const decodedPreview = pngjs.PNG.sync.read(previewBytes);
      expect(previewBytes.byteLength).toBeLessThanOrEqual(MAX_WINDOW_PREVIEW_BYTES);
      expect(preview.viewport).toEqual({ width: decodedPreview.width, height: decodedPreview.height });
      expect(windowPreviewCalls).toEqual([{ pid: first.pid, windowId: first.windowId }]);
      expect(createdComputerConfigs[0]).toMatchObject({ windowTarget: { pid: root.pid, windowId: root.windowId } });
      expect(JSON.stringify(api.getRun("device-one", started.runId)?.pendingRequest)).not.toContain(preview.previewToken);
      expect(api.getRun("device-one", started.runId)?.sequence).toBe(sequenceBeforePreview);
      expect(JSON.stringify(api.getRun("device-one", started.runId))).not.toContain(preview.dataBase64);

      const current = api.getRun("device-one", started.runId)!;
      await api.submitCommand("device-one", started.runId, {
        commandId: "handoff-preview-valid-proof",
        expectedSequence: current.sequence,
        type: "window.confirm",
        requestId,
        candidateToken: candidate.token,
        previewToken: preview.previewToken,
      });
      await session.waitForActiveRun();
      expect(api.getRun("device-one", started.runId)?.pendingRequest).toBeUndefined();
      expect(windowPreviewCalls).toHaveLength(1);
    } finally {
      if (session.activeRun?.controller.getSnapshot().status !== "finished") session.activeRun?.controller.cancel("test cleanup");
      await session.waitForActiveRun().catch(() => undefined);
      await session.close();
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it.each([
    { label: "caller cancellation", stage: "before-list", listOffset: 1, abort: (controller: AbortController) => controller.abort(new DOMException("preview cancelled", "AbortError")) },
    { label: "the eight-second deadline", stage: "before-list", listOffset: 1, abort: (controller: AbortController) => controller.abort(new DOMException("preview deadline", "TimeoutError")) },
    { label: "caller cancellation", stage: "after-list", listOffset: 2, abort: (controller: AbortController) => controller.abort(new DOMException("preview cancelled", "AbortError")) },
    { label: "the eight-second deadline", stage: "after-list", listOffset: 2, abort: (controller: AbortController) => controller.abort(new DOMException("preview deadline", "TimeoutError")) },
  ])("does not mint a handoff preview proof after $label at the $stage gate while the list operation is settling", async ({ label, stage, listOffset, abort }) => {
    const outputDir = await mkdtemp(join(tmpdir(), "harness-remote-api-handoff-preview-abort-gate-"));
    const root = { pid: 715, windowId: 7151, appName: "WPS Office", title: "Budget.docx" };
    const candidate = { pid: 716, windowId: 7161, appName: "Notepad.exe", title: "Untitled - Notepad" };
    const duplicateCandidate = { ...candidate, pid: 717, windowId: 7171 };
    const gate = deferred<readonly ComputerWindowCandidate[]>();
    const timeoutController = new AbortController();
    let restoreTimeoutSpy: (() => void) | undefined;
    let listCalls = 0;
    let gatedListCall: number | undefined;
    const click: ToolCall = {
      id: "handoff-preview-abort-gate-click" as ToolCallId,
      name: "click",
      arguments: { x: 4, y: 4 },
      declaredEffect: { effects: ["navigate"], target: "dialog", summary: "Open the dialog" },
    };
    const { api, session, windowPreviewCalls, setWindows } = createFixture(outputDir, {
      summary: "Done.",
      windowHandoff: "confirm-v1",
      listWindowHandoffCandidates: () => {
        listCalls += 1;
        return listCalls === gatedListCall ? gate.promise : [candidate, duplicateCandidate];
      },
      turnFactory: (turnNumber) => turnNumber === 1
        ? { type: "tool_calls", calls: [click] }
        : { type: "finish", summary: "Done." },
      executeAction: (action) => ({
        actionId: action.actionId,
        status: "refused",
        driverCode: "WINDOW_FOREGROUND_MISMATCH",
        message: "The foreground target changed before input.",
      }),
    });
    setWindows([root, candidate, duplicateCandidate]);
    const callerController = new AbortController();
    try {
      const initial = await api.listWindowTargets("device-one");
      const rootChoice = initial.candidates.find((choice) => choice.appName === root.appName);
      if (rootChoice === undefined) throw new Error("root window was not listed");
      const started = await api.startRun("device-one", `handoff-preview-abort-${label.replaceAll(" ", "-")}`, "Continue in the dialog", {
        mode: "window", targetToken: rootChoice.token,
      });
      await waitFor(() => api.getRun("device-one", started.runId)?.pendingRequest?.kind === "window_handoff",
        "Run did not request window handoff");
      const waiting = api.getRun("device-one", started.runId)!;
      const pending = waiting.pendingRequest;
      if (pending?.kind !== "window_handoff") throw new Error("expected a handoff request");
      const candidateToken = pending.candidates[0]?.token;
      if (candidateToken === undefined) throw new Error("handoff candidate token was not published");
      const requestId = pending.requestId;
      gatedListCall = listCalls + listOffset;
      const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockImplementation((milliseconds) => {
        expect(milliseconds).toBe(8_000);
        return timeoutController.signal;
      });
      restoreTimeoutSpy = () => timeoutSpy.mockRestore();

      const previewPromise = api.previewWindowHandoffCandidate("device-one", started.runId, requestId, candidateToken,
        label === "caller cancellation" ? callerController.signal : undefined);
      let previewSettled = false;
      void previewPromise.then(() => { previewSettled = true; }, () => { previewSettled = true; });
      await waitFor(() => listCalls >= gatedListCall!, `${stage} handoff candidate check did not start`);
      if (label === "caller cancellation") abort(callerController);
      else abort(timeoutController);
      await Promise.resolve();
      expect(previewSettled).toBe(false);
      await expect(api.previewWindowHandoffCandidate("device-one", started.runId, requestId, candidateToken))
        .rejects.toMatchObject({ code: "WINDOW_PREVIEW_BUSY" });

      gate.resolve([candidate, duplicateCandidate]);
      await expect(previewPromise).rejects.toMatchObject({ name: label === "caller cancellation" ? "AbortError" : "TimeoutError" });
      restoreTimeoutSpy();
      restoreTimeoutSpy = undefined;
      expect(windowPreviewCalls).toEqual(stage === "before-list" ? [] : [{ pid: candidate.pid, windowId: candidate.windowId }]);
      const afterAbort = api.getRun("device-one", started.runId)?.pendingRequest;
      expect(afterAbort?.kind).toBe("window_handoff");
      if (afterAbort?.kind !== "window_handoff") throw new Error("the original handoff request was not preserved after abort");
      expect(afterAbort.requestId).toBe(requestId);
      expect(afterAbort.candidates.some((item) => item.token === candidateToken && item.title === candidate.title)).toBe(true);

      const retry = await api.previewWindowHandoffCandidate("device-one", started.runId, requestId, candidateToken);
      expect(retry.previewToken).toMatch(/^[A-Za-z0-9_-]{32}$/u);
      const afterRetry = api.getRun("device-one", started.runId)?.pendingRequest;
      expect(afterRetry?.kind).toBe("window_handoff");
      if (afterRetry?.kind !== "window_handoff") throw new Error("the original handoff request was not preserved after retry");
      expect(afterRetry.requestId).toBe(requestId);
      expect(afterRetry.candidates.some((item) => item.token === candidateToken && item.title === candidate.title)).toBe(true);
      expect(windowPreviewCalls).toHaveLength(stage === "before-list" ? 1 : 2);
    } finally {
      restoreTimeoutSpy?.();
      gate.resolve([candidate, duplicateCandidate]);
      if (session.activeRun?.controller.getSnapshot().status !== "finished") session.activeRun?.controller.cancel("test cleanup");
      await session.waitForActiveRun().catch(() => undefined);
      await session.close();
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("keeps an ordinary candidate preview busy until an abort-insensitive capture settles, then permits the exact candidate retry", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "harness-remote-api-preview-capture-abort-gate-"));
    const first = { pid: 717, windowId: 7171, appName: "Notepad.exe", title: "Untitled - Notepad" };
    const capture = deferred<WindowTargetPreview>();
    let captureCalls = 0;
    const { api, session, windowPreviewCalls, setWindows } = createFixture(outputDir, {
      summary: "Done.",
      windowPreviewCapture: (target) => {
        captureCalls += 1;
        if (captureCalls === 1) return capture.promise;
        return {
          target,
          capturedAt: "2026-10-04T00:00:00.000Z",
          viewport: { width: 8, height: 8 },
          mediaType: "image/png",
          data: new Uint8Array([137, 80, 78, 71]),
        };
      },
    });
    const other = { ...first, pid: first.pid + 1, windowId: first.windowId + 1 };
    setWindows([first, other]);
    const controller = new AbortController();
    try {
      const choices = await api.listWindowTargets("device-one");
      const firstChoice = choices.candidates[0]!;
      const previewPromise = api.previewWindowTarget("device-one", firstChoice.token, controller.signal);
      let previewSettled = false;
      void previewPromise.then(() => { previewSettled = true; }, () => { previewSettled = true; });
      await waitFor(() => captureCalls === 1, "ordinary preview capture did not start");
      controller.abort(new DOMException("preview cancelled", "AbortError"));
      await Promise.resolve();
      expect(previewSettled).toBe(false);
      await expect(api.previewWindowTarget("device-one", firstChoice.token)).rejects.toMatchObject({ code: "WINDOW_PREVIEW_BUSY" });
      capture.resolve({
        target: first,
        capturedAt: "2026-10-04T00:00:00.000Z",
        viewport: { width: 8, height: 8 },
        mediaType: "image/png",
        data: new Uint8Array([137, 80, 78, 71]),
      });
      await expect(previewPromise).rejects.toBeDefined();
      expect(windowPreviewCalls).toEqual([{ pid: first.pid, windowId: first.windowId }]);
      const retry = await api.previewWindowTarget("device-one", firstChoice.token);
      expect(retry.appName).toBe(first.appName);
      expect(retry.title).toBe(first.title);
      expect(retry.previewToken).toMatch(/^[A-Za-z0-9_-]{32}$/u);
      expect(windowPreviewCalls).toHaveLength(2);
    } finally {
      capture.resolve({
        target: first,
        capturedAt: "2026-10-04T00:00:00.000Z",
        viewport: { width: 8, height: 8 },
        mediaType: "image/png",
        data: new Uint8Array([137, 80, 78, 71]),
      });
      if (session.activeRun?.controller.getSnapshot().status !== "finished") session.activeRun?.controller.cancel("test cleanup");
      await session.waitForActiveRun().catch(() => undefined);
      await session.close();
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("publishes handoff candidates only after the initial candidate refresh resolves", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "harness-remote-api-handoff-refresh-delay-"));
    const root = { pid: 731, windowId: 7311, appName: "WPS Office", title: "Budget.docx" };
    const candidate = { pid: 732, windowId: 7321, appName: "Notepad.exe", title: "Untitled - Notepad" };
    const candidateRefresh = deferred<readonly ComputerWindowCandidate[]>();
    let listStarted = 0;
    const click: ToolCall = {
      id: "handoff-refresh-delay-click" as ToolCallId,
      name: "click",
      arguments: { x: 4, y: 4 },
      declaredEffect: { effects: ["navigate"], target: "dialog", summary: "Open the dialog" },
    };
    const { api, session, setWindows } = createFixture(outputDir, {
      summary: "Done.",
      windowHandoff: "confirm-v1",
      listWindowHandoffCandidates: () => {
        listStarted += 1;
        return candidateRefresh.promise;
      },
      turnFactory: (turnNumber) => turnNumber === 1
        ? { type: "tool_calls", calls: [click] }
        : { type: "finish", summary: "Done." },
      executeAction: (action) => ({
        actionId: action.actionId,
        status: "refused",
        driverCode: "WINDOW_FOREGROUND_MISMATCH",
        message: "The foreground target changed before input.",
      }),
    });
    setWindows([root]);
    const pendingEvents: unknown[] = [];
    let subscription: ReturnType<typeof api.subscribe> | undefined;
    try {
      const initial = await api.listWindowTargets("device-one");
      const rootChoice = initial.candidates.find((choice) => choice.appName === root.appName);
      if (rootChoice === undefined) throw new Error("root window was not listed");
      const started = await api.startRun("device-one", "handoff-refresh-delay", "Continue in the dialog", {
        mode: "window", targetToken: rootChoice.token,
      });
      subscription = api.subscribe("device-one", started.runId, 0, (event) => pendingEvents.push(event));
      await waitFor(() => listStarted === 1 && api.getRun("device-one", started.runId)?.status === "waiting_window",
        "handoff candidate refresh did not start");

      expect(api.getRun("device-one", started.runId)?.pendingRequest).toBeUndefined();
      const earlyPendingRequests = pendingEvents.filter((event) => {
        if (typeof event !== "object" || event === null || !("type" in event) || event.type !== "run.event" || !("data" in event)) return false;
        const data = event.data;
        return typeof data === "object" && data !== null && "type" in data && data.type === "run.pending_request" && "request" in data;
      });
      expect(earlyPendingRequests).toEqual([]);

      candidateRefresh.resolve([candidate]);
      await waitFor(() => {
        const pending = api.getRun("device-one", started.runId)?.pendingRequest;
        return pending?.kind === "window_handoff" && pending.candidates.length === 1;
      }, "the refreshed candidate was not published");
      expect(api.getRun("device-one", started.runId)?.pendingRequest).toMatchObject({
        kind: "window_handoff",
        candidates: [{ appName: candidate.appName, title: candidate.title }],
      });
    } finally {
      subscription?.close();
      candidateRefresh.resolve([]);
      if (session.activeRun?.controller.getSnapshot().status !== "finished") session.activeRun?.controller.cancel("test cleanup");
      await session.waitForActiveRun().catch(() => undefined);
      await session.close();
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("emits one token for repeated same-identity handoff records with identical evidence", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "harness-remote-api-handoff-dedupe-identical-"));
    const duplicate: ComputerWindowCandidate = {
      pid: 781,
      windowId: 7811,
      appName: "Notepad.exe",
      title: "Notes",
      relationship: { kind: "scoped_peer" },
    };
    const fixture = await startHandoffWithCandidates(outputDir, [duplicate, { ...duplicate }], "identical");
    try {
      expect(fixture.pending.candidates).toHaveLength(1);
      expect(fixture.pending.candidates[0]).toMatchObject({
        appName: duplicate.appName,
        title: duplicate.title,
        relationship: { kind: "scoped_peer" },
      });
    } finally {
      if (fixture.session.activeRun?.controller.getSnapshot().status !== "finished") {
        fixture.session.activeRun?.controller.cancel("identical handoff candidate test cleanup");
      }
      await fixture.session.waitForActiveRun().catch(() => undefined);
      await fixture.session.close();
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("keeps different same-label handoff identities separate and preview-required", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "harness-remote-api-handoff-dedupe-distinct-"));
    const first: ComputerWindowCandidate = { pid: 782, windowId: 7821, appName: "Editor.exe", title: "Untitled" };
    const second: ComputerWindowCandidate = { pid: 783, windowId: 7831, appName: "Editor.exe", title: "Untitled" };
    const fixture = await startHandoffWithCandidates(outputDir, [first, second], "distinct");
    try {
      expect(fixture.pending.candidates).toHaveLength(2);
      expect(new Set(fixture.pending.candidates.map((candidate) => candidate.token)).size).toBe(2);
      expect(fixture.pending.candidates.every((candidate) => candidate.previewRequired === true)).toBe(true);
    } finally {
      if (fixture.session.activeRun?.controller.getSnapshot().status !== "finished") {
        fixture.session.activeRun?.controller.cancel("distinct handoff candidate test cleanup");
      }
      await fixture.session.waitForActiveRun().catch(() => undefined);
      await fixture.session.close();
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("preserves distinct handoff evidence whose labels contain delimiter collisions", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "harness-remote-api-handoff-dedupe-delimiter-"));
    const identity = { pid: 785, windowId: 7851 };
    const first: ComputerWindowCandidate = { ...identity, appName: "Editor:a", title: "b" };
    const second: ComputerWindowCandidate = { ...identity, appName: "Editor", title: "a:b" };
    const fixture = await startHandoffWithCandidates(outputDir, [first, second], "delimiter-collision");
    try {
      expect(fixture.pending.candidates).toHaveLength(2);
      expect(new Set(fixture.pending.candidates.map((candidate) => candidate.token)).size).toBe(2);
      expect(fixture.pending.candidates.map((candidate) => [candidate.appName, candidate.title]))
        .toEqual([[first.appName, first.title], [second.appName, second.title]]);
    } finally {
      if (fixture.session.activeRun?.controller.getSnapshot().status !== "finished") {
        fixture.session.activeRun?.controller.cancel("delimiter candidate test cleanup");
      }
      await fixture.session.waitForActiveRun().catch(() => undefined);
      await fixture.session.close();
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("preserves conflicting relationship evidence for one identity as separate preview-required rows", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "harness-remote-api-handoff-dedupe-conflict-"));
    const sameIdentity = { pid: 784, windowId: 7841, appName: "Editor.exe", title: "Untitled" };
    const ownedChild: ComputerWindowCandidate = {
      ...sameIdentity,
      relationship: { kind: "owned_child", owner: { pid: 780, windowId: 7801 }, rootRole: "dialog" },
    };
    const scopedPeer: ComputerWindowCandidate = { ...sameIdentity, relationship: { kind: "scoped_peer" } };
    const fixture = await startHandoffWithCandidates(outputDir, [ownedChild, scopedPeer], "conflicting-relationship");
    try {
      expect(fixture.pending.candidates).toHaveLength(2);
      expect(new Set(fixture.pending.candidates.map((candidate) => candidate.token)).size).toBe(2);
      expect(fixture.pending.candidates.map((candidate) => candidate.relationship?.kind).sort())
        .toEqual(["owned_child", "scoped_peer"]);
      expect(fixture.pending.candidates.every((candidate) => candidate.previewRequired === true)).toBe(true);
    } finally {
      if (fixture.session.activeRun?.controller.getSnapshot().status !== "finished") {
        fixture.session.activeRun?.controller.cancel("conflicting relationship candidate test cleanup");
      }
      await fixture.session.waitForActiveRun().catch(() => undefined);
      await fixture.session.close();
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("publishes a recoverable empty handoff after candidate refresh fails", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "harness-remote-api-handoff-refresh-failure-"));
    const root = { pid: 741, windowId: 7411, appName: "WPS Office", title: "Budget.docx" };
    const click: ToolCall = {
      id: "handoff-refresh-failure-click" as ToolCallId,
      name: "click",
      arguments: { x: 4, y: 4 },
      declaredEffect: { effects: ["navigate"], target: "dialog", summary: "Open the dialog" },
    };
    const { api, session, setWindows } = createFixture(outputDir, {
      summary: "Done.",
      windowHandoff: "confirm-v1",
      listWindowHandoffCandidates: async () => { throw new Error("fixture inventory unavailable"); },
      turnFactory: (turnNumber) => turnNumber === 1
        ? { type: "tool_calls", calls: [click] }
        : { type: "finish", summary: "Done." },
      executeAction: (action) => ({
        actionId: action.actionId,
        status: "refused",
        driverCode: "WINDOW_FOREGROUND_MISMATCH",
        message: "The foreground target changed before input.",
      }),
    });
    setWindows([root]);
    let subscription: ReturnType<typeof api.subscribe> | undefined;
    try {
      const initial = await api.listWindowTargets("device-one");
      const rootChoice = initial.candidates.find((choice) => choice.appName === root.appName);
      if (rootChoice === undefined) throw new Error("root window was not listed");
      const started = await api.startRun("device-one", "handoff-refresh-failure", "Continue safely", {
        mode: "window", targetToken: rootChoice.token,
      });
      const events: unknown[] = [];
      subscription = api.subscribe("device-one", started.runId, 0, (event) => events.push(event));
      await waitFor(() => {
        const pending = api.getRun("device-one", started.runId)?.pendingRequest;
        return pending?.kind === "window_handoff";
      }, "a failed candidate refresh left the handoff without recovery controls");
      const waiting = api.getRun("device-one", started.runId)!;
      expect(waiting.pendingRequest).toMatchObject({ kind: "window_handoff", reasonCode: "foreground_mismatch", candidates: [] });
      expect(waiting.capabilities).toMatchObject({ windowHandoff: true, abort: true });
      expect(events.some((event) => {
        if (typeof event !== "object" || event === null || !("type" in event) || event.type !== "run.event" || !("data" in event)) return false;
        const data = event.data;
        return typeof data === "object" && data !== null && "type" in data && data.type === "run.pending_request" &&
          "request" in data && typeof data.request === "object" && data.request !== null &&
          "kind" in data.request && data.request.kind === "window_handoff" &&
          "candidates" in data.request && Array.isArray(data.request.candidates) && data.request.candidates.length === 0;
      })).toBe(true);

      await api.submitCommand("device-one", started.runId, {
        commandId: "handoff-refresh-failure-abort",
        expectedSequence: waiting.sequence,
        type: "abort",
      });
      await session.waitForActiveRun();
      expect(api.getRun("device-one", started.runId)?.status).toBe("finished");
      expect(api.getRun("device-one", started.runId)?.pendingRequest).toBeUndefined();
    } finally {
      subscription?.close();
      if (session.activeRun?.controller.getSnapshot().status !== "finished") session.activeRun?.controller.cancel("test cleanup");
      await session.waitForActiveRun().catch(() => undefined);
      await session.close();
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("cancels and ignores a late candidate refresh when its Run is aborted", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "harness-remote-api-handoff-refresh-cancel-"));
    const root = { pid: 751, windowId: 7511, appName: "WPS Office", title: "Budget.docx" };
    const staleCandidate = { pid: 752, windowId: 7521, appName: "Notepad.exe", title: "Stale candidate" };
    const currentCandidate = { pid: 753, windowId: 7531, appName: "Notepad.exe", title: "Current candidate" };
    const staleRefresh = deferred<readonly ComputerWindowCandidate[]>();
    let listCalls = 0;
    let staleSignal: AbortSignal | undefined;
    const click: ToolCall = {
      id: "handoff-refresh-cancel-click" as ToolCallId,
      name: "click",
      arguments: { x: 4, y: 4 },
      declaredEffect: { effects: ["navigate"], target: "dialog", summary: "Open the dialog" },
    };
    const { api, session, setWindows } = createFixture(outputDir, {
      summary: "Done.",
      windowHandoff: "confirm-v1",
      listWindowHandoffCandidates: (signal) => {
        listCalls += 1;
        if (listCalls === 1) {
          staleSignal = signal;
          return staleRefresh.promise;
        }
        return [currentCandidate];
      },
      turnFactory: (turnNumber) => turnNumber === 1
        ? { type: "tool_calls", calls: [click] }
        : { type: "finish", summary: "Done." },
      executeAction: (action) => ({
        actionId: action.actionId,
        status: "refused",
        driverCode: "WINDOW_FOREGROUND_MISMATCH",
        message: "The foreground target changed before input.",
      }),
    });
    setWindows([root]);
    let firstSubscription: ReturnType<typeof api.subscribe> | undefined;
    let secondSubscription: ReturnType<typeof api.subscribe> | undefined;
    try {
      const firstTargets = await api.listWindowTargets("device-one");
      const rootChoice = firstTargets.candidates.find((choice) => choice.appName === root.appName);
      if (rootChoice === undefined) throw new Error("root window was not listed");
      const firstRun = await api.startRun("device-one", "handoff-refresh-cancel-first", "Continue safely", {
        mode: "window", targetToken: rootChoice.token,
      });
      const firstEvents: unknown[] = [];
      firstSubscription = api.subscribe("device-one", firstRun.runId, 0, (event) => firstEvents.push(event));
      await waitFor(() => listCalls === 1 && api.getRun("device-one", firstRun.runId)?.status === "waiting_window",
        "the first candidate refresh did not start");

      const firstState = api.getRun("device-one", firstRun.runId)!;
      await api.submitCommand("device-one", firstRun.runId, {
        commandId: "handoff-refresh-cancel-abort",
        expectedSequence: firstState.sequence,
        type: "abort",
      });
      await session.waitForActiveRun();
      expect(staleSignal?.aborted).toBe(true);

      const secondTargets = await api.listWindowTargets("device-one");
      const secondRootChoice = secondTargets.candidates.find((choice) => choice.appName === root.appName);
      if (secondRootChoice === undefined) throw new Error("root window was not listed for the replacement Run");
      const secondRun = await api.startRun("device-one", "handoff-refresh-cancel-second", "Continue safely", {
        mode: "window", targetToken: secondRootChoice.token,
      });
      const secondEvents: unknown[] = [];
      secondSubscription = api.subscribe("device-one", secondRun.runId, 0, (event) => secondEvents.push(event));
      await waitFor(() => {
        const pending = api.getRun("device-one", secondRun.runId)?.pendingRequest;
        return pending?.kind === "window_handoff" && pending.candidates.length === 1;
      }, "the replacement Run candidate refresh did not publish");
      expect(api.getRun("device-one", secondRun.runId)?.pendingRequest).toMatchObject({
        kind: "window_handoff",
        candidates: [{ title: currentCandidate.title }],
      });

      staleRefresh.resolve([staleCandidate]);
      await new Promise((resolveWait) => setTimeout(resolveWait, 0));
      expect(api.getRun("device-one", firstRun.runId)?.pendingRequest).toBeUndefined();
      expect(api.getRun("device-one", secondRun.runId)?.pendingRequest).toMatchObject({
        kind: "window_handoff",
        candidates: [{ title: currentCandidate.title }],
      });
      expect(firstEvents.some((event) => {
        if (typeof event !== "object" || event === null || !("type" in event) || event.type !== "run.event" || !("data" in event)) return false;
        const data = event.data;
        return typeof data === "object" && data !== null && "type" in data && data.type === "run.pending_request" &&
          "request" in data && JSON.stringify(data.request).includes(staleCandidate.title);
      })).toBe(false);
      expect(secondEvents.some((event) => {
        if (typeof event !== "object" || event === null || !("type" in event) || event.type !== "run.event" || !("data" in event)) return false;
        const data = event.data;
        return typeof data === "object" && data !== null && "type" in data && data.type === "run.pending_request" &&
          "request" in data && JSON.stringify(data.request).includes(staleCandidate.title);
      })).toBe(false);
    } finally {
      firstSubscription?.close();
      secondSubscription?.close();
      staleRefresh.resolve([staleCandidate]);
      if (session.activeRun?.controller.getSnapshot().status !== "finished") session.activeRun?.controller.cancel("test cleanup");
      await session.waitForActiveRun().catch(() => undefined);
      await session.close();
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it.each([
    { label: "a different window identity", code: "WINDOW_TARGET_STALE", makePreview: (first: WindowTargetInfo): WindowTargetPreview => ({
      target: { ...first, pid: first.pid + 1 },
      capturedAt: "2026-10-04T00:00:00.000Z",
      viewport: { width: 8, height: 8 },
      mediaType: "image/png",
      data: new Uint8Array([137, 80, 78, 71]),
    }) },
    { label: "a source image above the internal cap", code: "WINDOW_PREVIEW_IMAGE_TOO_LARGE", makePreview: (first: WindowTargetInfo): WindowTargetPreview => ({
      target: first,
      capturedAt: "2026-10-04T00:00:00.000Z",
      viewport: { width: 8, height: 8 },
      mediaType: "image/png",
      data: new Uint8Array(16 * 1024 * 1024 + 1),
    }) },
  ])("refuses a candidate preview with $label without granting a reusable proof", async ({ makePreview, code }) => {
    const outputDir = await mkdtemp(join(tmpdir(), "harness-remote-api-invalid-window-preview-"));
    const first = { pid: 721, windowId: 7211, appName: "Notepad.exe", title: "Untitled - Notepad" };
    const { api, session, createdComputerConfigs, setWindows } = createFixture(outputDir, {
      summary: "The selected window task completed.",
      windowPreviewOverride: makePreview(first),
    });
    setWindows([first, { ...first, pid: 722, windowId: 7221 }]);
    try {
      const choices = await api.listWindowTargets("device-one");
      await expect(api.previewWindowTarget("device-one", choices.candidates[0]!.token))
        .rejects.toMatchObject({ code });
      await expect(api.startRun("device-one", "invalid-window-preview-proof", "Inspect the intended Notepad window", {
        mode: "window",
        targetToken: choices.candidates[0]!.token,
      })).rejects.toMatchObject({ code: "WINDOW_PREVIEW_REQUIRED" });
      expect(session.activeRun).toBeUndefined();
      expect(createdComputerConfigs).toEqual([]);
    } finally {
      await session.close();
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("normalizes a valid oversized PNG before issuing the exact candidate preview proof", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "harness-remote-api-window-preview-thumbnail-"));
    const first = { pid: 721, windowId: 7211, appName: "Notepad.exe", title: "Untitled - Notepad" };
    const source = createNoisyPng(2_048, 1_200);
    expect(source.byteLength).toBeGreaterThan(MAX_WINDOW_PREVIEW_BYTES);
    const { api, session, setWindows } = createFixture(outputDir, {
      summary: "The selected window task completed.",
      windowPreviewOverride: {
        target: first,
        capturedAt: "2026-10-06T00:00:00.000Z",
        viewport: { width: 2_048, height: 1_200 },
        mediaType: "image/png",
        data: source,
      },
    });
    setWindows([first, { ...first, pid: 722, windowId: 7221 }]);
    try {
      const choices = await api.listWindowTargets("device-one");
      expect(choices.candidates.every((candidate) => candidate.previewRequired === true)).toBe(true);
      const preview = await api.previewWindowTarget("device-one", choices.candidates[0]!.token);
      const thumbnail = Buffer.from(preview.dataBase64, "base64");
      const decoded = pngjs.PNG.sync.read(thumbnail);
      expect(thumbnail.byteLength).toBeLessThanOrEqual(MAX_WINDOW_PREVIEW_BYTES);
      expect(preview.viewport).toEqual({ width: decoded.width, height: decoded.height });
      await expect(api.startRun("device-one", "thumbnail-wrong-proof", "Inspect the intended Notepad window", {
        mode: "window", targetToken: choices.candidates[0]!.token, previewToken: "X".repeat(32),
      })).rejects.toMatchObject({ code: "WINDOW_PREVIEW_REQUIRED" });
      await expect(api.startRun("device-one", "thumbnail-exact-proof", "Inspect the intended Notepad window", {
        mode: "window", targetToken: choices.candidates[0]!.token, previewToken: preview.previewToken,
      })).resolves.toBeDefined();
      await session.waitForActiveRun();
    } finally {
      await session.close();
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("keeps the public stream unchanged when RunNotice projection is disabled", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "harness-remote-api-notices-off-"));
    const { api, session } = createFixture(outputDir, { askFirst: true, summary: "Done." });
    try {
      const choices = await api.listWindowTargets("device-one");
      const started = await api.startRun("device-one", "notices-off", "Check a schedule", choices.candidates[0]!.token);
      await waitFor(() => api.getRun("device-one", started.runId)?.status === "waiting_user", "Run did not request user input");
      const events: Array<{ type: string; data?: Record<string, unknown> }> = [];
      const subscription = api.subscribe("device-one", started.runId, 0, (event) => {
        if (event.type === "run.event") events.push(event as unknown as { type: string; data?: Record<string, unknown> });
      });
      subscription.close();
      expect(events.some((event) => event.data?.type === "run.notice")).toBe(false);
      expect(events.some((event) => event.data?.type === "run.pending_request")).toBe(true);
      const surfaceTransition = events.find((event) => event.data?.type === "run.surface_transition");
      expect(surfaceTransition?.data).toMatchObject({ reason: "initial_observation", fromKind: null, toKind: "native_window", generation: 1 });
      expect(JSON.stringify(surfaceTransition)).not.toContain(nativeWindowSurfaceRef.surfaceId);
      const current = api.getRun("device-one", started.runId)!;
      await api.submitCommand("device-one", started.runId, {
        commandId: "answer-notices-off",
        expectedSequence: current.sequence,
        type: "respond",
        requestId: current.pendingRequest!.requestId,
        text: "明天",
      });
      await session.waitForActiveRun();
    } finally {
      await session.close();
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("publishes minimal safe notices, validates pending IDs, and replays them through the ordered stream", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "harness-remote-api-notices-on-"));
    const { api, session } = createFixture(outputDir, { askFirst: true, summary: "A private itinerary summary.", runNotices: true, runNoticeDynamicContent: true });
    try {
      const choices = await api.listWindowTargets("device-one");
      const started = await api.startRun("device-one", "notices-on", "Check a schedule", choices.candidates[0]!.token);
      await waitFor(() => api.getRun("device-one", started.runId)?.status === "waiting_user", "Run did not request user input");

      const initialEvents: Array<{ sequence: number; data?: Record<string, unknown> }> = [];
      const initialSubscription = api.subscribe("device-one", started.runId, 0, (event) => {
        if (event.type === "run.event") initialEvents.push(event as unknown as { sequence: number; data?: Record<string, unknown> });
      });
      initialSubscription.close();
      const startNotices = initialEvents.filter((event) => event.data?.type === "run.notice" && event.data.text === "任务已开始。");
      expect(startNotices).toHaveLength(1);
      expect(startNotices[0]?.data).toMatchObject({
        kind: "progress",
        text: "任务已开始。",
        delivery: "polite",
        eventSequence: 0,
      });
      expect(JSON.stringify(startNotices[0])).not.toContain("Check a schedule");
      const startReplay: unknown[] = [];
      const startReplaySubscription = api.subscribe("device-one", started.runId, startNotices[0]!.sequence - 1, (event) => startReplay.push(event));
      startReplaySubscription.close();
      expect(startReplay.filter((event) => JSON.stringify(event).includes(String(startNotices[0]?.data?.noticeId)))).toHaveLength(1);

      const questionNotice = initialEvents.find((event) => event.data?.type === "run.notice" && event.data.kind === "question");
      const pendingRequestId = api.getRun("device-one", started.runId)?.pendingRequest?.requestId;
      expect(questionNotice?.data).toEqual({
        type: "run.notice",
        noticeId: expect.any(String),
        kind: "question",
        text: "我有个问题需要你回答，请查看任务。",
        delivery: "interrupt",
        eventSequence: expect.any(Number),
        pendingRequestId,
      });
      expect(JSON.stringify(questionNotice)).not.toContain("Which date should I check?");
      expect(JSON.stringify(questionNotice)).not.toMatch(/reason|path|modelDeclaredEffect/iu);

      const questionSequence = questionNotice!.sequence;
      const replayed: unknown[] = [];
      const replaySubscription = api.subscribe("device-one", started.runId, questionSequence - 1, (event) => replayed.push(event));
      replaySubscription.close();
      expect(replayed).toHaveLength(1);
      expect(JSON.stringify(replayed[0])).toContain('"noticeId"');

      const current = api.getRun("device-one", started.runId)!;
      await api.submitCommand("device-one", started.runId, {
        commandId: "answer-notices-on",
        expectedSequence: current.sequence,
        type: "respond",
        requestId: current.pendingRequest!.requestId,
        text: "明天",
      });
      await waitFor(() => api.getRun("device-one", started.runId)?.status === "finished", "Run did not finish after user input");
      const terminalEvents: Array<{ sequence: number; data?: Record<string, unknown> }> = [];
      const terminalSubscription = api.subscribe("device-one", started.runId, questionSequence, (event) => {
        if (event.type === "run.event") terminalEvents.push(event as unknown as { sequence: number; data?: Record<string, unknown> });
      });
      terminalSubscription.close();
      const resultNotices = terminalEvents.filter((event) => event.data?.type === "run.notice" && event.data.kind === "result");
      expect(resultNotices).toHaveLength(1);
      expect(resultNotices[0]?.data?.text).toBe("任务已完成，可查看结果。");
      expect(terminalEvents.some((event) => event.data?.type === "run.notice" && event.data.text === "任务已开始。")).toBe(false);
    } finally {
      await session.close();
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("publishes the first validated milestone soon after run start instead of rate-limiting it", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "harness-remote-api-first-milestone-notice-"));
    const click: ToolCall = {
      id: "first-milestone-click" as ToolCallId,
      name: "click",
      arguments: { x: 4, y: 4 },
      declaredEffect: { effects: ["navigate"], target: "results", summary: "Open results" },
    };
    let bindingAtSecondTurn: ReturnType<typeof currentObservationAssessmentBinding>;
    const { api, session } = createFixture(outputDir, {
      summary: "The task is complete.",
      runNotices: true,
      runNoticeDynamicContent: true,
      monitor: "guidance",
      turnFactory: (turnNumber, _input, events) => {
        if (turnNumber === 1) return { type: "tool_calls", calls: [click] };
        bindingAtSecondTurn = currentObservationAssessmentBinding(events);
        const binding = bindingAtSecondTurn;
        if (binding === undefined || binding.transition !== "changed") return { type: "finish", summary: "No validated changed transition." };
        return {
          type: "finish",
          summary: "The report is ready.",
          observationAssessment: {
            observationId: binding.observationId,
            actionId: binding.actionId,
            actionOutcome: "expected_change",
            evidence: "The results page is visibly open.",
            progress: { kind: "milestone", summary: "The results page is open." },
          },
        };
      },
    });
    try {
      const choices = await api.listWindowTargets("device-one");
      const started = await api.startRun("device-one", "first-milestone-notice", "Open the results page", choices.candidates[0]!.token, undefined, true);
      await session.waitForActiveRun();
      expect(bindingAtSecondTurn?.transition).toBe("changed");

      const events: Array<{ sequence: number; data?: Record<string, unknown> }> = [];
      const subscription = api.subscribe("device-one", started.runId, 0, (event) => {
        if (event.type === "run.event") events.push(event as unknown as { sequence: number; data?: Record<string, unknown> });
      });
      subscription.close();
      const notices = events.filter((event) => event.data?.type === "run.notice");
      const startNotice = notices.find((event) => event.data?.text === "任务已开始。");
      const milestoneNotice = notices.find((event) => event.data?.text === "The results page is open.");
      expect(startNotice).toBeDefined();
      expect(milestoneNotice).toBeDefined();
      expect(milestoneNotice?.data).not.toHaveProperty("progressSemantic");
      expect(milestoneNotice!.sequence).toBeGreaterThan(startNotice!.sequence);
    } finally {
      session.activeRun?.controller.cancel("first milestone notice test cleanup");
      await session.waitForActiveRun();
      await session.close();
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("projects the exact pending guarded click, its claimed target, and clears it when that approval resolves", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "harness-remote-api-approval-preview-"));
    const earlierCall: ToolCall = {
      id: "approval-preview-old" as ToolCallId,
      name: "click",
      arguments: { x: 10, y: 20 },
      declaredEffect: { effects: ["navigate"], target: "旧页面", summary: "打开旧页面" },
    };
    const pendingCall: ToolCall = {
      id: "approval-preview-current" as ToolCallId,
      name: "click",
      arguments: { x: 408, y: 667 },
      declaredEffect: { effects: ["navigate"], target: "查询", summary: "点击查询按钮" },
    };
    const { api, session } = createFixture(outputDir, {
      summary: "The pending click was rejected.",
      screen: { width: 900, height: 900, coordinateSpace: "physical" },
      runNotices: true,
      runNoticeDynamicContent: true,
      turns: [
        { type: "tool_calls", calls: [earlierCall] },
        { type: "tool_calls", calls: [pendingCall] },
      ],
      guardDecisions: [
        fixtureGuardDecision("allow", "The earlier click is allowed."),
        fixtureGuardDecision("require_approval", "This action requires approval."),
      ],
    });
    try {
      const choices = await api.listWindowTargets("device-one");
      const started = await api.startRun("device-one", "approval-preview-click", "Check the current page", choices.candidates[0]!.token, undefined, true);
      await waitFor(() => api.getRun("device-one", started.runId)?.status === "waiting_approval", "Run did not request click approval");

      const snapshot = api.getRun("device-one", started.runId)!;
      const pending = snapshot.pendingRequest;
      expect(pending?.kind).toBe("approval");
      if (pending?.kind !== "approval") throw new Error("expected an approval request");
      expect(pending.requiresVisualReview).toBe(true);
      expect(pending.reason).toContain("This action requires approval.");
      expect(pending.preview).toMatchObject({
        actions: [{ operation: "click", kind: "click", points: [{ x: 408, y: 667 }] }],
        modelDeclaredEffect: { target: "查询", summary: "点击查询按钮", verified: false },
        evidence: {
          assetId: expect.any(String),
          observationId: expect.any(String),
          decisionObservationId: expect.any(String),
          capturedAt: expect.any(String),
          viewport: { width: 900, height: 900, coordinateSpace: "physical" },
          surfaceRef: { surfaceId: nativeWindowSurfaceRef.surfaceId, generation: nativeWindowSurfaceRef.generation, kind: nativeWindowSurfaceRef.kind },
        },
      });
      const evidence = pending.preview?.evidence;
      expect(evidence).toBeDefined();
      expect(evidence?.observationId).not.toBe(evidence?.decisionObservationId);
      const evidenceAsset = await api.getAsset("device-one", started.runId, evidence!.assetId);
      expect(evidenceAsset).toMatchObject({ mediaType: "image/png" });
      expect(evidenceAsset?.data.byteLength).toBeGreaterThan(0);
      expect(await api.getAsset("device-two", started.runId, evidence!.assetId)).toBeUndefined();
      expect(JSON.stringify(pending)).not.toContain("旧页面");

      const streamedEvents: unknown[] = [];
      const subscription = api.subscribe("device-one", started.runId, 0, (event) => streamedEvents.push(event));
      subscription.close();
      const pendingProjection = streamedEvents.find((event) => {
        if (typeof event !== "object" || event === null || !("type" in event) || event.type !== "run.event" || !("data" in event)) return false;
        const data = event.data;
        return typeof data === "object" && data !== null && "type" in data && data.type === "run.pending_request" && "request" in data;
      });
      expect(JSON.stringify(pendingProjection)).toContain('"x":408');
      expect(JSON.stringify(pendingProjection)).toContain('"target":"查询"');
      expect(JSON.stringify(pendingProjection)).toContain('"requiresVisualReview":true');
      expect(JSON.stringify(pendingProjection)).toContain('"evidence"');
      expect(JSON.stringify(pendingProjection)).not.toContain("旧页面");

      const approvalNoticeEvent = streamedEvents.find((event) => {
        if (typeof event !== "object" || event === null || !("type" in event) || event.type !== "run.event" || !("data" in event)) return false;
        const data = event.data;
        return typeof data === "object" && data !== null && "type" in data && data.type === "run.notice" && "kind" in data && data.kind === "approval";
      });
      expect(approvalNoticeEvent).toMatchObject({
        data: {
          type: "run.notice",
          noticeId: expect.any(String),
          kind: "approval",
          text: "电脑打算按这份说明操作：「点击查询按钮」；目标：「查询」。这项操作还没执行；说明仍需核对，请勿仅凭说明批准。 可能涉及对外发送或提交内容的点击操作，请核对后审批。",
          delivery: "interrupt",
          eventSequence: expect.any(Number),
          pendingRequestId: pending.requestId,
        },
      });
      expect(JSON.stringify(approvalNoticeEvent)).not.toContain(pending.reason);
      expect(JSON.stringify(approvalNoticeEvent)).not.toMatch(/reason|path|policyVersion|modelRequestCount/iu);

      await api.submitCommand("device-one", started.runId, {
        commandId: "reject-preview-click",
        expectedSequence: snapshot.sequence,
        type: "reject",
        requestId: pending.requestId,
      });
      await session.waitForActiveRun();
      expect(api.getRun("device-one", started.runId)?.pendingRequest).toBeUndefined();
    } finally {
      session.activeRun?.controller.cancel("approval preview test cleanup");
      await session.waitForActiveRun();
      await session.close();
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("completes the Host-listed switch under explicit opt-in without a separate approval", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "harness-remote-api-window-switch-opt-in-"));
    const modelInputs: ModelInput[] = [];
    const listCall: ToolCall = { id: "window-list-call" as ToolCallId, name: "list_windows", arguments: {} };
    const switchCall: ToolCall = {
      id: "window-switch-call" as ToolCallId,
      name: "switch_window",
      arguments: { windowRef: "wps-window-ref" },
      declaredEffect: { effects: ["navigate"], target: "MODEL CLAIM ONLY", summary: "Switch to the requested app" },
    };
    const { api, session, createdComputerConfigs } = createFixture(outputDir, {
      summary: "The switch completed.",
      turns: [
        { type: "tool_calls", calls: [listCall] },
        { type: "tool_calls", calls: [switchCall] },
      ],
      onModelInput: (input) => modelInputs.push(input),
      switchWindowReceiptStatus: "completed",
      windowInventory: [
        { windowRef: "fixture-current-ref", appName: "Fixture app", title: "Fixture window", isCurrent: true },
        { windowRef: "wps-window-ref", appName: "WPS", title: "Review draft - unsaved", isCurrent: false },
      ],
    });
    try {
      const choices = await api.listWindowTargets("device-one");
      const started = await api.startRun("device-one", "window-switch-opt-in", "Open the listed document window", {
        mode: "window",
        targetToken: choices.candidates[0]!.token,
        switchWindows: true,
      }, undefined, true);
      await session.waitForActiveRun();
      const snapshot = api.getRun("device-one", started.runId)!;
      expect(snapshot.status).toBe("finished");
      expect(snapshot.pendingRequest).toBeUndefined();
      expect(snapshot.target).toMatchObject({ appName: "WPS", title: "Review draft - unsaved", provenance: "selected_target" });
      expect(createdComputerConfigs.at(-1)).toMatchObject({ windowSwitch: "opened-windows-v1" });
      expect(session.history.at(-1)?.outcome).toBe("succeeded");
      expect(modelInputs.length).toBeGreaterThanOrEqual(2);
      expect(modelInputs.every((input) => input.tools.some((tool) => tool.name === "list_windows"))).toBe(true);
      expect(modelInputs.every((input) => input.tools.some((tool) => tool.name === "switch_window"))).toBe(true);
      expect(modelInputs[0]?.tools).toEqual(modelInputs[1]?.tools);
      expect(modelInputs[0]?.system).toBe(modelInputs[1]?.system);
      expect(JSON.stringify(modelInputs[1]?.messages)).toContain("Review draft - unsaved");
      expect(started).toBeDefined();

      const events: unknown[] = [];
      const subscription = api.subscribe("device-one", started.runId, 0, (event) => events.push(event));
      subscription.close();
      expect(JSON.stringify(events)).toContain("WPS");
      expect(JSON.stringify(events)).not.toMatch(/"pid"|"windowId"/iu);
    } finally {
      session.activeRun?.controller.cancel("window-switch explicit opt-in cleanup");
      await session.waitForActiveRun();
      await session.close();
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("does not retain the starting target after a refused switch action has begun", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "harness-remote-api-window-switch-unknown-"));
    const listCall: ToolCall = { id: "unknown-window-list-call" as ToolCallId, name: "list_windows", arguments: {} };
    const switchCall: ToolCall = {
      id: "unknown-window-switch-call" as ToolCallId,
      name: "switch_window",
      arguments: { windowRef: "wps-window-ref" },
    };
    const { api, session } = createFixture(outputDir, {
      summary: "The switch could not be completed.",
      turns: [
        { type: "tool_calls", calls: [listCall] },
        { type: "tool_calls", calls: [switchCall] },
      ],
      windowInventory: [
        { windowRef: "fixture-current-ref", appName: "Fixture app", title: "Fixture window", isCurrent: true },
        { windowRef: "wps-window-ref", appName: "WPS", title: "Review draft", isCurrent: false },
      ],
      switchWindowReceiptStatus: "refused",
    });
    try {
      const choices = await api.listWindowTargets("device-one");
      const started = await api.startRun("device-one", "window-switch-unknown", "Switch to the listed window", {
        mode: "window",
        targetToken: choices.candidates[0]!.token,
        switchWindows: true,
      });
      await waitFor(() => api.getRun("device-one", started.runId)?.status === "finished", "failed window switch did not terminate the Run");
      const snapshot = api.getRun("device-one", started.runId)!;
      expect(snapshot.outcome).toBe("failed");
      expect(snapshot.target).toEqual({ provenance: "unknown_after_switch" });

      const projectedEvents: Array<{ data?: Record<string, unknown> }> = [];
      const subscription = api.subscribe("device-one", started.runId, 0, (event) => {
        if (event.type === "run.event") projectedEvents.push(event as unknown as { data?: Record<string, unknown> });
      });
      subscription.close();
      const targetEvents = projectedEvents.filter((event) => event.data?.type === "run.target");
      expect(targetEvents.at(-1)?.data?.target).toEqual({ provenance: "unknown_after_switch" });
      expect(JSON.stringify(targetEvents.slice(-2))).not.toContain("Fixture window");
    } finally {
      await session.waitForActiveRun();
      await session.close();
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("speaks only structured approval context and never repeats a sensitive raw reason", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "harness-remote-api-sensitive-approval-notice-"));
    const pendingCall: ToolCall = {
      id: "approval-sensitive-notice" as ToolCallId,
      name: "click",
      arguments: { x: 408, y: 667 },
      declaredEffect: { effects: ["navigate"], target: "查询", summary: "点击查询按钮" },
    };
    const { api, session } = createFixture(outputDir, {
      summary: "The request was rejected.",
      screen: { width: 900, height: 900, coordinateSpace: "physical" },
      runNotices: true,
      runNoticeDynamicContent: true,
      turns: [{ type: "tool_calls", calls: [pendingCall] }],
      guardDecisions: [fixtureGuardDecision("require_approval", "Please enter the password hunter2.")],
    });
    try {
      const choices = await api.listWindowTargets("device-one");
      const started = await api.startRun("device-one", "approval-sensitive-notice", "Submit the form", choices.candidates[0]!.token, undefined, true);
      await waitFor(() => api.getRun("device-one", started.runId)?.status === "waiting_approval", "Run did not request approval");
      const pending = api.getRun("device-one", started.runId)?.pendingRequest;
      if (pending?.kind !== "approval") throw new Error("expected an approval request");
      expect(pending.preview?.modelDeclaredEffect).toEqual({ target: "查询", summary: "点击查询按钮", verified: false });

      const events: Array<{ type: string; data?: Record<string, unknown> }> = [];
      const subscription = api.subscribe("device-one", started.runId, 0, (event) => {
        if (event.type === "run.event") events.push(event as unknown as { type: string; data?: Record<string, unknown> });
      });
      subscription.close();
      const approvalNotice = events.find((event) => event.data?.type === "run.notice" && event.data.kind === "approval");
      expect(approvalNotice?.data?.text).toBe("电脑打算按这份说明操作：「点击查询按钮」；目标：「查询」。这项操作还没执行；说明仍需核对，请勿仅凭说明批准。 可能涉及对外发送或提交内容的点击操作，请核对后审批。");
      expect(JSON.stringify(approvalNotice)).not.toContain("hunter2");
      expect(JSON.stringify(approvalNotice)).not.toContain("password");

      await api.submitCommand("device-one", started.runId, {
        commandId: "reject-sensitive-notice",
        expectedSequence: api.getRun("device-one", started.runId)!.sequence,
        type: "reject",
        requestId: pending.requestId,
      });
      await session.waitForActiveRun();
      expect(api.getRun("device-one", started.runId)?.pendingRequest).toBeUndefined();
    } finally {
      session.activeRun?.controller.cancel("sensitive approval notice test cleanup");
      await session.waitForActiveRun();
      await session.close();
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("shows typed character count and keys, never raw typed text, and rebinds preview after rejection", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "harness-remote-api-approval-preview-redaction-"));
    const secret = "do-not-send-this-sensitive-text";
    const typeCall: ToolCall = {
      id: "approval-preview-type" as ToolCallId,
      name: "type",
      arguments: { text: secret },
      declaredEffect: { effects: ["sensitive_disclosure"], target: "登录表单", summary: "输入待确认的内容" },
    };
    const keyCall: ToolCall = {
      id: "approval-preview-keys" as ToolCallId,
      name: "hotkey",
      arguments: { keys: ["CTRL", "ALT", "DELETE"] },
      declaredEffect: { effects: ["security_change"], target: "系统快捷键", summary: "执行系统快捷键" },
    };
    const { api, session } = createFixture(outputDir, {
      summary: "The approvals were rejected.",
      turns: [
        { type: "tool_calls", calls: [typeCall] },
        { type: "tool_calls", calls: [keyCall] },
      ],
      guardDecisions: [
        fixtureGuardDecision("require_approval", "Typing needs approval."),
        fixtureGuardDecision("require_approval", "The shortcut needs approval."),
      ],
    });
    try {
      const choices = await api.listWindowTargets("device-one");
      const started = await api.startRun("device-one", "approval-preview-sensitive", "Enter a sensitive value", choices.candidates[0]!.token);
      await waitFor(() => session.activeRun?.controller.getSnapshot().status === "waiting_approval", "Run did not request text approval");

      const firstSnapshot = api.getRun("device-one", started.runId)!;
      const firstPending = firstSnapshot.pendingRequest;
      if (firstPending?.kind !== "approval") throw new Error("expected a text approval request");
      expect(firstPending.preview?.actions).toEqual([{ operation: "type", kind: "type", typedCharacterCount: secret.length }]);
      expect(JSON.stringify(firstPending)).not.toContain(secret);

      await api.submitCommand("device-one", started.runId, {
        commandId: "reject-preview-text",
        expectedSequence: firstSnapshot.sequence,
        type: "reject",
        requestId: firstPending.requestId,
      });
      await waitFor(() => {
        const next = api.getRun("device-one", started.runId)?.pendingRequest;
        return next?.kind === "approval" && next.requestId !== firstPending.requestId;
      }, "the next guarded request did not replace the rejected approval preview");

      const secondSnapshot = api.getRun("device-one", started.runId)!;
      const secondPending = secondSnapshot.pendingRequest;
      if (secondPending?.kind !== "approval") throw new Error("expected a second approval request");
      expect(secondPending.preview?.actions).toEqual([{ operation: "hotkey", kind: "keypress", keys: ["CTRL", "ALT", "DELETE"] }]);
      expect(JSON.stringify(secondPending)).not.toContain(secret);
      expect(JSON.stringify(secondPending)).not.toContain("登录表单");

      await api.submitCommand("device-one", started.runId, {
        commandId: "reject-preview-hotkey",
        expectedSequence: secondSnapshot.sequence,
        type: "reject",
        requestId: secondPending.requestId,
      });
      await session.waitForActiveRun();
      expect(api.getRun("device-one", started.runId)?.pendingRequest).toBeUndefined();
    } finally {
      await session.close();
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("preserves completed replies and authorized screenshot assets while isolating Runs by paired device", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "harness-remote-api-owner-"));
    const modelInputs: ModelInput[] = [];
    const { api, session, createdComputerConfigs } = createFixture(outputDir, {
      summary: "The itinerary is saved in Documents.",
      onModelInput: (input) => modelInputs.push(input),
    });
    try {
      const choices = await api.listWindowTargets("device-one");
      expect(choices.candidates).toHaveLength(1);
      expect(containsWindowIdentityKey(choices)).toBe(false);
      const [first, repeated] = await Promise.all([
        api.startRun("device-one", "start-once", "Find the saved itinerary", choices.candidates[0]!.token),
        api.startRun("device-one", "start-once", "Find the saved itinerary", choices.candidates[0]!.token),
      ]);
      expect(repeated.runId).toBe(first.runId);
      expect(api.listRuns("device-two")).toEqual([]);
      expect(api.getRun("device-two", first.runId)).toBeUndefined();

      await session.waitForActiveRun();
      const completed = api.getRun("device-one", first.runId)!;
      expect(completed.status).toBe("finished");
      expect(completed.reply).toBe("The itinerary is saved in Documents.");
      expect(completed.target).toEqual({ appName: "Fixture app", title: "Fixture window", provenance: "starting_target" });
      expect(modelInputs[0]?.tools.map((tool) => tool.name)).not.toEqual(expect.arrayContaining(["list_windows", "switch_window"]));
      expect(JSON.stringify(modelInputs[0])).not.toMatch(/list_windows|switch_window/iu);
      expect(containsWindowIdentityKey(completed)).toBe(false);
      expect(createdComputerConfigs[0]).toMatchObject({ windowTarget: { pid: 42, windowId: 1001 }, windowDeliveryMode: "foreground" });
      await expect(api.startRun("device-one", "start-reuse-target", "Try the same target again", choices.candidates[0]!.token))
        .rejects.toMatchObject({ code: "WINDOW_TARGET_STALE" });
      await expect(api.startRun("device-one", "start-once", "Find the saved itinerary", "A".repeat(32)))
        .rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
      await expect(api.startRun("device-one", "start-once", "Changed goal", choices.candidates[0]!.token))
        .rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
      await expect(api.startRun("device-one", "start-once", "Find the saved itinerary", choices.candidates[0]!.token, undefined, true))
        .rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
      await expect(api.startRun("device-one", "start-once", "Find the saved itinerary", {
        mode: "window",
        targetToken: choices.candidates[0]!.token,
        switchWindows: true,
      })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
      expect(completed.latestAssetId).toBeTruthy();
      expect(JSON.stringify(completed)).not.toContain("assets/");

      const screenshot = await api.getAsset("device-one", first.runId, completed.latestAssetId!);
      expect(screenshot?.mediaType).toBe("image/png");
      expect(screenshot?.data.length).toBeGreaterThan(0);
      expect(await api.getAsset("device-two", first.runId, completed.latestAssetId!)).toBeUndefined();

      const events: number[] = [];
      api.subscribe("device-one", first.runId, 0, (event) => {
        if (event.type === "run.event") events.push(event.sequence);
      });
      expect(events.length).toBeGreaterThan(0);
      expect(events).toEqual(events.map((_value, index) => index + 1));
      expect(() => api.subscribe("device-two", first.runId, 0, () => undefined)).toThrow(RemoteRunApiError);
    } finally {
      await session.close();
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("projects failed Provider progress replies and preserves authorized post-action screenshots", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "harness-remote-api-provider-progress-"));
    const { api, session } = createFixture(outputDir, {
      summary: "must not become success",
      failAfterTurns: true,
      turns: [{ type: "tool_calls", calls: [{ id: "progress-click" as ToolCallId, name: "click", arguments: { x: 1, y: 2 } }] }],
    });
    try {
      const choices = await api.listWindowTargets("device-one");
      const started = await api.startRun("device-one", "timeout-progress", "fixture click", choices.candidates[0]!.token);
      await session.waitForActiveRun();
      const snapshot = api.getRun("device-one", started.runId)!;
      expect(snapshot.status).toBe("finished");
      expect(snapshot.reply).toContain("已保留 1 个非等待 GUI 动作完成回执");
      expect(snapshot.reply).toContain("任务完成未确认");
      expect(snapshot.reply).toContain(`assetId=${snapshot.latestAssetId}`);
      const streamed: unknown[] = [];
      api.subscribe("device-one", started.runId, 0, (event) => streamed.push(event)).close();
      expect(streamed).toEqual(expect.arrayContaining([expect.objectContaining({ type: "run.event", data: expect.objectContaining({ type: "run.reply", outcome: "failed", reply: snapshot.reply }) })]));
      const screenshot = await api.getAsset("device-one", started.runId, snapshot.latestAssetId!);
      expect(screenshot?.mediaType).toBe("image/png");
      expect(await api.getAsset("device-two", started.runId, snapshot.latestAssetId!)).toBeUndefined();
      expect(streamed.filter((event) => {
        const projected = event as { data?: { phase?: string; status?: string } };
        return projected.data?.phase === "action" && projected.data.status === "started";
      })).toHaveLength(1);
    } finally {
      await session.close();
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("starts an explicitly requested primary-desktop Run without window discovery or binding", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "harness-remote-api-desktop-target-"));
    const { api, session, createdComputerConfigs, windowDiscoveryCalls } = createFixture(outputDir, { summary: "Desktop inspected." });
    try {
      const run = await api.startRun("device-one", "desktop-run", "Inspect the transient popup", { mode: "desktop" });
      await session.waitForActiveRun();
      expect(api.getRun("device-one", run.runId)?.target).toEqual({
        appName: "Primary desktop",
        title: "Entire foreground desktop",
        provenance: "starting_target",
      });
      expect(windowDiscoveryCalls).toEqual([]);
      expect(createdComputerConfigs[0]).not.toHaveProperty("windowTarget");
      expect(createdComputerConfigs[0]?.grounding).toBe("off");
      expect(createdComputerConfigs[0]).not.toHaveProperty("managedBrowserCompanion");
    } finally {
      await session.close();
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("starts a desktop Run with a saved browser companion only when cross-window switching is opted in", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "harness-remote-api-desktop-switch-companion-"));
    const profileRoot = "C:\\HarnessOwned\\managed-browser-profiles";
    const managedBrowserProfile = { profileLabel: "mobile", profileRoot };
    let active = false;
    let released = 0;
    const coordinator: ManagedBrowserProfileRunCoordinator = {
      getDefaultSession: () => "saved",
      async acquireForRun() {
        if (active) throw Object.assign(new Error("profile busy"), { code: "PROFILE_BUSY" });
        active = true;
        return async () => { active = false; released += 1; };
      },
    };
    const { api, session, createdComputerConfigs, windowDiscoveryCalls } = createFixture(outputDir, {
      askFirst: true,
      summary: "The user confirmed the request.",
      managedBrowserProfile,
      managedBrowserProfileCoordinator: coordinator,
    });
    try {
      const run = await api.startRun("device-one", "desktop-switch-companion", "Inspect the desktop popup", {
        mode: "desktop", switchWindows: true,
      });
      await waitFor(() => api.getRun("device-one", run.runId)?.status === "waiting_user", "desktop companion Run did not pause for confirmation");
      expect(windowDiscoveryCalls).toEqual([]);
      expect(createdComputerConfigs[0]).toMatchObject({
        managedBrowserCompanion: true,
        managedBrowserUrl: "about:blank",
        managedBrowserProfileMode: "persistent",
        managedBrowserProfileLabel: "mobile",
        managedBrowserProfileRoot: profileRoot,
        windowSwitch: "opened-windows-v1",
        grounding: "off",
      });
      expect(createdComputerConfigs[0]).not.toHaveProperty("windowTarget");
      expect(session.activeRun?.config).toMatchObject({ windowSwitch: "opened-windows-v1", windowHandoff: "off" });
      expect(JSON.stringify(run)).not.toContain(profileRoot);
      expect(active).toBe(true);
      await session.submitUserInput("Continue");
      await session.waitForActiveRun();
      await waitFor(() => released === 1, "desktop saved-profile reservation was not released after Run cleanup");
    } finally {
      session.activeRun?.controller.cancel("desktop companion projection test cleanup");
      await session.waitForActiveRun();
      await session.close();
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("rejects a desktop switch before Run allocation when the Host cannot list windows", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "harness-remote-api-desktop-switch-unsupported-"));
    const { api, session, createdComputerConfigs } = createFixture(outputDir, {
      summary: "Should not run.",
      windowDiscoveryAvailable: false,
    });
    try {
      await expect(api.startRun("device-one", "desktop-switch-unsupported", "Inspect the desktop popup", {
        mode: "desktop", switchWindows: true,
      })).rejects.toMatchObject({ code: "INVALID_TARGET" });
      expect(api.listRuns("device-one")).toEqual([]);
      expect(session.activeRun).toBeUndefined();
      expect(createdComputerConfigs).toEqual([]);
    } finally {
      await session.close();
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("keeps a desktop foreground refusal in the Remote primary-desktop scope and freshly observes it", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "harness-remote-api-desktop-foreground-refusal-"));
    const click: ToolCall = {
      id: "desktop-foreground-refusal" as ToolCallId,
      name: "click",
      arguments: { x: 4, y: 5 },
      declaredEffect: { effects: ["navigate"], target: "visible desktop control", summary: "Activate the observed control" },
    };
    let handoffCandidateCalls = 0;
    let observedWindowHandoff: ApplicationSessionConfig["windowHandoff"];
    let fixtureSession: ApplicationSession | undefined;
    let readRunEvents: (() => readonly RuntimeEvent[]) | undefined;
    const fixture = createFixture(outputDir, {
      summary: "Continued after a fresh desktop observation.",
      turnFactory: (turnNumber) => {
        if (turnNumber === 1) {
          const handle = fixtureSession?.activeRun;
          observedWindowHandoff = handle?.config.windowHandoff;
          if (handle !== undefined) readRunEvents = () => handle.controller.getEvents();
          return { type: "tool_calls", calls: [click] };
        }
        return { type: "finish", summary: "Continued after a fresh desktop observation." };
      },
      executeAction: (action) => ({
        actionId: action.actionId,
        status: "refused",
        driverCode: "WINDOW_FOREGROUND_MISMATCH",
        message: "no input was sent",
      }),
      listWindowHandoffCandidates: () => {
        handoffCandidateCalls += 1;
        return [{ pid: 42, windowId: 88, appName: "Editor", title: "Untitled" }];
      },
    });
    fixtureSession = fixture.session;
    const { api, session, createdComputerConfigs } = fixture;
    try {
      const started = await api.startRun("device-one", "desktop-foreground-refusal", "Continue from the full desktop after a refused action", {
        mode: "desktop",
        switchWindows: true,
      });
      await waitFor(() => {
        const status = api.getRun("device-one", started.runId)?.status;
        return status === "finished" || status === "waiting_window";
      }, "desktop foreground-refusal Run did not reach a terminal or handoff state");
      expect(api.getRun("device-one", started.runId)?.status).toBe("finished");
      await session.waitForActiveRun();
      expect(observedWindowHandoff).toBe("off");
      expect(createdComputerConfigs[0]).not.toHaveProperty("windowTarget");
      expect(createdComputerConfigs[0]).toMatchObject({ windowSwitch: "opened-windows-v1" });
      expect(handoffCandidateCalls).toBe(0);
      const events = readRunEvents?.() ?? [];
      const mismatchReceipts = events.filter((event) => event.type === "action.execution.failed");
      expect(mismatchReceipts.map((event) => event.receipt.driverCode), JSON.stringify(events.map((event) => event.type))).toEqual(["WINDOW_FOREGROUND_MISMATCH"]);
      expect(events.some((event) => event.type === "computer.window.handoff.requested")).toBe(false);
      expect(events.filter((event) => event.type === "observation.created").map((event) => event.observation.surfaceRef.kind)).toEqual(["desktop", "desktop"]);
      expect(events.filter((event) => event.type === "action.execution.started")).toHaveLength(1);
    } finally {
      if (session.activeRun?.controller.getSnapshot().status !== "finished") session.activeRun?.controller.cancel("desktop foreground-refusal test cleanup");
      await session.waitForActiveRun().catch(() => undefined);
      await session.close();
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("freezes assistant preferences per Run, fingerprints them for idempotency, and leaves no residue", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "harness-remote-api-assistant-preferences-"));
    const modelInputs: ModelInput[] = [];
    const { api, session } = createFixture(outputDir, {
      summary: "Preferences remain private to the Run context.",
      onModelInput: (input) => modelInputs.push(input),
    });
    const firstPreferences = {
      version: 1 as const,
      responseDetail: "detailed" as const,
      stepExplanation: "more" as const,
      preferredLanguage: "zh-CN" as const,
      additionalGuidance: "Group findings by topic.",
    };
    try {
      const firstPromise = api.startRun("device-one", "prefs-idempotency", "Summarize this page", { mode: "browser" }, firstPreferences);
      firstPreferences.additionalGuidance = "Changed after the request started.";
      const repeatedPromise = api.startRun("device-one", "prefs-idempotency", "Summarize this page", { mode: "browser" }, {
        ...firstPreferences,
        additionalGuidance: "Group findings by topic.",
      });
      await expect(api.startRun("device-one", "prefs-idempotency", "Summarize this page", { mode: "browser" }, {
        version: 1,
        responseDetail: "concise",
        stepExplanation: "standard",
        preferredLanguage: "en",
        additionalGuidance: "A different preference set.",
      })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });

      const first = await firstPromise;
      const repeated = await repeatedPromise;
      expect(repeated.runId).toBe(first.runId);
      await session.waitForActiveRun();
      const firstInput = modelInputs[0]!;
      const firstTrace = firstInput.contextBudget?.trace;
      expect(firstTrace?.assistantPreferences).toMatchObject({
        projectionVersion: 1,
        included: true,
        responseDetail: "detailed",
        stepExplanation: "more",
        preferredLanguage: "zh-CN",
        additionalGuidancePresent: true,
        additionalGuidanceCharacters: "Group findings by topic.".length,
      });
      expect(JSON.stringify(firstTrace)).not.toContain("Group findings by topic.");
      expect(firstInput.messages.some((message) => message.role === "user" && message.content.some((block) =>
        block.type === "text" && block.text.includes("Group findings by topic."),
      ))).toBe(true);
      expect(JSON.stringify(firstInput.messages)).not.toContain("Changed after the request started.");

      const second = await api.startRun("device-one", "prefs-next-run", "Summarize this page", { mode: "browser" }, {
        version: 1,
        responseDetail: "concise",
        stepExplanation: "standard",
        preferredLanguage: "en",
        additionalGuidance: "Use a short numbered list.",
      });
      await session.waitForActiveRun();
      const secondInput = modelInputs[1]!;
      expect(secondInput.contextBudget?.trace?.stablePrefixHash).toBe(firstTrace?.stablePrefixHash);
      expect(secondInput.messages.some((message) => message.content.some((block) =>
        block.type === "text" && block.text.includes("Use a short numbered list."),
      ))).toBe(true);

      const third = await api.startRun("device-one", "prefs-omitted", "Summarize this page", { mode: "browser" });
      await session.waitForActiveRun();
      const thirdInput = modelInputs[2]!;
      expect(second.runId).not.toBe(first.runId);
      expect(third.runId).not.toBe(second.runId);
      expect(thirdInput.contextBudget?.trace?.assistantPreferences).toBeUndefined();
      expect(thirdInput.contextBudget?.trace?.stablePrefixHash).toBe(firstTrace?.stablePrefixHash);
      expect(JSON.stringify(thirdInput.messages)).not.toContain("Group findings by topic.");
      expect(JSON.stringify(api.getRun("device-one", first.runId))).not.toContain("Group findings by topic.");
    } finally {
      await session.close();
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("automatically binds a unique confident local window match and deduplicates the complete target", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "harness-remote-api-auto-target-"));
    const { api, session, createdComputerConfigs } = createFixture(outputDir, { summary: "Checked the report." });
    try {
      const [first, repeated] = await Promise.all([
        api.startRun("device-one", "auto-unique", "Open Fixture app and check the report", { mode: "auto" }),
        api.startRun("device-one", "auto-unique", "Open Fixture app and check the report", { mode: "auto" }),
      ]);
      expect(repeated.runId).toBe(first.runId);
      expect(first.target).toEqual({ appName: "Fixture app", title: "Fixture window", provenance: "starting_target" });
      expect(containsWindowIdentityKey(first)).toBe(false);
      await session.waitForActiveRun();
      expect(createdComputerConfigs[0]).toMatchObject({
        windowTarget: { pid: 42, windowId: 1001 },
        windowDeliveryMode: "foreground",
        grounding: "off",
      });
    } finally {
      await session.close();
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("restores one uniquely matched minimized window, refreshes visibility, then binds its exact identity", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "harness-remote-api-auto-minimized-window-"));
    const wechat = { pid: 102_140, windowId: 33_296_778, appName: "Weixin", title: "微信" };
    const { api, session, createdComputerConfigs, windowDiscoveryCalls } = createFixture(outputDir, {
      summary: "The message task can start.",
      allWindows: [wechat],
      windowSnapshots: [[], [wechat]],
      onActivateWindow(target, showWindow) {
        expect(target).toEqual({ pid: wechat.pid, windowId: wechat.windowId });
        showWindow(wechat);
      },
    });
    try {
      const run = await api.startRun("device-one", "auto-wechat-minimized", "在微信上给测试联系人发消息", { mode: "auto" });
      expect(run.target).toEqual({ appName: "Weixin", title: "微信", provenance: "starting_target" });
      expect(windowDiscoveryCalls).toEqual([
        { type: "all" },
        { type: "visible" },
        { type: "activate", pid: wechat.pid, windowId: wechat.windowId },
        { type: "visible" },
      ]);
      expect(createdComputerConfigs[0]).toMatchObject({
        windowTarget: { pid: wechat.pid, windowId: wechat.windowId },
        windowDeliveryMode: "foreground",
      });
      await session.waitForActiveRun();
    } finally {
      await session.close();
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("restores the explicitly named app from the complete inventory when another app title matches the task text", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "harness-remote-api-auto-explicit-minimized-app-"));
    const wps = { pid: 240, windowId: 2401, appName: "WPS Office", title: "CW02.docx" };
    const notepad = { pid: 250, windowId: 2501, appName: "Notepad", title: "周可轩" };
    const windowSelector = { select: vi.fn() } as unknown as WindowSelectionStrategy;
    const { api, session, createdComputerConfigs, windowDiscoveryCalls } = createFixture(outputDir, {
      summary: "The requested WPS window was restored.",
      allWindows: [wps, notepad],
      windowSnapshots: [[notepad], [wps, notepad]],
      windowSelector,
      onActivateWindow(target, showWindow) {
        expect(target).toEqual({ pid: wps.pid, windowId: wps.windowId });
        showWindow(wps);
      },
    });
    try {
      const run = await api.startRun(
        "device-one",
        "auto-explicit-minimized-wps",
        "在wps写入周可轩我爱你，字体大小四号，并保存",
        { mode: "auto" },
      );
      expect(run.target).toMatchObject({ appName: "WPS Office", title: "CW02.docx", provenance: "starting_target" });
      expect(windowDiscoveryCalls).toEqual([
        { type: "all" },
        { type: "visible" },
        { type: "activate", pid: wps.pid, windowId: wps.windowId },
        { type: "visible" },
      ]);
      expect(createdComputerConfigs[0]).toMatchObject({
        windowTarget: { pid: wps.pid, windowId: wps.windowId },
        windowDeliveryMode: "foreground",
      });
      expect(windowSelector.select).not.toHaveBeenCalled();
      await session.waitForActiveRun();
    } finally {
      await session.close();
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("does not activate an auto match whose visible identity changed after inventory", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "harness-remote-api-auto-minimized-stale-"));
    const selected = { pid: 102_140, windowId: 33_296_778, appName: "Weixin", title: "微信" };
    const replacement = { ...selected, title: "登录窗口" };
    const { api, session, windowDiscoveryCalls } = createFixture(outputDir, {
      summary: "Should not run.",
      allWindows: [selected],
      windowSnapshots: [[replacement]],
    });
    try {
      await expect(api.startRun("device-one", "auto-wechat-stale", "在微信上给测试联系人发消息", { mode: "auto" }))
        .rejects.toMatchObject({ code: "WINDOW_TARGET_STALE" });
      expect(windowDiscoveryCalls.some((call) => call.type === "activate")).toBe(false);
      expect(api.listRuns("device-one")).toEqual([]);
      expect(session.activeRun).toBeUndefined();
    } finally {
      await session.close();
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("requires the phone to choose manually when automatic matching is ambiguous or absent", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "harness-remote-api-auto-abstain-"));
    const { api, session, setWindows } = createFixture(outputDir, { summary: "Should not run." });
    try {
      setWindows([
        { pid: 10, windowId: 100, appName: "Google Chrome", title: "First" },
        { pid: 20, windowId: 200, appName: "Google Chrome", title: "Second" },
      ]);
      await expect(api.startRun("device-one", "auto-ambiguous", "Use Google Chrome to check the report", { mode: "auto" }))
        .rejects.toMatchObject({ code: "WINDOW_SELECTION_REQUIRED" });

      setWindows([
        { pid: 30, windowId: 300, appName: "Browser", title: "New Tab" },
        { pid: 40, windowId: 400, appName: "Browser", title: "Untitled" },
      ]);
      await expect(api.startRun("device-one", "auto-none", "Look at the browser window", { mode: "auto" }))
        .rejects.toMatchObject({ code: "WINDOW_SELECTION_REQUIRED" });
      expect(api.listRuns("device-one")).toEqual([]);
      expect(session.activeRun).toBeUndefined();
    } finally {
      await session.close();
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("refreshes changed title metadata when the exact app window identity remains stable", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "harness-remote-api-auto-moved-"));
    const { api, session, createdComputerConfigs } = createFixture(outputDir, {
      summary: "The selected app window is still current.",
      windowSnapshots: [
        [{ pid: 42, windowId: 1001, appName: "Fixture app", title: "Fixture window" }],
        [{ pid: 42, windowId: 1001, appName: "Fixture app", title: "A replacement window" }],
      ],
    });
    try {
      const run = await api.startRun("device-one", "auto-moved", "Open Fixture app and check the report", { mode: "auto" });
      expect(run.target).toMatchObject({ appName: "Fixture app", title: "A replacement window", provenance: "starting_target" });
      expect(createdComputerConfigs[0]).toMatchObject({ windowTarget: { pid: 42, windowId: 1001 } });
      await session.waitForActiveRun();
    } finally {
      await session.close();
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("requires confirmed setup before saved browser targets or saved browser companions start", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "harness-remote-api-profile-setup-required-"));
    const coordinator: ManagedBrowserProfileRunCoordinator = {
      getDefaultSession: () => "saved",
      async acquireForRun() { throw Object.assign(new Error("profile needs setup"), { code: "PROFILE_NOT_READY" }); },
    };
    const managedBrowserProfile = { profileLabel: "mobile", profileRoot: "C:\\HarnessOwned\\managed-browser-profiles" };
    const { api, session, createdComputerConfigs, windowDiscoveryCalls } = createFixture(outputDir, {
      summary: "Should not run.",
      managedBrowserProfile,
      managedBrowserProfileCoordinator: coordinator,
    });
    try {
      await expect(api.startRun("device-one", "saved-browser-before-setup", "Open the travel site", {
        mode: "browser", url: "https://travel.example",
      })).rejects.toMatchObject({ code: "MANAGED_BROWSER_SETUP_REQUIRED" });
      await expect(api.startRun("device-one", "saved-companion-before-setup", "Open Fixture app", {
        mode: "auto", switchWindows: true,
      })).rejects.toMatchObject({ code: "MANAGED_BROWSER_SETUP_REQUIRED" });
      await expect(api.startRun("device-one", "saved-desktop-before-setup", "Inspect the desktop window", {
        mode: "desktop", switchWindows: true,
      })).rejects.toMatchObject({ code: "MANAGED_BROWSER_SETUP_REQUIRED" });
      expect(windowDiscoveryCalls).toEqual([]);
      expect(createdComputerConfigs).toEqual([]);
      expect(api.listRuns("device-one")).toEqual([]);
      expect(session.activeRun).toBeUndefined();
    } finally {
      await session.close();
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("does not start on a different app merely because its title matches text from the task", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "harness-remote-api-explicit-app-conflict-"));
    const notepad = { pid: 88, windowId: 880, appName: "Notepad", title: "周可轩" };
    const { api, session, createdComputerConfigs, setWindows } = createFixture(outputDir, {
      summary: "Should not run until a window is explicitly chosen.",
      allWindows: [notepad],
    });
    setWindows([notepad]);
    try {
      await expect(api.startRun(
        "device-one",
        "auto-app-title-conflict",
        "在wps写入周可轩我爱你，字体大小四号，并保存",
        { mode: "auto" },
      )).rejects.toMatchObject({ code: "WINDOW_SELECTION_REQUIRED" });
      expect(api.listRuns("device-one")).toEqual([]);
      expect(session.activeRun).toBeUndefined();
      expect(createdComputerConfigs).toEqual([]);

      const manualCandidates = await api.listWindowTargets("device-one");
      expect(manualCandidates.candidates).toMatchObject([{ appName: "Notepad", title: "周可轩" }]);
    } finally {
      await session.close();
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("uses the shared semantic selector for a natural-language app name and then verifies the exact candidate", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "harness-remote-api-semantic-initial-target-"));
    const wps = { pid: 900, windowId: 9000, appName: "WPS Office", title: "Résumé.docx" };
    const notepad = { pid: 901, windowId: 9001, appName: "Notepad.exe", title: "Notes" };
    const windowSelector: WindowSelectionStrategy = {
      async select(goal, candidates) {
        expect(goal).toBe("在记事本里写入今天的会议记录并保存");
        expect(candidates).toEqual([wps, notepad]);
        return { kind: "matched", target: candidates[1]! };
      },
    };
    const { api, session, createdComputerConfigs } = createFixture(outputDir, {
      summary: "The selected window was verified.",
      allWindows: [wps, notepad],
      windowSnapshots: [[notepad], [notepad]],
      windowSelector,
    });
    try {
      const run = await api.startRun("device-one", "auto-natural-notepad", "在记事本里写入今天的会议记录并保存", { mode: "auto" });
      expect(run.target).toMatchObject({ appName: "Notepad.exe", title: "Notes", provenance: "starting_target" });
      expect(createdComputerConfigs[0]).toMatchObject({ windowTarget: { pid: notepad.pid, windowId: notepad.windowId } });
      await session.waitForActiveRun();
    } finally {
      await session.close();
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("offers a proven owned-child dialog only through its independent parent for initial semantic selection", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "harness-remote-api-owned-child-initial-pool-"));
    const parent = { pid: 27384, windowId: 0x98e1b34, appName: "Notepad.exe", title: "*CH-NOTEPAD-20261003202446274-5330b6 - Notepad" };
    const child = {
      pid: 27384,
      windowId: 0x991316,
      appName: "Notepad.exe",
      title: "主机弹出窗口",
      relationship: { kind: "owned_child" as const, owner: { pid: parent.pid, windowId: parent.windowId } },
    };
    const otherApp = { pid: 42, windowId: 420, appName: "WPS Office", title: "A report" };
    const windowSelector: WindowSelectionStrategy = {
      async select(goal, candidates) {
        expect(goal).toBe("在记事本里写入今天的会议记录并保存");
        expect(candidates).toEqual([parent, otherApp]);
        return { kind: "matched", target: candidates[0]! };
      },
    };
    const visible = [child, parent, otherApp];
    const { api, session, createdComputerConfigs, windowDiscoveryCalls } = createFixture(outputDir, {
      summary: "The root app window was selected.",
      allWindows: visible,
      windowSnapshots: [visible, visible, visible],
      windowSelector,
    });
    try {
      const run = await api.startRun("device-one", "auto-notepad-owned-child", "在记事本里写入今天的会议记录并保存", { mode: "auto" });
      expect(run.target).toMatchObject({ appName: parent.appName, title: parent.title, provenance: "starting_target" });
      expect(createdComputerConfigs[0]).toMatchObject({ windowTarget: { pid: parent.pid, windowId: parent.windowId } });
      expect(windowDiscoveryCalls.filter((call) => call.type === "all")).toHaveLength(1);
      await session.waitForActiveRun();
    } finally {
      await session.close();
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("filters semantic candidates to an explicit app hint before disambiguating same-app windows", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "harness-remote-api-semantic-app-filter-"));
    const wpsOne = { pid: 910, windowId: 9100, appName: "WPS Office", title: "Budget.xlsx" };
    const wpsTwo = { pid: 911, windowId: 9101, appName: "WPS Office", title: "Meeting.docx" };
    const notepad = { pid: 912, windowId: 9102, appName: "Notepad", title: "处理文件" };
    const windowSelector: WindowSelectionStrategy = {
      async select(goal, candidates) {
        expect(goal).toBe("在WPS中处理文件");
        expect(candidates).toEqual([wpsOne, wpsTwo]);
        return { kind: "matched", target: candidates[1]! };
      },
    };
    const { api, session, createdComputerConfigs } = createFixture(outputDir, {
      summary: "The WPS window was selected.",
      allWindows: [wpsOne, wpsTwo, notepad],
      windowSnapshots: [[wpsOne, wpsTwo], [wpsOne, wpsTwo]],
      windowSelector,
    });
    try {
      const run = await api.startRun("device-one", "auto-wps-app-filter", "在WPS中处理文件", { mode: "auto" });
      expect(run.target).toMatchObject({ appName: "WPS Office", title: "Meeting.docx", provenance: "starting_target" });
      expect(createdComputerConfigs[0]).toMatchObject({ windowTarget: { pid: wpsTwo.pid, windowId: wpsTwo.windowId } });
      await session.waitForActiveRun();
    } finally {
      await session.close();
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("rejects a semantic suggestion for duplicate app/title candidates instead of blind selection", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "harness-remote-api-semantic-duplicate-labels-"));
    const duplicateA = { pid: 920, windowId: 9200, appName: "WPS Office", title: "Report.docx" };
    const duplicateB = { pid: 921, windowId: 9201, appName: "WPS Office", title: "Report.docx" };
    const windowSelector: WindowSelectionStrategy = {
      async select(_goal, candidates) {
        expect(candidates).toEqual([]);
        // Even a buggy/custom selector cannot return a candidate that was not
        // present in its safe, distinguishable candidate set.
        return { kind: "matched", target: duplicateA };
      },
    };
    const { api, session, createdComputerConfigs } = createFixture(outputDir, {
      summary: "Should not start on an indistinguishable target.",
      allWindows: [duplicateA, duplicateB],
      windowSelector,
    });
    try {
      await expect(api.startRun("device-one", "auto-duplicate-labels", "在WPS里检查报告", { mode: "auto" }))
        .rejects.toMatchObject({ code: "WINDOW_SELECTION_REQUIRED" });
      expect(api.listRuns("device-one")).toEqual([]);
      expect(createdComputerConfigs).toEqual([]);
      expect(session.activeRun).toBeUndefined();
    } finally {
      await session.close();
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("shows duplicate manual window captions only as preview-required while keeping unique labels direct", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "harness-remote-api-duplicate-window-captions-"));
    const { api, session, setWindows } = createFixture(outputDir, { summary: "unused" });
    setWindows([
      { pid: 11, windowId: 110, appName: "Notepad", title: "Notes" },
      { pid: 12, windowId: 120, appName: "Notepad", title: "Notes" },
      { pid: 13, windowId: 130, appName: "WPS Office", title: "Report.docx" },
    ]);
    try {
      const choices = await api.listWindowTargets("device-one");
      expect(choices.candidates).toMatchObject([
        { appName: "Notepad", title: "Notes", previewRequired: true },
        { appName: "Notepad", title: "Notes", previewRequired: true },
        { appName: "WPS Office", title: "Report.docx" },
      ]);
      expect(choices.omittedAmbiguousCount).toBeUndefined();
      expect(containsWindowIdentityKey(choices)).toBe(false);
    } finally {
      await session.close();
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("starts the next Run with a fresh Computer session and observation after an unknown action with confirmed cleanup", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "harness-remote-api-unknown-cleanup-next-run-"));
    const click: ToolCall = {
      id: "unknown-cleanup-click" as ToolCallId,
      name: "click",
      arguments: { x: 4, y: 4 },
      declaredEffect: { effects: ["navigate"], target: "report", summary: "Open the report" },
    };
    let failFirstAction = true;
    const executedActionIds: string[] = [];
    const { api, session, createdComputerConfigs, observedComputerSessionIds } = createFixture(outputDir, {
      summary: "The new Run started from a fresh observation.",
      turnFactory: (turnNumber) => turnNumber === 1 && failFirstAction
        ? { type: "tool_calls", calls: [click] }
        : { type: "finish", summary: "Fresh Run complete." },
      executeAction: async (action) => {
        executedActionIds.push(String(action.actionId));
        if (failFirstAction) {
          failFirstAction = false;
          throw new Error("fixture driver returned an unknown action outcome");
        }
        return { actionId: action.actionId, status: "completed" };
      },
    });
    try {
      const first = await api.startRun("device-one", "unknown-then-fresh-first", "Open Fixture app and inspect the report", { mode: "auto" });
      await expect(session.waitForActiveRun()).resolves.toBe("outcome_unknown");
      expect(api.getRun("device-one", first.runId)).toMatchObject({ status: "finished", outcome: "outcome_unknown" });
      expect(session.lastRun).toMatchObject({ outcome: "outcome_unknown", ownerState: "released" });

      const second = await api.startRun("device-one", "unknown-then-fresh-second", "Open Fixture app and inspect the report", { mode: "auto" });
      await expect(session.waitForActiveRun()).resolves.toBe("succeeded");
      expect(api.getRun("device-one", second.runId)).toMatchObject({ status: "finished", outcome: "succeeded" });
      expect(createdComputerConfigs).toHaveLength(2);
      expect(observedComputerSessionIds).toHaveLength(2);
      expect(new Set(observedComputerSessionIds).size).toBe(2);
      expect(executedActionIds).toHaveLength(1);
      expect(session.history.map((record) => record.outcome)).toEqual(["outcome_unknown", "succeeded"]);
    } finally {
      session.activeRun?.controller.cancel("unknown cleanup next-run fixture cleanup");
      await session.waitForActiveRun();
      await session.close();
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("projects the Host default onto saved browser and native cross-window companion Runs", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "harness-remote-api-profile-default-saved-"));
    const profileRoot = "C:\\HarnessOwned\\managed-browser-profiles";
    const managedBrowserProfile = { profileLabel: "mobile", profileRoot };
    let active = false;
    let acquired = 0;
    let released = 0;
    const coordinator: ManagedBrowserProfileRunCoordinator = {
      getDefaultSession: () => "saved",
      async acquireForRun() {
        if (active) throw Object.assign(new Error("profile busy"), { code: "PROFILE_BUSY" });
        active = true;
        acquired += 1;
        return async () => { active = false; released += 1; };
      },
    };
    const { api, session, createdComputerConfigs } = createFixture(outputDir, {
      askFirst: true,
      summary: "The user confirmed the request.",
      managedBrowserProfile,
      managedBrowserProfileCoordinator: coordinator,
    });
    try {
      const choices = await api.listWindowTargets("device-one");
      const companion = await api.startRun("device-one", "saved-window-companion", "Open Fixture app", {
        mode: "window", targetToken: choices.candidates[0]!.token, switchWindows: true,
      });
      await waitFor(() => api.getRun("device-one", companion.runId)?.status === "waiting_user", "saved companion Run did not pause for confirmation");
      expect(createdComputerConfigs[0]).toMatchObject({
        managedBrowserCompanion: true,
        managedBrowserUrl: "about:blank",
        managedBrowserProfileMode: "persistent",
        managedBrowserProfileLabel: "mobile",
        managedBrowserProfileRoot: profileRoot,
        windowSwitch: "opened-windows-v1",
      });
      expect(JSON.stringify(companion)).not.toContain(profileRoot);
      expect(active).toBe(true);

      await session.submitUserInput("Continue");
      await session.waitForActiveRun();
      await waitFor(() => released === 1, "saved profile reservation was not released after Run cleanup");

      const browser = await api.startRun("device-one", "saved-browser-default", "Open the saved travel page", {
        mode: "browser", url: "https://travel.example",
      });
      expect(createdComputerConfigs[1]).toMatchObject({
        managedBrowserUrl: "https://travel.example/",
        managedBrowserProfileMode: "persistent",
        managedBrowserProfileLabel: "mobile",
        managedBrowserProfileRoot: profileRoot,
      });
      expect(createdComputerConfigs[1]).not.toHaveProperty("managedBrowserCompanion");
      expect(acquired).toBe(2);
      session.activeRun?.controller.cancel("saved profile projection test cleanup");
      await session.waitForActiveRun();
      await waitFor(() => released === 2, "saved browser reservation was not released after Run cleanup");
      expect(JSON.stringify(browser)).not.toContain(profileRoot);

      const nativeChoices = await api.listWindowTargets("device-one");
      const nativeWithoutSwitch = await api.startRun("device-one", "saved-native-no-switch", "Open Fixture app", {
        mode: "window", targetToken: nativeChoices.candidates[0]!.token, switchWindows: false,
      });
      await waitFor(() => api.getRun("device-one", nativeWithoutSwitch.runId)?.status === "waiting_user", "native Run did not pause for confirmation");
      expect(createdComputerConfigs[2]).toMatchObject({ windowSwitch: "off" });
      expect(createdComputerConfigs[2]).not.toHaveProperty("managedBrowserCompanion");
      expect(acquired).toBe(2);
      expect(active).toBe(false);
      session.activeRun?.controller.cancel("saved profile projection test cleanup");
      await session.waitForActiveRun();
    } finally {
      session.activeRun?.controller.cancel("saved profile projection test cleanup");
      await session.waitForActiveRun();
      await session.close();
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("uses a temporary Host default without preparing or reserving the saved profile", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "harness-remote-api-profile-default-temporary-"));
    const acquireForRun = vi.fn(async () => { throw new Error("temporary mode must not reserve the saved profile"); });
    const coordinator: ManagedBrowserProfileRunCoordinator = { getDefaultSession: () => "temporary", acquireForRun };
    const managedBrowserProfile = { profileLabel: "mobile", profileRoot: "C:\\HarnessOwned\\managed-browser-profiles" };
    const { api, session, createdComputerConfigs } = createFixture(outputDir, {
      summary: "Temporary browser opened.",
      managedBrowserProfile,
      managedBrowserProfileCoordinator: coordinator,
    });
    try {
      const browser = await api.startRun("device-one", "temporary-browser-default", "Open a temporary page", {
        mode: "browser", url: "https://example.test",
      });
      expect(createdComputerConfigs[0]).toMatchObject({
        managedBrowserUrl: "https://example.test/",
        managedBrowserProfileMode: "ephemeral",
        grounding: "hybrid-catalog-v1",
      });
      expect(createdComputerConfigs[0]).not.toHaveProperty("managedBrowserCompanion");
      expect(acquireForRun).not.toHaveBeenCalled();
      expect(JSON.stringify(browser)).not.toContain("C:\\\\HarnessOwned");
      await session.waitForActiveRun();
    } finally {
      session.activeRun?.controller.cancel("temporary profile projection test cleanup");
      await session.waitForActiveRun();
      await session.close();
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("opens the explicitly requested browser with the injected Host profile and redacts URL and profile path", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "harness-remote-api-managed-browser-"));
    const profileRoot = "C:\\HarnessOwned\\managed-browser-profiles";
    const managedBrowserProfile = { profileLabel: "saved.login", profileRoot };
    const url = "https://tickets.example/search?token=private";
    const { api, session, createdComputerConfigs } = createFixture(outputDir, {
      askFirst: true,
      summary: "Checked the requested page.",
      managedBrowserProfile,
    });
    try {
      const [first, repeated] = await Promise.all([
        api.startRun("device-one", "browser-once", "Check my ticket", { mode: "browser", sessionMode: "saved", url }),
        api.startRun("device-one", "browser-once", "Check my ticket", { mode: "browser", sessionMode: "saved", url }),
      ]);
      expect(repeated.runId).toBe(first.runId);
      expect(first.target).toEqual({ appName: "Harness-managed browser", title: "tickets.example", provenance: "starting_target" });
      expect(JSON.stringify(first)).not.toContain("token=private");
      expect(JSON.stringify(first)).not.toContain(profileRoot);
      expect(createdComputerConfigs[0]).toMatchObject({
        grounding: "hybrid-catalog-v1",
        managedBrowserUrl: url,
        managedBrowserProfileMode: "persistent",
        managedBrowserProfileLabel: "saved.login",
        managedBrowserProfileRoot: profileRoot,
        windowDeliveryMode: "foreground",
      });
      expect(createdComputerConfigs[0]).not.toHaveProperty("windowTarget");
      await expect(api.startRun("device-one", "browser-once", "Check my ticket", { mode: "browser", sessionMode: "saved", url: "https://other.example" }))
        .rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
      await waitFor(() => session.activeRun?.controller.getSnapshot().status === "waiting_user", "managed browser fixture did not pause for its report check");
      const handle = session.activeRun;
      if (handle === undefined) throw new Error("expected managed browser fixture Run to remain active");
      await session.submitUserInput("Continue");
      await session.waitForActiveRun();
      const report = await handle.report();
      expect(JSON.stringify(report)).not.toContain("token=private");
      expect(JSON.stringify(report)).not.toContain(profileRoot);
    } finally {
      if (session.activeRun !== undefined) session.activeRun.controller.cancel("managed browser config test cleanup");
      await session.waitForActiveRun();
      await session.close();
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("projects model progress through the remote event stream without provider internals", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "harness-remote-api-progress-"));
    const { api, session } = createFixture(outputDir, { summary: "Progress was captured." });
    try {
      const started = await api.startRun("device-one", "progress-once", "Check the managed page", { mode: "browser", url: "https://example.test" });
      const streamed: unknown[] = [];
      const subscription = api.subscribe("device-one", started.runId, 0, (event) => streamed.push(event));
      await session.waitForActiveRun();
      subscription.close();
      const progress = streamed.filter((event) => typeof event === "object" && event !== null && "type" in event && event.type === "run.event"
        && "data" in event && typeof event.data === "object" && event.data !== null && "type" in event.data && event.data.type === "run.progress");
      expect(progress).toEqual(expect.arrayContaining([
        expect.objectContaining({ data: expect.objectContaining({ phase: "model", status: "started" }) }),
        expect.objectContaining({ data: expect.objectContaining({ phase: "model", status: "completed" }) }),
      ]));
      expect(JSON.stringify(progress)).not.toContain("reasoning_content");
    } finally {
      await session.close();
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("reports a stale managed-browser profile before creating a Run", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "harness-remote-api-managed-browser-stale-profile-"));
    const managedBrowserProfile = { profileLabel: "travel", profileRoot: "C:\\HarnessOwned\\managed-browser-profiles" };
    const { api, session } = createFixture(outputDir, {
      summary: "Should not run.",
      managedBrowserProfile,
      inspectManagedBrowserProfile: async (profileRoot, profileLabel) => {
        expect(profileRoot).toBe(managedBrowserProfile.profileRoot);
        expect(profileLabel).toBe("travel");
        return { state: "stale", markers: ["profile_lock", "devtools_port"] };
      },
    });
    try {
      await expect(api.startRun("device-one", "browser-stale-profile", "Open the travel page", { mode: "browser", sessionMode: "saved" }))
        .rejects.toMatchObject({ code: "MANAGED_BROWSER_PROFILE_UNAVAILABLE" });
      expect(api.listRuns("device-one")).toEqual([]);
      expect(session.activeRun).toBeUndefined();
    } finally {
      await session.close();
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("maps managed-profile inspection failures to a safe typed pre-Run error", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "harness-remote-api-managed-browser-profile-check-error-"));
    const { api, session } = createFixture(outputDir, {
      summary: "Should not run.",
      managedBrowserProfile: { profileLabel: "mobile", profileRoot: "C:\\HarnessOwned\\managed-browser-profiles" },
      inspectManagedBrowserProfile: async () => { throw new Error("permission denied at a private path"); },
    });
    try {
      await expect(api.startRun("device-one", "browser-profile-check-error", "Open the website", { mode: "browser", sessionMode: "saved" }))
        .rejects.toMatchObject({ code: "MANAGED_BROWSER_PROFILE_UNAVAILABLE" });
      expect(api.listRuns("device-one")).toEqual([]);
      expect(session.activeRun).toBeUndefined();
    } finally {
      await session.close();
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("defaults a temporary browser to an ephemeral exact about:blank target", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "harness-remote-api-browser-blank-"));
    const managedBrowserProfile = { profileLabel: "saved.login", profileRoot: "C:\\HarnessOwned\\managed-browser-profiles" };
    const { api, session, createdComputerConfigs } = createFixture(outputDir, {
      summary: "Opened a blank managed page.",
      managedBrowserProfile,
    });
    try {
      const [first, sameCommandWithEmptyUrl] = await Promise.all([
        api.startRun("device-one", "browser-blank", "Open a blank managed page", { mode: "browser" }),
        api.startRun("device-one", "browser-blank", "Open a blank managed page", { mode: "browser", url: " \t " }),
      ]);
      expect(sameCommandWithEmptyUrl.runId).toBe(first.runId);
      expect(first.target).toEqual({ appName: "Harness-managed browser", title: "New tab", provenance: "starting_target" });
      expect(createdComputerConfigs[0]).toMatchObject({
        managedBrowserUrl: "about:blank",
        managedBrowserProfileMode: "ephemeral",
        grounding: "hybrid-catalog-v1",
        windowDeliveryMode: "foreground",
      });
      const sameCommandWithExplicitBlank = await api.startRun("device-one", "browser-blank", "Open a blank managed page", { mode: "browser", url: "about:blank" });
      expect(sameCommandWithExplicitBlank.runId).toBe(first.runId);
    } finally {
      session.activeRun?.controller.cancel("about:blank target test cleanup");
      await session.waitForActiveRun();
      await session.close();
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("waits for cleanup after a public finished snapshot before starting the next Run", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "harness-remote-api-finished-cleanup-"));
    let releaseCleanup!: () => void;
    const cleanupGate = new Promise<void>((resolveCleanup) => { releaseCleanup = resolveCleanup; });
    const { api, session, createdComputerConfigs } = createFixture(outputDir, {
      summary: "The first Run finished before cleanup completed.",
      closeComputer: () => cleanupGate,
    });
    let cleanupStatusPublished = false;
    let subscription: ReturnType<typeof api.subscribe> | undefined;
    try {
      const first = await api.startRun("device-one", "finished-before-cleanup", "Open a blank managed page", { mode: "browser" });
      await waitFor(() => api.getRun("device-one", first.runId)?.status === "finished", "public finished snapshot was not published");
      expect(session.activeRun).toBeDefined();
      const finished = api.getRun("device-one", first.runId);
      expect(finished?.ownerState).toBe("pending_cleanup");
      expect(api.listRuns("device-one").find((run) => run.runId === first.runId)?.ownerState).toBe("pending_cleanup");
      if (finished === undefined) throw new Error("finished Run snapshot was unavailable");
      subscription = api.subscribe("device-one", first.runId, finished.sequence, (event) => {
        if (event.type === "run.event" && event.data.type === "run.status") cleanupStatusPublished = true;
      });

      const secondPromise = api.startRun("device-one", "after-finished-cleanup", "Open another blank managed page", { mode: "browser" });
      await new Promise<void>((resolveWait) => setTimeout(resolveWait, 20));
      expect(createdComputerConfigs).toHaveLength(1);
      expect(session.activeRun).toBeDefined();

      releaseCleanup();
      const second = await secondPromise;
      expect(second.runId).not.toBe(first.runId);
      expect(createdComputerConfigs).toHaveLength(2);
      await waitFor(() => api.getRun("device-one", first.runId)?.ownerState === "released", "released owner state was not projected after cleanup");
      expect(cleanupStatusPublished).toBe(true);
      expect(api.listRuns("device-one").find((run) => run.runId === first.runId)?.ownerState).toBe("released");
      await session.waitForActiveRun();
    } finally {
      subscription?.close();
      releaseCleanup();
      session.activeRun?.controller.cancel("finished cleanup ordering test cleanup");
      await session.waitForActiveRun();
      await session.close();
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("does not attribute a later Run's active lease to an earlier finished Run", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "harness-remote-api-run-owner-identity-"));
    let generatedTurns = 0;
    const { api, session } = createFixture(outputDir, {
      summary: "The first Run finished.",
      turnFactory: () => {
        generatedTurns += 1;
        return generatedTurns === 1
          ? { type: "finish", summary: "The first Run finished." }
          : { type: "user_input_required", question: "Should the next Run continue?" };
      },
    });
    try {
      const first = await api.startRun("device-one", "owner-identity-first", "Finish the first task", { mode: "browser" });
      await waitFor(() => api.getRun("device-one", first.runId)?.ownerState === "released", "first Run cleanup was not confirmed");

      const second = await api.startRun("device-one", "owner-identity-second", "Wait for user input", { mode: "browser" });
      await waitFor(() => api.getRun("device-one", second.runId)?.status === "waiting_user", "second Run did not wait for input");

      expect(session.activeRun?.runId).toBe(second.runId);
      expect(api.getRun("device-one", first.runId)?.ownerState).toBe("released");
      expect(api.getRun("device-one", second.runId)?.ownerState).toBeUndefined();
      expect(api.listRuns("device-one").find((run) => run.runId === first.runId)?.ownerState).toBe("released");
    } finally {
      session.activeRun?.controller.cancel("owner identity test cleanup");
      await session.waitForActiveRun();
      await session.close();
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("rejects a second start while the current Run is still waiting for user input", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "harness-remote-api-running-busy-"));
    const { api, session } = createFixture(outputDir, { askFirst: true, summary: "The user input was received." });
    try {
      const first = await api.startRun("device-one", "running-busy-first", "Open a blank managed page", { mode: "browser" });
      await waitFor(() => api.getRun("device-one", first.runId)?.status === "waiting_user", "Run did not remain active while waiting for input");
      await expect(api.startRun("device-one", "running-busy-second", "Open another blank managed page", { mode: "browser" }))
        .rejects.toMatchObject({ code: "RUN_BUSY" });
      await session.submitUserInput("Continue");
      await session.waitForActiveRun();
    } finally {
      session.activeRun?.controller.cancel("running busy test cleanup");
      await session.waitForActiveRun();
      await session.close();
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("waits before inspecting a saved profile after a terminal snapshot", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "harness-remote-api-saved-cleanup-order-"));
    let releaseCleanup!: () => void;
    const cleanupGate = new Promise<void>((resolveCleanup) => { releaseCleanup = resolveCleanup; });
    let inspectCalls = 0;
    const { api, session, createdComputerConfigs } = createFixture(outputDir, {
      summary: "The browser task finished.",
      managedBrowserProfile: { profileLabel: "travel", profileRoot: "C:\\HarnessOwned\\managed-browser-profiles" },
      inspectManagedBrowserProfile: async () => {
        inspectCalls += 1;
        return { state: "ready", markers: [] };
      },
      readManagedBrowserStartupUrls: async () => ["https://travel.example/"],
      closeComputer: () => cleanupGate,
    });
    try {
      const first = await api.startRun("device-one", "saved-order-first", "Open a blank managed page", { mode: "browser" });
      await waitFor(() => api.getRun("device-one", first.runId)?.status === "finished", "terminal snapshot was not published");
      const secondPromise = api.startRun("device-one", "saved-order-second", "Open the saved travel site", { mode: "browser", sessionMode: "saved" });
      await new Promise<void>((resolveWait) => setTimeout(resolveWait, 20));
      expect(inspectCalls).toBe(0);
      expect(createdComputerConfigs).toHaveLength(1);
      releaseCleanup();
      await secondPromise;
      expect(inspectCalls).toBe(1);
      expect(createdComputerConfigs).toHaveLength(2);
    } finally {
      releaseCleanup();
      session.activeRun?.controller.cancel("saved cleanup ordering test cleanup");
      await session.waitForActiveRun();
      await session.close();
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("waits before automatic window discovery after a terminal snapshot", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "harness-remote-api-auto-cleanup-order-"));
    let releaseCleanup!: () => void;
    const cleanupGate = new Promise<void>((resolveCleanup) => { releaseCleanup = resolveCleanup; });
    const { api, session, createdComputerConfigs, windowDiscoveryCalls } = createFixture(outputDir, {
      summary: "The browser task finished.",
      allWindows: [{ pid: 42, windowId: 1001, appName: "Fixture app", title: "Fixture window" }],
      closeComputer: () => cleanupGate,
    });
    try {
      const first = await api.startRun("device-one", "auto-order-first", "Open a blank managed page", { mode: "browser" });
      await waitFor(() => api.getRun("device-one", first.runId)?.status === "finished", "terminal snapshot was not published");
      const callsBeforeSecond = windowDiscoveryCalls.length;
      const secondPromise = api.startRun("device-one", "auto-order-second", "Open Fixture app and check the report", { mode: "auto" });
      await new Promise<void>((resolveWait) => setTimeout(resolveWait, 20));
      expect(windowDiscoveryCalls).toHaveLength(callsBeforeSecond);
      expect(createdComputerConfigs).toHaveLength(1);
      releaseCleanup();
      await secondPromise;
      expect(windowDiscoveryCalls.some((call) => call.type === "all")).toBe(true);
      expect(createdComputerConfigs).toHaveLength(2);
    } finally {
      releaseCleanup();
      session.activeRun?.controller.cancel("auto cleanup ordering test cleanup");
      await session.waitForActiveRun();
      await session.close();
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("waits before manual window verification after a terminal snapshot", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "harness-remote-api-manual-cleanup-order-"));
    let releaseCleanup!: () => void;
    const cleanupGate = new Promise<void>((resolveCleanup) => { releaseCleanup = resolveCleanup; });
    const { api, session, createdComputerConfigs, windowDiscoveryCalls } = createFixture(outputDir, {
      summary: "The browser task finished.",
      closeComputer: () => cleanupGate,
    });
    try {
      const candidates = await api.listWindowTargets("device-one");
      const targetToken = candidates.candidates[0]?.token;
      if (targetToken === undefined) throw new Error("fixture did not expose a manual window target");
      const first = await api.startRun("device-one", "manual-order-first", "Open a blank managed page", { mode: "browser" });
      await waitFor(() => api.getRun("device-one", first.runId)?.status === "finished", "terminal snapshot was not published");
      const callsBeforeSecond = windowDiscoveryCalls.length;
      const secondPromise = api.startRun("device-one", "manual-order-second", "Use the selected Fixture app", targetToken);
      await new Promise<void>((resolveWait) => setTimeout(resolveWait, 20));
      expect(windowDiscoveryCalls).toHaveLength(callsBeforeSecond);
      expect(createdComputerConfigs).toHaveLength(1);
      releaseCleanup();
      await secondPromise;
      expect(windowDiscoveryCalls.length).toBeGreaterThan(callsBeforeSecond);
      expect(createdComputerConfigs).toHaveLength(2);
    } finally {
      releaseCleanup();
      session.activeRun?.controller.cancel("manual cleanup ordering test cleanup");
      await session.waitForActiveRun();
      await session.close();
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("restores the first prepared saved site when the saved browser URL is omitted", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "harness-remote-api-saved-browser-"));
    const profileRoot = await mkdtemp(join(tmpdir(), "harness-remote-api-profile-root-"));
    const profile = { profileLabel: "travel", profileRoot };
    await mkdir(join(profileRoot, profile.profileLabel), { recursive: true });
    await writeFile(join(profileRoot, profile.profileLabel, "managed-browser-startup.json"), JSON.stringify({ schemaVersion: 1, urls: ["https://travel.example/search", "https://tickets.example/"] }), "utf8");
    const { api, session, createdComputerConfigs } = createFixture(outputDir, {
      summary: "Opened the prepared site.",
      managedBrowserProfile: profile,
    });
    try {
      const run = await api.startRun("device-one", "saved-browser", "Check the prepared travel site", { mode: "browser", sessionMode: "saved" });
      expect(run.target).toEqual({ appName: "Harness-managed browser", title: "travel.example", provenance: "starting_target" });
      const sameCommandWithWhitespace = await api.startRun("device-one", "saved-browser", "Check the prepared travel site", { mode: "browser", sessionMode: "saved", url: " \t " });
      expect(sameCommandWithWhitespace.runId).toBe(run.runId);
      expect(createdComputerConfigs[0]).toMatchObject({
        managedBrowserUrl: "https://travel.example/search",
        managedBrowserProfileMode: "persistent",
        managedBrowserProfileLabel: "travel",
        managedBrowserProfileRoot: profile.profileRoot,
      });
      await session.waitForActiveRun();
      const explicitBlank = await api.startRun("device-one", "saved-browser-explicit-blank", "Open a saved blank page", { mode: "browser", sessionMode: "saved", url: "about:blank" });
      expect(explicitBlank.target).toEqual({ appName: "Harness-managed browser", title: "New tab", provenance: "starting_target" });
      expect(createdComputerConfigs.at(-1)).toMatchObject({ managedBrowserUrl: "about:blank", managedBrowserProfileMode: "persistent" });
    } finally {
      session.activeRun?.controller.cancel("saved browser restore test cleanup");
      await session.waitForActiveRun();
      await session.close();
      await rm(outputDir, { recursive: true, force: true });
      await rm(profileRoot, { recursive: true, force: true });
    }
  });

  it("falls back to temporary-looking about:blank target when saved profile has no prepared sites", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "harness-remote-api-saved-browser-empty-"));
    const profile = { profileLabel: "empty", profileRoot: "C:\\HarnessOwned\\managed-browser-profiles" };
    const { api, session, createdComputerConfigs } = createFixture(outputDir, {
      summary: "Opened the empty saved profile.",
      managedBrowserProfile: profile,
      readManagedBrowserStartupUrls: async () => [],
    });
    try {
      const run = await api.startRun("device-one", "saved-browser-empty", "Open the saved browser", { mode: "browser", sessionMode: "saved" });
      expect(run.target).toEqual({ appName: "Harness-managed browser", title: "New tab", provenance: "starting_target" });
      expect(createdComputerConfigs[0]).toMatchObject({ managedBrowserUrl: "about:blank", managedBrowserProfileMode: "persistent" });
    } finally {
      session.activeRun?.controller.cancel("empty saved browser test cleanup");
      await session.waitForActiveRun();
      await session.close();
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("rejects saved browser mode without a persistent profile while allowing temporary mode", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "harness-remote-api-browser-gate-"));
    const { api, session, createdComputerConfigs } = createFixture(outputDir, { summary: "Should not run." });
    try {
      await expect(api.startRun("device-one", "browser-unconfigured", "Check a page", { mode: "browser", sessionMode: "saved", url: "https://example.test" }))
        .rejects.toMatchObject({ code: "MANAGED_BROWSER_UNAVAILABLE" });
      const extraProfilePath = {
        mode: "browser",
        url: "https://example.test",
        managedBrowserProfileRoot: "C:\\client-controlled",
      } as never;
      await expect(api.startRun("device-one", "browser-client-path", "Check a page", extraProfilePath))
        .rejects.toMatchObject({ code: "INVALID_TARGET" });
      await expect(api.startRun("device-one", "browser-invalid-scheme", "Check a page", { mode: "browser", url: "file:///private/document" }))
        .rejects.toMatchObject({ code: "INVALID_TARGET" });
      await expect(api.startRun("device-one", "browser-credentials", "Check a page", { mode: "browser", url: "https://name:secret@example.test" }))
        .rejects.toMatchObject({ code: "INVALID_TARGET" });
      await expect(api.startRun("device-one", "browser-about-fragment", "Check a page", { mode: "browser", url: "about:blank#other" }))
        .rejects.toMatchObject({ code: "INVALID_TARGET" });
      await expect(api.startRun("device-one", "browser-other-about", "Check a page", { mode: "browser", url: "about:newtab" }))
        .rejects.toMatchObject({ code: "INVALID_TARGET" });
      await expect(api.startRun("device-one", "browser-data-url", "Check a page", { mode: "browser", url: "data:text/html,hello" }))
        .rejects.toMatchObject({ code: "INVALID_TARGET" });
      await expect(api.startRun("device-one", "browser-javascript-url", "Check a page", { mode: "browser", url: "javascript:alert(1)" }))
        .rejects.toMatchObject({ code: "INVALID_TARGET" });
      await expect(api.startRun("device-one", "desktop-malformed-switch", "Inspect a popup", { mode: "desktop", switchWindows: "yes" } as never))
        .rejects.toMatchObject({ code: "INVALID_TARGET" });
      await expect(api.startRun("device-one", "malformed-switch-flag", "Open a listed app", { mode: "auto", switchWindows: "yes" } as never))
        .rejects.toMatchObject({ code: "INVALID_TARGET" });
      expect(createdComputerConfigs).toEqual([]);
      expect(session.activeRun).toBeUndefined();
    } finally {
      await session.close();
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("binds user replies to the pending question event and hides another phone's Run", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "harness-remote-api-request-"));
    const { api, session } = createFixture(outputDir, { askFirst: true, summary: "Checked the requested date." });
    try {
      const choices = await api.listWindowTargets("device-one");
      const run = await api.startRun("device-one", "start-question", "Check a calendar date", choices.candidates[0]!.token);
      await waitFor(() => session.activeRun?.controller.getSnapshot().status === "waiting_user", "Run did not request user input");
      const pending = api.getRun("device-one", run.runId)?.pendingRequest;
      expect(pending?.kind).toBe("user_input");
      if (pending?.kind !== "user_input") throw new Error("expected pending user input");
      const sequence = api.getRun("device-one", run.runId)!.sequence;

      await expect(api.submitCommand("device-one", run.runId, {
        commandId: "bad-reply",
        expectedSequence: sequence,
        type: "respond",
        requestId: "stale-question",
        text: "Tomorrow",
      })).rejects.toMatchObject({ code: "STALE_REQUEST" });
      await expect(api.submitCommand("device-two", run.runId, {
        commandId: "other-device",
        expectedSequence: sequence,
        type: "respond",
        requestId: pending.requestId,
        text: "Tomorrow",
      })).rejects.toMatchObject({ code: "RUN_NOT_FOUND" });

      const accepted = await api.submitCommand("device-one", run.runId, {
        commandId: "good-reply",
        expectedSequence: sequence,
        type: "respond",
        requestId: pending.requestId,
        text: "Tomorrow",
      });
      expect(accepted.status).toBe("accepted");
      expect(api.getCommandReceipt("device-two", run.runId, "good-reply")).toBeUndefined();
      await session.waitForActiveRun();
      await waitFor(
        () => api.getCommandReceipt("device-one", run.runId, "good-reply")?.status === "applied",
        "response command did not reach its terminal receipt",
      );
      expect(api.getRun("device-one", run.runId)?.reply).toBe("Checked the requested date.");
    } finally {
      await session.close();
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("never evicts start idempotency keys to make capacity; duplicate requests cannot create a second Run", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "harness-remote-api-capacity-"));
    let now = 10_000;
    const { api, session } = createFixture(outputDir, { summary: "Completed once." }, { maxStartRequests: 1, now: () => now });
    try {
      const choices = await api.listWindowTargets("device-one");
      const targetToken = choices.candidates[0]!.token;
      const first = await api.startRun("device-one", "start-stable", "Perform one task", targetToken);
      await session.waitForActiveRun();
      now += 10 * 60_000 + 1;
      const duplicate = await api.startRun("device-one", "start-stable", "Perform one task", targetToken);
      expect(duplicate.runId).toBe(first.runId);
      await expect(api.startRun("device-one", "start-new", "A second task", "A".repeat(32))).rejects.toMatchObject({ code: "CAPACITY_REACHED" });
      const duplicateAfterCapacity = await api.startRun("device-one", "start-stable", "Perform one task", targetToken);
      expect(duplicateAfterCapacity.runId).toBe(first.runId);
    } finally {
      await session.close();
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("retains command receipts and rejects new IDs rather than evicting actionable dedupe entries", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "harness-remote-api-command-capacity-"));
    const { api, session } = createFixture(outputDir, { askFirst: true, summary: "Answered once." }, { maxCommandsPerRun: 1 });
    try {
      const choices = await api.listWindowTargets("device-one");
      const run = await api.startRun("device-one", "start-command-capacity", "Ask one question", choices.candidates[0]!.token);
      await waitFor(() => session.activeRun?.controller.getSnapshot().status === "waiting_user", "Run did not request user input");
      const pending = api.getRun("device-one", run.runId)?.pendingRequest;
      if (pending?.kind !== "user_input") throw new Error("expected pending user input");
      const command = {
        commandId: "answer-stable",
        expectedSequence: api.getRun("device-one", run.runId)!.sequence,
        type: "respond" as const,
        requestId: pending.requestId,
        text: "Tomorrow",
      };
      await api.submitCommand("device-one", run.runId, command);
      await session.waitForActiveRun();
      await waitFor(() => api.getCommandReceipt("device-one", run.runId, command.commandId)?.status === "applied", "command did not finish");
      expect((await api.submitCommand("device-one", run.runId, command)).status).toBe("applied");
      await expect(api.submitCommand("device-one", run.runId, {
        ...command,
        commandId: "answer-new",
        expectedSequence: api.getRun("device-one", run.runId)!.sequence,
      })).rejects.toMatchObject({ code: "CAPACITY_REACHED" });
    } finally {
      await session.close();
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("binds initial-window tokens to one device and invalidates refreshed, expired, or changed choices", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "harness-remote-api-window-tokens-"));
    let now = 10_000;
    const { api, session, setWindows } = createFixture(outputDir, { summary: "Should not start." }, { now: () => now });
    try {
      const firstList = await api.listWindowTargets("device-one");
      const oldToken = firstList.candidates[0]!.token;
      expect(Date.parse(firstList.expiresAt) - now).toBe(10 * 60_000);
      await expect(api.startRun("device-two", "cross-device", "No target authority", oldToken))
        .rejects.toMatchObject({ code: "WINDOW_TARGET_STALE" });

      const refreshed = await api.listWindowTargets("device-one");
      await expect(api.startRun("device-one", "old-choice", "Stale after refresh", oldToken))
        .rejects.toMatchObject({ code: "WINDOW_TARGET_STALE" });

      const changedTargetToken = refreshed.candidates[0]!.token;
      setWindows([{ pid: 42, windowId: 1001, appName: "Replacement app", title: "Replaced window" }]);
      await expect(api.startRun("device-one", "changed-target", "Do not start on a reused window", changedTargetToken))
        .rejects.toMatchObject({ code: "WINDOW_TARGET_STALE" });
      expect(session.history).toHaveLength(0);

      setWindows([{ pid: 42, windowId: 1001, appName: "Fixture app", title: "Fixture window" }]);
      const expiring = await api.listWindowTargets("device-one");
      now += 10 * 60_000 + 1;
      await expect(api.startRun("device-one", "expired-choice", "Expired", expiring.candidates[0]!.token))
        .rejects.toMatchObject({ code: "WINDOW_TARGET_STALE" });
      expect(session.history).toHaveLength(0);
    } finally {
      await session.close();
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("reads valid local assets when path and handle stats expose different identity fields", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "harness-remote-asset-stat-"));
    const assetRoot = join(tempRoot, "assets");
    const assetPath = join(assetRoot, "snapshot.png");
    const bytes = new Uint8Array([1, 2, 3, 4]);
    await mkdir(assetRoot, { recursive: true });
    await writeFile(assetPath, bytes);

    try {
      const pathStat = await lstat(assetPath);
      const pathBigIntStat = await lstat(assetPath, { bigint: true });
      const { number: handleStat, bigint: handleBigIntStat } = await (async () => {
        const file = await open(assetPath, "r");
        try {
          const [number, bigint] = await Promise.all([file.stat(), file.stat({ bigint: true })] as const);
          return { number, bigint };
        } finally {
          await file.close();
        }
      })();
      const resolvedRoot = await realpath(assetRoot);
      const resolvedAsset = await realpath(assetPath);
      const relativeAsset = relative(resolvedRoot, resolvedAsset);
      const contained = relativeAsset !== "" && relativeAsset !== ".." &&
        !relativeAsset.startsWith(".." + sep) && !isAbsolute(relativeAsset);
      const diagnostics = JSON.stringify({
        node: process.version,
        platform: process.platform,
        numberStats: {
          lstat: { dev: pathStat.dev, ino: pathStat.ino, size: pathStat.size, isFile: pathStat.isFile() },
          fileStat: { dev: handleStat.dev, ino: handleStat.ino, size: handleStat.size, isFile: handleStat.isFile() },
        },
        bigintStats: {
          lstat: { dev: pathBigIntStat.dev.toString(), ino: pathBigIntStat.ino.toString(), size: pathBigIntStat.size.toString() },
          fileStat: { dev: handleBigIntStat.dev.toString(), ino: handleBigIntStat.ino.toString(), size: handleBigIntStat.size.toString() },
        },
        containment: { relativeAsset, contained },
      });
      if (process.platform === "win32") console.info(`[remote-asset-stat] ${diagnostics}`);

      expect(pathStat.isFile(), diagnostics).toBe(true);
      expect(handleStat.isFile(), diagnostics).toBe(true);
      expect(pathBigIntStat.size, diagnostics).toBe(4n);
      expect(handleBigIntStat.size, diagnostics).toBe(4n);
      expect(contained, diagnostics).toBe(true);

      const ref: AssetRef = {
        assetId: "asset-stat" as AssetId,
        relativePath: "snapshot.png",
        mediaType: "image/png",
        byteLength: bytes.byteLength,
      };
      await expect(createFileRemoteAssetReader(assetRoot).read(ref, new AbortController().signal)).resolves.toEqual(bytes);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("rejects remote assets whose stored byte length differs from the file", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "harness-remote-asset-length-"));
    const assetRoot = join(tempRoot, "assets");
    await mkdir(assetRoot, { recursive: true });
    await writeFile(join(assetRoot, "snapshot.png"), new Uint8Array([1, 2, 3, 4]));
    try {
      const ref: AssetRef = {
        assetId: "asset-wrong-length" as AssetId,
        relativePath: "snapshot.png",
        mediaType: "image/png",
        byteLength: 3,
      };
      await expect(createFileRemoteAssetReader(assetRoot).read(ref, new AbortController().signal))
        .rejects.toThrow(/metadata does not match/iu);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("rejects symlinked remote asset path components when the filesystem supports symlinks", async ({ skip }) => {
    const tempRoot = await mkdtemp(join(tmpdir(), "harness-remote-asset-symlink-"));
    const assetRoot = join(tempRoot, "assets");
    const outsideAssetDir = join(tempRoot, "outside-assets");
    const outsideFile = join(outsideAssetDir, "escape.png");
    await mkdir(assetRoot, { recursive: true });
    await mkdir(outsideAssetDir, { recursive: true });
    await writeFile(outsideFile, new Uint8Array([1, 2, 3]));
    try {
      try {
        await symlink(outsideAssetDir, join(assetRoot, "images"), process.platform === "win32" ? "junction" : "dir");
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (process.platform === "win32" && ["EPERM", "EACCES", "ENOTSUP", "UNKNOWN"].includes(code ?? "")) {
          skip();
          return;
        }
        throw error;
      }
      const ref: AssetRef = {
        assetId: "asset-symlink" as AssetId,
        relativePath: "images/escape.png",
        mediaType: "image/png",
        byteLength: 3,
      };
      await expect(createFileRemoteAssetReader(assetRoot).read(ref, new AbortController().signal)).rejects.toThrow(/symlink|changed|outside/iu);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});
