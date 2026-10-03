import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { CuaBootstrapSession, ManagedBrowserProfileInspection } from "@computer-harness/computer-cua";
import { CuaBootstrapSessionError, ManagedBrowserHost, type ManagedBrowserHostOptions } from "../../../packages/computer-cua/src/managed-browser-host.js";
import {
  ApplicationSession,
  InProcessEnvironmentOwner,
  environmentIdentityForConfig,
  type ApplicationSessionConfig,
  type ManagedBrowserPreparationHost,
  type ManagedBrowserPreparationHostOptions,
  ManagedBrowserPreparationError,
  prepareManagedBrowserProfile,
} from "@computer-harness/app-runtime";
import {
  ManagedBrowserProfileService,
  FileManagedBrowserProfileStateStore,
  type LoadedManagedBrowserProfilePersistedState,
  type ManagedBrowserProfilePersistedState,
  type ManagedBrowserProfileStateStore,
} from "./managed-browser-profile-service.js";

class MemoryStateStore implements ManagedBrowserProfileStateStore {
  public value: LoadedManagedBrowserProfilePersistedState | undefined;
  public readonly save = vi.fn(async (state: ManagedBrowserProfilePersistedState) => { this.value = { ...state }; });

  public async load(): Promise<LoadedManagedBrowserProfilePersistedState | undefined> {
    return this.value === undefined ? undefined : { ...this.value };
  }
}

function fixture(options: {
  readonly closeFailure?: Error;
  readonly bootstrapCloseFailure?: Error;
  readonly bootstrapOpenError?: Error;
  readonly store?: MemoryStateStore;
  readonly profileRoot?: string;
  readonly profileLabel?: string;
  readonly environmentOwner?: InProcessEnvironmentOwner;
  readonly environmentIdentity?: string;
  readonly profileDirectory?: "present" | "missing" | "unsafe";
  readonly useFilesystemProfileDirectory?: boolean;
  readonly hostConstructorFailures?: number;
  readonly hostStartFailures?: number;
} = {}) {
  const calls = { bootstrapOpen: 0, bootstrapClose: 0, hostStart: 0, hostClose: 0 };
  let inspection: ManagedBrowserProfileInspection = { state: "ready", markers: [] };
  let profileDirectory = options.profileDirectory ?? "present";
  let hostConstructorFailures = options.hostConstructorFailures ?? 0;
  let hostStartFailures = options.hostStartFailures ?? 0;
  const store = options.store ?? new MemoryStateStore();
  const environmentOwner = options.environmentOwner ?? new InProcessEnvironmentOwner();
  const environmentIdentity = options.environmentIdentity ?? environmentIdentityForConfig({
    kind: "cua",
    socketPath: "fixture.sock",
    screenshotDir: "fixture-screens",
    grounding: "off",
  });
  const profileRoot = options.profileRoot ?? join(tmpdir(), "HarnessOwned", "managed-browser-profiles");
  const profileLabel = options.profileLabel ?? "fixture";
  const bootstrap: CuaBootstrapSession = {
    driver: {} as CuaBootstrapSession["driver"],
    label: "fixture-bootstrap",
    async close() {
      calls.bootstrapClose += 1;
      if (options.bootstrapCloseFailure !== undefined) throw options.bootstrapCloseFailure;
    },
  };
  const host = {
    async start() { calls.hostStart += 1; },
    async close() {
      calls.hostClose += 1;
      if (options.closeFailure !== undefined) throw options.closeFailure;
    },
  } as ManagedBrowserPreparationHost;
  const service = new ManagedBrowserProfileService({
    socketPath: "fixture.sock",
    profileLabel,
    profileRoot,
    environmentOwner,
    environmentIdentity,
    store,
    inspectProfile: async () => inspection,
    ...(options.useFilesystemProfileDirectory ? {} : { inspectProfileDirectory: async () => profileDirectory }),
    preparationDependencies: {
      openBootstrap: async () => {
        calls.bootstrapOpen += 1;
        if (options.bootstrapOpenError !== undefined) throw options.bootstrapOpenError;
        return bootstrap;
      },
      createHost: (hostOptions: ManagedBrowserPreparationHostOptions) => {
        expect(hostOptions.browser).toBe(process.platform === "win32" ? "edge" : "chromium");
        expect(hostOptions.profileMode).toBe("persistent");
        expect(hostOptions.profileLabel).toBe(profileLabel);
        expect(hostOptions.persistentProfileRoot).toBe(profileRoot);
        expect(hostOptions.url).toBe("about:blank");
        expect(hostOptions.registerStartupUrl).toBe(false);
        if (hostConstructorFailures > 0) {
          hostConstructorFailures -= 1;
          throw new Error("injected host constructor failure");
        }
        return host;
      },
      ...(options.hostStartFailures === undefined ? {} : {
        createHost: (hostOptions: ManagedBrowserPreparationHostOptions) => {
          expect(hostOptions.browser).toBe(process.platform === "win32" ? "edge" : "chromium");
          expect(hostOptions.profileMode).toBe("persistent");
          expect(hostOptions.profileLabel).toBe(profileLabel);
          expect(hostOptions.persistentProfileRoot).toBe(profileRoot);
          expect(hostOptions.url).toBe("about:blank");
          expect(hostOptions.registerStartupUrl).toBe(false);
          return {
            async start() {
              calls.hostStart += 1;
              if (hostStartFailures > 0) {
                hostStartFailures -= 1;
                throw new Error("injected host startup failure");
              }
            },
            async close() {
              calls.hostClose += 1;
              if (options.closeFailure !== undefined) throw options.closeFailure;
            },
          } as ManagedBrowserPreparationHost;
        },
      }),
      resolveOwnedWindow: async () => undefined,
      loadCua: async () => { throw new Error("injected preparation seams must avoid the CUA loader"); },
    },
  });
  return {
    service,
    store,
    calls,
    environmentOwner,
    environmentIdentity,
    profileRoot,
    profileLabel,
    setHostConstructorFailures: (value: number) => { hostConstructorFailures = value; },
    setInspection: (value: ManagedBrowserProfileInspection) => { inspection = value; },
    setProfileDirectory: (value: "present" | "missing" | "unsafe") => { profileDirectory = value; },
  };
}

function appSessionConfig(outputDir: string): ApplicationSessionConfig {
  return {
    model: "glm-5.3-flash",
    computer: { kind: "cua", socketPath: "fixture.sock", screenshotDir: join(outputDir, "screens"), grounding: "off" },
    outputDir,
    maxSteps: 1,
    maxModelRequests: 1,
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

describe("managed browser profile service", () => {
  it("atomically stores only the local mode preference and user-confirmed readiness marker", async () => {
    const directory = await mkdtemp(join(tmpdir(), "harness-managed-profile-state-"));
    const filePath = join(directory, "state.json");
    try {
      const store = new FileManagedBrowserProfileStateStore(filePath);
      const persisted = { version: 2 as const, profileIdentityHash: "a".repeat(64), defaultSession: "saved" as const, readyConfirmed: true };
      await store.save(persisted);
      expect(await store.load()).toEqual(persisted);
      expect(JSON.parse(await readFile(filePath, "utf8"))).toEqual(persisted);
      expect(await readdir(directory)).toEqual(["state.json"]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("returns from prepare promptly, holds the visible host until complete, and persists only confirmed readiness", async () => {
    const rig = fixture();
    const initial = await rig.service.getState();
    expect(initial).toMatchObject({ status: "unprepared", defaultSession: "saved" });

    const preparation = await rig.service.prepare();
    expect(preparation.status).toBe("preparing");
    expect(preparation.operationId).toMatch(/^[0-9a-f-]{36}$/iu);
    expect(rig.store.value?.readyConfirmed).toBe(false);
    expect(JSON.stringify(preparation)).not.toContain("fixture");
    expect(JSON.stringify(preparation)).not.toContain("HarnessOwned");

    const repeated = await rig.service.prepare();
    expect(repeated.operationId).toBe(preparation.operationId);
    expect(rig.calls.hostClose).toBe(0);

    const completed = await rig.service.complete(preparation.operationId);
    expect(completed).toMatchObject({ status: "ready", defaultSession: "saved" });
    expect(completed.operationId).toBeUndefined();
    expect(rig.calls).toEqual({ bootstrapOpen: 1, bootstrapClose: 1, hostStart: 1, hostClose: 1 });
    expect(rig.store.value).toMatchObject({ version: 2, defaultSession: "saved", readyConfirmed: true });
    expect(rig.store.value?.profileIdentityHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(rig.environmentOwner.inspect(rig.environmentIdentity)).toBeUndefined();
    await expect(rig.service.complete(preparation.operationId)).resolves.toMatchObject({ status: "ready" });
  });

  it("persists the selected default across service restarts without treating profile existence as readiness", async () => {
    const store = new MemoryStateStore();
    const first = fixture({ store });
    await expect(first.service.getState()).resolves.toMatchObject({ status: "unprepared" });
    await first.service.setDefaultSession("temporary");
    expect(store.value).toMatchObject({ version: 2, defaultSession: "temporary", readyConfirmed: false });

    const restarted = fixture({ store });
    await expect(restarted.service.getState()).resolves.toMatchObject({ status: "unprepared", defaultSession: "temporary" });
    const preparation = await restarted.service.prepare();
    const result = await restarted.service.complete(preparation.operationId);
    expect(result).toMatchObject({ status: "ready", defaultSession: "temporary" });

    const afterRestart = fixture({ store });
    await expect(afterRestart.service.getState()).resolves.toMatchObject({ status: "ready", defaultSession: "temporary" });
  });

  it("relogin reopens the same persistent profile and clears confirmation until a clean complete", async () => {
    const rig = fixture();
    const initial = await rig.service.prepare();
    await rig.service.complete(initial.operationId);
    const relogin = await rig.service.relogin();
    expect(relogin.status).toBe("preparing");
    expect(rig.store.value?.readyConfirmed).toBe(false);
    expect(rig.calls.bootstrapOpen).toBe(2);
    expect(rig.calls.hostStart).toBe(2);
    expect(await rig.service.complete(relogin.operationId)).toMatchObject({ status: "ready" });
    expect(rig.store.value?.readyConfirmed).toBe(true);
  });

  it("fails closed on uncertain cleanup and never persists a false ready confirmation", async () => {
    const rig = fixture({ closeFailure: new Error("host close failed") });
    const preparation = await rig.service.prepare();
    await expect(rig.service.complete(preparation.operationId)).resolves.toMatchObject({ status: "cleanup_failed" });
    expect(rig.store.value).toMatchObject({ version: 2, defaultSession: "saved", readyConfirmed: false });
    expect(rig.environmentOwner.inspect(rig.environmentIdentity)).toMatchObject({ state: "pending_cleanup" });
    await expect(rig.service.prepare()).rejects.toMatchObject({ code: "PROFILE_STATE_UNAVAILABLE" });
  });

  it.each([
    ["constructor", { hostConstructorFailures: 1 }],
    ["startup", { hostStartFailures: 1 }],
  ] as const)("releases the desktop lease and allows retry after confirmed %s failure", async (_kind, failure) => {
    const rig = fixture(failure);
    const first = await rig.service.prepare();
    expect(first.status).toBe("preparing");
    await waitForPreparationStatus(rig.service, "unprepared");
    expect(rig.environmentOwner.inspect(rig.environmentIdentity)).toBeUndefined();
    expect(rig.store.value).toMatchObject({ version: 2, defaultSession: "saved", readyConfirmed: false });

    const retry = await rig.service.prepare();
    expect(retry.status).toBe("preparing");
    await expect(rig.service.complete(retry.operationId)).resolves.toMatchObject({ status: "ready" });
    expect(rig.environmentOwner.inspect(rig.environmentIdentity)).toBeUndefined();
    expect(rig.calls.hostStart).toBe(_kind === "constructor" ? 1 : 2);
  });

  it("requires relogin after a confirmed relogin preparation failure", async () => {
    const rig = fixture();
    const initial = await rig.service.prepare();
    await rig.service.complete(initial.operationId);
    rig.setHostConstructorFailures(1);

    const relogin = await rig.service.relogin();
    await waitForPreparationStatus(rig.service, "relogin_required");
    expect(rig.environmentOwner.inspect(rig.environmentIdentity)).toBeUndefined();
    expect(rig.store.value).toMatchObject({ version: 2, defaultSession: "saved", readyConfirmed: false });
    expect(relogin.status).toBe("preparing");
  });

  it("keeps the desktop lease when constructor failure cleanup is unknown", async () => {
    const rig = fixture({ hostConstructorFailures: 1, bootstrapCloseFailure: new Error("private cleanup detail") });
    const preparation = await rig.service.prepare();
    await waitForPreparationStatus(rig.service, "cleanup_failed");
    expect(rig.environmentOwner.inspect(rig.environmentIdentity)).toMatchObject({ state: "pending_cleanup" });
    await expect(rig.service.prepare()).rejects.toMatchObject({ code: "PROFILE_STATE_UNAVAILABLE" });
    expect(JSON.stringify(await rig.service.getState())).not.toContain("private cleanup detail");
    expect(preparation.status).toBe("preparing");
  });

  it("keeps the Host lease for the real bootstrap driver's uncertain startup cleanup contract", async () => {
    const bootstrapError = new CuaBootstrapSessionError("unknown", new Error("partial start could not be confirmed closed"));
    const rig = fixture({ bootstrapOpenError: bootstrapError });
    const preparation = await rig.service.prepare();
    await waitForPreparationStatus(rig.service, "cleanup_failed");
    expect(rig.calls.hostStart).toBe(0);
    expect(rig.environmentOwner.inspect(rig.environmentIdentity)).toMatchObject({ state: "pending_cleanup" });
    expect(JSON.stringify(await rig.service.getState())).not.toContain("partial start");
    expect(preparation.status).toBe("preparing");
  });

  it("fails closed when a custom bootstrap opener rejects without explicit cleanup certainty", async () => {
    const rig = fixture({ bootstrapOpenError: new Error("custom bootstrap opener failed") });
    await rig.service.prepare();
    await waitForPreparationStatus(rig.service, "cleanup_failed");
    expect(rig.environmentOwner.inspect(rig.environmentIdentity)).toMatchObject({ state: "pending_cleanup" });
    expect(rig.calls.hostStart).toBe(0);
    expect(JSON.stringify(await rig.service.getState())).not.toContain("custom bootstrap opener failed");
  });

  it("propagates an actual CUA host critical cleanup diagnostic through preparation and holds the Host lease", async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "harness-managed-profile-real-host-failure-"));
    const profileRoot = join(temporaryRoot, "profiles");
    const environmentOwner = new InProcessEnvironmentOwner();
    const environmentIdentity = environmentIdentityForConfig({
      kind: "cua",
      socketPath: "fixture.sock",
      screenshotDir: "fixture-screens",
      grounding: "off",
    });
    const store = new MemoryStateStore();
    const child = Object.assign(new EventEmitter(), { pid: 654321, exitCode: null }) as ChildProcess;
    const bootstrap: CuaBootstrapSession = {
      driver: {} as CuaBootstrapSession["driver"],
      label: "fixture-bootstrap",
      async close() {},
    };
    const diagnostics: string[] = [];
    let preparationError: unknown;
    const service = new ManagedBrowserProfileService({
      socketPath: "fixture.sock",
      profileLabel: "fixture",
      profileRoot,
      environmentOwner,
      environmentIdentity,
      store,
      inspectProfile: async () => ({ state: "ready", markers: [] }),
      inspectProfileDirectory: async () => "missing",
      prepareProfile: async (options, dependencies) => {
        try {
          return await prepareManagedBrowserProfile(options, dependencies);
        } catch (error) {
          preparationError = error;
          throw error;
        }
      },
      preparationDependencies: {
        openBootstrap: async () => bootstrap,
        resolveOwnedWindow: async () => undefined,
        createHost: (options: ManagedBrowserHostOptions) => {
          const reportDiagnostic = options.onCleanupDiagnostic;
          return new ManagedBrowserHost({
            ...options,
            executablePath: process.execPath,
            startupTimeoutMs: 1,
            resolveOwnedWindowTarget: async () => undefined,
            spawnManagedBrowser: () => child,
            cleanupHooks: {
              waitForProcessTree: async () => false,
              forceTerminate: async () => undefined,
            },
            onCleanupDiagnostic: (kind) => {
              diagnostics.push(kind);
              reportDiagnostic?.(kind);
            },
          });
        },
      },
    });

    try {
      const preparation = await service.prepare();
      expect(preparation.status).toBe("preparing");
      await waitForPreparationStatus(service, "cleanup_failed");
      expect(diagnostics).toContain("process_exit_timeout");
      expect(preparationError).toBeInstanceOf(ManagedBrowserPreparationError);
      expect(preparationError).toMatchObject({ cleanup: "unknown" });
      expect(environmentOwner.inspect(environmentIdentity)).toMatchObject({ state: "pending_cleanup" });
      expect(JSON.stringify(await service.getState())).not.toContain(temporaryRoot);
    } finally {
      await service.close();
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("reserves a confirmed saved profile for one Run and releases it after cleanup", async () => {
    const rig = fixture();
    const preparation = await rig.service.prepare();
    await rig.service.complete(preparation.operationId);
    const release = await rig.service.acquireForRun();
    await expect(rig.service.getState()).resolves.toMatchObject({ status: "in_use" });
    await expect(rig.service.prepare()).rejects.toMatchObject({ code: "PREPARE_BUSY" });
    await release();
    await expect(rig.service.getState()).resolves.toMatchObject({ status: "ready" });
  });

  it("takes the same desktop owner used by ApplicationSession before opening any browser resource", async () => {
    const rig = fixture();
    const outputDir = await mkdtemp(join(tmpdir(), "harness-profile-owner-run-first-"));
    let announceFactory!: () => void;
    let releaseFactory!: () => void;
    const enteredFactory = new Promise<void>((resolveEntered) => { announceFactory = resolveEntered; });
    const factoryGate = new Promise<void>((resolveGate) => { releaseFactory = resolveGate; });
    const createRun = vi.fn(async () => {
      announceFactory();
      await factoryGate;
      throw new Error("fixture Run ends before resource creation");
    });
    const session = new ApplicationSession({
      config: appSessionConfig(outputDir),
      owner: rig.environmentOwner,
      createRun,
    });
    try {
      const pendingStart = session.startRun("fake Run owns the desktop");
      await enteredFactory;
      expect(rig.environmentOwner.inspect(rig.environmentIdentity)).toMatchObject({ state: "active" });
      await expect(rig.service.prepare()).rejects.toMatchObject({ code: "PREPARE_BUSY" });
      expect(rig.calls.bootstrapOpen).toBe(0);
      expect(rig.calls.hostStart).toBe(0);
      expect(rig.environmentOwner.inspect(rig.environmentIdentity)).toMatchObject({ state: "active" });
      releaseFactory();
      await expect(pendingStart).rejects.toThrow("fixture Run ends before resource creation");
      expect(rig.environmentOwner.inspect(rig.environmentIdentity)).toBeUndefined();
    } finally {
      releaseFactory();
      await session.close();
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("blocks an ApplicationSession Run while the same owner is leased by visible profile setup", async () => {
    const rig = fixture();
    const outputDir = await mkdtemp(join(tmpdir(), "harness-profile-owner-prepare-first-"));
    const createRun = vi.fn(async () => { throw new Error("Run factory must not be reached while profile setup owns the desktop"); });
    const session = new ApplicationSession({
      config: appSessionConfig(outputDir),
      owner: rig.environmentOwner,
      createRun,
    });
    try {
      const preparation = await rig.service.prepare();
      expect(preparation.status).toBe("preparing");
      expect(rig.environmentOwner.inspect(rig.environmentIdentity)).toMatchObject({ state: "active" });
      await expect(session.startRun("fake Run must wait until profile setup closes")).rejects.toThrow(/owned by run managed-browser-profile-/u);
      expect(createRun).not.toHaveBeenCalled();
      expect(rig.calls.hostStart).toBe(1);
      await expect(rig.service.complete(preparation.operationId)).resolves.toMatchObject({ status: "ready" });
      expect(rig.environmentOwner.inspect(rig.environmentIdentity)).toBeUndefined();
    } finally {
      const state = await rig.service.getState();
      if (state.status === "preparing" && state.operationId !== undefined) await rig.service.complete(state.operationId);
      await session.close();
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("reconciles active or uncertain profile locks instead of opening another browser", async () => {
    const active = fixture();
    active.setInspection({ state: "active", markers: ["profile_lock"] });
    await expect(active.service.getState()).resolves.toMatchObject({ status: "in_use" });
      await expect(active.service.prepare()).rejects.toMatchObject({ code: "PREPARE_BUSY" });

    const stale = fixture();
    stale.setInspection({ state: "stale", markers: ["profile_lock"] });
    await expect(stale.service.getState()).resolves.toMatchObject({ status: "cleanup_failed" });
    await expect(stale.service.relogin()).rejects.toMatchObject({ code: "PROFILE_STATE_UNAVAILABLE" });
  });

  it("invalidates readiness when the configured profile label or root changes", async () => {
    const sameRootStore = new MemoryStateStore();
    const first = fixture({ store: sameRootStore });
    const preparation = await first.service.prepare();
    await first.service.complete(preparation.operationId);
    expect(sameRootStore.value?.readyConfirmed).toBe(true);
    const originalLabelIdentityHash = sameRootStore.value?.profileIdentityHash;

    const changedLabel = fixture({ store: sameRootStore, profileLabel: "renamed" });
    await expect(changedLabel.service.getState()).resolves.toMatchObject({ status: "unprepared", defaultSession: "saved" });
    expect(sameRootStore.value).toMatchObject({ version: 2, readyConfirmed: false });
    expect(sameRootStore.value?.profileIdentityHash).not.toBe(originalLabelIdentityHash);

    const changedRootStore = new MemoryStateStore();
    const originalRoot = fixture({ store: changedRootStore });
    const originalPreparation = await originalRoot.service.prepare();
    await originalRoot.service.complete(originalPreparation.operationId);
    const originalRootIdentityHash = changedRootStore.value?.profileIdentityHash;
    const changedRoot = fixture({ store: changedRootStore, profileRoot: join(tmpdir(), "HarnessOwned", "other-managed-browser-profiles") });
    await expect(changedRoot.service.getState()).resolves.toMatchObject({ status: "unprepared", defaultSession: "saved" });
    expect(changedRootStore.value).toMatchObject({ version: 2, readyConfirmed: false });
    expect(changedRootStore.value?.profileIdentityHash).not.toBe(originalRootIdentityHash);
  });

  it("clears persisted readiness if the profile directory is removed", async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "harness-managed-profile-directory-"));
    const profileRoot = join(temporaryRoot, "managed-browser-profiles");
    const profileDirectory = join(profileRoot, "fixture");
    await mkdir(profileDirectory, { recursive: true });
    const store = new MemoryStateStore();
    const rig = fixture({ store, profileRoot, useFilesystemProfileDirectory: true });
    try {
      const preparation = await rig.service.prepare();
      await expect(rig.service.complete(preparation.operationId)).resolves.toMatchObject({ status: "ready" });
      expect(store.value?.readyConfirmed).toBe(true);
      await rm(profileDirectory, { recursive: true, force: true });
      await expect(rig.service.getState()).resolves.toMatchObject({ status: "unprepared" });
      expect(store.value?.readyConfirmed).toBe(false);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("rejects stale completion generations", async () => {
    const rig = fixture();
    await expect(rig.service.complete("11111111-1111-1111-1111-111111111111"))
      .rejects.toMatchObject({ code: "PROFILE_OPERATION_STALE" });
  });
});

async function waitForPreparationStatus(
  service: ManagedBrowserProfileService,
  expected: "unprepared" | "relogin_required" | "cleanup_failed",
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const state = await service.getState();
    if (state.status === expected) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`managed browser preparation did not reach ${expected}`);
}
