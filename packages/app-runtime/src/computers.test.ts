import { describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDefaultToolRegistry, type Computer, type ComputerExecuteOptions } from "@computer-harness/runtime";
import type { ActionId, ActionIntent, ComputerSessionDescriptor, ComputerWindowCandidate, ComputerWindowOption, ObservationId, SurfaceId, ToolCallId } from "@computer-harness/protocol";
import { defaultManagedBrowserKind, type DomGroundingTransport, type ManagedBrowserHost, type ManagedBrowserHostOptions, type ManagedBrowserTarget, type CuaBootstrapSession } from "@computer-harness/computer-cua";
import { createComputer, prepareComputerRunAssembly } from "./computers.js";
import { createRun } from "./run-factory.js";

// Use the real current Controller across the package boundary, not old dist.
vi.mock("@computer-harness/runtime", async (importOriginal) => ({
  ...await importOriginal<typeof import("@computer-harness/runtime")>(),
  RunController: (await import("../../runtime/src/run-controller.js")).RunController,
}));

const managedTarget: ManagedBrowserTarget = {
  kind: "managed-chromium",
  browser: "edge",
  profileId: "managed-test",
  windowTarget: { pid: 321, windowId: 654 },
  tabId: "tab-test",
  generation: "generation-test",
  delivery: "loopback-cdp",
};

const managedSurfaceRef = { surfaceId: "managed-test-tab" as SurfaceId, parentSurfaceId: "managed-test-window" as SurfaceId, generation: 1, kind: "browser_tab" as const };

const managedSession: ComputerSessionDescriptor = {
  id: "managed-session",
  backend: "cua-driver",
  viewport: { width: 800, height: 600, coordinateSpace: "physical" },
  capabilities: { screenshot: true, pointer: true, keyboard: true, accessibility: false },
  openedAt: "2026-09-21T00:00:00.000Z",
};

const nativeSessionAfterHandoff: ComputerSessionDescriptor = {
  ...managedSession,
};

const nativeWindowCandidate: ComputerWindowCandidate = {
  pid: 456,
  windowId: 789,
  appName: "WPS",
  title: "Review draft",
};

const managedWindowInventory: readonly ComputerWindowOption[] = [
  { windowRef: "fixture-wps-ref", appName: "WPS", title: "Review draft", isCurrent: false },
];

describe("prepareComputerRunAssembly", () => {
  it("keeps CUA grounding and window tool limits with Computer assembly", () => {
    const registry = createDefaultToolRegistry();
    const click = registry.get("click");
    if (click === undefined) throw new Error("default registry is missing click");
    registry.register({ ...click, name: "unverified_computer_tool" });

    const desktop = prepareComputerRunAssembly({ kind: "cua", socketPath: "fixture.sock", screenshotDir: "screenshots" }, "off");
    expect(desktop.enabledToolNames(registry)).toBeUndefined();
    expect(desktop.groundingTools).toEqual([]);

    const backgroundWindow = prepareComputerRunAssembly({
      kind: "cua",
      socketPath: "fixture.sock",
      screenshotDir: "screenshots",
      windowTarget: { pid: 1234, windowId: 5678 },
    }, "off");
    const backgroundNames = backgroundWindow.enabledToolNames(registry);
    expect(backgroundNames).toEqual(expect.arrayContaining(["click", "wait", "terminate"]));
    expect(backgroundNames).not.toContain("type");
    expect(backgroundNames).not.toContain("double_click");
    expect(backgroundNames).not.toContain("unverified_computer_tool");

    const foregroundWindow = prepareComputerRunAssembly({
      kind: "cua",
      socketPath: "fixture.sock",
      screenshotDir: "screenshots",
      windowTarget: { pid: 1234, windowId: 5678 },
      windowDeliveryMode: "foreground",
    }, "off");
    const foregroundNames = foregroundWindow.enabledToolNames(registry);
    expect(foregroundNames).toEqual(expect.arrayContaining(["click", "wait", "type", "keypress", "hotkey", "drag", "scroll"]));
    expect(foregroundNames).not.toContain("double_click");
    expect(foregroundNames).not.toContain("unverified_computer_tool");

    const uia = prepareComputerRunAssembly({
      kind: "cua",
      socketPath: "fixture.sock",
      screenshotDir: "screenshots",
      windowTarget: { pid: 1234, windowId: 5678 },
    }, "uia-catalog-v1");
    expect(uia.groundingTools.map((tool) => tool.name)).toEqual(["click_element"]);
    const uiaRegistry = createDefaultToolRegistry();
    uiaRegistry.registerMany(uia.groundingTools);
    expect(uia.enabledToolNames(uiaRegistry)).toContain("click_element");
    expect(uia.enabledToolNames(uiaRegistry)).not.toContain("select_option");

    const managed = prepareComputerRunAssembly({
      kind: "cua",
      socketPath: "fixture.sock",
      screenshotDir: "screenshots",
      managedBrowserUrl: "https://example.test",
    }, "dom-catalog-v1");
    expect(managed.config).toMatchObject({ grounding: "dom-catalog-v1", windowDeliveryMode: "foreground" });
    expect(managed.groundingTools.map((tool) => tool.name).sort()).toEqual(["click_element", "select_option"]);
    const managedRegistry = createDefaultToolRegistry();
    const managedClick = managedRegistry.get("click");
    if (managedClick === undefined) throw new Error("default registry is missing click");
    managedRegistry.register({ ...managedClick, name: "unverified_computer_tool" });
    managedRegistry.registerMany(managed.groundingTools);
    expect(managed.enabledToolNames(managedRegistry)).toEqual(expect.arrayContaining(["wait", "type", "click_element", "select_option"]));
    expect(managed.enabledToolNames(managedRegistry)).not.toContain("click");
    expect(managed.enabledToolNames(managedRegistry)).not.toContain("unverified_computer_tool");

    const managedCrossWindow = prepareComputerRunAssembly({
      kind: "cua",
      socketPath: "fixture.sock",
      screenshotDir: "screenshots",
      managedBrowserUrl: "https://example.test",
    }, "hybrid-catalog-v1", "opened-windows-v1");
    expect(managedCrossWindow.enabledToolNames(managedRegistry)).toContain("click");
    expect(managedCrossWindow.enabledToolNames(managedRegistry)).not.toContain("unverified_computer_tool");

    const managedBlank = prepareComputerRunAssembly({
      kind: "cua",
      socketPath: "fixture.sock",
      screenshotDir: "screenshots",
      managedBrowserUrl: "about:blank",
    }, "hybrid-catalog-v1");
    expect(managedBlank.config).toMatchObject({ managedBrowserUrl: "about:blank", grounding: "hybrid-catalog-v1", windowDeliveryMode: "foreground" });
    for (const invalidUrl of ["about:blank#other", "about:newtab", "file:///private/document", "data:text/html,hello", "javascript:alert(1)", "https://user:secret@example.test"]) {
      expect(() => prepareComputerRunAssembly({
        kind: "cua",
        socketPath: "fixture.sock",
        screenshotDir: "screenshots",
        managedBrowserUrl: invalidUrl,
      }, "hybrid-catalog-v1")).toThrow(/managedBrowserUrl/iu);
    }
  });

  it("accepts a desktop-screen starting binding for opted-in cross-window Runs", () => {
    const assembly = prepareComputerRunAssembly({
      kind: "cua",
      socketPath: "fixture.sock",
      screenshotDir: "screenshots",
    }, "off", "opened-windows-v1");

    expect(assembly.config).toMatchObject({
      windowSwitch: "opened-windows-v1",
      windowDeliveryMode: "foreground",
    });
  });

  it("rejects unsupported grounding before Computer or Run resources are created", () => {
    expect(() => prepareComputerRunAssembly({ kind: "osworld", bridgeUrl: "http://127.0.0.1:5000" }, "dom-catalog-v1"))
      .toThrow(/requires the CUA computer/iu);
    expect(() => prepareComputerRunAssembly({ kind: "cua", socketPath: "fixture.sock", screenshotDir: "screenshots" }, "uia-catalog-v1"))
      .toThrow(/explicit CUA window target/iu);
    expect(() => prepareComputerRunAssembly({ kind: "external", id: "mock" }, "uia-catalog-v1"))
      .toThrow(/external Computer/iu);
  });
});

function managedFixture(options: {
  runtime?: boolean;
  unknownExecution?: boolean;
  failStart?: boolean;
  abortDelegateOpen?: boolean;
  failDelegateOpen?: boolean;
  failDelegateDispose?: boolean;
  failDelegateClose?: boolean;
  failHostClose?: boolean;
  failBootstrapClose?: boolean;
  cleanupDiagnosticOnClose?: Parameters<NonNullable<ManagedBrowserHostOptions["onCleanupDiagnostic"]>>[0];
} = {}) {
  const execution: { observations: number; actions: ActionIntent[]; options: (ComputerExecuteOptions | undefined)[] } = { observations: 0, actions: [], options: [] };
  const calls: { bootstrapOpen: number; bootstrapClose: number; hostConstruct: number; hostStart: number; hostClose: number; delegateConstruct: number; delegateOpen: number; delegateClose: number; delegateDispose: number; delegateListWindows: number; delegateListHandoffCandidates: number; delegateListNewHandoffCandidates: number; delegateDetectNewHandoffCandidates: number; delegateHandoff: number; delegateCloseSessionId?: string; delegateHandoffCandidate?: ComputerWindowCandidate; delegateWindowDeliveryMode?: unknown; delegateOptions?: Record<string, unknown>; hostOptions?: ManagedBrowserHostOptions } = { bootstrapOpen: 0, bootstrapClose: 0, hostConstruct: 0, hostStart: 0, hostClose: 0, delegateConstruct: 0, delegateOpen: 0, delegateClose: 0, delegateDispose: 0, delegateListWindows: 0, delegateListHandoffCandidates: 0, delegateListNewHandoffCandidates: 0, delegateDetectNewHandoffCandidates: 0, delegateHandoff: 0 };
  const transport = {} as DomGroundingTransport;
  const host = {
    async start() {
      calls.hostStart += 1;
      if (options.failStart === true) throw new Error("fixture host start failed");
      return { target: managedTarget, processId: 321, profileId: managedTarget.profileId, tabId: managedTarget.tabId, generation: managedTarget.generation };
    },
    createTransport() { return transport; },
    async close() {
      calls.hostClose += 1;
      if (options.cleanupDiagnosticOnClose !== undefined) calls.hostOptions?.onCleanupDiagnostic?.(options.cleanupDiagnosticOnClose);
      if (options.failHostClose === true) throw new Error("fixture host close failed");
    },
  } as unknown as ManagedBrowserHost;
  const createHost = vi.fn((hostOptions: ManagedBrowserHostOptions) => {
    calls.hostConstruct += 1;
    calls.hostOptions = hostOptions;
    return host;
  });
  const bootstrap: CuaBootstrapSession = {
    driver: {} as CuaBootstrapSession["driver"],
    label: "bootstrap-fixture",
    async close() {
      calls.bootstrapClose += 1;
      if (options.failBootstrapClose === true) throw new Error("fixture bootstrap close failed");
    },
  };
  const openBootstrap = vi.fn(async () => {
    calls.bootstrapOpen += 1;
    return bootstrap;
  });
  class Delegate implements Computer {
    public constructor(options: Record<string, unknown>) { calls.delegateConstruct += 1; calls.delegateWindowDeliveryMode = options.windowDeliveryMode; calls.delegateOptions = options; }
    public async open(_options: unknown, signal: AbortSignal) {
      calls.delegateOpen += 1;
      if (options.abortDelegateOpen === true) signal.throwIfAborted();
      if (options.failDelegateOpen === true) throw new Error("fixture delegate open failed");
      return managedSession;
    }
    public async observe(session: ComputerSessionDescriptor, observationId: ObservationId) {
      if (!options.runtime) throw new Error("not used");
      execution.observations += 1;
      return { capturedAt: "2026-10-03T00:00:00.000Z", viewport: session.viewport, surfaceRef: managedSurfaceRef, screenshot: { mediaType: "image/png" as const, data: new Uint8Array([1, 2, 3]) }, grounding: { version: "grounding-catalog-v2" as const, source: "hybrid" as const, observationId, computerSessionId: session.id, surfaceRef: managedSurfaceRef, completeness: "complete" as const, degraded: false, maxElements: 256, elements: [{ elementRef: "search-ref", role: "textbox", name: "Search", source: "dom" as const, browserRegion: "content" as const, bbox: { x: 10, y: 20, width: 100, height: 24 }, state: { enabled: true, editable: true, focused: true } }] } };
    }
    public async execute(_session: ComputerSessionDescriptor, action: ActionIntent, signal: AbortSignal, executeOptions?: ComputerExecuteOptions) {
      if (!options.runtime) throw new Error("not used");
      signal.throwIfAborted();
      execution.actions.push(action);
      execution.options.push(executeOptions);
      if (options.unknownExecution) throw new Error("fixture unknown input outcome");
      return { actionId: action.actionId, status: "completed" as const };
    }
    public async close(session: ComputerSessionDescriptor) {
      calls.delegateClose += 1;
      calls.delegateCloseSessionId = session.id;
      if (options.failDelegateClose === true) throw new Error("fixture delegate close failed");
    }
    public async dispose() {
      calls.delegateDispose += 1;
      if (options.failDelegateDispose === true) throw new Error("fixture delegate dispose failed");
    }
    public async listWindows() { calls.delegateListWindows += 1; return managedWindowInventory; }
    public async listWindowHandoffCandidates() { calls.delegateListHandoffCandidates += 1; return [nativeWindowCandidate]; }
    public async listNewWindowHandoffCandidates() { calls.delegateListNewHandoffCandidates += 1; return [nativeWindowCandidate]; }
    public async detectNewWindowHandoffCandidates() { calls.delegateDetectNewHandoffCandidates += 1; return options.runtime ? [] : [nativeWindowCandidate]; }
    public async handoffWindow(_session: ComputerSessionDescriptor, candidate: ComputerWindowCandidate) {
      calls.delegateHandoff += 1;
      calls.delegateHandoffCandidate = structuredClone(candidate);
      return nativeSessionAfterHandoff;
    }
  }
  return { calls, execution, createHost, openBootstrap, Delegate, signal: new AbortController().signal };
}

describe("createComputer", () => {
  it.each(["different-focused-process", "target-focused-global-conflict"])("preserves typed exact activation refusal through real CUA, managed wrapper and Runtime with %s", async (scenario) => {
    const directory = await mkdtemp(join(tmpdir(), "harness-managed-activation-startup-"));
    const source = "../../computer-cua/src/cua-driver-computer.js";
    const support = "../../computer-cua/src/cua-sdk-test-support.js";
    const { CuaDriverComputer } = await import(source);
    (await import(support)).installFakeCuaSdkModuleForTests();
    const fixture = managedFixture();
    const driverCalls: string[] = [];
    const driver = {
      async startSession() { driverCalls.push("startSession"); return { active: true }; },
      async endSession() { driverCalls.push("endSession"); return { active: false }; },
      async shutdown() { driverCalls.push("shutdown"); }, uniffiDestroy() {},
      async callTool(name: string) {
        driverCalls.push(name);
        const targetFocused = scenario === "target-focused-global-conflict";
        const structured = name === "health_report" ? { platform: "darwin" } : { status: "partial", pid: managedTarget.windowTarget.pid, window_id: managedTarget.windowTarget.windowId, request_accepted: true, process_activated: targetFocused, exact_window_effect: { verified: false, target_visible_ordinary: true }, observed: { front_process_matches_target: targetFocused, focused_window_id: targetFocused ? managedTarget.windowTarget.windowId : 999, frontmost_ordinary_window_id: 999, workspace_frontmost_pid: targetFocused ? managedTarget.windowTarget.pid : 888, ...(targetFocused ? { frontmost_pid: managedTarget.windowTarget.pid } : {}) }, title: "PRIVATE_TITLE", path: "PRIVATE_PATH" };
        return { isError: name === "bring_to_front", text: "PRIVATE_DRIVER_TEXT", images: [], degraded: false, rawJson: "{}", structuredJson: JSON.stringify(structured) };
      },
    };
    class Delegate extends CuaDriverComputer { constructor(options: Record<string, unknown>) { super({ ...options, driverFactory: () => driver }); } }
    const config = { kind: "cua" as const, socketPath: "fixture.sock", screenshotDir: directory, grounding: "hybrid-catalog-v1" as const, managedBrowserUrl: "about:blank", windowDeliveryMode: "foreground" as const, windowSwitch: "off" as const };
    const host = fixture.createHost({} as ManagedBrowserHostOptions);
    host.createTransport = () => ({ kind: "managed-loopback-cdp-v1", async collect() { throw new Error("must not collect before activation confirmation"); } });
    const computer = await createComputer(config, { createManagedBrowserHost: () => host, openCuaBootstrapSession: fixture.openBootstrap, importCuaComputer: async () => ({ CuaDriverComputer: Delegate }) });
    let modelCalls = 0;
    const handle = await createRun({ goal: "fixture startup", model: "glm-5.3-flash", computer: config, grounding: "hybrid-catalog-v1", windowSwitch: "off", windowHandoff: "off", outputDir: directory, maxSteps: 3, maxModelRequests: 3, planning: false, memory: "off", batching: "off", contextMode: "raw", contextMaxHistoryEvents: 8, riskProfile: "experiment", riskGuard: "off", riskModel: "off", riskMaxModelRequests: 0, riskTimeoutMs: 100, cleanupDeadlineMs: 100 }, { createComputer: async () => computer, createProvider: () => ({ id: "fixture", async generate() { modelCalls += 1; throw new Error("must not reach model"); } }) });
    try {
      expect(await handle.start()).toBe("failed");
      const events = handle.controller.getEvents();
      expect(events.at(-1)).toMatchObject({ type: "run.finished", outcome: "failed", summary: expect.stringContaining("窗口启动未通过精确前台身份确认") });
      expect(events.some((event) => event.type === "computer.open.completed" || event.type === "observation.created" || event.type === "action.execution.started" || event.type === "model.request.started")).toBe(false);
      expect(modelCalls).toBe(0);
      expect(driverCalls).toEqual(["startSession", "health_report", "bring_to_front", "endSession", "shutdown"]);
      const error = events.find((event) => event.type === "runtime.error");
      expect(error).toMatchObject({ message: expect.stringContaining('"requestAccepted":true') });
      if (scenario === "target-focused-global-conflict") {
        expect(error).toMatchObject({ message: expect.stringContaining(`AX focused_window_id=${managedTarget.windowTarget.windowId}`) });
        expect(error).toMatchObject({ message: expect.stringContaining("independent frontmost_ordinary_window_id=999") });
      }
      expect(JSON.stringify(events)).not.toMatch(/PRIVATE_TITLE|PRIVATE_PATH|PRIVATE_DRIVER_TEXT/);
    } finally { await handle.close(); await rm(directory, { recursive: true, force: true }); }
  });
  it.each([["off", "completed"], ["opened-windows-v1", "completed"], ["off", "unknown"], ["opened-windows-v1", "unknown"], ["opened-windows-v1", "missing-detector"]] as const)("runs the real managed wrapper through Runtime with windowSwitch %s and %s", async (mode, scenario) => {
    const directory = await mkdtemp(join(tmpdir(), "harness-managed-handoff-contract-"));
    const fixture = managedFixture({ runtime: true, unknownExecution: scenario === "unknown" });
    if (scenario === "missing-detector") Object.defineProperty(fixture.Delegate.prototype, "detectNewWindowHandoffCandidates", { value: undefined });
    const config = { kind: "cua" as const, socketPath: "fixture.sock", screenshotDir: directory, grounding: "hybrid-catalog-v1" as const, managedBrowserUrl: "about:blank", windowDeliveryMode: "foreground" as const, windowSwitch: mode };
    const computer = await createComputer(config, { createManagedBrowserHost: fixture.createHost, openCuaBootstrapSession: fixture.openBootstrap, importCuaComputer: async () => ({ CuaDriverComputer: fixture.Delegate }) });
    expect(computer.detectNewWindowHandoffCandidates).toBeUndefined();
    let turns = 0;
    const handle = await createRun({ goal: "fixture single Search click", model: "glm-5.3-flash", computer: config, grounding: "hybrid-catalog-v1", windowSwitch: mode, windowHandoff: "confirm-v1", outputDir: directory, maxSteps: 3, maxModelRequests: 3, planning: false, memory: "off", batching: "off", contextMode: "raw", contextMaxHistoryEvents: 8, riskProfile: "experiment", riskGuard: "off", riskModel: "off", riskMaxModelRequests: 0, riskTimeoutMs: 100, cleanupDeadlineMs: 100 }, {
      createComputer: async () => computer,
      createProvider: () => ({ id: "fixture", async generate() { turns += 1; return turns === 1 ? { type: "tool_calls", calls: [{ id: "one-click" as ToolCallId, name: "click_element", arguments: { elementRef: "search-ref" } }] } : { type: "finish", summary: "fixture finished" }; } }),
    });
    try {
      const outcome = await handle.start();
      expect(outcome).toBe(scenario === "unknown" ? "outcome_unknown" : "succeeded");
      expect(fixture.execution.actions).toHaveLength(1);
      expect(fixture.execution.actions[0]?.kind).toBe("click");
      expect(fixture.execution.observations).toBe(scenario === "unknown" ? 1 : 2);
      expect(fixture.execution.options[0]?.detectNewWindowHandoff).toBe(mode === "off" || scenario === "missing-detector" ? undefined : true);
      expect(fixture.calls.delegateDetectNewHandoffCandidates).toBe(mode === "off" || scenario === "unknown" || scenario === "missing-detector" ? 0 : 1);
      expect(turns).toBe(scenario === "unknown" ? 1 : 2);
      expect(fixture.calls.delegateHandoff).toBe(0);
      expect(fixture.calls.delegateListHandoffCandidates).toBe(0);
      expect(fixture.calls.delegateListNewHandoffCandidates).toBe(0);
      expect(handle.controller.getEvents().some((event) => event.type === "computer.window.handoff.requested")).toBe(false);
      expect(computer.handoffWindow).toBeUndefined();
      expect(computer.listWindows).toBeUndefined();
    } finally { await handle.close(); await rm(directory, { recursive: true, force: true }); }
  });

  it("does not expose single-target window capabilities and refuses an unauthorized direct switch", async () => {
    const fixture = managedFixture({ runtime: true });
    const computer = await createComputer({ kind: "cua", socketPath: "fixture.sock", screenshotDir: "screenshots", grounding: "hybrid-catalog-v1", managedBrowserUrl: "about:blank", windowSwitch: "off" }, { createManagedBrowserHost: fixture.createHost, openCuaBootstrapSession: fixture.openBootstrap, importCuaComputer: async () => ({ CuaDriverComputer: fixture.Delegate }) });
    const session = await computer.open({}, fixture.signal);
    try {
      expect(computer.listWindows).toBeUndefined();
      expect(computer.listWindowHandoffCandidates).toBeUndefined();
      expect(computer.listNewWindowHandoffCandidates).toBeUndefined();
      expect(computer.detectNewWindowHandoffCandidates).toBeUndefined();
      expect(computer.handoffWindow).toBeUndefined();
      await expect(computer.execute(session, { actionId: "unauthorized" as ActionId, kind: "switch_window", windowRef: "fixture-wps-ref" }, fixture.signal)).resolves.toMatchObject({ status: "refused", driverCode: "WINDOW_SWITCH_DISABLED" });
      expect(fixture.execution.actions).toHaveLength(0);
      expect(fixture.calls.delegateHandoff).toBe(0);
    } finally { await computer.close(session); }
  });
  it("does not resolve the CUA module for the OSWorld backend", async () => {
    const importCuaComputer = vi.fn(async () => {
      throw new Error("native binding should not be loaded");
    });

    const computer = await createComputer(
      { kind: "osworld", bridgeUrl: "http://127.0.0.1:5000" },
      { importCuaComputer },
    );

    expect(computer).toBeDefined();
    expect(importCuaComputer).not.toHaveBeenCalled();
  });

  it("reports a CUA module load failure without exposing it as another backend failure", async () => {
    const bindingError = new Error("native binding unavailable");

    await expect(createComputer(
      { kind: "cua", socketPath: "fixture.sock", screenshotDir: "screenshots" },
      { importCuaComputer: async () => Promise.reject(bindingError) },
    )).rejects.toMatchObject({
      message: expect.stringContaining("native @trycua/cua-driver platform binding"),
      cause: bindingError,
    });
  });

  it("does not relabel constructor failures as native binding load failures", async () => {
    const constructorError = new Error("invalid CUA configuration");
    class FailingComputer {
      public constructor() {
        throw constructorError;
      }
    }

    await expect(createComputer(
      { kind: "cua", socketPath: "fixture.sock", screenshotDir: "screenshots" },
      { importCuaComputer: async () => ({ CuaDriverComputer: FailingComputer as unknown as new () => Computer }) },
    )).rejects.toBe(constructorError);
  });

  it("passes an explicit CUA window target without changing the default backend path", async () => {
    let received: Record<string, unknown> | undefined;
    class CapturingComputer {
      public constructor(options: Record<string, unknown>) {
        received = options;
      }
    }

    await createComputer(
      { kind: "cua", socketPath: "fixture.sock", screenshotDir: "screenshots", windowTarget: { pid: 1234, windowId: 5678 }, windowDeliveryMode: "foreground" },
      { importCuaComputer: async () => ({ CuaDriverComputer: CapturingComputer as unknown as new (options: Record<string, unknown>) => Computer }) },
    );

    expect(received).toMatchObject({ socketPath: "fixture.sock", screenshotDir: "screenshots", windowTarget: { pid: 1234, windowId: 5678 } });
    if (process.platform === "win32") {
      expect(received?.windowRelationshipProbe).toMatchObject({ read: expect.any(Function) });
    } else {
      expect(received).not.toHaveProperty("windowRelationshipProbe");
    }
  });

  it("allows explicit probe injection and an explicit opt-out of the Windows fallback", async () => {
    const probe = { read: vi.fn(async () => ({ source: "win32_relationship_probe" as const, complete: false, windows: [] })) };
    let injected: Record<string, unknown> | undefined;
    class CapturingComputer {
      public constructor(options: Record<string, unknown>) { injected = options; }
    }
    const importer = async () => ({
      CuaDriverComputer: CapturingComputer as unknown as new (options: Record<string, unknown>) => Computer,
    });
    const config = { kind: "cua" as const, socketPath: "fixture.sock", screenshotDir: "screenshots", windowDeliveryMode: "foreground" as const };

    await createComputer(config, { importCuaComputer: importer, windowRelationshipProbe: probe });
    expect(injected?.windowRelationshipProbe).toBe(probe);

    injected = undefined;
    await createComputer(config, { importCuaComputer: importer, windowRelationshipProbe: null });
    expect(injected).not.toHaveProperty("windowRelationshipProbe");
  });

  it("keeps mode off on the existing CUA path without constructing a managed host", async () => {
    const importCuaComputer = vi.fn(async () => ({ CuaDriverComputer: class { public constructor() {} } as unknown as new (options: Record<string, unknown>) => Computer }));
    const createHost = vi.fn(() => { throw new Error("managed host must not be constructed"); });
    await createComputer(
      { kind: "cua", socketPath: "fixture.sock", screenshotDir: "screenshots", grounding: "off" },
      { importCuaComputer, createManagedBrowserHost: createHost },
    );
    expect(importCuaComputer).toHaveBeenCalledTimes(1);
    expect(createHost).not.toHaveBeenCalled();
  });

  it("rejects SDK persistent managed profiles without an explicit Harness-owned root", async () => {
    await expect(createComputer({
      kind: "cua",
      socketPath: "fixture.sock",
      screenshotDir: "screenshots",
      grounding: "dom-catalog-v1",
      managedBrowserUrl: "https://example.test",
      managedBrowserProfileMode: "persistent",
      managedBrowserProfileLabel: "fixture",
    }, { importCuaComputer: async () => ({ CuaDriverComputer: class {} as unknown as new () => Computer }) })).rejects.toThrow(/profile label and explicit profile root/iu);
  });

  it("owns the managed host/bootstrap lifecycle around the delegate Computer", async () => {
    const fixture = managedFixture();
    const computer = await createComputer(
      {
        kind: "cua",
        socketPath: "fixture.sock",
        screenshotDir: "screenshots",
        grounding: "dom-catalog-v1",
        managedBrowserUrl: "https://example.test/path?secret=hidden",
      },
      {
        createManagedBrowserHost: fixture.createHost,
        openCuaBootstrapSession: fixture.openBootstrap,
        importCuaComputer: async () => ({ CuaDriverComputer: fixture.Delegate }),
      },
    );
    const session = await computer.open({}, fixture.signal);
    expect(fixture.calls).toMatchObject({ bootstrapOpen: 1, hostConstruct: 1, hostStart: 1, delegateConstruct: 1, delegateOpen: 1, delegateWindowDeliveryMode: "foreground" });
    expect(fixture.createHost.mock.calls[0]?.[0].browser).toBe(defaultManagedBrowserKind());
    expect(fixture.createHost.mock.calls[0]?.[0]).not.toHaveProperty("registerStartupUrl");
    await computer.close(session);
    expect(fixture.calls).toMatchObject({ delegateClose: 1, hostClose: 1, bootstrapClose: 1 });
  });

  it("starts a desktop-screen Run with one exact Host-owned browser companion candidate", async () => {
    const fixture = managedFixture();
    const nativeScope = { pid: 456, windowId: 789 };
    const computer = await createComputer(
      {
        kind: "cua",
        socketPath: "fixture.sock",
        screenshotDir: "screenshots",
        grounding: "hybrid-catalog-v1",
        managedBrowserUrl: "about:blank",
        managedBrowserProfileMode: "persistent",
        managedBrowserProfileLabel: "default",
        managedBrowserProfileRoot: "C:\\HarnessOwned\\profiles",
        managedBrowserCompanion: true,
        windowSwitch: "opened-windows-v1",
        windowSwitchAllowedTargets: [nativeScope],
      },
      {
        createManagedBrowserHost: fixture.createHost,
        openCuaBootstrapSession: fixture.openBootstrap,
        importCuaComputer: async () => ({ CuaDriverComputer: fixture.Delegate }),
      },
    );
    const session = await computer.open({}, fixture.signal);

    expect(fixture.calls.hostOptions).toMatchObject({ profileMode: "persistent", profileLabel: "default", persistentProfileRoot: "C:\\HarnessOwned\\profiles" });
    expect(fixture.calls.delegateOptions).toMatchObject({
      browserTarget: managedTarget,
      windowSwitch: "opened-windows-v1",
      windowSwitchAllowedTargets: [nativeScope, managedTarget.windowTarget],
    });
    expect(fixture.calls.delegateOptions).not.toHaveProperty("windowTarget");
    expect(fixture.calls).toMatchObject({ hostStart: 1, delegateOpen: 1, hostClose: 0, bootstrapClose: 0 });

    await computer.close(session);
    expect(fixture.calls).toMatchObject({ delegateClose: 1, hostClose: 1, bootstrapClose: 1 });
  });

  it("rejects a companion with an empty Host target scope before opening the browser", async () => {
    const fixture = managedFixture();
    await expect(createComputer({
      kind: "cua",
      socketPath: "fixture.sock",
      screenshotDir: "screenshots",
      grounding: "hybrid-catalog-v1",
      managedBrowserUrl: "about:blank",
      managedBrowserCompanion: true,
      windowSwitch: "opened-windows-v1",
      windowSwitchAllowedTargets: [],
    }, {
      createManagedBrowserHost: fixture.createHost,
      openCuaBootstrapSession: fixture.openBootstrap,
      importCuaComputer: async () => ({ CuaDriverComputer: fixture.Delegate }),
    })).rejects.toThrow(/empty Host target scope/iu);
    expect(fixture.calls).toMatchObject({ bootstrapOpen: 0, hostConstruct: 0, hostStart: 0 });
  });

  it("rejects an empty scope for browser-initial window switching before opening the browser", async () => {
    const fixture = managedFixture();
    await expect(createComputer({
      kind: "cua",
      socketPath: "fixture.sock",
      screenshotDir: "screenshots",
      grounding: "hybrid-catalog-v1",
      managedBrowserUrl: "about:blank",
      windowSwitch: "opened-windows-v1",
      windowSwitchAllowedTargets: [],
    }, {
      createManagedBrowserHost: fixture.createHost,
      openCuaBootstrapSession: fixture.openBootstrap,
      importCuaComputer: async () => ({ CuaDriverComputer: fixture.Delegate }),
    })).rejects.toThrow(/empty Host target scope/iu);
    expect(fixture.calls).toMatchObject({ bootstrapOpen: 0, hostConstruct: 0, hostStart: 0 });
  });

  it("adds only the exact owned browser HWND to an explicit browser-initial Run scope", async () => {
    const fixture = managedFixture();
    const nativeScope = { pid: 456, windowId: 789 };
    const computer = await createComputer({
      kind: "cua",
      socketPath: "fixture.sock",
      screenshotDir: "screenshots",
      grounding: "hybrid-catalog-v1",
      managedBrowserUrl: "about:blank",
      windowSwitch: "opened-windows-v1",
      windowSwitchAllowedTargets: [nativeScope],
    }, {
      createManagedBrowserHost: fixture.createHost,
      openCuaBootstrapSession: fixture.openBootstrap,
      importCuaComputer: async () => ({ CuaDriverComputer: fixture.Delegate }),
    });
    const session = await computer.open({}, fixture.signal);

    expect(fixture.calls.delegateOptions).toMatchObject({
      windowTarget: managedTarget.windowTarget,
      windowSwitchAllowedTargets: [nativeScope, managedTarget.windowTarget],
    });
    expect(fixture.calls.delegateOptions).not.toHaveProperty("managedBrowserCompanion", true);
    await computer.close(session);
  });

  it("disposes a delegate whose open fails, then closes Host and bootstrap", async () => {
    const fixture = managedFixture({ failDelegateOpen: true });
    const computer = await createComputer(
      { kind: "cua", socketPath: "fixture.sock", screenshotDir: "screenshots", grounding: "hybrid-catalog-v1", managedBrowserUrl: "about:blank" },
      {
        createManagedBrowserHost: fixture.createHost,
        openCuaBootstrapSession: fixture.openBootstrap,
        importCuaComputer: async () => ({ CuaDriverComputer: fixture.Delegate }),
      },
    );

    await expect(computer.open({}, fixture.signal)).rejects.toThrow("fixture delegate open failed");
    expect(fixture.calls).toMatchObject({ delegateOpen: 1, delegateClose: 0, delegateDispose: 1, hostClose: 1, bootstrapClose: 1 });
  });

  it("preserves the original open failure and aggregates every cleanup failure", async () => {
    const fixture = managedFixture({
      failDelegateOpen: true,
      failDelegateDispose: true,
      failHostClose: true,
      failBootstrapClose: true,
    });
    const computer = await createComputer(
      { kind: "cua", socketPath: "fixture.sock", screenshotDir: "screenshots", grounding: "hybrid-catalog-v1", managedBrowserUrl: "about:blank" },
      {
        createManagedBrowserHost: fixture.createHost,
        openCuaBootstrapSession: fixture.openBootstrap,
        importCuaComputer: async () => ({ CuaDriverComputer: fixture.Delegate }),
      },
    );

    let caught: unknown;
    try { await computer.open({}, fixture.signal); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(AggregateError);
    const aggregate = caught as AggregateError;
    expect((aggregate.cause as Error).message).toBe("fixture delegate open failed");
    const messages = aggregate.errors.map((error) => error instanceof Error ? error.message : String(error));
    expect(messages).toContain("fixture delegate open failed");
    expect(messages).toContain("fixture delegate dispose failed");
    expect(messages).toContain("fixture host close failed");
    expect(messages).toContain("fixture bootstrap close failed");
    expect(fixture.calls).toMatchObject({ delegateDispose: 1, hostClose: 1, bootstrapClose: 1 });
  });

  it("attempts delegate, Host, and bootstrap once on close and propagates all failures", async () => {
    const fixture = managedFixture({ failDelegateClose: true, failHostClose: true, failBootstrapClose: true });
    const computer = await createComputer(
      { kind: "cua", socketPath: "fixture.sock", screenshotDir: "screenshots", grounding: "hybrid-catalog-v1", managedBrowserUrl: "about:blank" },
      {
        createManagedBrowserHost: fixture.createHost,
        openCuaBootstrapSession: fixture.openBootstrap,
        importCuaComputer: async () => ({ CuaDriverComputer: fixture.Delegate }),
      },
    );
    const session = await computer.open({}, fixture.signal);

    await expect(computer.close(session)).rejects.toMatchObject({ message: "managed browser Computer cleanup was not confirmed" });
    await expect(computer.dispose?.()).rejects.toBeInstanceOf(AggregateError);
    expect(fixture.calls).toMatchObject({ delegateClose: 1, delegateDispose: 0, hostClose: 1, bootstrapClose: 1 });
  });

  it.each(["process_exit_timeout", "profile_cleanup_failed", "profile_lock_release_failed"] as const)(
    "treats Host %s diagnostics as unresolved cleanup",
    async (diagnostic) => {
    const fixture = managedFixture({ cleanupDiagnosticOnClose: diagnostic });
    const computer = await createComputer(
      { kind: "cua", socketPath: "fixture.sock", screenshotDir: "screenshots", grounding: "hybrid-catalog-v1", managedBrowserUrl: "about:blank" },
      {
        createManagedBrowserHost: fixture.createHost,
        openCuaBootstrapSession: fixture.openBootstrap,
        importCuaComputer: async () => ({ CuaDriverComputer: fixture.Delegate }),
      },
    );
    const session = await computer.open({}, fixture.signal);

    let caught: unknown;
    try { await computer.close(session); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(AggregateError);
    expect((caught as AggregateError).errors.some((error) => error instanceof Error && error.message.includes(diagnostic))).toBe(true);
    expect(fixture.calls).toMatchObject({ delegateClose: 1, hostClose: 1, bootstrapClose: 1 });
  });

  it("forwards opt-in handoff methods while retaining the managed browser host until Run cleanup", async () => {
    const fixture = managedFixture();
    const computer = await createComputer(
      {
        kind: "cua",
        socketPath: "fixture.sock",
        screenshotDir: "screenshots",
        grounding: "hybrid-catalog-v1",
        managedBrowserUrl: "about:blank",
        windowSwitch: "opened-windows-v1",
      },
      {
        createManagedBrowserHost: fixture.createHost,
        openCuaBootstrapSession: fixture.openBootstrap,
        importCuaComputer: async () => ({ CuaDriverComputer: fixture.Delegate }),
      },
    );
    const preOpenList = computer.listWindows;
    expect(preOpenList).toBeDefined();
    await expect(async () => preOpenList!(managedSession, fixture.signal)).rejects.toThrow(/capability is unavailable/u);
    expect(fixture.calls.delegateListWindows).toBe(0);
    const browserSession = await computer.open({}, fixture.signal);
    const cachedDetector = computer.detectNewWindowHandoffCandidates;

    await expect(computer.listWindows?.(browserSession, fixture.signal)).resolves.toEqual(managedWindowInventory);
    await expect(computer.listWindowHandoffCandidates?.(browserSession, fixture.signal)).resolves.toEqual([nativeWindowCandidate]);
    await expect(computer.listNewWindowHandoffCandidates?.(browserSession, fixture.signal)).resolves.toEqual([nativeWindowCandidate]);
    await expect(computer.detectNewWindowHandoffCandidates?.(browserSession, fixture.signal)).resolves.toEqual([nativeWindowCandidate]);
    const nativeSession = await computer.handoffWindow?.(browserSession, nativeWindowCandidate, fixture.signal);
    expect(nativeSession).toBe(nativeSessionAfterHandoff);
    expect(fixture.calls).toMatchObject({
      delegateListWindows: 1,
      delegateListHandoffCandidates: 1,
      delegateListNewHandoffCandidates: 1,
      delegateDetectNewHandoffCandidates: 1,
      delegateHandoff: 1,
      hostClose: 0,
      bootstrapClose: 0,
      delegateClose: 0,
      delegateHandoffCandidate: nativeWindowCandidate,
    });

    await computer.close(nativeSession!);
    expect(computer.detectNewWindowHandoffCandidates).toBeUndefined();
    expect(computer.listWindows).toBeUndefined();
    await expect(async () => cachedDetector!(browserSession, fixture.signal)).rejects.toThrow(/capability is unavailable/u);
    expect(fixture.calls.delegateDetectNewHandoffCandidates).toBe(1);
    expect(fixture.calls).toMatchObject({
      delegateClose: 1,
      delegateCloseSessionId: nativeSessionAfterHandoff.id,
      hostClose: 1,
      bootstrapClose: 1,
    });
  });

  it("cleans bootstrap and host when managed startup or delegate open fails", async () => {
    const failedHost = managedFixture({ failStart: true });
    const failedComputer = await createComputer(
      { kind: "cua", socketPath: "fixture.sock", screenshotDir: "screenshots", grounding: "hybrid-catalog-v1", managedBrowserUrl: "http://example.test" },
      { createManagedBrowserHost: failedHost.createHost, openCuaBootstrapSession: failedHost.openBootstrap, importCuaComputer: async () => ({ CuaDriverComputer: failedHost.Delegate }) },
    );
    await expect(failedComputer.open({}, failedHost.signal)).rejects.toThrow(/fixture host start failed/iu);
    expect(failedHost.calls).toMatchObject({ hostClose: 1, bootstrapClose: 1 });

    const aborted = new AbortController();
    aborted.abort(new Error("fixture abort"));
    const failedDelegate = managedFixture({ abortDelegateOpen: true });
    const abortedComputer = await createComputer(
      { kind: "cua", socketPath: "fixture.sock", screenshotDir: "screenshots", grounding: "dom-catalog-v1", managedBrowserUrl: "http://example.test" },
      { createManagedBrowserHost: failedDelegate.createHost, openCuaBootstrapSession: failedDelegate.openBootstrap, importCuaComputer: async () => ({ CuaDriverComputer: failedDelegate.Delegate }) },
    );
    await expect(abortedComputer.open({}, aborted.signal)).rejects.toThrow();
    expect(failedDelegate.calls).toMatchObject({ hostClose: 1, bootstrapClose: 1 });
  });
});
