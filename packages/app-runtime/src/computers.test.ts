import { describe, expect, it, vi } from "vitest";
import { createDefaultToolRegistry, type Computer } from "@computer-harness/runtime";
import type { ComputerSessionDescriptor } from "@computer-harness/protocol";
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

  it("rejects unsupported grounding before Computer or Run resources are created", () => {
    expect(() => prepareComputerRunAssembly({ kind: "osworld", bridgeUrl: "http://127.0.0.1:5000" }, "dom-catalog-v1"))
      .toThrow(/requires the CUA computer/iu);
    expect(() => prepareComputerRunAssembly({ kind: "cua", socketPath: "fixture.sock", screenshotDir: "screenshots" }, "uia-catalog-v1"))
      .toThrow(/explicit CUA window target/iu);
    expect(() => prepareComputerRunAssembly({ kind: "external", id: "mock" }, "uia-catalog-v1"))
      .toThrow(/external Computer/iu);
  });
});

function managedFixture(options: { failStart?: boolean; abortDelegateOpen?: boolean } = {}) {
  const calls: { bootstrapOpen: number; bootstrapClose: number; hostConstruct: number; hostStart: number; hostClose: number; delegateConstruct: number; delegateOpen: number; delegateClose: number; delegateWindowDeliveryMode?: unknown } = { bootstrapOpen: 0, bootstrapClose: 0, hostConstruct: 0, hostStart: 0, hostClose: 0, delegateConstruct: 0, delegateOpen: 0, delegateClose: 0 };
  const transport = {} as DomGroundingTransport;
  const host = {
    async start() {
      calls.hostStart += 1;
      if (options.failStart === true) throw new Error("fixture host start failed");
      return { target: managedTarget, processId: 321, profileId: managedTarget.profileId, tabId: managedTarget.tabId, generation: managedTarget.generation };
    },
    createTransport() { return transport; },
    async close() { calls.hostClose += 1; },
  } as unknown as ManagedBrowserHost;
  const createHost = vi.fn((_options: ManagedBrowserHostOptions) => {
    calls.hostConstruct += 1;
    return host;
  });
  const bootstrap: CuaBootstrapSession = {
    driver: {} as CuaBootstrapSession["driver"],
    label: "bootstrap-fixture",
    async close() { calls.bootstrapClose += 1; },
  };
  const openBootstrap = vi.fn(async () => {
    calls.bootstrapOpen += 1;
    return bootstrap;
  });
  class Delegate implements Computer {
    public constructor(options: Record<string, unknown>) { calls.delegateConstruct += 1; calls.delegateWindowDeliveryMode = options.windowDeliveryMode; }
    public async open(_options: unknown, signal: AbortSignal) {
      calls.delegateOpen += 1;
      if (options.abortDelegateOpen === true) signal.throwIfAborted();
      return managedSession;
    }
    public async observe() { throw new Error("not used"); }
    public async execute() { throw new Error("not used"); }
    public async close() { calls.delegateClose += 1; }
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
      { kind: "cua", socketPath: "fixture.sock", screenshotDir: "screenshots", windowTarget: { pid: 1234, windowId: 5678 } },
      { importCuaComputer: async () => ({ CuaDriverComputer: CapturingComputer as unknown as new (options: Record<string, unknown>) => Computer }) },
    );

    expect(received).toMatchObject({ socketPath: "fixture.sock", screenshotDir: "screenshots", windowTarget: { pid: 1234, windowId: 5678 } });
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
