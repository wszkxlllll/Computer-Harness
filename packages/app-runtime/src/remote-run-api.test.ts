import { lstat, mkdir, mkdtemp, open, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
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
  type RunOutcome,
  type Viewport,
  type MonitorPolicyMode,
} from "@computer-harness/runtime";
import type { RuntimeEvent, AssetId, AssetRef, ComputerSessionId, ComputerWindowOption, ModelTurn, RunId, SurfaceId, ToolCall, ToolCallId } from "@computer-harness/protocol";
import type { WindowTargetInfo } from "./application-session.js";
import { createFileRemoteAssetReader, type ApplicationSessionConfig } from "./index.js";
import { ApplicationSession } from "./application-session.js";
import { InProcessEnvironmentOwner } from "./environment-owner.js";
import { ApplicationRemoteRunApi, RemoteRunApiError, type ManagedBrowserProfileRunCoordinator } from "./remote-run-api.js";

const viewport: Viewport = { width: 8, height: 8, coordinateSpace: "physical" };
const surfaceRef = { surfaceId: "remote-run-api-desktop" as SurfaceId, generation: 1, kind: "desktop" as const };

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
): Computer {
  let sequence = 0;
  const session: ComputerSession = {
    id: "remote-api-session" as ComputerSessionId,
    backend: "fixture",
    viewport: screen,
    capabilities: { screenshot: true, pointer: true, keyboard: true, accessibility: false },
    openedAt: "2026-09-26T00:00:00.000Z",
  };
  return {
    async open() { return session; },
    async observe() {
      sequence += 1;
      return {
        capturedAt: "2026-09-26T00:00:0" + String(sequence) + ".000Z",
        viewport: screen,
        surfaceRef,
        screenshot: { mediaType: "image/png" as const, data: new Uint8Array([3, 1, 4, sequence]) },
      };
    },
    async execute(_session, action) {
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
    async listWindows() { return windowInventory; },
    async close() { await closeComputer(); },
  } as unknown as Computer;
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
  },
  limits: { maxStartRequests?: number; maxCommandsPerRun?: number; now?: () => number } = {},
) {
  let windows: readonly WindowTargetInfo[] = [{ pid: 42, windowId: 1001, appName: "Fixture app", title: "Fixture window" }];
  let windowReadIndex = 0;
  let guardDecisionIndex = 0;
  const createdComputerConfigs: Array<Extract<ApplicationSessionConfig["computer"], { kind: "cua" }>> = [];
  const windowDiscoveryCalls: Array<{ type: "visible" | "all" | "activate"; pid?: number; windowId?: number }> = [];
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
      listWindows: async () => {
        windowDiscoveryCalls.push({ type: "visible" });
        return options.windowSnapshots?.[windowReadIndex++] ?? windows;
      },
      listAllWindows: async () => {
        windowDiscoveryCalls.push({ type: "all" });
        return options.allWindows ?? options.windowSnapshots?.[0] ?? windows;
      },
      activateWindow: async (target) => {
        windowDiscoveryCalls.push({ type: "activate", pid: target.pid, windowId: target.windowId });
        options.onActivateWindow?.(target, (window) => { windows = [...windows.filter((item) => item.pid !== window.pid || item.windowId !== window.windowId), window]; });
      },
    } }),
    dependencies: {
      createProvider: () => providerFor(options, () => session.activeRun?.controller.getEvents() ?? []),
      createComputer: async ({ config: computerConfig }) => {
        if (computerConfig.kind === "cua") createdComputerConfigs.push(computerConfig);
        return fixtureComputer(options.screen, options.closeComputer, options.windowInventory, options.switchWindowReceiptStatus);
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
    ...limits,
  });
  return { api, session, createdComputerConfigs, windowDiscoveryCalls, setWindows: (value: readonly WindowTargetInfo[]) => { windows = value; } };
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

describe("ApplicationRemoteRunApi", () => {
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
      expect(surfaceTransition?.data).toMatchObject({ reason: "initial_observation", fromKind: null, toKind: "desktop", generation: 1 });
      expect(JSON.stringify(surfaceTransition)).not.toContain(surfaceRef.surfaceId);
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
          surfaceRef: { surfaceId: surfaceRef.surfaceId, generation: surfaceRef.generation, kind: surfaceRef.kind },
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
          text: "可能涉及对外发送或提交内容的点击操作，请核对后审批。",
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

      const events: Array<{ type: string; data?: Record<string, unknown> }> = [];
      const subscription = api.subscribe("device-one", started.runId, 0, (event) => {
        if (event.type === "run.event") events.push(event as unknown as { type: string; data?: Record<string, unknown> });
      });
      subscription.close();
      const approvalNotice = events.find((event) => event.data?.type === "run.notice" && event.data.kind === "approval");
      expect(approvalNotice?.data?.text).toBe("可能涉及对外发送或提交内容的点击操作，请核对后审批。");
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
      expect(JSON.stringify(choices)).not.toMatch(/pid|windowId/iu);
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
      expect(JSON.stringify(completed)).not.toMatch(/pid|windowId/iu);
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
        grounding: "hybrid-catalog-v1",
      });
      expect(createdComputerConfigs[0]).not.toHaveProperty("windowTarget");
      expect(session.activeRun?.config).toMatchObject({ windowSwitch: "opened-windows-v1", windowHandoff: "confirm-v1" });
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
      expect(JSON.stringify(first)).not.toMatch(/pid|windowId/iu);
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

  it("rejects an automatic match whose exact window identity changes before Run start", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "harness-remote-api-auto-moved-"));
    const { api, session, createdComputerConfigs } = createFixture(outputDir, {
      summary: "Should not run.",
      windowSnapshots: [
        [{ pid: 42, windowId: 1001, appName: "Fixture app", title: "Fixture window" }],
        [{ pid: 42, windowId: 1001, appName: "Fixture app", title: "A replacement window" }],
      ],
    });
    try {
      await expect(api.startRun("device-one", "auto-moved", "Open Fixture app and check the report", { mode: "auto" }))
        .rejects.toMatchObject({ code: "WINDOW_TARGET_STALE" });
      expect(api.listRuns("device-one")).toEqual([]);
      expect(session.activeRun).toBeUndefined();
      expect(createdComputerConfigs).toEqual([]);
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
    try {
      const first = await api.startRun("device-one", "finished-before-cleanup", "Open a blank managed page", { mode: "browser" });
      await waitFor(() => api.getRun("device-one", first.runId)?.status === "finished", "public finished snapshot was not published");
      expect(session.activeRun).toBeDefined();

      const secondPromise = api.startRun("device-one", "after-finished-cleanup", "Open another blank managed page", { mode: "browser" });
      await new Promise<void>((resolveWait) => setTimeout(resolveWait, 20));
      expect(createdComputerConfigs).toHaveLength(1);
      expect(session.activeRun).toBeDefined();

      releaseCleanup();
      const second = await secondPromise;
      expect(second.runId).not.toBe(first.runId);
      expect(createdComputerConfigs).toHaveLength(2);
      await session.waitForActiveRun();
    } finally {
      releaseCleanup();
      session.activeRun?.controller.cancel("finished cleanup ordering test cleanup");
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
      setWindows([{ pid: 42, windowId: 1001, appName: "Fixture app", title: "Replaced window" }]);
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
          skip("Windows junction creation is unavailable for this account or filesystem.");
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
