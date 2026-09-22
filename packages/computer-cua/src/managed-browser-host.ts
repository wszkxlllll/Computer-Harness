import { createHash, randomBytes } from "node:crypto";
import { access, mkdir, mkdtemp, open, readFile, rm, stat, writeFile, type FileHandle } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { execFile as execFileCallback, spawn, type ChildProcess } from "node:child_process";
import { platform, tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { promisify } from "node:util";
import { CuaDriver, EndSessionInput, StartSessionInput, type CuaDriverLike } from "@trycua/cua-driver";
import { validateWindowTarget, type CuaWindowTarget } from "./window-contract.js";
import {
  DomGroundingUnavailableError,
  type DomGroundingCollectRequest,
  type DomGroundingRawCandidate,
  type DomGroundingTransport,
  type DomGroundingTransportResult,
  type ManagedBrowserTarget,
} from "./dom-grounding.js";

const LOOPBACK_HOST = "127.0.0.1";
const DEFAULT_STARTUP_TIMEOUT_MS = 15_000;
const MAX_CDP_PAYLOAD_BYTES = 8 * 1024 * 1024;
const CDP_PROTOCOL_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const execFile = promisify(execFileCallback);
const MANAGED_BROWSER_STARTUP_METADATA_FILE = "managed-browser-startup.json";
export const MAX_MANAGED_BROWSER_STARTUP_URLS = 8;

export type ManagedBrowserProfileMode = "ephemeral" | "persistent";
export type ManagedBrowserKind = "edge" | "chromium";

/** Select the native default without making callers duplicate OS policy. */
export function defaultManagedBrowserKind(osPlatform: NodeJS.Platform = platform()): ManagedBrowserKind {
  return osPlatform === "win32" ? "edge" : "chromium";
}

/** Explicit, bounded executable locations supported by the managed host. */
export function managedBrowserExecutableCandidates(browser: ManagedBrowserKind, osPlatform: NodeJS.Platform = platform()): readonly string[] {
  if (osPlatform === "darwin") {
    return browser === "edge"
      ? ["/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"]
      : ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium"];
  }
  if (osPlatform === "linux") {
    return browser === "edge"
      ? ["/usr/bin/microsoft-edge", "/usr/bin/microsoft-edge-stable"]
      : ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
  }
  return browser === "edge"
    ? ["C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe", "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"]
    : ["C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe"];
}

export interface ManagedBrowserStartupMetadata {
  readonly schemaVersion: 1;
  readonly urls: readonly string[];
}

/**
 * Keep only an explicit, bounded, credential-free startup identity. Query and
 * fragment components are deliberately discarded before this is persisted;
 * the full command URL is used only for the current launch.
 */
export function normalizeManagedBrowserStartupUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new DomGroundingUnavailableError("managed browser startup URL must be an explicit http(s) URL");
  }
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.hostname.length === 0 || parsed.username.length > 0 || parsed.password.length > 0) {
    throw new DomGroundingUnavailableError("managed browser startup URL must be an explicit credential-free http(s) URL");
  }
  parsed.search = "";
  parsed.hash = "";
  const normalized = parsed.toString();
  if (normalized.length > 2048) throw new DomGroundingUnavailableError("managed browser startup URL is too long");
  return normalized;
}

export async function readManagedBrowserStartupUrls(profileRoot: string): Promise<readonly string[]> {
  let text: string;
  try {
    text = await readFile(join(profileRoot, MANAGED_BROWSER_STARTUP_METADATA_FILE), "utf8");
  } catch (error) {
    if (isMissingFile(error)) return [];
    throw new DomGroundingUnavailableError("managed browser startup metadata could not be read");
  }
  try {
    const value = JSON.parse(text) as unknown;
    if (!isRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.urls) || value.urls.length > MAX_MANAGED_BROWSER_STARTUP_URLS) {
      throw new Error("invalid managed browser startup metadata");
    }
    const urls: string[] = [];
    for (const entry of value.urls) {
      if (typeof entry !== "string") throw new Error("invalid managed browser startup metadata");
      const normalized = normalizeManagedBrowserStartupUrl(entry);
      if (!urls.includes(normalized)) urls.push(normalized);
    }
    return urls;
  } catch (error) {
    if (error instanceof DomGroundingUnavailableError) throw error;
    throw new DomGroundingUnavailableError("managed browser startup metadata is invalid");
  }
}

export async function registerManagedBrowserStartupUrl(profileRoot: string, value: string): Promise<readonly string[]> {
  const normalized = normalizeManagedBrowserStartupUrl(value);
  const existing = [...await readManagedBrowserStartupUrls(profileRoot)];
  if (existing.includes(normalized)) return existing;
  if (existing.length >= MAX_MANAGED_BROWSER_STARTUP_URLS) {
    throw new DomGroundingUnavailableError(`managed browser startup URL limit is ${MAX_MANAGED_BROWSER_STARTUP_URLS}`);
  }
  existing.push(normalized);
  const metadata: ManagedBrowserStartupMetadata = { schemaVersion: 1, urls: existing };
  try {
    await writeFile(join(profileRoot, MANAGED_BROWSER_STARTUP_METADATA_FILE), `${JSON.stringify(metadata)}\n`, "utf8");
  } catch {
    throw new DomGroundingUnavailableError("managed browser startup metadata could not be written");
  }
  return existing;
}

export interface ManagedBrowserProfileLease {
  readonly mode: ManagedBrowserProfileMode;
  readonly profileId: string;
  /** Host-private filesystem location; never put this value in model/trace data. */
  readonly profileRoot: string;
  release(): Promise<void>;
}

export async function acquireManagedBrowserProfileLease(options: {
  readonly profileMode: ManagedBrowserProfileMode;
  readonly profileLabel?: string;
  readonly persistentProfileRoot?: string;
}): Promise<ManagedBrowserProfileLease> {
  const resources = await prepareManagedBrowserProfile(options);
  return {
    mode: options.profileMode,
    profileId: resources.profileId,
    profileRoot: resources.profileRoot,
    async release() {
      await cleanupManagedBrowser(undefined, undefined, undefined, resources.profileRoot, options.profileMode, resources.profileLock, undefined);
    },
  };
}

/**
 * A small, host-owned visible browser session. The caller must resolve an
 * exact window identity after process startup; this module never guesses by
 * title/process name and never reuses a user profile.
 */
export interface ManagedBrowserHostOptions {
  readonly browser: ManagedBrowserKind;
  readonly url: string;
  /** Ephemeral is the default; persistent is Harness-owned and explicitly labeled. */
  readonly profileMode?: ManagedBrowserProfileMode;
  /** Required for persistent mode; never a personal browser profile name. */
  readonly profileLabel?: string;
  /** Harness-owned base directory for persistent profiles. */
  readonly persistentProfileRoot?: string;
  /** Browser-login only: register this explicit URL for later persistent launches. */
  readonly registerStartupUrl?: boolean;
  /** Resolve the exact OS window after the managed process has started. */
  readonly resolveOwnedWindowTarget: (browserProcessId: number, signal: AbortSignal, hint?: ManagedBrowserWindowBindingHint) => Promise<ManagedBrowserWindowResolution | undefined>;
  readonly executablePath?: string;
  readonly startupTimeoutMs?: number;
  readonly onCleanupDiagnostic?: (kind: "graceful_close_failed" | "process_exit_timeout" | "profile_cleanup_failed" | "profile_lock_release_failed") => void;
  /** Host-local redacted evidence for diagnosing a failed window binding. */
  readonly onWindowResolutionDiagnostic?: (diagnostic: ManagedBrowserWindowResolutionDiagnostic) => void;
  /** Host-local redacted page-set evidence; never contains URL or page text. */
  readonly onStartupPageDiagnostic?: (diagnostic: ManagedBrowserStartupPageDiagnostic) => void;
}

export interface ManagedBrowserWindowResolutionDiagnostic {
  readonly hostProcessId: number;
  readonly ownedProcessCount: number;
  readonly cdpBrowserWindowId: number;
  readonly cdpBounds?: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
  readonly candidateCount: number;
  readonly ownedCandidateCount: number;
  readonly boundsMatchingCandidateCount: number;
  readonly geometryCompatibleCandidateCount: number;
  readonly boundsDifferences: readonly { readonly dx: number; readonly dy: number; readonly dwidth: number; readonly dheight: number }[];
  readonly reason?: "cua_query_failed" | "zero_windows" | "multiple_candidates" | "ownership_mismatch";
}

export interface ManagedBrowserStartupPageDiagnostic {
  readonly pageCount: number;
  readonly browserWindowId?: number;
  readonly selected: boolean;
}

export interface ManagedBrowserWindowBindingHint {
  readonly browserWindowId: number;
  readonly browserBounds?: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
  readonly ownedProcessIds?: readonly number[];
  readonly onDiagnostic?: (diagnostic: ManagedBrowserWindowResolutionDiagnostic) => void;
}

export interface ManagedBrowserWindowResolution {
  readonly target: CuaWindowTarget;
  readonly ownershipEvidence: {
    readonly ownedByHost: boolean;
    readonly hostProcessId: number;
    readonly processId: number;
    readonly windowId: number;
    readonly windowCount: number;
    readonly browserWindowId?: number;
    readonly windowBounds?: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
  };
}

export interface ManagedBrowserHostRecord {
  readonly target: ManagedBrowserTarget;
  readonly processId: number;
  readonly profileId: string;
  readonly tabId: string;
  readonly generation: string;
  readonly profileMode: ManagedBrowserProfileMode;
}

export interface CuaBootstrapSession {
  readonly driver: CuaDriverLike;
  readonly label: string;
  close(): Promise<void>;
}

export async function openCuaBootstrapSession(socketPath: string, label: string, signal: AbortSignal): Promise<CuaBootstrapSession> {
  const driver = CuaDriver.connect(socketPath);
  let started = false;
  try {
    await driver.startSession(StartSessionInput.new({ session: label }), { signal });
    started = true;
    return {
      driver,
      label,
      async close() {
        if (started) {
          started = false;
          await driver.endSession(EndSessionInput.new({ session: label }), { signal: new AbortController().signal }).catch(() => undefined);
        }
        (driver as unknown as { uniffiDestroy?: () => void }).uniffiDestroy?.();
      },
    };
  } catch (error) {
    if (started) await driver.endSession(EndSessionInput.new({ session: label }), { signal: new AbortController().signal }).catch(() => undefined);
    (driver as unknown as { uniffiDestroy?: () => void }).uniffiDestroy?.();
    throw error;
  }
}

export interface ManagedBrowserDevToolsPage {
  readonly id?: unknown;
  readonly type?: unknown;
  readonly webSocketDebuggerUrl?: unknown;
}

export interface ManagedBrowserPageActivity {
  readonly page: ManagedBrowserDevToolsPage;
  readonly browserWindowId: number;
  readonly visibilityState: "visible" | "hidden" | "prerender" | "unloaded";
  readonly hasFocus?: boolean;
  readonly browserBounds?: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
}

export type ManagedBrowserPageActivityReader = (
  page: ManagedBrowserDevToolsPage,
  signal: AbortSignal,
) => Promise<ManagedBrowserPageActivity | undefined>;

/**
 * Accept only the one page that was bound when the managed host started.
 * Navigation in that page keeps its id and is therefore allowed; opening a
 * popup, replacing the target, or closing it is a transport gate failure.
 */
export function validateManagedBrowserPageSet(
  pages: readonly ManagedBrowserDevToolsPage[],
  expectedTabId?: string,
): ManagedBrowserDevToolsPage | undefined {
  const pageTargets = pages.filter((item) => item.type === "page" && typeof item.id === "string" && typeof item.webSocketDebuggerUrl === "string");
  if (pageTargets.length !== 1) return undefined;
  const page = pageTargets[0]!;
  if (expectedTabId !== undefined && page.id !== expectedTabId) return undefined;
  return page;
}

/**
 * Select the unique visible page inside the host-attested CDP browser window.
 * Page titles and URLs are deliberately not involved. A second visible page
 * is ambiguous even when one reports focus, so collection fails closed.
 */
export function resolveManagedBrowserActivePage(
  activities: readonly ManagedBrowserPageActivity[],
  expectedBrowserWindowId?: number,
): ManagedBrowserPageActivity | undefined {
  const inWindow = expectedBrowserWindowId === undefined
    ? activities
    : activities.filter((activity) => activity.browserWindowId === expectedBrowserWindowId);
  const visible = inWindow.filter((activity) => activity.visibilityState === "visible");
  return visible.length === 1 ? visible[0] : undefined;
}

/** Resolve page activity through an injectable CDP reader for offline tests. */
export async function resolveManagedBrowserActivePageSet(
  pages: readonly ManagedBrowserDevToolsPage[],
  readActivity: ManagedBrowserPageActivityReader,
  signal: AbortSignal,
  expectedBrowserWindowId?: number,
  requireSingleBrowserWindow = false,
): Promise<ManagedBrowserPageActivity | undefined> {
  const pageTargets = pages.filter((item) => item.type === "page" && typeof item.id === "string" && typeof item.webSocketDebuggerUrl === "string");
  if (pageTargets.length === 0 || pageTargets.length > MAX_MANAGED_PAGE_TARGETS) return undefined;
  const activities = await Promise.all(pageTargets.map((page) => readActivity(page, signal)));
  if (activities.some((activity) => activity === undefined)) return undefined;
  const resolvedActivities = activities as ManagedBrowserPageActivity[];
  const selected = resolveManagedBrowserActivePage(resolvedActivities, expectedBrowserWindowId);
  if (selected === undefined || !requireSingleBrowserWindow) return selected;
  return resolvedActivities.every((activity) => activity.browserWindowId === selected.browserWindowId) ? selected : undefined;
}

const MANAGED_PAGE_ACTIVITY_SCRIPT = String.raw`({
  visibilityState: document.visibilityState,
  hasFocus: document.hasFocus()
})`;
const MAX_MANAGED_PAGE_TARGETS = 32;

interface HostState {
  target: ManagedBrowserTarget;
  processId: number;
  profileId: string;
  tabId: string;
  generation: string;
  readonly browserWindowId: number;
  readonly child: ChildProcess;
  readonly profileRoot: string;
  readonly debuggerPort: number;
  readonly browserWebSocketDebuggerUrl: string;
  readonly profileMode: ManagedBrowserProfileMode;
  readonly profileLock: FileHandle | undefined;
}

/**
 * Expression evaluated in the managed page's main world. It intentionally
 * avoids selectors, node IDs, input values and full text/DOM serialization.
 * Open shadow roots are traversed; iframe documents (especially cross-origin)
 * remain an explicit boundary and canvas/WebGL stays visual-only.
 */
export const MANAGED_DOM_EVALUATION_SCRIPT = String.raw`(function() {
  const cssWidth = Number(window.innerWidth);
  const cssHeight = Number(window.innerHeight);
  const deviceScaleFactor = Number(window.devicePixelRatio);
  const maxCandidates = 256;
  const candidates = [];
  const seen = new Set();
  const interactiveRoles = new Set(["button", "link", "checkbox", "combobox", "listbox", "menuitem", "option", "radio", "slider", "switch", "tab", "textbox", "treeitem"]);
  const tagRoles = { a: "link", button: "button", select: "combobox", textarea: "textbox", summary: "button" };
  const inputRoles = { checkbox: "checkbox", radio: "radio", range: "slider", button: "button", submit: "button", reset: "button", image: "button", number: "spinbutton" };
  const boundedText = (value, max) => {
    if (typeof value !== "string") return undefined;
    const text = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
    return text.length === 0 ? undefined : text.slice(0, max);
  };
  const roleOf = (element) => boundedText(element.getAttribute("role") || (element.localName === "input" ? (inputRoles[(element.getAttribute("type") || "text").toLowerCase()] || "textbox") : tagRoles[element.localName]) || (element.tabIndex >= 0 ? "generic" : undefined), 64);
  const visibleFrame = (element) => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    if (style.display === "none" || style.visibility === "hidden" || style.pointerEvents === "none" || rect.width <= 0 || rect.height <= 0) return undefined;
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  };
  const isCanvasLike = (element, role) => element.localName === "canvas" || role === "canvas" || role === "webgl" || role === "bitmap";
  const isInteractive = (element, role) => {
    if (element.disabled === true) return true;
    if (element.tabIndex >= 0 || element.isContentEditable === true) return true;
    if (role !== undefined && interactiveRoles.has(role.toLowerCase())) return true;
    return ["a", "button", "input", "select", "textarea", "summary"].includes(element.localName);
  };
  const emit = (element) => {
    if (candidates.length >= maxCandidates || seen.has(element)) return;
    seen.add(element);
    const role = roleOf(element);
    const frame = visibleFrame(element);
    if (frame === undefined || !isInteractive(element, role) || isCanvasLike(element, role)) return;
    const name = boundedText(element.getAttribute("aria-label") || element.getAttribute("title") || element.getAttribute("placeholder") || (element.localName === "input" || element.localName === "textarea" ? undefined : element.textContent), 160);
    const enabled = element.disabled !== true;
    const inputType = (element.getAttribute("type") || "text").toLowerCase();
    const editable = element.isContentEditable === true || element.localName === "textarea" || (element.localName === "input" && ["text", "search", "email", "url", "tel", "password", "number"].includes(inputType));
    candidates.push({
      tagName: element.localName,
      ariaRole: role,
      name,
      frame,
      visible: true,
      interactive: true,
      tabIndex: Number.isInteger(element.tabIndex) ? element.tabIndex : undefined,
      inputType: element.localName === "input" ? inputType : undefined,
      canvasLike: false,
      state: { enabled, focused: document.activeElement === element, editable, expanded: element.getAttribute("aria-expanded") === "true", selected: element.getAttribute("aria-selected") === "true" },
    });
  };
  const walk = (root) => {
    if (root === undefined || root === null || candidates.length >= maxCandidates) return;
    const elements = root instanceof Element ? [root, ...root.querySelectorAll("*")] : [...root.querySelectorAll("*")];
    for (const element of elements) {
      const role = roleOf(element);
      emit(element);
      if (element.shadowRoot) walk(element.shadowRoot);
      // iframe documents are intentionally not traversed: a new frame identity
      // requires a separate observation/transport binding.
      void role;
    }
  };
  walk(document);
  return {
    candidates,
    complete: true,
    coordinateSpace: "css",
    viewportMetrics: { cssWidth, cssHeight, deviceScaleFactor },
  };
})()`;

export function validateOwnedWindowResolution(
  browserProcessId: number,
  resolution: ManagedBrowserWindowResolution | undefined,
  hint?: ManagedBrowserWindowBindingHint,
): CuaWindowTarget {
  if (resolution === undefined) throw new DomGroundingUnavailableError("managed browser window resolver ownership_mismatch: no exact target");
  validateWindowTarget(resolution.target);
  const evidence = resolution.ownershipEvidence;
  const processOwned = hint?.ownedProcessIds === undefined
    ? evidence.processId === browserProcessId
    : hint.ownedProcessIds.includes(evidence.processId);
  const boundsMatch = hint?.browserBounds === undefined
    ? true
    : evidence.windowBounds !== undefined && managedBrowserWindowBoundsMatch(evidence.windowBounds, hint.browserBounds);
  if (!evidence.ownedByHost || evidence.hostProcessId !== browserProcessId || !processOwned || evidence.processId !== resolution.target.pid || evidence.windowId !== resolution.target.windowId || evidence.windowCount !== 1 || hint?.browserWindowId !== undefined && evidence.browserWindowId !== hint.browserWindowId || !boundsMatch) {
    throw new DomGroundingUnavailableError("managed browser window resolver ownership_mismatch: host ownership was not proven");
  }
  // Edge may broker the visible process; the resolver may return that owned
  // PID, but it must still provide explicit ownership evidence tied to it.
  if (!Number.isSafeInteger(browserProcessId) || browserProcessId <= 0) throw new DomGroundingUnavailableError("managed browser process identity was invalid");
  return resolution.target;
}

export function managedBrowserWindowBoundsMatch(
  left: { readonly x: number; readonly y: number; readonly width: number; readonly height: number },
  right: { readonly x: number; readonly y: number; readonly width: number; readonly height: number },
): boolean {
  if (left.x === right.x && left.y === right.y && left.width === right.width && left.height === right.height) return true;
  // CDP reports browser bounds in device-independent pixels while CUA may
  // report physical pixels.  Compare dimensions for one common scale and
  // deliberately ignore the small frame-origin offset.  Process ownership
  // and uniqueness remain mandatory; geometry is only a safe disambiguator.
  const widthScale = left.width / right.width;
  const heightScale = left.height / right.height;
  const scaleDelta = Math.abs(widthScale - heightScale) / Math.max(widthScale, heightScale);
  const leftAspect = left.width / left.height;
  const rightAspect = right.width / right.height;
  const aspectDelta = Math.abs(leftAspect - rightAspect) / Math.max(leftAspect, rightAspect);
  return scaleDelta <= 0.08 && aspectDelta <= 0.08;
}

export class ManagedBrowserHost {
  private state: HostState | undefined;
  private closing = false;

  public constructor(private readonly options: ManagedBrowserHostOptions) {
    if (typeof options.resolveOwnedWindowTarget !== "function") {
      throw new DomGroundingUnavailableError("managed browser host requires an owned-window resolver");
    }
    if (!options.url.startsWith("https://") && !options.url.startsWith("http://") && !options.url.startsWith("data:text/html")) {
      throw new DomGroundingUnavailableError("managed browser host URL must be an explicit http(s) or static data URL");
    }
    if (!Number.isInteger(options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS) || (options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS) <= 0) {
      throw new DomGroundingUnavailableError("managed browser startup timeout must be positive");
    }
    const profileMode = options.profileMode ?? "ephemeral";
    if (profileMode !== "ephemeral" && profileMode !== "persistent") {
      throw new DomGroundingUnavailableError("managed browser profile mode must be ephemeral or persistent");
    }
    if (profileMode === "persistent") {
      if (!isManagedBrowserProfileLabel(options.profileLabel) || options.persistentProfileRoot === undefined || options.persistentProfileRoot.trim().length === 0) {
        throw new DomGroundingUnavailableError("persistent managed browser mode requires an explicit profile label and Harness-owned profile root");
      }
    }
  }

  public async start(signal: AbortSignal): Promise<ManagedBrowserHostRecord> {
    if (this.state !== undefined) throw new DomGroundingUnavailableError("managed browser host is already running");
    signal.throwIfAborted();
    const executablePath = await resolveManagedBrowserExecutable(this.options.browser, this.options.executablePath);
    let profileRoot: string | undefined;
    let profileLock: FileHandle | undefined;
    let profileMode: ManagedBrowserProfileMode = this.options.profileMode ?? "ephemeral";
    let child: ChildProcess | undefined;
    let browserWebSocketDebuggerUrl: string | undefined;
    try {
      const profile = await prepareManagedBrowserProfile(this.options);
      profileRoot = profile.profileRoot;
      profileLock = profile.profileLock;
      const preparedStartupUrls = profileMode === "persistent"
        ? await readManagedBrowserStartupUrls(profileRoot)
        : [];
      const launchUrls = profileMode === "persistent"
        ? buildManagedBrowserLaunchUrls(preparedStartupUrls, this.options.url)
        : [this.options.url];
      const args = [
        `--user-data-dir=${profileRoot}`,
        "--remote-debugging-address=127.0.0.1",
        "--remote-debugging-port=0",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-sync",
        "--disable-extensions",
        ...(process.platform === "darwin" ? ["--force-renderer-accessibility"] : []),
        "--new-window",
        ...launchUrls,
      ];
      const launchStartedAt = Date.now();
      await clearManagedBrowserDevToolsPort(profileRoot);
      child = spawn(executablePath, args, { stdio: "ignore", windowsHide: false });
      const processId = child.pid;
      if (processId === undefined || !Number.isSafeInteger(processId) || processId <= 0) throw new DomGroundingUnavailableError("managed browser process did not expose a valid PID");
      const ownedProcessId = processId;
      const devTools = await waitForDevToolsPort(profileRoot, child, this.options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS, signal, launchStartedAt);
      const browserEndpoint = await waitForDevToolsBrowserEndpoint(devTools.port, child, this.options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS, signal);
      browserWebSocketDebuggerUrl = browserEndpoint;
      const startupPageSet = await waitForManagedBrowserStartupPageSet(
        devTools.port,
        browserEndpoint,
        signal,
        Math.min(this.options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS, 3_000),
      );
      const pages = startupPageSet.pages;
      const selected = startupPageSet.selected;
      if (selected === undefined) {
        try { this.options.onStartupPageDiagnostic?.({ pageCount: pages.length, selected: false }); } catch { /* best effort */ }
        throw new DomGroundingUnavailableError("managed browser host must expose one visible page in one browser window");
      }
      try {
        this.options.onStartupPageDiagnostic?.({
          pageCount: pages.filter((page) => page.type === "page").length,
          browserWindowId: selected.browserWindowId,
          selected: true,
        });
      } catch {
        // Diagnostic consumers are best-effort and must not affect startup.
      }
      const tabId = selected.page.id as string;
      const ownedProcessIds = await discoverManagedBrowserProcessIds(ownedProcessId, profileRoot, signal);
      const windowHint: ManagedBrowserWindowBindingHint = {
        browserWindowId: selected.browserWindowId,
        ...(selected.browserBounds === undefined ? {} : { browserBounds: selected.browserBounds }),
        ownedProcessIds: [...ownedProcessIds],
        ...(this.options.onWindowResolutionDiagnostic === undefined ? {} : { onDiagnostic: this.options.onWindowResolutionDiagnostic }),
      };
      const resolution = await this.options.resolveOwnedWindowTarget(ownedProcessId, signal, windowHint);
      const windowTarget = validateOwnedWindowResolution(ownedProcessId, resolution, windowHint);
      const generation = shortHash(`${ownedProcessId}:${tabId}:${Date.now()}`);
      const target: ManagedBrowserTarget = {
        kind: "managed-chromium",
        browser: this.options.browser,
        profileId: profile.profileId,
        windowTarget,
        tabId,
        generation,
        delivery: "loopback-cdp",
      };
      if (profileMode === "persistent" && this.options.registerStartupUrl === true) {
        await registerManagedBrowserStartupUrl(profileRoot, this.options.url);
      }
      this.state = { target, processId: ownedProcessId, profileId: profile.profileId, tabId, generation, browserWindowId: selected.browserWindowId, child, profileRoot, debuggerPort: devTools.port, browserWebSocketDebuggerUrl: browserEndpoint, profileMode, profileLock };
      return { target, processId: ownedProcessId, profileId: profile.profileId, tabId, generation, profileMode };
    } catch (error) {
      if (signal.aborted) signal.throwIfAborted();
      if (profileRoot !== undefined) await cleanupManagedBrowser(child, child?.pid, browserWebSocketDebuggerUrl, profileRoot, profileMode, profileLock, this.options.onCleanupDiagnostic);
      if (error instanceof DomGroundingUnavailableError) throw error;
      throw new DomGroundingUnavailableError("managed browser host failed to start");
    }
  }

  public createTransport(): DomGroundingTransport {
    if (this.state === undefined) throw new DomGroundingUnavailableError("managed browser host is not running");
    return new ManagedCdpDomGroundingTransport(this);
  }

  public async close(): Promise<void> {
    if (this.state === undefined || this.closing) return;
    this.closing = true;
    const state = this.state;
    this.state = undefined;
    await cleanupManagedBrowser(state.child, state.processId, state.browserWebSocketDebuggerUrl, state.profileRoot, state.profileMode, state.profileLock, this.options.onCleanupDiagnostic);
  }

  public getRecord(): ManagedBrowserHostRecord | undefined {
    if (this.state === undefined) return undefined;
    const { target, processId, profileId, tabId, generation, profileMode } = this.state;
    return { target, processId, profileId, tabId, generation, profileMode };
  }

  public async collect(request: DomGroundingCollectRequest, signal: AbortSignal): Promise<DomGroundingTransportResult> {
    const state = this.state;
    if (state === undefined) throw new DomGroundingUnavailableError("managed browser host is not running");
    if (request.browserTarget.profileId !== state.profileId || request.browserTarget.browser !== state.target.browser || request.browserTarget.delivery !== state.target.delivery || request.browserTarget.windowTarget.pid !== state.target.windowTarget.pid || request.browserTarget.windowTarget.windowId !== state.target.windowTarget.windowId) {
      throw new DomGroundingUnavailableError("managed browser target is stale");
    }
    // Revalidate every page target for every observation. A new active tab is
    // accepted only inside the host-attested browser window; a popup in a new
    // browser window is excluded. Same-tab navigation is allowed because the
    // target id remains stable and the freshly listed websocket URL is used.
    const pages = await listDevToolsPages(state.debuggerPort, signal);
    const selected = await resolveManagedBrowserActivePageSet(pages, (page, activitySignal) => inspectManagedPageActivity(page, state.browserWebSocketDebuggerUrl, activitySignal), signal, state.browserWindowId);
    if (selected === undefined) throw new DomGroundingUnavailableError("managed browser active page was stale or ambiguous");
    const selectedTabId = selected.page.id as string;
    if (selectedTabId !== state.tabId) {
      state.tabId = selectedTabId;
      state.generation = shortHash(`${state.processId}:${state.tabId}:${Date.now()}`);
      state.target = { ...state.target, tabId: state.tabId, generation: state.generation };
    }
    const webSocketDebuggerUrl = selected.page.webSocketDebuggerUrl as string;
    const expression = MANAGED_DOM_EVALUATION_SCRIPT;
    const socket = await LoopbackWebSocket.connect(webSocketDebuggerUrl, signal);
    try {
      const response = await socket.command("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: false }, signal);
      const value = response?.result?.result?.value;
      if (!isRecord(value) || !Array.isArray(value.candidates)) throw new DomGroundingUnavailableError("managed DOM evaluation returned no bounded candidates");
      if (value.coordinateSpace !== "css" || !isRecord(value.viewportMetrics)) {
        throw new DomGroundingUnavailableError("managed DOM evaluation omitted CSS coordinate metadata");
      }
      const viewportMetrics = {
        cssWidth: Number(value.viewportMetrics.cssWidth),
        cssHeight: Number(value.viewportMetrics.cssHeight),
        deviceScaleFactor: Number(value.viewportMetrics.deviceScaleFactor),
      };
      if (![viewportMetrics.cssWidth, viewportMetrics.cssHeight, viewportMetrics.deviceScaleFactor].every((item) => Number.isFinite(item) && item > 0)) {
        throw new DomGroundingUnavailableError("managed DOM evaluation returned invalid CSS viewport metadata");
      }
      return {
        candidates: value.candidates as DomGroundingRawCandidate[],
        complete: value.complete === true,
        coordinateSpace: "css",
        viewportMetrics,
        tabId: state.tabId,
        generation: state.generation,
      };
    } finally {
      socket.close();
    }
  }
}

class ManagedCdpDomGroundingTransport implements DomGroundingTransport {
  public readonly kind = "managed-loopback-cdp-v1" as const;

  public constructor(private readonly host: ManagedBrowserHost) {}

  public async collect(request: DomGroundingCollectRequest, signal: AbortSignal): Promise<DomGroundingTransportResult> {
    return this.host.collect(request, signal);
  }
}

interface ManagedBrowserProfileResources {
  readonly profileRoot: string;
  readonly profileId: string;
  readonly profileLock?: FileHandle;
}

export function buildManagedBrowserLaunchUrls(
  preparedStartupUrls: readonly string[],
  currentUrl: string,
): readonly string[] {
  const currentNormalized = normalizeManagedBrowserStartupUrl(currentUrl);
  const prepared = preparedStartupUrls
    .map((url) => normalizeManagedBrowserStartupUrl(url))
    .filter((url, index, urls) => urls.indexOf(url) === index && url !== currentNormalized);
  // Chromium treats the first command-line URL as the foreground tab. Keep
  // the explicitly supplied Run URL first; prepared sites are background tabs.
  return [currentUrl, ...prepared];
}

function isMissingFile(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

function isManagedBrowserProfileLabel(value: string | undefined): value is string {
  return value !== undefined && /^[A-Za-z0-9._-]{1,64}$/u.test(value);
}

async function prepareManagedBrowserProfile(options: {
  readonly profileMode?: ManagedBrowserProfileMode;
  readonly profileLabel?: string;
  readonly persistentProfileRoot?: string;
}): Promise<{ readonly profileRoot: string; readonly profileId: string; readonly profileLock?: FileHandle }> {
  const profileMode = options.profileMode ?? "ephemeral";
  if (profileMode === "ephemeral") {
    const profileRoot = await mkdtemp(join(tmpdir(), "computer-harness-managed-browser-"));
    return { profileRoot, profileId: `managed-${shortHash(profileRoot)}` };
  }
  if (!isManagedBrowserProfileLabel(options.profileLabel) || options.persistentProfileRoot === undefined || options.persistentProfileRoot.trim().length === 0) {
    throw new DomGroundingUnavailableError("persistent managed browser mode requires an explicit profile label and Harness-owned profile root");
  }
  const profileRoot = join(resolvePath(options.persistentProfileRoot), options.profileLabel);
  await mkdir(profileRoot, { recursive: true });
  const lockPath = join(profileRoot, ".computer-harness-profile.lock");
  let profileLock: FileHandle;
  try {
    profileLock = await open(lockPath, "wx");
  } catch {
    throw new DomGroundingUnavailableError("persistent managed browser profile is already in use or has a stale lock; close the owning Harness browser and recover it with an explicit profile reset before retrying");
  }
  return { profileRoot, profileId: `managed-${shortHash(profileRoot)}`, profileLock };
}

async function discoverManagedBrowserProcessIds(
  hostProcessId: number,
  profileRoot: string,
  signal: AbortSignal,
): Promise<Set<number>> {
  const owned = new Set<number>([hostProcessId]);
  const queried = await queryManagedBrowserProcessIds(hostProcessId, profileRoot, signal, 2_500, true);
  if (queried !== undefined) for (const pid of queried) owned.add(pid);
  // Keep the exact spawned PID as the only proof when process inventory is unavailable.
  return owned;
}

async function queryManagedBrowserProcessIds(
  hostProcessId: number,
  profileRoot: string,
  signal?: AbortSignal,
  timeoutMs = 2_500,
  includeHostFallback = false,
): Promise<Set<number> | undefined> {
  if (process.platform !== "win32") return await queryPosixManagedBrowserProcessIds(hostProcessId, profileRoot, signal, timeoutMs, includeHostFallback);
  const script = "$root=[Environment]::GetEnvironmentVariable('CH_MANAGED_PROFILE_ROOT'); $hostPid=[int][Environment]::GetEnvironmentVariable('CH_MANAGED_HOST_PID'); $includeHost=[Environment]::GetEnvironmentVariable('CH_MANAGED_INCLUDE_HOST') -eq '1'; $items=@(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine); $owned=[Collections.Generic.HashSet[int]]::new(); $hostItem=$items | Where-Object { [int]$_.ProcessId -eq $hostPid } | Select-Object -First 1; $hostCommand=''; if($null -ne $hostItem){ $hostCommand=[string]$hostItem.CommandLine }; $hostMatchesRoot=($root.Length -gt 0 -and $hostCommand.IndexOf($root,[StringComparison]::OrdinalIgnoreCase) -ge 0); if($hostMatchesRoot -or ($includeHost -and $null -ne $hostItem)){ [void]$owned.Add($hostPid) }; $changed=$true; while($changed){ $changed=$false; foreach($item in $items){ $command=[string]$item.CommandLine; $byRoot=($root.Length -gt 0 -and $command.IndexOf($root,[StringComparison]::OrdinalIgnoreCase) -ge 0); $byParent=$owned.Contains([int]$item.ParentProcessId); if(($byRoot -or $byParent) -and $owned.Add([int]$item.ProcessId)){ $changed=$true } } }; $owned | Sort-Object";
  try {
    signal?.throwIfAborted();
    const result = await execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      windowsHide: true,
      timeout: timeoutMs,
      ...(signal === undefined ? {} : { signal }),
      env: { ...process.env, CH_MANAGED_PROFILE_ROOT: profileRoot, CH_MANAGED_HOST_PID: String(hostProcessId), CH_MANAGED_INCLUDE_HOST: includeHostFallback ? "1" : "0" },
    });
    const pids = new Set<number>();
    for (const line of String(result.stdout).split(/\r?\n/u)) {
      const pid = Number(line.trim());
      if (Number.isSafeInteger(pid) && pid > 0) pids.add(pid);
    }
    return pids;
  } catch (error) {
    if (signal?.aborted) throw error;
    return undefined;
  }
}

async function queryPosixManagedBrowserProcessIds(
  hostProcessId: number,
  profileRoot: string,
  signal: AbortSignal | undefined,
  timeoutMs: number,
  includeHostFallback: boolean,
): Promise<Set<number> | undefined> {
  try {
    signal?.throwIfAborted();
    const result = await execFile("ps", ["-axo", "pid=,ppid=,command="], {
      timeout: timeoutMs,
      ...(signal === undefined ? {} : { signal }),
    });
    const items: { pid: number; parentPid: number; command: string }[] = [];
    for (const line of String(result.stdout).split(/\r?\n/u)) {
      const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/u.exec(line);
      if (match === null) continue;
      items.push({ pid: Number(match[1]), parentPid: Number(match[2]), command: match[3] ?? "" });
    }
    const owned = new Set<number>();
    const host = items.find((item) => item.pid === hostProcessId);
    if (host?.command.includes(profileRoot) === true || (includeHostFallback && host !== undefined)) owned.add(hostProcessId);
    let changed = true;
    while (changed) {
      changed = false;
      for (const item of items) {
        if ((item.command.includes(profileRoot) || owned.has(item.parentPid)) && !owned.has(item.pid)) {
          owned.add(item.pid);
          changed = true;
        }
      }
    }
    return owned;
  } catch (error) {
    if (signal?.aborted) throw error;
    return undefined;
  }
}

/** Host-local redacted process-tree evidence used by lifecycle diagnostics. */
export async function inspectManagedBrowserProcessTree(hostProcessId: number, profileRoot: string): Promise<number | undefined> {
  const live = await queryManagedBrowserProcessIds(hostProcessId, profileRoot, undefined, 1_000, false);
  return live?.size;
}

async function resolveManagedBrowserExecutable(browser: ManagedBrowserHostOptions["browser"], explicitPath: string | undefined): Promise<string> {
  const candidates = explicitPath === undefined ? managedBrowserExecutableCandidates(browser) : [explicitPath];
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Continue through the explicit, bounded executable candidates.
    }
  }
  throw new DomGroundingUnavailableError(`managed ${browser} executable was not found`);
}

export async function clearManagedBrowserDevToolsPort(profileRoot: string): Promise<void> {
  await rm(join(profileRoot, "DevToolsActivePort"), { force: true });
}

export async function waitForDevToolsPort(
  profileRoot: string,
  child: ChildProcess,
  timeoutMs: number,
  signal: AbortSignal,
  notBeforeMs = 0,
): Promise<{ readonly port: number }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    if (child.exitCode !== null) throw new DomGroundingUnavailableError("managed browser exited before DevTools became ready");
    try {
      const portFile = join(profileRoot, "DevToolsActivePort");
      const metadata = await stat(portFile);
      if (notBeforeMs > 0 && metadata.mtimeMs < notBeforeMs) {
        await wait(50, signal);
        continue;
      }
      const lines = (await readFile(portFile, "utf8")).split(/\r?\n/u).filter(Boolean);
      const port = Number(lines[0]);
      if (Number.isInteger(port) && port > 0 && port < 65_536) return { port };
    } catch {
      // The browser has not written its loopback endpoint yet.
    }
    await wait(50, signal);
  }
  throw new DomGroundingUnavailableError("managed browser DevTools startup timed out");
}

export async function waitForDevToolsBrowserEndpoint(
  port: number,
  child: ChildProcess,
  timeoutMs: number,
  signal: AbortSignal,
  readEndpoint: (port: number, signal: AbortSignal) => Promise<string> = listDevToolsBrowserWebSocketUrl,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    if (child.exitCode !== null) throw new DomGroundingUnavailableError("managed browser exited before DevTools endpoint became ready");
    try {
      return await readEndpoint(port, signal);
    } catch (error) {
      if (signal.aborted) throw error;
      // /json/version can lag behind DevToolsActivePort during normal startup.
    }
    await wait(50, signal);
  }
  throw new DomGroundingUnavailableError("managed browser DevTools endpoint startup timed out");
}

export async function cleanupManagedBrowser(
  child: ChildProcess | undefined,
  hostProcessId: number | undefined,
  browserWebSocketDebuggerUrl: string | undefined,
  profileRoot: string,
  profileMode: ManagedBrowserProfileMode,
  profileLock: FileHandle | undefined,
  onDiagnostic: ManagedBrowserHostOptions["onCleanupDiagnostic"],
  hooks: ManagedBrowserCleanupHooks = {},
): Promise<void> {
  let processExited = true;
  const shouldManageBrowserLifecycle = child !== undefined && (
    child.exitCode === null
    || process.platform === "win32" && (hostProcessId !== undefined || browserWebSocketDebuggerUrl !== undefined)
  );
  if (shouldManageBrowserLifecycle) {
    let gracefulRequestAccepted = false;
    if (browserWebSocketDebuggerUrl !== undefined) {
      try {
        gracefulRequestAccepted = await (hooks.closeGracefully ?? closeManagedBrowserGracefully)(browserWebSocketDebuggerUrl);
      } catch {
        gracefulRequestAccepted = false;
      }
      if (!gracefulRequestAccepted) onDiagnostic?.("graceful_close_failed");
    }
    processExited = await (hooks.waitForProcessTree ?? waitForManagedBrowserProcessTree)(child, hostProcessId, profileRoot, 5_000);
    if (!processExited) {
      await (hooks.forceTerminate ?? forceTerminateManagedBrowserTree)(child, hostProcessId, profileRoot);
      processExited = await (hooks.waitForProcessTree ?? waitForManagedBrowserProcessTree)(child, hostProcessId, profileRoot, 1_500);
    }
    if (!processExited) onDiagnostic?.("process_exit_timeout");
  }
  if (profileLock !== undefined) {
    try { await profileLock.close(); } catch { onDiagnostic?.("profile_lock_release_failed"); }
    if (processExited) {
      try { await rm(join(profileRoot, ".computer-harness-profile.lock"), { force: true }); } catch { onDiagnostic?.("profile_lock_release_failed"); }
    }
  }
  if (profileMode === "ephemeral") {
    try {
      await rm(profileRoot, { recursive: true, force: true });
    } catch {
      onDiagnostic?.("profile_cleanup_failed");
    }
  }
}

const MANAGED_BROWSER_GRACEFUL_CLOSE_TIMEOUT_MS = 1_000;

export interface ManagedBrowserCloseTransport {
  command(method: string, params: Record<string, unknown>, signal: AbortSignal): Promise<unknown>;
  close(): void;
}

export async function closeManagedBrowserGracefully(
  browserWebSocketDebuggerUrl: string,
  timeoutMs = MANAGED_BROWSER_GRACEFUL_CLOSE_TIMEOUT_MS,
  connect: (webSocketUrl: string, signal: AbortSignal) => Promise<ManagedBrowserCloseTransport> = LoopbackWebSocket.connect,
): Promise<boolean> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error("managed browser graceful close timed out"));
  }, timeoutMs);
  let socket: ManagedBrowserCloseTransport | undefined;
  try {
    socket = await connect(browserWebSocketDebuggerUrl, controller.signal);
    // Browser.close normally closes the websocket before returning a CDP
    // response. A rejected command after it was sent is therefore expected;
    // process-tree exit remains the authoritative completion check.
    await socket.command("Browser.close", {}, controller.signal).catch(() => undefined);
    return !timedOut;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
    socket?.close();
  }
}

interface ManagedBrowserCleanupHooks {
  readonly closeGracefully?: typeof closeManagedBrowserGracefully;
  readonly waitForProcessTree?: typeof waitForManagedBrowserProcessTree;
  readonly forceTerminate?: typeof forceTerminateManagedBrowserTree;
}

async function waitForManagedBrowserProcessTree(
  child: ChildProcess,
  hostProcessId: number | undefined,
  profileRoot: string,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const childExited = child.exitCode !== null;
    if (process.platform !== "win32") {
      if (childExited) return true;
    } else if (hostProcessId !== undefined) {
      const live = await queryManagedBrowserProcessIds(hostProcessId, profileRoot, undefined, 2_000, false);
      // On Windows Edge may broker the spawned handle so Node never receives
      // a reliable exitCode. The current host-owned process inventory is the
      // stronger proof that the managed tree is gone.
      if (live !== undefined && live.size === 0) return true;
    }
    await wait(100, new AbortController().signal);
  }
  if (process.platform !== "win32") return child.exitCode !== null;
  if (hostProcessId === undefined) return child.exitCode !== null;
  const live = await queryManagedBrowserProcessIds(hostProcessId, profileRoot, undefined, 2_000, false);
  return live !== undefined && live.size === 0;
}

async function forceTerminateManagedBrowserTree(
  child: ChildProcess,
  hostProcessId: number | undefined,
  profileRoot: string,
): Promise<void> {
  if (process.platform !== "win32") {
    if (child.exitCode === null) child.kill();
    return;
  }
  const pids = hostProcessId === undefined ? new Set<number>() : await queryManagedBrowserProcessIds(hostProcessId, profileRoot, undefined, 2_000, false) ?? new Set<number>();
  for (const pid of [...pids].sort((left, right) => right - left)) {
    await execFile("taskkill.exe", ["/PID", String(pid), "/F"], { windowsHide: true, timeout: 1_000 }).catch(() => undefined);
  }
}

async function listDevToolsPages(port: number, signal: AbortSignal): Promise<ManagedBrowserDevToolsPage[]> {
  signal.throwIfAborted();
  try {
    const response = await fetch(`http://${LOOPBACK_HOST}:${port}/json/list`, { signal });
    if (!response.ok) throw new Error("not ok");
    const value = await response.json() as unknown;
    return Array.isArray(value) ? value.filter(isRecord) as ManagedBrowserDevToolsPage[] : [];
  } catch {
    throw new DomGroundingUnavailableError("managed browser DevTools page list was unavailable");
  }
}

async function waitForManagedBrowserStartupPageSet(
  port: number,
  browserWebSocketDebuggerUrl: string,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<{ readonly pages: ManagedBrowserDevToolsPage[]; readonly selected: ManagedBrowserPageActivity | undefined }> {
  const deadline = Date.now() + timeoutMs;
  let lastPages: ManagedBrowserDevToolsPage[] = [];
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    try {
      lastPages = await listDevToolsPages(port, signal);
      const selected = await resolveManagedBrowserActivePageSet(lastPages, (page, activitySignal) => inspectManagedPageActivity(page, browserWebSocketDebuggerUrl, activitySignal), signal, undefined, true);
      if (selected !== undefined) return { pages: lastPages, selected };
    } catch (error) {
      if (signal.aborted) throw error;
    }
    await wait(100, signal);
  }
  return { pages: lastPages, selected: undefined };
}

async function listDevToolsBrowserWebSocketUrl(port: number, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  try {
    const response = await fetch(`http://${LOOPBACK_HOST}:${port}/json/version`, { signal });
    if (!response.ok) throw new Error("not ok");
    const value = await response.json() as unknown;
    const webSocketDebuggerUrl = isRecord(value) ? value.webSocketDebuggerUrl : undefined;
    if (typeof webSocketDebuggerUrl !== "string") throw new Error("missing browser endpoint");
    const parsed = new URL(webSocketDebuggerUrl);
    if (parsed.protocol !== "ws:" || parsed.hostname !== LOOPBACK_HOST || parsed.port.length === 0) throw new Error("non-loopback browser endpoint");
    return webSocketDebuggerUrl;
  } catch {
    throw new DomGroundingUnavailableError("managed browser DevTools browser endpoint was unavailable");
  }
}

async function inspectManagedPageActivity(
  page: ManagedBrowserDevToolsPage,
  browserWebSocketDebuggerUrl: string,
  signal: AbortSignal,
): Promise<ManagedBrowserPageActivity | undefined> {
  const webSocketDebuggerUrl = page.webSocketDebuggerUrl;
  const targetId = page.id;
  if (typeof webSocketDebuggerUrl !== "string" || typeof targetId !== "string") return undefined;
  let socket: LoopbackWebSocket | undefined;
  let browserSocket: LoopbackWebSocket | undefined;
  try {
    browserSocket = await LoopbackWebSocket.connect(browserWebSocketDebuggerUrl, signal);
    const windowResponse = await browserSocket.command("Browser.getWindowForTarget", { targetId }, signal);
    const browserWindowId = windowResponse?.result?.windowId;
    if (!Number.isSafeInteger(browserWindowId) || browserWindowId <= 0) return undefined;
    let browserBounds: ManagedBrowserPageActivity["browserBounds"];
    try {
      const boundsResponse = await browserSocket.command("Browser.getWindowBounds", { windowId: browserWindowId }, signal);
      browserBounds = parseBrowserBounds(boundsResponse?.result?.bounds);
    } catch {
      // Window id remains useful for the active-tab gate; CUA ownership may
      // still be proved by the process inventory and exact PID evidence.
    }
    let visibilityState: ManagedBrowserPageActivity["visibilityState"] = "unloaded";
    let hasFocus: boolean | undefined;
    try {
      socket = await LoopbackWebSocket.connect(webSocketDebuggerUrl, signal);
      const visibilityResponse = await socket.command("Runtime.evaluate", { expression: MANAGED_PAGE_ACTIVITY_SCRIPT, returnByValue: true, awaitPromise: false }, signal);
      const visibilityValue = visibilityResponse?.result?.result?.value;
      const candidateVisibility = isRecord(visibilityValue) ? visibilityValue.visibilityState : undefined;
      if (candidateVisibility === "visible" || candidateVisibility === "hidden" || candidateVisibility === "prerender" || candidateVisibility === "unloaded") {
        visibilityState = candidateVisibility;
      }
      if (isRecord(visibilityValue) && typeof visibilityValue.hasFocus === "boolean") hasFocus = visibilityValue.hasFocus;
    } catch {
      // Browser-internal or transient page targets may reject Runtime.evaluate;
      // retain their window identity and treat them as non-active.
    }
    return {
      page,
      browserWindowId,
      visibilityState,
      ...(hasFocus === undefined ? {} : { hasFocus }),
      ...(browserBounds === undefined ? {} : { browserBounds }),
    };
  } catch (error) {
    if (signal.aborted) throw error;
    return undefined;
  } finally {
    socket?.close();
    browserSocket?.close();
  }
}

function parseBrowserBounds(value: unknown): ManagedBrowserPageActivity["browserBounds"] {
  if (!isRecord(value)) return undefined;
  const x = finiteInteger(value.left ?? value.x);
  const y = finiteInteger(value.top ?? value.y);
  const width = positiveIntegerValue(value.width);
  const height = positiveIntegerValue(value.height);
  return x === undefined || y === undefined || width === undefined || height === undefined ? undefined : { x, y, width, height };
}

function finiteInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
}

function positiveIntegerValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

export class LoopbackWebSocket {
  public static async connect(webSocketUrl: string, signal: AbortSignal): Promise<LoopbackWebSocket> {
    const parsed = new URL(webSocketUrl);
    if (parsed.protocol !== "ws:" || parsed.hostname !== LOOPBACK_HOST) throw new DomGroundingUnavailableError("managed CDP endpoint was not loopback websocket");
    const port = Number(parsed.port);
    if (!Number.isInteger(port) || port <= 0 || port >= 65_536) throw new DomGroundingUnavailableError("managed CDP endpoint port was invalid");
    const socket = createConnection({ host: LOOPBACK_HOST, port });
    const client = new LoopbackWebSocket(socket);
    await client.handshake(parsed.pathname + parsed.search, signal);
    return client;
  }

  private readonly pending = new Map<number, { resolve: (value: any) => void; reject: (error: unknown) => void }>();
  private nextId = 1;
  private frameBuffer = Buffer.alloc(0);
  private handshakeBuffer = Buffer.alloc(0);
  private handshakeDone = false;
  private handshakeResolve: (() => void) | undefined;
  private handshakeReject: ((error: unknown) => void) | undefined;
  private fragmentedText: Buffer | undefined;

  private constructor(private readonly socket: Socket) {
    this.socket = socket;
    socket.on("data", (chunk) => this.onData(Buffer.from(chunk)));
    socket.on("error", (error) => this.fail(error));
    socket.on("close", () => this.fail(new Error("managed CDP websocket closed")));
  }

  private async handshake(path: string, signal: AbortSignal): Promise<void> {
    const key = randomBytes(16).toString("base64");
    const expected = createHash("sha1").update(key + CDP_PROTOCOL_GUID).digest("base64");
    const promise = new Promise<void>((resolve, reject) => { this.handshakeResolve = resolve; this.handshakeReject = reject; });
    const onAbort = () => this.close();
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      await new Promise<void>((resolve, reject) => {
        this.socket.once("connect", resolve);
        this.socket.once("error", reject);
      });
      this.expectedHandshakeAccept = expected;
      this.socket.write(`GET ${path} HTTP/1.1\r\nHost: ${LOOPBACK_HOST}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
      await promise;
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }

  private expectedHandshakeAccept = "";

  public async command(method: string, params: Record<string, unknown>, signal: AbortSignal): Promise<any> {
    if (!this.handshakeDone) throw new DomGroundingUnavailableError("managed CDP websocket handshake was incomplete");
    signal.throwIfAborted();
    const id = this.nextId++;
    const result = new Promise<any>((resolve, reject) => this.pending.set(id, { resolve, reject }));
    const onAbort = () => {
      this.pending.get(id)?.reject(signal.reason ?? new Error("aborted"));
      this.pending.delete(id);
      this.close();
    };
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      this.socket.write(encodeClientFrame(JSON.stringify({ id, method, params })));
      return await result;
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }

  public close(): void {
    this.socket.destroy();
    this.fail(new Error("managed CDP websocket closed"));
  }

  private onData(chunk: Buffer): void {
    if (!this.handshakeDone) {
      this.handshakeBuffer = Buffer.concat([this.handshakeBuffer, chunk]);
      const marker = this.handshakeBuffer.indexOf("\r\n\r\n");
      if (marker < 0) return;
      const header = this.handshakeBuffer.subarray(0, marker).toString("ascii");
      const accept = header.split(/\r\n/u).find((line) => /^sec-websocket-accept:/iu.test(line))?.split(":", 2)[1]?.trim();
      if (!header.startsWith("HTTP/1.1 101") || accept !== this.expectedHandshakeAccept) {
        this.handshakeReject?.(new DomGroundingUnavailableError("managed CDP websocket handshake was refused"));
        this.close();
        return;
      }
      this.handshakeDone = true;
      this.handshakeResolve?.();
      this.handshakeResolve = undefined;
      this.handshakeReject = undefined;
      const rest = this.handshakeBuffer.subarray(marker + 4);
      this.handshakeBuffer = Buffer.alloc(0);
      if (rest.length > 0) this.frameBuffer = Buffer.concat([this.frameBuffer, rest]);
    } else {
      this.frameBuffer = Buffer.concat([this.frameBuffer, chunk]);
      if (this.frameBuffer.length > MAX_CDP_PAYLOAD_BYTES + 64) {
        this.fail(new DomGroundingUnavailableError("managed CDP frame buffer exceeded its bound"));
        this.close();
        return;
      }
    }
    this.parseFrames();
  }

  private parseFrames(): void {
    while (this.frameBuffer.length >= 2) {
      const first = this.frameBuffer[0]!;
      const second = this.frameBuffer[1]!;
      let offset = 2;
      let length = second & 0x7f;
      if (length === 126) {
        if (this.frameBuffer.length < 4) return;
        length = this.frameBuffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (this.frameBuffer.length < 10) return;
        const high = this.frameBuffer.readUInt32BE(2);
        const low = this.frameBuffer.readUInt32BE(6);
        if (high !== 0) {
          this.fail(new DomGroundingUnavailableError("managed CDP frame was too large"));
          this.close();
          return;
        }
        length = low;
        offset = 10;
      }
      const masked = (second & 0x80) !== 0;
      const maskOffset = masked ? 4 : 0;
      if (length > MAX_CDP_PAYLOAD_BYTES || this.frameBuffer.length < offset + maskOffset + length) {
        if (length > MAX_CDP_PAYLOAD_BYTES) {
          this.fail(new DomGroundingUnavailableError("managed CDP payload exceeded its bound"));
          this.close();
        }
        return;
      }
      const mask = masked ? this.frameBuffer.subarray(offset, offset + 4) : undefined;
      offset += maskOffset;
      const payload = Buffer.from(this.frameBuffer.subarray(offset, offset + length));
      this.frameBuffer = this.frameBuffer.subarray(offset + length);
      if (mask !== undefined) for (let index = 0; index < payload.length; index += 1) payload[index] = payload[index]! ^ mask[index % 4]!;
      const opcode = first & 0x0f;
      const final = (first & 0x80) !== 0;
      if (opcode >= 0x8 && (!final || length > 125)) {
        this.fail(new DomGroundingUnavailableError("managed CDP control frame was invalid"));
        this.close();
        return;
      }
      if (opcode === 0x8) { this.close(); return; }
      if (opcode === 0x9) { this.socket.write(encodeClientFrame(payload, 0xA)); continue; }
      if (opcode === 0x1 && !final) {
        if (this.fragmentedText !== undefined) {
          this.fail(new DomGroundingUnavailableError("managed CDP text fragmentation was nested"));
          this.close();
          return;
        }
        this.fragmentedText = payload;
        continue;
      }
      if (opcode === 0x0) {
        if (this.fragmentedText === undefined) {
          this.fail(new DomGroundingUnavailableError("managed CDP continuation frame had no text opener"));
          this.close();
          return;
        }
        this.fragmentedText = Buffer.concat([this.fragmentedText, payload]);
        if (this.fragmentedText.length > MAX_CDP_PAYLOAD_BYTES) {
          this.fail(new DomGroundingUnavailableError("managed CDP fragmented payload exceeded its bound"));
          this.close();
          return;
        }
        if (!final) continue;
        this.handleTextPayload(this.fragmentedText);
        this.fragmentedText = undefined;
        continue;
      }
      if (opcode !== 0x1 || !final) continue;
      this.handleTextPayload(payload);
    }
  }

  private handleTextPayload(payload: Buffer): void {
    try {
      const message = JSON.parse(payload.toString("utf8")) as { id?: unknown; result?: unknown; error?: unknown };
      if (typeof message.id !== "number") return;
      const pending = this.pending.get(message.id);
      if (pending === undefined) return;
      this.pending.delete(message.id);
      if (message.error !== undefined) pending.reject(new DomGroundingUnavailableError("managed CDP command failed"));
      else pending.resolve(message);
    } catch {
      this.fail(new DomGroundingUnavailableError("managed CDP returned invalid JSON"));
    }
  }

  private fail(error: unknown): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    this.handshakeReject?.(error);
    this.handshakeReject = undefined;
  }
}

function encodeClientFrame(value: string | Buffer, opcode = 0x1): Buffer {
  const payload = typeof value === "string" ? Buffer.from(value, "utf8") : value;
  const mask = randomBytes(4);
  const length = payload.length;
  const header = length < 126 ? Buffer.alloc(2) : length <= 0xffff ? Buffer.alloc(4) : Buffer.alloc(10);
  header[0] = 0x80 | opcode;
  if (length < 126) header[1] = 0x80 | length;
  else if (length <= 0xffff) { header[1] = 0x80 | 126; header.writeUInt16BE(length, 2); }
  else { header[1] = 0x80 | 127; header.writeUInt32BE(0, 2); header.writeUInt32BE(length, 6); }
  const masked = Buffer.from(payload);
  for (let index = 0; index < masked.length; index += 1) masked[index] = masked[index]! ^ mask[index % 4]!;
  return Buffer.concat([header, mask, masked]);
}

function shortHash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 16);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason ?? new Error("aborted")); return; }
    const timer = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(timer); signal.removeEventListener("abort", onAbort); reject(signal.reason ?? new Error("aborted")); };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
