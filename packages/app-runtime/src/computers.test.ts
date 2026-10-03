import { describe, expect, it, vi } from "vitest";
import { createDefaultToolRegistry, type Computer } from "@computer-harness/runtime";
import type { ComputerSessionDescriptor, ComputerWindowCandidate, ComputerWindowOption } from "@computer-harness/protocol";
import type { DomGroundingTransport, ManagedBrowserHost, ManagedBrowserHostOptions, ManagedBrowserTarget, CuaBootstrapSession } from "@computer-harness/computer-cua";
import { createComputer, prepareComputerRunAssembly } from "./computers.js";

const managedTarget: ManagedBrowserTarget = {
  kind: "managed-chromium",
  browser: "edge",
  profileId: "managed-test",
  windowTarget: { pid: 321, windowId: 654 },
  tabId: "tab-test",
  generation: "generation-test",
  delivery: "loopback-cdp",
};

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
    expect(managed.enabledToolNames(managedRegistry)).toEqual(expect.arrayContaining(["click", "wait", "type", "click_element", "select_option"]));
    expect(managed.enabledToolNames(managedRegistry)).not.toContain("unverified_computer_tool");

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
  failStart?: boolean;
  abortDelegateOpen?: boolean;
  failDelegateOpen?: boolean;
  failDelegateDispose?: boolean;
  failDelegateClose?: boolean;
  failHostClose?: boolean;
  failBootstrapClose?: boolean;
  cleanupDiagnosticOnClose?: Parameters<NonNullable<ManagedBrowserHostOptions["onCleanupDiagnostic"]>>[0];
} = {}) {
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
    public async observe() { throw new Error("not used"); }
    public async execute() { throw new Error("not used"); }
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
    public async detectNewWindowHandoffCandidates() { calls.delegateDetectNewHandoffCandidates += 1; return [nativeWindowCandidate]; }
    public async handoffWindow(_session: ComputerSessionDescriptor, candidate: ComputerWindowCandidate) {
      calls.delegateHandoff += 1;
      calls.delegateHandoffCandidate = structuredClone(candidate);
      return nativeSessionAfterHandoff;
    }
  }
  return { calls, createHost, openBootstrap, Delegate, signal: new AbortController().signal };
}

describe("createComputer", () => {
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
    const browserSession = await computer.open({}, fixture.signal);

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
