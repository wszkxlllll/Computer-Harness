import { createInterface } from "node:readline";
import { defaultManagedBrowserKind } from "@computer-harness/computer-cua";
import type { CuaBootstrapSession, ManagedBrowserHost, ManagedBrowserHostOptions, ManagedBrowserWindowBindingHint, ManagedBrowserWindowResolution } from "@computer-harness/computer-cua";

export type ManagedBrowserPreparationBootstrap = CuaBootstrapSession;
export type ManagedBrowserPreparationHost = ManagedBrowserHost;
export type ManagedBrowserPreparationHostOptions = ManagedBrowserHostOptions;
export type ManagedBrowserPreparationWindowHint = ManagedBrowserWindowBindingHint;
export type ManagedBrowserPreparationWindowResolution = ManagedBrowserWindowResolution;
export type ManagedBrowserPreparationCleanupDiagnostic = Parameters<NonNullable<ManagedBrowserHostOptions["onCleanupDiagnostic"]>>[0];

export interface ManagedBrowserPreparationCuaModule {
  readonly openCuaBootstrapSession: typeof import("@computer-harness/computer-cua").openCuaBootstrapSession;
  readonly ManagedBrowserHost: typeof import("@computer-harness/computer-cua").ManagedBrowserHost;
  readonly resolveOwnedManagedBrowserWindow: typeof import("@computer-harness/computer-cua").resolveOwnedManagedBrowserWindow;
}

async function loadCuaModule(): Promise<ManagedBrowserPreparationCuaModule> {
  return await import("@computer-harness/computer-cua");
}

export interface ManagedBrowserPreparationOptions {
  readonly socketPath: string;
  readonly managedBrowserUrl: string;
  readonly profileLabel: string;
  readonly persistentProfileRoot: string;
  readonly signal?: AbortSignal;
}

export interface ManagedBrowserPreparationReady {
  readonly profileLabel: string;
  readonly urlHost: string;
}

export interface ManagedBrowserPreparationResult {
  readonly outcome: "enter" | "interrupt";
  /** Host-local diagnostics; no URL, profile path, or credential is included. */
  readonly cleanupDiagnostics: readonly ManagedBrowserPreparationCleanupDiagnostic[];
  /** Cleanup must prove this before the command claims that the profile was retained. */
  readonly profileRetention: "confirmed" | "unknown";
}

export interface ManagedBrowserPreparationDependencies {
  readonly loadCua?: () => Promise<ManagedBrowserPreparationCuaModule>;
  readonly openBootstrap?: ManagedBrowserPreparationCuaModule["openCuaBootstrapSession"];
  readonly createHost?: (options: ManagedBrowserPreparationHostOptions) => ManagedBrowserPreparationHost;
  readonly resolveOwnedWindow?: ManagedBrowserPreparationCuaModule["resolveOwnedManagedBrowserWindow"];
  readonly waitForContinue?: (signal: AbortSignal) => Promise<"enter" | "interrupt">;
  readonly onReady?: (ready: ManagedBrowserPreparationReady) => void;
}

/**
 * Opens only the managed bootstrap session and visible browser host. It does
 * not construct a Computer, Provider, screenshot path, or action session.
 */
export async function prepareManagedBrowserProfile(
  options: ManagedBrowserPreparationOptions,
  dependencies: ManagedBrowserPreparationDependencies = {},
): Promise<ManagedBrowserPreparationResult> {
  const signal = options.signal ?? new AbortController().signal;
  let cuaModule: ManagedBrowserPreparationCuaModule | undefined;
  const load = async (): Promise<ManagedBrowserPreparationCuaModule> => cuaModule ??= await (dependencies.loadCua ?? loadCuaModule)();
  const openBootstrap = dependencies.openBootstrap ?? (await load()).openCuaBootstrapSession;
  const resolveOwnedWindow = dependencies.resolveOwnedWindow ?? (await load()).resolveOwnedManagedBrowserWindow;
  let createHost: (hostOptions: ManagedBrowserPreparationHostOptions) => ManagedBrowserPreparationHost;
  if (dependencies.createHost !== undefined) createHost = dependencies.createHost;
  else {
    const module = await load();
    createHost = (hostOptions) => new module.ManagedBrowserHost(hostOptions);
  }
  const label = `computer-harness-managed-login-${Date.now()}`;
  let bootstrap: ManagedBrowserPreparationBootstrap | undefined;
  let host: ManagedBrowserPreparationHost | undefined;
  const cleanupDiagnostics: ManagedBrowserPreparationCleanupDiagnostic[] = [];
  let outcome: "enter" | "interrupt" | undefined;
  let operationError: unknown;
  const cleanupErrors: unknown[] = [];
  try {
    bootstrap = await openBootstrap(options.socketPath, label, signal);
    const bootstrapSession = bootstrap;
    host = createHost({
      browser: defaultManagedBrowserKind(),
      url: options.managedBrowserUrl,
      profileMode: "persistent",
      profileLabel: options.profileLabel,
      persistentProfileRoot: options.persistentProfileRoot,
      registerStartupUrl: true,
      onCleanupDiagnostic: (kind) => cleanupDiagnostics.push(kind),
      resolveOwnedWindowTarget: (browserProcessId, resolverSignal, hint) => resolveOwnedWindow(bootstrapSession.driver, bootstrapSession.label, browserProcessId, resolverSignal, hint),
    });
    await host.start(signal);
    dependencies.onReady?.({ profileLabel: options.profileLabel, urlHost: new URL(options.managedBrowserUrl).host });
    outcome = await (dependencies.waitForContinue ?? ((waitSignal) => waitForManagedBrowserPreparationContinue(waitSignal)))(signal);
  } catch (error) {
    operationError = error;
  }
  if (host !== undefined) {
    try {
      await host.close();
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (bootstrap !== undefined) {
    try {
      await bootstrap.close();
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (operationError !== undefined || cleanupErrors.length > 0) {
    const failures = operationError === undefined ? cleanupErrors : [operationError, ...cleanupErrors];
    if (failures.length === 1) throw failures[0];
    throw new AggregateError(failures, "managed browser preparation and cleanup failed");
  }
  if (outcome === undefined) throw new Error("managed browser preparation finished without an outcome");
  return {
    outcome,
    cleanupDiagnostics,
    profileRetention: cleanupDiagnostics.length === 0 ? "confirmed" : "unknown",
  };
}

export function waitForManagedBrowserPreparationContinue(
  signal: AbortSignal,
  input: NodeJS.ReadableStream = process.stdin,
): Promise<"enter" | "interrupt"> {
  const readline = createInterface({ input, crlfDelay: Infinity });
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: "enter" | "interrupt") => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      readline.removeListener("line", onLine);
      readline.removeListener("SIGINT", onSigint);
      input.removeListener("close", onClose);
      readline.close();
      resolve(result);
    };
    const onLine = () => finish("enter");
    const onSigint = () => finish("interrupt");
    const onClose = () => finish("interrupt");
    const onAbort = () => finish("interrupt");
    readline.once("line", onLine);
    readline.once("SIGINT", onSigint);
    input.once("close", onClose);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
