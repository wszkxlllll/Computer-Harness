import { describe, expect, it, vi } from "vitest";
import { defaultManagedBrowserKind, type CuaBootstrapSession } from "@computer-harness/computer-cua";
import { prepareManagedBrowserProfile, type ManagedBrowserPreparationCuaModule, type ManagedBrowserPreparationHost, type ManagedBrowserPreparationHostOptions } from "./managed-browser-prepare.js";

describe("managed browser preparation seam", () => {
  it("keeps preparation host-only and closes bootstrap/host after the wait seam", async () => {
    const calls = { bootstrapOpen: 0, bootstrapClose: 0, hostStart: 0, hostClose: 0 };
    const bootstrap: CuaBootstrapSession = { driver: {} as CuaBootstrapSession["driver"], label: "bootstrap", async close() { calls.bootstrapClose += 1; } };
    const openBootstrap = vi.fn(async () => { calls.bootstrapOpen += 1; return bootstrap; });
    const host = {
      async start() {
        calls.hostStart += 1;
        return {};
      },
      async close() { calls.hostClose += 1; },
    } as ManagedBrowserPreparationHost;
    const createHost = vi.fn((options: ManagedBrowserPreparationHostOptions) => {
      expect(options.browser).toBe(defaultManagedBrowserKind());
      expect(options.registerStartupUrl).toBe(true);
      return host;
    });
    const resolveOwnedWindow = vi.fn(async (_driver: unknown, _session: string, _pid: number, _signal: AbortSignal) => undefined);
    const loadCua = vi.fn(async () => { throw new Error("dynamic CUA loader must not run with injected seams"); }) as unknown as () => Promise<ManagedBrowserPreparationCuaModule>;
    const onReady = vi.fn();
    await expect(prepareManagedBrowserProfile({
      socketPath: "fixture.sock",
      managedBrowserUrl: "https://example.test/path?hidden=query",
      profileLabel: "fixture",
      persistentProfileRoot: "C:\\HarnessOwned\\profiles",
    }, {
      openBootstrap,
      createHost,
      resolveOwnedWindow,
      loadCua,
      waitForContinue: async () => "enter",
      onReady,
    })).resolves.toMatchObject({ outcome: "enter", cleanupDiagnostics: [], profileRetention: "confirmed" });
    expect(calls).toEqual({ bootstrapOpen: 1, bootstrapClose: 1, hostStart: 1, hostClose: 1 });
    expect(onReady).toHaveBeenCalledWith({ profileLabel: "fixture", urlHost: "example.test" });
    expect(JSON.stringify(onReady.mock.calls)).not.toContain("hidden=query");
    expect(loadCua).not.toHaveBeenCalled();
  });

  it("never registers about:blank as a startup URL", async () => {
    const bootstrap: CuaBootstrapSession = { driver: {} as CuaBootstrapSession["driver"], label: "bootstrap", async close() {} };
    const host = { async start() { return {}; }, async close() {} } as ManagedBrowserPreparationHost;
    const createHost = vi.fn((options: ManagedBrowserPreparationHostOptions) => {
      expect(options.url).toBe("about:blank");
      expect(options.registerStartupUrl).toBe(false);
      return host;
    });
    await prepareManagedBrowserProfile({
      socketPath: "fixture.sock",
      managedBrowserUrl: "about:blank",
      profileLabel: "fixture",
      persistentProfileRoot: "C:\\HarnessOwned\\profiles",
    }, {
      openBootstrap: async () => bootstrap,
      createHost,
      resolveOwnedWindow: async () => undefined,
      waitForContinue: async () => "enter",
    });
    expect(createHost).toHaveBeenCalledOnce();
  });

  it("reports host cleanup diagnostics and does not claim retention when cleanup is unconfirmed", async () => {
    const calls = { bootstrapClose: 0, hostClose: 0 };
    const bootstrap: CuaBootstrapSession = { driver: {} as CuaBootstrapSession["driver"], label: "bootstrap", async close() { calls.bootstrapClose += 1; } };
    let reportDiagnostic: ((kind: Parameters<NonNullable<ManagedBrowserPreparationHostOptions["onCleanupDiagnostic"]>>[0]) => void) | undefined;
    const host = {
      async start() { return {}; },
      async close() { calls.hostClose += 1; },
    } as ManagedBrowserPreparationHost;
    const result = await prepareManagedBrowserProfile({
      socketPath: "fixture.sock",
      managedBrowserUrl: "https://example.test",
      profileLabel: "fixture",
      persistentProfileRoot: "C:\\HarnessOwned\\profiles",
    }, {
      openBootstrap: async () => bootstrap,
      createHost: (options) => {
        reportDiagnostic = options.onCleanupDiagnostic;
        return host;
      },
      resolveOwnedWindow: async () => undefined,
      waitForContinue: async () => {
        reportDiagnostic?.("process_exit_timeout");
        reportDiagnostic?.("profile_lock_release_failed");
        return "enter";
      },
    });
    expect(result).toEqual({
      outcome: "enter",
      cleanupDiagnostics: ["process_exit_timeout", "profile_lock_release_failed"],
      profileRetention: "unknown",
    });
    expect(calls).toEqual({ bootstrapClose: 1, hostClose: 1 });
  });

  it("propagates host close failure and still closes the bootstrap session", async () => {
    const bootstrapClose = vi.fn(async () => undefined);
    const bootstrap: CuaBootstrapSession = { driver: {} as CuaBootstrapSession["driver"], label: "bootstrap", close: bootstrapClose };
    const hostCloseError = new Error("host close failed");
    await expect(prepareManagedBrowserProfile({
      socketPath: "fixture.sock",
      managedBrowserUrl: "https://example.test",
      profileLabel: "fixture",
      persistentProfileRoot: "C:\\HarnessOwned\\profiles",
    }, {
      openBootstrap: async () => bootstrap,
      createHost: () => ({
        async start() { return {}; },
        async close() { throw hostCloseError; },
      } as ManagedBrowserPreparationHost),
      resolveOwnedWindow: async () => undefined,
      waitForContinue: async () => "interrupt",
    })).rejects.toMatchObject({
      name: "ManagedBrowserPreparationError",
      cleanup: "unknown",
      cause: hostCloseError,
    });
    expect(bootstrapClose).toHaveBeenCalledOnce();
  });

  it("propagates bootstrap close failure instead of claiming a retained profile", async () => {
    const bootstrapCloseError = new Error("bootstrap close failed");
    await expect(prepareManagedBrowserProfile({
      socketPath: "fixture.sock",
      managedBrowserUrl: "https://example.test",
      profileLabel: "fixture",
      persistentProfileRoot: "C:\\HarnessOwned\\profiles",
    }, {
      openBootstrap: async () => ({ driver: {} as CuaBootstrapSession["driver"], label: "bootstrap", close: async () => { throw bootstrapCloseError; } }),
      createHost: () => ({
        async start() { return {}; },
        async close() { /* successful host cleanup */ },
      } as ManagedBrowserPreparationHost),
      resolveOwnedWindow: async () => undefined,
      waitForContinue: async () => "enter",
    })).rejects.toMatchObject({
      name: "ManagedBrowserPreparationError",
      cleanup: "unknown",
      cause: bootstrapCloseError,
    });
  });

  it("allows a noncritical graceful-close diagnostic when cleanup otherwise completes", async () => {
    const bootstrap: CuaBootstrapSession = { driver: {} as CuaBootstrapSession["driver"], label: "bootstrap", async close() {} };
    const host = { async start() { return {}; }, async close() {} } as ManagedBrowserPreparationHost;
    let reportDiagnostic: ((kind: Parameters<NonNullable<ManagedBrowserPreparationHostOptions["onCleanupDiagnostic"]>>[0]) => void) | undefined;
    const result = await prepareManagedBrowserProfile({
      socketPath: "fixture.sock",
      managedBrowserUrl: "about:blank",
      profileLabel: "fixture",
      persistentProfileRoot: "C:\\HarnessOwned\\profiles",
    }, {
      openBootstrap: async () => bootstrap,
      createHost: (options) => {
        reportDiagnostic = options.onCleanupDiagnostic;
        return host;
      },
      resolveOwnedWindow: async () => undefined,
      waitForContinue: async () => {
        reportDiagnostic?.("graceful_close_failed");
        return "interrupt";
      },
    });
    expect(result).toEqual({
      outcome: "interrupt",
      cleanupDiagnostics: ["graceful_close_failed"],
      profileRetention: "confirmed",
    });
  });

  it("marks constructor failure cleanup confirmed when bootstrap close succeeds", async () => {
    const bootstrapClose = vi.fn(async () => undefined);
    await expect(prepareManagedBrowserProfile({
      socketPath: "fixture.sock",
      managedBrowserUrl: "about:blank",
      profileLabel: "fixture",
      persistentProfileRoot: "C:\\HarnessOwned\\profiles",
    }, {
      openBootstrap: async () => ({ driver: {} as CuaBootstrapSession["driver"], label: "bootstrap", close: bootstrapClose }),
      createHost: () => { throw new Error("constructor failed"); },
      resolveOwnedWindow: async () => undefined,
      waitForContinue: async () => "enter",
    })).rejects.toMatchObject({
      name: "ManagedBrowserPreparationError",
      cleanup: "confirmed",
    });
    expect(bootstrapClose).toHaveBeenCalledOnce();
  });

  it("marks startup failure cleanup confirmed after host and bootstrap close", async () => {
    const bootstrapClose = vi.fn(async () => undefined);
    const hostClose = vi.fn(async () => undefined);
    await expect(prepareManagedBrowserProfile({
      socketPath: "fixture.sock",
      managedBrowserUrl: "about:blank",
      profileLabel: "fixture",
      persistentProfileRoot: "C:\\HarnessOwned\\profiles",
    }, {
      openBootstrap: async () => ({ driver: {} as CuaBootstrapSession["driver"], label: "bootstrap", close: bootstrapClose }),
      createHost: () => ({
        async start() { throw new Error("startup failed"); },
        close: hostClose,
      } as ManagedBrowserPreparationHost),
      resolveOwnedWindow: async () => undefined,
      waitForContinue: async () => "enter",
    })).rejects.toMatchObject({
      name: "ManagedBrowserPreparationError",
      cleanup: "confirmed",
    });
    expect(hostClose).toHaveBeenCalledOnce();
    expect(bootstrapClose).toHaveBeenCalledOnce();
  });

  it("preserves uncertain cleanup from a partially started bootstrap session", async () => {
    const bootstrapError = Object.assign(new Error("bootstrap start was ambiguous"), { cleanupCertainty: "unknown" as const });
    await expect(prepareManagedBrowserProfile({
      socketPath: "fixture.sock",
      managedBrowserUrl: "about:blank",
      profileLabel: "fixture",
      persistentProfileRoot: "C:\\HarnessOwned\\profiles",
    }, {
      openBootstrap: async () => { throw bootstrapError; },
      createHost: () => { throw new Error("host must not be created"); },
      resolveOwnedWindow: async () => undefined,
      waitForContinue: async () => "enter",
    })).rejects.toMatchObject({
      name: "ManagedBrowserPreparationError",
      cleanup: "unknown",
    });
  });

  it("treats a custom bootstrap opener error without explicit cleanup certainty as unknown", async () => {
    await expect(prepareManagedBrowserProfile({
      socketPath: "fixture.sock",
      managedBrowserUrl: "about:blank",
      profileLabel: "fixture",
      persistentProfileRoot: "C:\\HarnessOwned\\profiles",
    }, {
      openBootstrap: async () => { throw new Error("custom opener failed"); },
      createHost: () => { throw new Error("host must not be created"); },
      resolveOwnedWindow: async () => undefined,
      waitForContinue: async () => "enter",
    })).rejects.toMatchObject({
      name: "ManagedBrowserPreparationError",
      cleanup: "unknown",
    });
  });

  it("accepts an explicit confirmed cleanup result from a custom bootstrap opener", async () => {
    const bootstrapError = Object.assign(new Error("custom opener failed after confirmed cleanup"), { cleanupCertainty: "confirmed" as const });
    await expect(prepareManagedBrowserProfile({
      socketPath: "fixture.sock",
      managedBrowserUrl: "about:blank",
      profileLabel: "fixture",
      persistentProfileRoot: "C:\\HarnessOwned\\profiles",
    }, {
      openBootstrap: async () => { throw bootstrapError; },
      createHost: () => { throw new Error("host must not be created"); },
      resolveOwnedWindow: async () => undefined,
      waitForContinue: async () => "enter",
    })).rejects.toMatchObject({
      name: "ManagedBrowserPreparationError",
      cleanup: "confirmed",
    });
  });
});
