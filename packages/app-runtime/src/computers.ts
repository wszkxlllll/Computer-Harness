import { CuaWindowDiscovery, ManagedBrowserHost, defaultManagedBrowserKind, formatManagedBrowserStartupDiagnostic, openCuaBootstrapSession, resolveOwnedManagedBrowserWindow, type CuaBootstrapSession, type CuaDriverComputerOptions, type CuaWindowTarget, type ManagedBrowserHostOptions, type ManagedBrowserWindowBindingHint, type WindowRelationshipProbe } from "@computer-harness/computer-cua";
import { OsworldBridgeClient, OsworldComputer } from "@computer-harness/computer-osworld";
import { groundingComputerTools, type Computer, type ComputerExecuteOptions, type ComputerOpenOptions, type ToolDefinition, type ToolRegistry } from "@computer-harness/runtime";
import type { ActionIntent, ActionReceipt, ComputerSessionDescriptor, ComputerWindowCandidate, ComputerWindowOption, ObservationCapture, ObservationId } from "@computer-harness/protocol";
import type { WindowTargetDiscovery } from "./application-session.js";
import { createWindowsWindowRelationshipProbe } from "./windows-window-relationship-probe.js";

export type ComputerBackendConfig =
  | {
      /** Adapter supplied by RunDependencies.createComputer. */
      kind: "external";
      id: string;
    }
  | {
      kind: "cua";
      socketPath: string;
      screenshotDir: string;
      /** Explicit host-only opt-in; omitted keeps primary desktop behavior. */
      windowTarget?: { pid: number; windowId: number };
      /** Explicit window action delivery; background never escalates. */
      windowDeliveryMode?: "background" | "foreground";
      /** Explicit per-Run permission to discover and switch among opened windows. */
      windowSwitch?: "off" | "opened-windows-v1";
      /** Host-only exact target allowlist; omitted permits the enumerated opened-window inventory. */
      windowSwitchAllowedTargets?: readonly CuaWindowTarget[];
      /** Resolved per-Run mode: include the Run-owned managed browser alongside the chosen initial binding. */
      managedBrowserCompanion?: boolean;
      /** Optional UIA/managed-browser grounding sidecar. */
      grounding?: "off" | "uia-catalog-v1" | "dom-catalog-v1" | "hybrid-catalog-v1";
      /** Explicit managed-browser URL; required for DOM/hybrid grounding. */
      managedBrowserUrl?: string;
      /** Harness-owned managed profile lifecycle; defaults to ephemeral. */
      managedBrowserProfileMode?: "ephemeral" | "persistent";
      /** Required bounded label for persistent managed profiles. */
      managedBrowserProfileLabel?: string;
      /** Private Harness-owned persistent profile root; never model/report data. */
      managedBrowserProfileRoot?: string;
    }
  | {
      kind: "osworld";
      bridgeUrl: string;
    };

/**
 * Per-Run policy owned by the application Computer assembly boundary.
 * Backend-specific grounding tools and model-visible tool limits stay beside
 * the backend configuration that requires them.
 */
export interface ComputerRunAssemblyPolicy {
  readonly config: ComputerBackendConfig;
  readonly groundingTools: readonly ToolDefinition[];
  enabledToolNames(registry: ToolRegistry): readonly string[] | undefined;
}

export function prepareComputerRunAssembly(
  config: ComputerBackendConfig,
  grounding: NonNullable<import("./config.js").ResolvedRunConfig["grounding"]>,
  windowSwitch: NonNullable<import("./config.js").ResolvedRunConfig["windowSwitch"]> = "off",
): ComputerRunAssemblyPolicy {
  const effectiveConfig = effectiveComputerConfig(config, grounding, windowSwitch);
  validateComputerGrounding(effectiveConfig, grounding);
  validateWindowSwitch(effectiveConfig, windowSwitch, grounding);

  const managedGrounding = grounding === "dom-catalog-v1" || grounding === "hybrid-catalog-v1";
  const windowScoped = effectiveConfig.kind === "cua" && (effectiveConfig.windowTarget !== undefined || managedGrounding);
  const groundingTools = grounding === "off"
    ? []
    : groundingComputerTools({ includeSelectOption: managedGrounding });

  return {
    config: effectiveConfig,
    groundingTools,
    enabledToolNames(registry) {
      if (!windowScoped || effectiveConfig.kind !== "cua") return undefined;
      // Single-target managed browsers only click through grounded elements.
      // Cross-window Runs retain the click candidate for desktop/native peers;
      // Runtime filters it again for the current browser Surface, including
      // when its DOM catalog is unavailable.
      const groundedClicksOnly = managedGrounding && windowSwitch === "off";
      const allowedComputerTools = new Set(groundedClicksOnly ? ["wait"] : ["click", "wait"]);
      if (effectiveConfig.windowDeliveryMode === "foreground") {
        allowedComputerTools.add("type");
        allowedComputerTools.add("keypress");
        allowedComputerTools.add("hotkey");
        allowedComputerTools.add("drag");
        allowedComputerTools.add("scroll");
      }
      if (grounding !== "off") allowedComputerTools.add("click_element");
      if (managedGrounding) allowedComputerTools.add("select_option");
      if (windowSwitch === "opened-windows-v1") allowedComputerTools.add("switch_window");
      return registry.list()
        .filter((definition) => definition.category !== "computer" || allowedComputerTools.has(definition.name))
        .map((definition) => definition.name);
    },
  };
}

function effectiveComputerConfig(
  computer: ComputerBackendConfig,
  grounding: NonNullable<import("./config.js").ResolvedRunConfig["grounding"]>,
  windowSwitch: NonNullable<import("./config.js").ResolvedRunConfig["windowSwitch"]>,
): ComputerBackendConfig {
  if (computer.kind !== "cua") return computer;
  const managedGrounding = grounding === "dom-catalog-v1" || grounding === "hybrid-catalog-v1";
  return {
    ...computer,
    grounding,
    windowSwitch,
    ...(managedGrounding || windowSwitch === "opened-windows-v1" ? { windowDeliveryMode: "foreground" as const } : {}),
  };
}

function validateWindowSwitch(
  config: ComputerBackendConfig,
  windowSwitch: NonNullable<import("./config.js").ResolvedRunConfig["windowSwitch"]>,
  grounding: NonNullable<import("./config.js").ResolvedRunConfig["grounding"]>,
): void {
  if (windowSwitch === "off") return;
  if (windowSwitch !== "opened-windows-v1") throw new Error("windowSwitch must be off or opened-windows-v1");
  if (config.kind !== "cua") throw new Error("windowSwitch opened-windows-v1 requires the CUA Computer");
  // An unbound CUA screen session is a supported starting mode too. Its
  // inventory is still host-scoped, and model switching binds to an exact
  // opened window before any targeted action is delivered.
  const managedGrounding = grounding === "dom-catalog-v1" || grounding === "hybrid-catalog-v1";
  if (config.managedBrowserCompanion === true && !managedGrounding) {
    throw new Error("managed browser companion requires hybrid DOM grounding");
  }
}

function validateComputerGrounding(
  config: ComputerBackendConfig,
  grounding: NonNullable<import("./config.js").ResolvedRunConfig["grounding"]>,
): void {
  if (grounding === "off") return;
  if (config.kind === "external") {
    throw new Error(`external Computer '${config.id}' does not use app-managed CUA/UIA/DOM grounding; set grounding to off`);
  }
  if (grounding === "dom-catalog-v1" || grounding === "hybrid-catalog-v1") {
    if (config.kind !== "cua") {
      throw new Error(`grounding ${grounding} requires the CUA computer and its explicit socket`);
    }
    validateManagedBrowserConfig(config, grounding);
    return;
  }
  if (config.kind !== "cua" || config.windowTarget === undefined) {
    throw new Error("grounding uia-catalog-v1 requires an explicit CUA window target");
  }
}

function validateManagedBrowserConfig(
  config: Extract<ComputerBackendConfig, { kind: "cua" }>,
  grounding?: "dom-catalog-v1" | "hybrid-catalog-v1",
): void {
  const label = grounding === undefined ? "DOM/hybrid grounding" : `grounding ${grounding}`;
  if (!isManagedBrowserUrl(config.managedBrowserUrl)) {
    throw new Error(`${label} requires a credential-free http(s) managedBrowserUrl or exact about:blank`);
  }
  if (config.socketPath.trim().length === 0) throw new Error(`${label} requires a non-empty CUA socket`);
  const companionEnabled = config.managedBrowserCompanion === true && config.windowSwitch === "opened-windows-v1";
  if (config.managedBrowserCompanion === true && !companionEnabled) {
    throw new Error("managed browser companion requires the opened-windows-v1 opt-in");
  }
  if (config.windowSwitch === "opened-windows-v1" && config.windowSwitchAllowedTargets?.length === 0) {
    throw new Error("managed browser Run cannot use an empty Host target scope");
  }
  if (config.windowTarget !== undefined && !companionEnabled) {
    throw new Error(`${label} owns its initial browser window; omit the preselected CUA window target unless using the managed-browser companion mode`);
  }
  if (companionEnabled) {
    const allowed = config.windowSwitchAllowedTargets;
    if (allowed !== undefined && config.windowTarget !== undefined && !allowed.some((target) => target.pid === config.windowTarget!.pid && target.windowId === config.windowTarget!.windowId)) {
      throw new Error("managed browser companion requires the exact initial window in the Host target scope");
    }
  }
  const profileMode = config.managedBrowserProfileMode ?? "ephemeral";
  if (profileMode !== "ephemeral" && profileMode !== "persistent") {
    throw new Error("managed browser profile mode must be ephemeral or persistent");
  }
  if (profileMode === "persistent" && (config.managedBrowserProfileLabel === undefined || !/^[A-Za-z0-9._-]{1,64}$/u.test(config.managedBrowserProfileLabel) || config.managedBrowserProfileRoot === undefined || config.managedBrowserProfileRoot.trim().length === 0)) {
    throw new Error("persistent managed browser mode requires a bounded profile label and explicit profile root");
  }
}

interface CuaComputerModule {
  CuaDriverComputer: new (options: CuaDriverComputerOptions) => Computer;
}

export interface ComputerFactoryDependencies {
  importCuaComputer?: () => Promise<CuaComputerModule>;
  /** Injected by the application boundary; no ambient environment read here. */
  osworldBridgeToken?: string;
  /** Test seam for managed-browser lifecycle; production uses the CUA host. */
  createManagedBrowserHost?: (options: ManagedBrowserHostOptions) => ManagedBrowserHost;
  /** Test seam for the short CUA bootstrap session. */
  openCuaBootstrapSession?: typeof openCuaBootstrapSession;
  /** Cross-platform probe injection; null explicitly disables the Windows fallback. */
  windowRelationshipProbe?: WindowRelationshipProbe | null;
}

export function createWindowTargetDiscovery(config: ComputerBackendConfig): WindowTargetDiscovery | undefined {
  if (config.kind !== "cua") return undefined;
  const discovery = new CuaWindowDiscovery({ socketPath: config.socketPath });
  const project = (windows: Awaited<ReturnType<CuaWindowDiscovery["listWindows"]>>) => windows.map((window) => ({
    pid: window.target.pid,
    windowId: window.target.windowId,
    ...(window.appName === undefined ? {} : { appName: window.appName }),
    ...(window.title === undefined ? {} : { title: window.title }),
  }));
  return {
    async listWindows(signal) {
      return project(await discovery.listWindows(signal));
    },
    async listAllWindows(signal) {
      return project(await discovery.listWindows(signal, false));
    },
    async activateWindow(target, signal) {
      await discovery.activateWindow(target, signal);
    },
  };
}

const defaultCuaImporter = (): Promise<CuaComputerModule> => import("@computer-harness/computer-cua");

/**
 * Select a Computer backend without resolving the native CUA binding for
 * backends that do not use it.
 */
export async function createComputer(
  config: ComputerBackendConfig,
  dependencies: ComputerFactoryDependencies = {},
): Promise<Computer> {
  if (config.kind === "external") {
    throw new Error(`external Computer '${config.id}' requires an injected createComputer factory`);
  }
  if (config.kind === "osworld") {
    return new OsworldComputer({
      bridge: new OsworldBridgeClient({
        baseUrl: config.bridgeUrl,
        ...(dependencies.osworldBridgeToken === undefined ? {} : { token: dependencies.osworldBridgeToken }),
      }),
    });
  }

  const managedBrowser = config.grounding === "dom-catalog-v1" || config.grounding === "hybrid-catalog-v1";
  if (managedBrowser) validateManagedBrowserConfig(config);

  const relationshipProbe = dependencies.windowRelationshipProbe !== undefined
    ? dependencies.windowRelationshipProbe ?? undefined
    : process.platform === "win32" && config.windowDeliveryMode === "foreground" && config.managedBrowserCompanion !== true
      ? createWindowsWindowRelationshipProbe()
      : undefined;

  const importCuaComputer = dependencies.importCuaComputer ?? defaultCuaImporter;
  let cuaModule: CuaComputerModule;
  try {
    cuaModule = await importCuaComputer();
  } catch (cause) {
    throw new Error(
      "Failed to load @computer-harness/computer-cua. The cua backend requires the native @trycua/cua-driver platform binding to be installed and loadable.",
      { cause },
    );
  }

  if (!managedBrowser) {
    return new cuaModule.CuaDriverComputer({
      socketPath: config.socketPath,
      screenshotDir: config.screenshotDir,
      ...(config.windowTarget === undefined ? {} : { windowTarget: config.windowTarget }),
      ...(config.windowDeliveryMode === undefined ? {} : { windowDeliveryMode: config.windowDeliveryMode }),
      ...(config.grounding === undefined ? {} : { grounding: config.grounding }),
      ...(config.windowSwitch === undefined ? {} : { windowSwitch: config.windowSwitch }),
      ...(config.windowSwitchAllowedTargets === undefined ? {} : { windowSwitchAllowedTargets: config.windowSwitchAllowedTargets }),
      ...(relationshipProbe === undefined ? {} : { windowRelationshipProbe: relationshipProbe }),
    });
  }
  const createHost = dependencies.createManagedBrowserHost ?? ((options: ManagedBrowserHostOptions) => new ManagedBrowserHost(options));
  const openBootstrap = dependencies.openCuaBootstrapSession ?? openCuaBootstrapSession;
  const createDelegate = cuaModule.CuaDriverComputer;
  const managedConfig = { ...config, windowDeliveryMode: "foreground" as const };
  return new ManagedBrowserComputer({
    config: managedConfig,
    createHost,
    openBootstrap,
    createDelegate,
    ...(relationshipProbe === undefined ? {} : { windowRelationshipProbe: relationshipProbe }),
  });
}

function isManagedBrowserUrl(value: string | undefined): value is string {
  if (value === undefined || value.trim().length === 0) return false;
  if (value === "about:blank") return true;
  try {
    const parsed = new URL(value);
    return (parsed.protocol === "http:" || parsed.protocol === "https:") && parsed.hostname.length > 0 && parsed.username.length === 0 && parsed.password.length === 0;
  } catch {
    return false;
  }
}

interface ManagedBrowserComputerOptions {
  readonly config: Extract<ComputerBackendConfig, { kind: "cua" }>;
  readonly createHost: (options: ManagedBrowserHostOptions) => ManagedBrowserHost;
  readonly openBootstrap: typeof openCuaBootstrapSession;
  readonly createDelegate: CuaComputerModule["CuaDriverComputer"];
  readonly windowRelationshipProbe?: WindowRelationshipProbe;
}

class ManagedBrowserComputer implements Computer {
  private bootstrap: CuaBootstrapSession | undefined;
  private host: ManagedBrowserHost | undefined;
  private delegate: Computer | undefined;
  private opened: ComputerSessionDescriptor | undefined;
  private closing: Promise<void> | undefined;
  private openAttempted = false;
  private readonly hostCleanupDiagnostics: string[] = [];

  public constructor(private readonly options: ManagedBrowserComputerOptions) {}

  public async open(openOptions: ComputerOpenOptions, signal: AbortSignal): Promise<ComputerSessionDescriptor> {
    if (this.openAttempted || this.closing !== undefined) throw new Error("managed browser Computer lifecycle has already been used");
    this.openAttempted = true;
    const label = `computer-harness-managed-bootstrap-${Date.now()}`;
    try {
      const bootstrap = await this.options.openBootstrap(this.options.config.socketPath, label, signal);
      this.bootstrap = bootstrap;
      const createHost = this.options.createHost;
      const host = createHost({
        browser: defaultManagedBrowserKind(),
        url: this.options.config.managedBrowserUrl!,
        profileMode: this.options.config.managedBrowserProfileMode ?? "ephemeral",
        ...(this.options.config.managedBrowserProfileLabel === undefined ? {} : { profileLabel: this.options.config.managedBrowserProfileLabel }),
        ...(this.options.config.managedBrowserProfileMode === "persistent"
          ? { persistentProfileRoot: this.options.config.managedBrowserProfileRoot! }
          : {}),
        resolveOwnedWindowTarget: (browserProcessId, resolverSignal, hint?: ManagedBrowserWindowBindingHint) => resolveOwnedManagedBrowserWindow(bootstrap!.driver, bootstrap!.label, browserProcessId, resolverSignal, hint),
        onCleanupDiagnostic: (diagnostic) => this.hostCleanupDiagnostics.push(diagnostic),
        onStartupDiagnostic: (diagnostic) => process.stderr.write(`${formatManagedBrowserStartupDiagnostic(diagnostic)}\n`),
      });
      this.host = host;
      const record = await host.start(signal);
      this.throwIfHostCleanupUnconfirmed();
      const companionMode = this.options.config.managedBrowserCompanion === true &&
        this.options.config.windowSwitch === "opened-windows-v1";
      const initialTarget = companionMode ? this.options.config.windowTarget : record.target.windowTarget;
      const allowedTargets = this.options.config.windowSwitchAllowedTargets;
      const scopedTargets = allowedTargets === undefined
        ? undefined
        : allowedTargets.length === 0
          ? []
          : this.options.config.windowSwitch === "opened-windows-v1"
            ? uniqueTargets([...allowedTargets, record.target.windowTarget])
            : allowedTargets;
      const delegateOptions: CuaDriverComputerOptions = {
        socketPath: this.options.config.socketPath,
        screenshotDir: this.options.config.screenshotDir,
        browserTarget: record.target,
        domGroundingTransport: host.createTransport(),
        ...(initialTarget === undefined ? {} : { windowTarget: initialTarget }),
        ...(this.options.config.windowDeliveryMode === undefined ? {} : { windowDeliveryMode: this.options.config.windowDeliveryMode }),
        ...(this.options.config.grounding === undefined ? {} : { grounding: this.options.config.grounding }),
        ...(this.options.config.windowSwitch === undefined ? {} : { windowSwitch: this.options.config.windowSwitch }),
        ...(scopedTargets === undefined ? {} : { windowSwitchAllowedTargets: scopedTargets }),
        ...(this.options.windowRelationshipProbe === undefined ? {} : { windowRelationshipProbe: this.options.windowRelationshipProbe }),
      };
      const delegate = new this.options.createDelegate(delegateOptions);
      this.delegate = delegate;
      if (this.options.config.windowSwitch === "opened-windows-v1" && delegate.listWindows === undefined) {
        throw new Error("windowSwitch opened-windows-v1 requires a Computer with listWindows support");
      }
      const session = await delegate.open(openOptions, signal);
      this.opened = session;
      return session;
    } catch (error) {
      try {
        await this.closeOwnedResources();
      } catch (cleanupError) {
        const failures = cleanupError instanceof AggregateError ? [...cleanupError.errors] : [cleanupError];
        throw new AggregateError([error, ...failures], "managed browser Computer startup failed and cleanup was not confirmed", { cause: error });
      }
      throw error;
    }
  }

  public async observe(session: ComputerSessionDescriptor, observationId: ObservationId, signal: AbortSignal): Promise<ObservationCapture> {
    if (this.delegate === undefined) throw new Error("managed browser Computer is not open");
    return this.delegate.observe(session, observationId, signal);
  }

  public async execute(session: ComputerSessionDescriptor, action: ActionIntent, signal: AbortSignal, options?: ComputerExecuteOptions): Promise<ActionReceipt> {
    if (this.delegate === undefined) throw new Error("managed browser Computer is not open");
    // Preserve the adapter's opaque windowRef and sessionAfter without
    // resolving or rewriting a target in this lifecycle wrapper.
    return this.delegate.execute(session, action, signal, options);
  }

  public async listWindows(session: ComputerSessionDescriptor, signal: AbortSignal): Promise<readonly ComputerWindowOption[]> {
    if (this.delegate?.listWindows === undefined) throw new Error("managed browser Computer has no opened-window inventory");
    return this.delegate.listWindows(session, signal);
  }

  public async listWindowHandoffCandidates(session: ComputerSessionDescriptor, signal: AbortSignal): Promise<readonly ComputerWindowCandidate[]> {
    if (this.options.config.windowSwitch !== "opened-windows-v1") throw new Error("managed browser window handoff requires the explicit window-switch opt-in");
    if (this.delegate?.listWindowHandoffCandidates === undefined) throw new Error("managed browser Computer has no window handoff picker");
    return this.delegate.listWindowHandoffCandidates(session, signal);
  }

  public async listNewWindowHandoffCandidates(session: ComputerSessionDescriptor, signal: AbortSignal): Promise<readonly ComputerWindowCandidate[]> {
    if (this.options.config.windowSwitch !== "opened-windows-v1") throw new Error("managed browser window handoff requires the explicit window-switch opt-in");
    if (this.delegate?.listNewWindowHandoffCandidates === undefined) throw new Error("managed browser Computer has no new-window handoff picker");
    return this.delegate.listNewWindowHandoffCandidates(session, signal);
  }

  public async detectNewWindowHandoffCandidates(session: ComputerSessionDescriptor, signal: AbortSignal): Promise<readonly ComputerWindowCandidate[]> {
    if (this.options.config.windowSwitch !== "opened-windows-v1") throw new Error("managed browser window handoff requires the explicit window-switch opt-in");
    if (this.delegate?.detectNewWindowHandoffCandidates === undefined) throw new Error("managed browser Computer cannot detect new-window handoff candidates");
    return this.delegate.detectNewWindowHandoffCandidates(session, signal);
  }

  public async handoffWindow(session: ComputerSessionDescriptor, candidate: ComputerWindowCandidate, signal: AbortSignal): Promise<ComputerSessionDescriptor> {
    if (this.options.config.windowSwitch !== "opened-windows-v1") throw new Error("managed browser window handoff requires the explicit window-switch opt-in");
    if (this.delegate?.handoffWindow === undefined) throw new Error("managed browser Computer cannot hand off to a window");
    // The CUA delegate validates candidates against the current native binding;
    // this wrapper keeps the Harness-owned browser Host alive until Run cleanup.
    return this.delegate.handoffWindow(session, candidate, signal);
  }

  public async close(session: ComputerSessionDescriptor): Promise<void> {
    return this.closeOwnedResources(session);
  }

  public async dispose(): Promise<void> {
    return this.closeOwnedResources();
  }

  private async closeOwnedResources(session?: ComputerSessionDescriptor): Promise<void> {
    if (this.closing !== undefined) return this.closing;
    const delegate = this.delegate;
    const opened = this.opened;
    const host = this.host;
    const bootstrap = this.bootstrap;
    this.closing = (async () => {
      const failures: unknown[] = [];
      if (delegate !== undefined) {
        const activeSession = session ?? opened;
        if (activeSession !== undefined) {
          try { await delegate.close(activeSession); } catch (error) { failures.push(error); }
        } else if (delegate.dispose !== undefined) {
          try { await delegate.dispose(); } catch (error) { failures.push(error); }
        }
      }
      if (host !== undefined) {
        try { await host.close(); } catch (error) { failures.push(error); }
      }
      if (bootstrap !== undefined) {
        try { await bootstrap.close(); } catch (error) { failures.push(error); }
      }
      const criticalDiagnostics = criticalManagedBrowserCleanupDiagnostics(this.hostCleanupDiagnostics);
      if (criticalDiagnostics.length > 0) {
        failures.push(new Error(`managed browser cleanup was not confirmed (${criticalDiagnostics.join(", ")})`));
      }
      this.opened = undefined;
      this.delegate = undefined;
      this.host = undefined;
      this.bootstrap = undefined;
      if (failures.length > 0) {
        throw new AggregateError(failures, "managed browser Computer cleanup was not confirmed", { cause: failures[0] });
      }
    })();
    return this.closing;
  }

  private throwIfHostCleanupUnconfirmed(): void {
    const criticalDiagnostics = criticalManagedBrowserCleanupDiagnostics(this.hostCleanupDiagnostics);
    if (criticalDiagnostics.length > 0) {
      throw new Error(`managed browser startup cleanup was not confirmed (${criticalDiagnostics.join(", ")})`);
    }
  }
}

function criticalManagedBrowserCleanupDiagnostics(diagnostics: readonly string[]): string[] {
  const critical = new Set(["process_exit_timeout", "profile_cleanup_failed", "profile_lock_release_failed"]);
  return [...new Set(diagnostics.filter((diagnostic) => critical.has(diagnostic)))];
}

function uniqueTargets(targets: readonly CuaWindowTarget[]): readonly CuaWindowTarget[] {
  const seen = new Set<string>();
  return targets.filter((target) => {
    const key = `${target.pid}:${target.windowId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
