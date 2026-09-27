import { CuaWindowDiscovery, ManagedBrowserHost, openCuaBootstrapSession, resolveOwnedManagedBrowserWindow, type CuaBootstrapSession, type CuaDriverComputerOptions, type ManagedBrowserHostOptions, type ManagedBrowserWindowBindingHint } from "@computer-harness/computer-cua";
import { OsworldBridgeClient, OsworldComputer } from "@computer-harness/computer-osworld";
import { groundingComputerTools, type Computer, type ComputerExecuteOptions, type ComputerOpenOptions, type ToolDefinition, type ToolRegistry } from "@computer-harness/runtime";
import type { ActionIntent, ActionReceipt, ComputerSessionDescriptor, ObservationCapture, ObservationId } from "@computer-harness/protocol";
import type { WindowTargetDiscovery } from "./application-session.js";

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
): ComputerRunAssemblyPolicy {
  const effectiveConfig = effectiveComputerConfig(config, grounding);
  validateComputerGrounding(effectiveConfig, grounding);

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
      const allowedComputerTools = new Set(["click", "wait"]);
      if (effectiveConfig.windowDeliveryMode === "foreground") {
        allowedComputerTools.add("type");
        allowedComputerTools.add("keypress");
        allowedComputerTools.add("hotkey");
        allowedComputerTools.add("drag");
        allowedComputerTools.add("scroll");
      }
      if (grounding !== "off") allowedComputerTools.add("click_element");
      if (managedGrounding) allowedComputerTools.add("select_option");
      return registry.list()
        .filter((definition) => definition.category !== "computer" || allowedComputerTools.has(definition.name))
        .map((definition) => definition.name);
    },
  };
}

function effectiveComputerConfig(
  computer: ComputerBackendConfig,
  grounding: NonNullable<import("./config.js").ResolvedRunConfig["grounding"]>,
): ComputerBackendConfig {
  if (computer.kind !== "cua") return computer;
  const managedGrounding = grounding === "dom-catalog-v1" || grounding === "hybrid-catalog-v1";
  return {
    ...computer,
    grounding,
    ...(managedGrounding ? { windowDeliveryMode: "foreground" as const } : {}),
  };
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
  if (config.windowTarget !== undefined) {
    throw new Error(`${label} owns its temporary browser window; omit the preselected CUA window target`);
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
}

class ManagedBrowserComputer implements Computer {
  private bootstrap: CuaBootstrapSession | undefined;
  private host: ManagedBrowserHost | undefined;
  private delegate: Computer | undefined;
  private opened: ComputerSessionDescriptor | undefined;
  private closing: Promise<void> | undefined;

  public constructor(private readonly options: ManagedBrowserComputerOptions) {}

  public async open(openOptions: ComputerOpenOptions, signal: AbortSignal): Promise<ComputerSessionDescriptor> {
    if (this.opened !== undefined) throw new Error("managed browser Computer is already open");
    const label = `computer-harness-managed-bootstrap-${Date.now()}`;
    let bootstrap: CuaBootstrapSession | undefined;
    let host: ManagedBrowserHost | undefined;
    try {
      bootstrap = await this.options.openBootstrap(this.options.config.socketPath, label, signal);
      const createHost = this.options.createHost;
      host = createHost({
        browser: "edge",
        url: this.options.config.managedBrowserUrl!,
        profileMode: this.options.config.managedBrowserProfileMode ?? "ephemeral",
        ...(this.options.config.managedBrowserProfileLabel === undefined ? {} : { profileLabel: this.options.config.managedBrowserProfileLabel }),
        ...(this.options.config.managedBrowserProfileMode === "persistent"
          ? { persistentProfileRoot: this.options.config.managedBrowserProfileRoot! }
          : {}),
        resolveOwnedWindowTarget: (browserProcessId, resolverSignal, hint?: ManagedBrowserWindowBindingHint) => resolveOwnedManagedBrowserWindow(bootstrap!.driver, bootstrap!.label, browserProcessId, resolverSignal, hint),
      });
      const record = await host.start(signal);
      const delegateOptions: CuaDriverComputerOptions = {
        socketPath: this.options.config.socketPath,
        screenshotDir: this.options.config.screenshotDir,
        windowTarget: record.target.windowTarget,
        browserTarget: record.target,
        domGroundingTransport: host.createTransport(),
        ...(this.options.config.windowDeliveryMode === undefined ? {} : { windowDeliveryMode: this.options.config.windowDeliveryMode }),
        ...(this.options.config.grounding === undefined ? {} : { grounding: this.options.config.grounding }),
      };
      const delegate = new this.options.createDelegate(delegateOptions);
      const session = await delegate.open(openOptions, signal);
      this.bootstrap = bootstrap;
      this.host = host;
      this.delegate = delegate;
      this.opened = session;
      return session;
    } catch (error) {
      await host?.close().catch(() => undefined);
      await bootstrap?.close().catch(() => undefined);
      throw error;
    }
  }

  public async observe(session: ComputerSessionDescriptor, observationId: ObservationId, signal: AbortSignal): Promise<ObservationCapture> {
    if (this.delegate === undefined) throw new Error("managed browser Computer is not open");
    return this.delegate.observe(session, observationId, signal);
  }

  public async execute(session: ComputerSessionDescriptor, action: ActionIntent, signal: AbortSignal, options?: ComputerExecuteOptions): Promise<ActionReceipt> {
    if (this.delegate === undefined) throw new Error("managed browser Computer is not open");
    return this.delegate.execute(session, action, signal, options);
  }

  public async close(session: ComputerSessionDescriptor): Promise<void> {
    if (this.closing !== undefined) return this.closing;
    this.closing = (async () => {
      try {
        if (this.delegate !== undefined && this.opened !== undefined) await this.delegate.close(session);
      } finally {
        await this.host?.close().catch(() => undefined);
        await this.bootstrap?.close().catch(() => undefined);
        this.opened = undefined;
        this.delegate = undefined;
        this.host = undefined;
        this.bootstrap = undefined;
      }
    })();
    return this.closing;
  }
}
