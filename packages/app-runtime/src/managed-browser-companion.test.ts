import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import type { CuaDriverLike, ToolResult as CuaToolResult } from "@trycua/cua-driver";
import type { ToolCall, ToolCallId } from "@computer-harness/protocol";
import type { ModelInput, ProviderAdapter } from "@computer-harness/runtime";
import {
  createMockDomGroundingTransport,
  type CuaDriverComputerOptions,
  type CuaWindowTarget,
  type ManagedBrowserHostOptions,
  type ManagedBrowserHostRecord,
  type ManagedBrowserTarget,
} from "@computer-harness/computer-cua";
import { CuaDriverComputer } from "../../computer-cua/src/cua-driver-computer.js";
import { installFakeCuaSdkModuleForTests } from "../../computer-cua/src/cua-sdk-test-support.js";
import { ApplicationSession, type ApplicationSessionConfig } from "./application-session.js";
import { createComputer } from "./computers.js";
import { InProcessEnvironmentOwner } from "./environment-owner.js";

const BROWSER_TARGET: CuaWindowTarget = { pid: 7101, windowId: 71011 };
const NATIVE_TARGET: CuaWindowTarget = { pid: 7202, windowId: 72022 };
const RECOVERY_TARGET: CuaWindowTarget = { pid: 7202, windowId: 72023 };
const THIRD_TARGET: CuaWindowTarget = { pid: 7303, windowId: 73033 };
const WINDOW_BOUNDS = { x: 100, y: 120, width: 100, height: 100 };
installFakeCuaSdkModuleForTests();
const ONE_BY_ONE_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

type FixtureWindow = CuaWindowTarget & {
  readonly title: string;
  readonly appName: string;
};

const WINDOWS: readonly FixtureWindow[] = [
  { ...BROWSER_TARGET, title: "Managed Edge", appName: "Microsoft Edge" },
  { ...NATIVE_TARGET, title: "Native Editor", appName: "Editor" },
  { ...RECOVERY_TARGET, title: "Prepared blank", appName: "TextEdit" },
  { ...THIRD_TARGET, title: "Out of scope", appName: "Other App" },
];

type RunStep =
  | { readonly kind: "click"; readonly callId: string; readonly expectedEnabled: boolean }
  | { readonly kind: "list"; readonly callId: string }
  | { readonly kind: "switch"; readonly callId: string; readonly listCallId: string; readonly targetTitle: string }
  | { readonly kind: "action"; readonly callId: string; readonly name: string; readonly arguments: Record<string, unknown> }
  | { readonly kind: "finish" };

interface ProviderTrace {
  readonly inputs: ModelInput[];
  readonly toolNames: string[][];
  readonly listedWindows: Array<readonly ListedWindow[]>;
  readonly selectedRefs: string[];
  factoryConfig?: { computer: Record<string, unknown> };
}

interface ListedWindow {
  readonly windowRef: string;
  readonly appName?: string;
  readonly title?: string;
  readonly isCurrent: boolean;
}

interface FixtureOptions {
  readonly steps?: readonly RunStep[];
  readonly companion?: boolean;
  readonly initialTarget?: CuaWindowTarget;
  readonly allowedTargets?: readonly CuaWindowTarget[];
  readonly initialGrounding?: "hybrid-catalog-v1";
  readonly managedBrowserUrl?: string;
  readonly profileMode?: "ephemeral" | "persistent";
  readonly profileLabel?: string;
  readonly profileRoot?: string;
  readonly failure?: "bootstrap" | "host" | "delegate";
  readonly failDomCapture?: boolean;
  readonly textEditExecutableUrl?: string;
  readonly includeRecoveryWindow?: boolean;
  readonly hybridOutputPath?: string;
}

interface FixtureMetrics {
  readonly provider: ProviderTrace;
  readonly hostOptions: ManagedBrowserHostOptions[];
  readonly delegateOptions: CuaDriverComputerOptions[];
  readonly host: { starts: number; closes: number; transports: number };
  readonly bootstrap: { opens: number; closes: number; failureCleanup: number };
  readonly bootstrapDriver: ReturnType<typeof createDriver>;
  readonly delegateDriver: ReturnType<typeof createDriver>;
  readonly delegateCalls: ReturnType<typeof createDriver>["calls"];
  readonly domTargets: CuaWindowTarget[];
}

function pngWithDimensions(width: number, height: number): string {
  const bytes = Buffer.from(ONE_BY_ONE_PNG);
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes.toString("base64");
}

function temporarilySetProcessPlatform(platform: NodeJS.Platform): () => void {
  const original = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { configurable: true, value: platform });
  return () => {
    if (original === undefined) Reflect.deleteProperty(process, "platform");
    else Object.defineProperty(process, "platform", original);
  };
}

function toolResult(overrides: Partial<CuaToolResult> = {}): CuaToolResult {
  return {
    text: "ok",
    images: [],
    isError: false,
    degraded: false,
    rawJson: "{}",
    ...overrides,
  };
}

function createDriver(options: { readonly failStart?: boolean; readonly failCapture?: boolean; readonly textEditExecutableUrl?: string; readonly includeRecoveryWindow?: boolean; readonly hybridOutputPath?: string } = {}) {
  const calls: Array<{ readonly name: string; readonly input?: Record<string, unknown> }> = [];
  let hybridDocumentClean = false;
  let hybridPrimaryClosed = false;
  let hybridReopenCount = 0;
  let hybridTypedText = "";
  const reopenedWindowId = RECOVERY_TARGET.windowId + 1;
  const driver = {
    async startSession() {
      calls.push({ name: "startSession" });
      if (options.failStart === true) throw new Error("fixture bootstrap start failed");
      return { active: true, revived: false } as never;
    },
    async endSession() {
      calls.push({ name: "endSession" });
      return { active: false, session: "fixture" } as never;
    },
    async shutdown() {
      calls.push({ name: "shutdown" });
    },
    async verifyState(input: unknown) {
      const state = input as { pid?: bigint; windowId?: bigint };
      calls.push({ name: "verifyState", input: { pid: Number(state.pid), windowId: Number(state.windowId) } });
      if (options.failCapture === true) return toolResult({ isError: true, errorCode: "window_not_found" });
      return toolResult({
        images: [{ mimeType: "image/png", dataBase64: pngWithDimensions(100, 100) }],
        verification: { status: 0, stable: true, elapsedMs: 0n, samples: 1n, predicates: [] },
      });
    },
    async callTool(name: string, inputJson: string) {
      const input = JSON.parse(inputJson) as Record<string, unknown>;
      calls.push({ name, input });
      if (name === "list_windows") {
        const requestedPid = typeof input.pid === "number" ? input.pid : undefined;
        const windows = WINDOWS
          .filter((window) => options.includeRecoveryWindow === true || window.windowId !== RECOVERY_TARGET.windowId)
          .filter((window) => !(hybridPrimaryClosed && window.windowId === NATIVE_TARGET.windowId))
          .filter((window) => requestedPid === undefined || window.pid === requestedPid)
          .map((window) => ({
            pid: window.pid,
            window_id: window.windowId,
            title: window.title,
            app_name: window.appName,
            bounds: WINDOW_BOUNDS,
            is_on_screen: true,
          }));
        if (options.includeRecoveryWindow === true && hybridReopenCount > 0 && (requestedPid === undefined || requestedPid === NATIVE_TARGET.pid)) {
          windows.push({ pid: NATIVE_TARGET.pid, window_id: reopenedWindowId, title: "itinerary.txt", app_name: "TextEdit", bounds: WINDOW_BOUNDS, is_on_screen: true });
        }
        return toolResult({ structuredJson: JSON.stringify({ windows, complete: true }) });
      }
      if (name === "bring_to_front") {
        return toolResult({ structuredJson: JSON.stringify({ landed_on_target: true }) });
      }
      if (name === "type_text" && options.includeRecoveryWindow === true && typeof options.hybridOutputPath === "string") {
        hybridTypedText = String(input.text ?? "");
        hybridDocumentClean = false;
        return toolResult();
      }
      if (name === "hotkey" && options.includeRecoveryWindow === true && Array.isArray(input.keys)) {
        const keys = input.keys.map((key) => String(key).toUpperCase());
        if (keys.includes("S") && typeof options.hybridOutputPath === "string") {
          await writeFile(options.hybridOutputPath, hybridTypedText, "utf8");
          hybridDocumentClean = true;
        }
        if (keys.includes("W")) hybridPrimaryClosed = true;
        return toolResult();
      }
      if (name === "launch_app" && options.includeRecoveryWindow === true) {
        hybridReopenCount += 1;
        return toolResult({ structuredJson: JSON.stringify({ pid: NATIVE_TARGET.pid }) });
      }
      if (name === "get_window_state") {
        if (input.document_identity_query !== undefined) {
          const targetPid = Number(input.pid);
          const windowId = Number(input.window_id);
          const processStart = { seconds: 1, microseconds: 2 };
          if (options.includeRecoveryWindow === true) {
            const isDocument = hybridDocumentClean && (hybridReopenCount > 0 ? windowId === reopenedWindowId : windowId === NATIVE_TARGET.windowId);
            const target = { pid: targetPid, window_id: windowId, process_start: processStart };
            return toolResult({ structuredJson: JSON.stringify({ _private_document_proof: {
              version: "macos-document-identity-v1", snapshot_id: `hybrid-${windowId}-${isDocument ? "doc" : "blank"}`,
              status: "identity_verified", tail_revalidated: true,
              target,
              application_identity: { status: "verified", target: { ...target, bundle_id: "com.apple.TextEdit", executable_url: options.textEditExecutableUrl ?? "file:///System/Applications/TextEdit.app/Contents/MacOS/TextEdit" },
                instances: [{ pid: targetPid, process_start: processStart, bundle_id: "com.apple.TextEdit", executable_url: options.textEditExecutableUrl ?? "file:///System/Applications/TextEdit.app/Contents/MacOS/TextEdit" }] },
              frontmost_pid: targetPid, focused_window_id: windowId,
              window: { role: "AXWindow", pid: targetPid, owner_pid: targetPid, window_id: windowId, bounds: WINDOW_BOUNDS },
              document: { status: isDocument ? "ok" : "missing", type: "cf_url", matches_expected: isDocument },
              document_domain: { status: "complete_for_ax_windows", matching_window_ids: isDocument ? [windowId] : [] },
              edited: { source: "ax_close_button", close_button: { status: "verified", role: "AXButton", subrole: "AXCloseButton", pid: targetPid, window_id: windowId, ax_window_id: windowId, ax_window_matches_target: true }, value: { status: "ok", type: "cf_boolean", value: false } },
            } }) });
          }
          return toolResult({ structuredJson: JSON.stringify({ _private_document_proof: {
            version: "macos-document-identity-v1", snapshot_id: `initial-${windowId}`, status: "unstable", tail_revalidated: false,
            target: { pid: targetPid, window_id: windowId, process_start: processStart },
            application_identity: { status: "verified", target: { pid: targetPid, window_id: windowId, process_start: processStart,
              bundle_id: "com.apple.TextEdit", executable_url: options.textEditExecutableUrl ?? "file:///System/Applications/TextEdit.app/Contents/MacOS/TextEdit" },
              instances: [{ pid: targetPid, process_start: processStart, bundle_id: "com.apple.TextEdit",
                executable_url: options.textEditExecutableUrl ?? "file:///System/Applications/TextEdit.app/Contents/MacOS/TextEdit" }] },
            frontmost_pid: targetPid, focused_window_id: windowId,
            window: { role: "AXWindow", pid: targetPid, owner_pid: targetPid, window_id: windowId, bounds: WINDOW_BOUNDS },
          } }) });
        }
        if (input.include_screenshot === true) {
          return toolResult({
            images: [{ mimeType: "image/png", dataBase64: pngWithDimensions(100, 100) }],
            structuredJson: JSON.stringify({
              pid: input.pid,
              window_id: input.window_id,
              window_bounds: WINDOW_BOUNDS,
              screenshot_frame_valid: true,
              screenshot_width: 100,
              screenshot_height: 100,
              screenshot_mime_type: "image/png",
              screenshot_scale: 1,
            }),
          });
        }
        return toolResult({
          structuredJson: JSON.stringify({
            elements_complete: true,
            elements: [{ role: "Document", frame: { x: 105, y: 125, width: 90, height: 90 }, enabled: true }],
          }),
        });
      }
      if (name === "get_screen_size") {
        return toolResult({ structuredJson: JSON.stringify({ width: 100, height: 100 }) });
      }
      if (name === "get_desktop_state") {
        await writeFile(String(input.screenshot_out_file), Buffer.from(pngWithDimensions(100, 100), "base64"));
        return toolResult({ structuredJson: JSON.stringify({ screenshot_width: 100, screenshot_height: 100 }) });
      }
      return toolResult();
    },
    uniffiDestroy() {
      calls.push({ name: "uniffiDestroy" });
    },
  } as unknown as CuaDriverLike;
  return { driver, calls };
}

function listedWindowsFrom(input: ModelInput, callId: string): readonly ListedWindow[] {
  const result = input.messages
    .flatMap((message) => message.content)
    .find((block) => block.type === "tool_result" && block.result.callId === callId);
  const output = result?.type === "tool_result" ? result.result.output : undefined;
  if (result?.type !== "tool_result" || result.result.status !== "completed" ||
      output === null || typeof output !== "object" || Array.isArray(output) || !Array.isArray(output.windows)) {
    throw new Error(`fixture could not find completed list_windows result '${callId}'`);
  }
  return output.windows as unknown as readonly ListedWindow[];
}

function scriptedProvider(steps: readonly RunStep[], trace: ProviderTrace): ProviderAdapter {
  let cursor = 0;
  let pendingListCallId: string | undefined;
  return {
    id: "managed-browser-companion-fixture",
    async generate(input) {
      trace.inputs.push(input);
      trace.toolNames.push(input.tools.map((tool) => tool.name));
      const step = steps[cursor++];
      if (step === undefined) throw new Error("fixture Provider received more turns than scripted");
      if (step.kind === "click") {
        expect(input.tools.some((tool) => tool.name === "click")).toBe(step.expectedEnabled);
        // A misbehaving Provider can still request a hidden tool; Runtime must
        // reject it without sending native input to the managed browser.
        return { type: "tool_calls", calls: [{ id: step.callId as ToolCallId, name: "click", arguments: { x: 20, y: 20 } }] };
      }
      if (step.kind === "finish") {
        if (pendingListCallId !== undefined) {
          trace.listedWindows.push(listedWindowsFrom(input, pendingListCallId));
          pendingListCallId = undefined;
        }
        return { type: "finish", summary: "offline fixture finished" };
      }
      if (step.kind === "list") {
        pendingListCallId = step.callId;
        return {
          type: "tool_calls",
          calls: [{ id: step.callId as ToolCallId, name: "list_windows", arguments: {} }],
        };
      }
      if (step.kind === "action") {
        return { type: "tool_calls", calls: [{ id: step.callId as ToolCallId, name: step.name, arguments: step.arguments }] };
      }
      const windows = listedWindowsFrom(input, step.listCallId);
      trace.listedWindows.push(windows);
      pendingListCallId = undefined;
      const selected = windows.find((window) => window.title === step.targetTitle);
      if (selected === undefined) throw new Error(`fixture could not find listed target '${step.targetTitle}'`);
      trace.selectedRefs.push(selected.windowRef);
      const call: ToolCall = {
        id: step.callId as ToolCallId,
        name: "switch_window",
        arguments: { windowRef: selected.windowRef },
      };
      return { type: "tool_calls", calls: [call] };
    },
  };
}

async function createFixture(outputDir: string, options: FixtureOptions = {}) {
  const providerTrace: ProviderTrace = { inputs: [], toolNames: [], listedWindows: [], selectedRefs: [] };
  const bootstrapDriver = createDriver({ failStart: options.failure === "bootstrap", textEditExecutableUrl: options.textEditExecutableUrl, includeRecoveryWindow: options.includeRecoveryWindow, hybridOutputPath: options.hybridOutputPath });
  const delegateDriver = createDriver({ failCapture: options.failure === "delegate", textEditExecutableUrl: options.textEditExecutableUrl, includeRecoveryWindow: options.includeRecoveryWindow, hybridOutputPath: options.hybridOutputPath });
  const hostOptions: ManagedBrowserHostOptions[] = [];
  const delegateOptions: CuaDriverComputerOptions[] = [];
  const host = { starts: 0, closes: 0, transports: 0 };
  const bootstrap = { opens: 0, closes: 0, failureCleanup: 0 };
  const domTargets: CuaWindowTarget[] = [];
  const domTransport = createMockDomGroundingTransport((request) => {
    domTargets.push({ ...request.browserTarget.windowTarget });
    if (options.failDomCapture === true) throw new Error("fixture DOM capture unavailable");
    return { complete: true, tabId: `fixture-tab-${domTargets.length}`, generation: `fixture-generation-${domTargets.length}`, candidates: [] };
  });

  const computerFactoryDependencies = {
    // The fixture's CUA windows are synthetic; never merge them with the
    // machine's live Win32 inventory in Windows test runs.
    windowRelationshipProbe: null,
    importCuaComputer: async () => ({
      CuaDriverComputer: class FixtureCuaDriverComputer extends CuaDriverComputer {
        public constructor(options: CuaDriverComputerOptions) {
          delegateOptions.push(options);
          super({ ...options, driverFactory: () => delegateDriver.driver, windowCaptureRetry: { delay: async () => undefined } });
        }
      },
    }),
    openCuaBootstrapSession: async (_socketPath: string, label: string, _signal: AbortSignal) => {
      bootstrap.opens += 1;
      try {
        await bootstrapDriver.driver.startSession({ session: label } as never, { signal: new AbortController().signal });
      } catch (error) {
        bootstrap.failureCleanup += 1;
        (bootstrapDriver.driver as unknown as { uniffiDestroy?: () => void }).uniffiDestroy?.();
        throw error;
      }
      let closed = false;
      return {
        driver: bootstrapDriver.driver,
        label,
        async close() {
          if (closed) return;
          closed = true;
          bootstrap.closes += 1;
          await (bootstrapDriver.driver.endSession as (...args: unknown[]) => Promise<unknown>)({ session: label }, { signal: new AbortController().signal });
          await (bootstrapDriver.driver.shutdown as (...args: unknown[]) => Promise<unknown>)({ signal: new AbortController().signal });
          (bootstrapDriver.driver as unknown as { uniffiDestroy?: () => void }).uniffiDestroy?.();
        },
      };
    },
    createManagedBrowserHost: (options: ManagedBrowserHostOptions) => {
      hostOptions.push(options);
      return {
        async start(signal: AbortSignal): Promise<ManagedBrowserHostRecord> {
          host.starts += 1;
          const resolution = await options.resolveOwnedWindowTarget(BROWSER_TARGET.pid, signal);
          if (resolution === undefined) throw new Error("fixture managed browser window did not resolve");
          const target: ManagedBrowserTarget = {
            kind: "managed-chromium",
            browser: "edge",
            profileId: "fixture-profile",
            windowTarget: resolution.target,
            tabId: "startup-tab",
            generation: "startup-generation",
            delivery: "loopback-cdp",
          };
          return {
            target,
            processId: BROWSER_TARGET.pid,
            profileId: target.profileId,
            tabId: target.tabId,
            generation: target.generation,
            profileMode: options.profileMode ?? "ephemeral",
          };
        },
        createTransport() {
          host.transports += 1;
          return domTransport;
        },
        async close() {
          host.closes += 1;
        },
      } as unknown as import("@computer-harness/computer-cua").ManagedBrowserHost;
    },
  };

  // The injected Host failure is kept in a local option because it belongs to
  // this fixture's lifecycle behavior, not to the production Host contract.
  if (options.failure === "host") {
    const createHost = computerFactoryDependencies.createManagedBrowserHost;
    computerFactoryDependencies.createManagedBrowserHost = (hostOption) => {
      const created = createHost(hostOption);
      const originalStart = created.start.bind(created);
      created.start = async (signal) => {
        await originalStart(signal).catch(() => undefined);
        throw new Error("fixture Host start failed");
      };
      return created;
    };
  }

  const computer: Extract<ApplicationSessionConfig["computer"], { kind: "cua" }> = {
    kind: "cua",
    socketPath: "fixture-socket",
    screenshotDir: join(outputDir, "screens"),
    ...(options.companion === true ? { managedBrowserCompanion: true } : {}),
    ...(options.initialTarget === undefined ? {} : { windowTarget: options.initialTarget }),
    ...(options.allowedTargets === undefined ? {} : { windowSwitchAllowedTargets: options.allowedTargets }),
    ...(options.initialGrounding === undefined ? {} : { grounding: options.initialGrounding }),
    ...(options.managedBrowserUrl === undefined ? {} : { managedBrowserUrl: options.managedBrowserUrl }),
    ...(options.profileMode === undefined ? {} : { managedBrowserProfileMode: options.profileMode }),
    ...(options.profileLabel === undefined ? {} : { managedBrowserProfileLabel: options.profileLabel }),
    ...(options.profileRoot === undefined ? {} : { managedBrowserProfileRoot: options.profileRoot }),
  };
  const config: ApplicationSessionConfig = {
    model: "glm-5.3-flash",
    computer,
    outputDir,
    maxSteps: 20,
    maxModelRequests: 20,
    planning: false,
    memory: "off",
    batching: "off",
    contextMode: "raw",
    contextMaxHistoryEvents: 40,
    riskProfile: "experiment",
    riskGuard: "off",
    riskModel: "off",
    riskMaxModelRequests: 1,
    riskTimeoutMs: 100,
    cleanupDeadlineMs: 500,
    ...(options.initialGrounding === undefined ? {} : { grounding: options.initialGrounding }),
  };
  const session = new ApplicationSession({
    config,
    owner: new InProcessEnvironmentOwner(),
    dependencies: {
      createProvider(providerOptions) {
        providerTrace.factoryConfig = { computer: providerOptions.config.computer as unknown as Record<string, unknown> };
        return scriptedProvider(options.steps ?? [{ kind: "finish" }], providerTrace);
      },
      createComputer: ({ config: runComputer }) => createComputer(runComputer, computerFactoryDependencies),
    },
  });
  const metrics: FixtureMetrics = { provider: providerTrace, hostOptions, delegateOptions, host, bootstrap, bootstrapDriver, delegateDriver, delegateCalls: delegateDriver.calls, domTargets };
  return { session, metrics };
}

async function runFixture(session: ApplicationSession, windowSwitch: "off" | "opened-windows-v1") {
  const handle = await session.startRun("exercise managed browser companion", { windowSwitch });
  const outcome = await session.waitForActiveRun();
  return { handle, outcome };
}

describe("managed browser companion through ApplicationSession and the real tool registry", () => {
  it("runs the Host hybrid profile through ApplicationSession and production CUA without merging Browser into native recovery scope", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "hybrid-browser-textedit-runtime-"));
    const canonicalOutputDir = await realpath(outputDir);
    const profilePath = join(canonicalOutputDir, "itinerary.txt");
    const executable = join(canonicalOutputDir, "TextEdit.app", "Contents", "MacOS", "TextEdit");
    await mkdir(join(canonicalOutputDir, "TextEdit.app", "Contents", "MacOS"), { recursive: true });
    await writeFile(executable, "fixture executable");
    const executableUrl = pathToFileURL(executable).href;
    const restorePlatform = temporarilySetProcessPlatform("darwin");
    const { session, metrics } = await createFixture(outputDir, {
      steps: [{ kind: "list", callId: "hybrid-list" }, { kind: "switch", callId: "hybrid-switch", listCallId: "hybrid-list", targetTitle: "Managed Edge" }, { kind: "finish" }],
      companion: true, initialTarget: NATIVE_TARGET,
      allowedTargets: [NATIVE_TARGET, RECOVERY_TARGET], initialGrounding: "hybrid-catalog-v1",
      includeRecoveryWindow: true,
      managedBrowserUrl: "https://trains.ctrip.com/",
      textEditExecutableUrl: executableUrl,
    });
    try {
      const hybridHandle = await session.startRun("fixed T3 fixture\n", {
        windowTarget: NATIVE_TARGET,
        windowDeliveryMode: "foreground",
        windowSwitch: "opened-windows-v1",
        windowHandoff: "confirm-v1",
        grounding: "hybrid-catalog-v1",
        managedBrowserCompanion: true,
        managedBrowserUrl: "https://trains.ctrip.com/",
        nativeWebDocument: {
          primaryTarget: NATIVE_TARGET,
          recoveryTarget: RECOVERY_TARGET,
          outputPath: profilePath,
          expectedExecutableUrl: executableUrl,
        },
      });
      const hybridOutcome = await session.waitForActiveRun();
      expect(hybridOutcome).toBe("succeeded");
      expect(hybridHandle.controller.getSnapshot().modelRequestCount).toBe(3);
      expect(metrics.hostOptions[0]).toMatchObject({ url: "https://trains.ctrip.com/", profileMode: "ephemeral" });
      expect(metrics.delegateOptions[0]).toMatchObject({
        windowTarget: NATIVE_TARGET,
        recoveryWindowTarget: RECOVERY_TARGET,
        windowSwitchAllowedTargets: [NATIVE_TARGET, RECOVERY_TARGET],
        recoverBoundWindowMissing: true,
        reopenSavedDocumentGrant: { path: profilePath },
        hybridNativeWebDocumentCapability: {
          primaryTarget: NATIVE_TARGET,
          recoveryTarget: RECOVERY_TARGET,
          managedBrowserTarget: { windowTarget: BROWSER_TARGET, profileId: "fixture-profile" },
        },
      });
      expect(metrics.delegateOptions[0]?.windowSwitchAllowedTargets).not.toContainEqual(BROWSER_TARGET);
      expect(metrics.provider.listedWindows).toHaveLength(1);
      expect(metrics.provider.listedWindows[0]?.map((window) => window.title)).toContain("Managed Edge");
      expect(metrics.provider.listedWindows[0]?.map((window) => window.title)).not.toContain("Prepared blank");
      expect(metrics.domTargets).toEqual([BROWSER_TARGET]);
      expect(metrics.bootstrap.opens).toBe(1);
      expect(metrics.host.starts).toBe(1);
    } finally {
      try {
        await session.close();
      } finally {
        restorePlatform();
        await rm(outputDir, { recursive: true, force: true });
      }
    }
  });

  it("keeps Browser research, completed TextEdit close, exact recovery, and one reopen in one Runtime run", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "hybrid-browser-textedit-reopen-runtime-"));
    const canonicalOutputDir = await realpath(outputDir);
    const profilePath = join(canonicalOutputDir, "itinerary.txt");
    const executable = join(canonicalOutputDir, "TextEdit.app", "Contents", "MacOS", "TextEdit");
    await mkdir(join(canonicalOutputDir, "TextEdit.app", "Contents", "MacOS"), { recursive: true });
    await writeFile(executable, "fixture executable");
    const executableUrl = pathToFileURL(executable).href;
    const restorePlatform = temporarilySetProcessPlatform("darwin");
    const { session, metrics } = await createFixture(outputDir, {
      includeRecoveryWindow: true,
      hybridOutputPath: profilePath,
      textEditExecutableUrl: executableUrl,
      steps: [
        { kind: "list", callId: "t3-list-browser" },
        { kind: "switch", callId: "t3-switch-browser", listCallId: "t3-list-browser", targetTitle: "Managed Edge" },
        { kind: "list", callId: "t3-list-textedit" },
        { kind: "switch", callId: "t3-switch-textedit", listCallId: "t3-list-textedit", targetTitle: "Native Editor" },
        { kind: "action", callId: "t3-type-document", name: "type", arguments: { text: "Offline itinerary fixture" } },
        { kind: "action", callId: "t3-save-document", name: "hotkey", arguments: { keys: ["CMD", "S"] } },
        { kind: "action", callId: "t3-close-document", name: "hotkey", arguments: { keys: ["CMD", "W"] } },
        { kind: "list", callId: "t3-list-recovery" },
        { kind: "switch", callId: "t3-select-recovery", listCallId: "t3-list-recovery", targetTitle: "Prepared blank" },
        { kind: "action", callId: "t3-reopen-once", name: "reopen_saved_document", arguments: {} },
        { kind: "finish" },
      ],
    });
    try {
      const handle = await session.startRun("Search the fixed trains page and save the itinerary in the supplied document\n", {
        windowTarget: NATIVE_TARGET,
        windowDeliveryMode: "foreground",
        windowSwitch: "opened-windows-v1",
        windowHandoff: "confirm-v1",
        grounding: "hybrid-catalog-v1",
        managedBrowserCompanion: true,
        managedBrowserUrl: "https://trains.ctrip.com/",
        nativeWebDocument: { primaryTarget: NATIVE_TARGET, recoveryTarget: RECOVERY_TARGET, outputPath: profilePath, expectedExecutableUrl: executableUrl },
      });
      const outcome = await session.waitForActiveRun();
      const events = handle.controller.getEvents();
      const failures = events.filter((event) => event.type === "runtime.error" || event.type === "action.execution.failed");
      expect(outcome, JSON.stringify(failures)).toBe("succeeded");
      expect(metrics.domTargets).toEqual([BROWSER_TARGET]);
      expect(metrics.delegateCalls.filter((call) => call.name === "launch_app")).toHaveLength(1);
      expect(metrics.delegateCalls.find((call) => call.name === "launch_app")?.input).toMatchObject({ urls: [pathToFileURL(profilePath).href] });
      expect(events.some((event) => event.type === "computer.window.handoff.requested" && event.reasonCode === "bound_window_missing")).toBe(true);
      expect(events.some((event) => event.type === "computer.window.handoff.completed" && event.target.pid === RECOVERY_TARGET.pid && event.target.windowId === RECOVERY_TARGET.windowId)).toBe(true);
      const closeProposal = events.find((event) => event.type === "action.proposed" && event.callId === "t3-close-document");
      const closeReceipt = events.find((event) => event.type === "action.execution.completed" && closeProposal?.type === "action.proposed" && event.receipt.actionId === closeProposal.action.actionId);
      const missingBoundary = events.find((event) => event.type === "computer.window.handoff.requested" && event.reasonCode === "bound_window_missing");
      expect(closeReceipt?.type).toBe("action.execution.completed");
      expect(missingBoundary?.type === "computer.window.handoff.requested" ? missingBoundary.sourceActionId : undefined)
        .toBe(closeProposal?.type === "action.proposed" ? closeProposal.action.actionId : undefined);
      expect(events.filter((event) => event.type === "tool.call.received" && event.call.id === "t3-reopen-once")).toHaveLength(1);
      const reopenProposal = events.find((event) => event.type === "action.proposed" && event.callId === "t3-reopen-once");
      const reopenReceiptIndex = events.findIndex((event) => event.type === "action.execution.completed" && reopenProposal?.type === "action.proposed" && event.receipt.actionId === reopenProposal.action.actionId);
      const reopenReceipt = events[reopenReceiptIndex];
      expect(reopenReceipt?.type === "action.execution.completed" ? reopenReceipt.receipt.sessionAfter : undefined).toBeDefined();
      expect(events.slice(reopenReceiptIndex + 1).some((event) => event.type === "observation.created")).toBe(true);
      expect(metrics.delegateCalls.some((call) => call.name === "verifyState" && call.input?.windowId === RECOVERY_TARGET.windowId + 1)).toBe(true);
      expect(events.filter((event) => event.type === "observation.created").length).toBeGreaterThan(5);
      expect(metrics.delegateOptions[0]?.windowSwitchAllowedTargets).toEqual([NATIVE_TARGET, RECOVERY_TARGET]);
    } finally {
      try { await session.close(); } finally { restorePlatform(); await rm(outputDir, { recursive: true, force: true }); }
    }
  });

  it.each([false, true])("restores desktop/native clicks while browser clicks stay blocked (DOM capture failure: %s)", async (failDomCapture) => {
    const outputDir = await mkdtemp(join(tmpdir(), "harness-companion-surface-click-"));
    const fixture = await createFixture(outputDir, {
      companion: true,
      failDomCapture,
      steps: [
        { kind: "click", callId: "desktop-click", expectedEnabled: true },
        { kind: "list", callId: "desktop-list" },
        { kind: "switch", callId: "to-browser", listCallId: "desktop-list", targetTitle: "Managed Edge" },
        { kind: "click", callId: "blocked-browser-click", expectedEnabled: false },
        { kind: "list", callId: "browser-list" },
        { kind: "switch", callId: "to-native", listCallId: "browser-list", targetTitle: "Native Editor" },
        { kind: "click", callId: "native-click", expectedEnabled: true },
        { kind: "list", callId: "native-list" },
        { kind: "switch", callId: "back-to-browser", listCallId: "native-list", targetTitle: "Managed Edge" },
        { kind: "click", callId: "blocked-browser-click-again", expectedEnabled: false },
        { kind: "finish" },
      ],
    });
    try {
      const { handle, outcome } = await runFixture(fixture.session, "opened-windows-v1");
      const failures = handle.controller.getEvents().filter((event) => event.type === "runtime.error" || event.type === "action.execution.failed");
      expect(outcome, JSON.stringify(failures)).toBe("succeeded");
      const clicks = fixture.metrics.delegateDriver.calls.filter((call) => call.name === "click");
      expect(clicks).toHaveLength(2);
      expect(clicks[0]?.input).toMatchObject({ target: { kind: "desktop", display_id: "primary" } });
      expect(clicks[1]?.input).toMatchObject({ target: { pid: NATIVE_TARGET.pid, window_id: NATIVE_TARGET.windowId } });
      const observations = handle.controller.getEvents().filter((event) => event.type === "observation.created");
      expect(observations.some((event) => event.type === "observation.created" && event.observation.surfaceRef.kind === (failDomCapture ? "browser_tab" : "dom"))).toBe(true);
    } finally {
      await fixture.session.close();
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("keeps the default CUA run on its chosen native window without starting a browser Host", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "harness-managed-companion-default-"));
    const fixture = await createFixture(outputDir, { initialTarget: NATIVE_TARGET });
    try {
      const { handle, outcome } = await runFixture(fixture.session, "off");
      const report = await handle.report();
      expect(outcome).toBe("succeeded");
      expect(fixture.metrics.host.starts).toBe(0);
      expect(fixture.metrics.bootstrap.opens).toBe(0);
      expect(fixture.metrics.provider.toolNames[0]).not.toEqual(expect.arrayContaining(["list_windows", "switch_window"]));
      expect(fixture.metrics.delegateOptions[0]).toMatchObject({ windowTarget: NATIVE_TARGET, grounding: "off", windowSwitch: "off" });
      expect(report.summary.grounding).toBe("off");
      await fixture.session.close();
    } finally {
      await fixture.session.close();
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("switches native → managed browser → native → managed browser with fresh refs and browser-only DOM", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "harness-managed-companion-roundtrip-"));
    const fixture = await createFixture(outputDir, {
      companion: true,
      initialTarget: NATIVE_TARGET,
      allowedTargets: [NATIVE_TARGET, NATIVE_TARGET],
      managedBrowserUrl: "https://fixture.example/path?private=query",
      profileMode: "persistent",
      profileLabel: "fixture.profile",
      profileRoot: "C:\\HarnessOwned\\managed-profiles",
      steps: [
        { kind: "list", callId: "list-initial" },
        { kind: "switch", callId: "to-browser", listCallId: "list-initial", targetTitle: "Managed Edge" },
        { kind: "list", callId: "list-on-browser" },
        { kind: "switch", callId: "to-native", listCallId: "list-on-browser", targetTitle: "Native Editor" },
        { kind: "list", callId: "list-on-native" },
        { kind: "switch", callId: "back-to-browser", listCallId: "list-on-native", targetTitle: "Managed Edge" },
        { kind: "finish" },
      ],
    });
    try {
      const { handle, outcome } = await runFixture(fixture.session, "opened-windows-v1");
      const report = await handle.report();
      expect(outcome).toBe("succeeded");
      expect(handle.config.computer).toMatchObject({ managedBrowserCompanion: true, grounding: "hybrid-catalog-v1" });
      expect(fixture.metrics.provider.toolNames[0]).toEqual(expect.arrayContaining(["list_windows", "switch_window"]));
      expect(fixture.metrics.provider.toolNames[0]?.filter((name) => name === "list_windows")).toHaveLength(1);
      expect(fixture.metrics.provider.toolNames[0]?.filter((name) => name === "switch_window")).toHaveLength(1);
      expect(fixture.metrics.delegateOptions[0]).toMatchObject({
        windowTarget: NATIVE_TARGET,
        browserTarget: { windowTarget: BROWSER_TARGET },
        grounding: "hybrid-catalog-v1",
        windowSwitch: "opened-windows-v1",
        windowSwitchAllowedTargets: [NATIVE_TARGET, BROWSER_TARGET],
      });
      expect(fixture.metrics.provider.listedWindows).toHaveLength(3);
      expect(fixture.metrics.provider.listedWindows[0]?.filter((window) => window.title === "Managed Edge")).toHaveLength(1);
      expect(fixture.metrics.provider.listedWindows[0]?.some((window) => window.title === "Out of scope")).toBe(false);
      expect(fixture.metrics.provider.listedWindows[0]?.find((window) => window.title === "Native Editor")?.isCurrent).toBe(true);
      expect(new Set(fixture.metrics.provider.selectedRefs).size).toBe(3);
      expect(fixture.metrics.domTargets).toEqual([BROWSER_TARGET, BROWSER_TARGET]);
      expect(fixture.metrics.hostOptions[0]).toMatchObject({ profileMode: "persistent", profileLabel: "fixture.profile", persistentProfileRoot: "C:\\HarnessOwned\\managed-profiles" });
      expect(fixture.metrics.host.starts).toBe(1);
      expect(fixture.metrics.host.closes).toBe(1);
      expect(fixture.metrics.bootstrap.closes).toBe(1);
      expect(fixture.metrics.provider.factoryConfig?.computer).not.toHaveProperty("managedBrowserCompanion");
      expect(fixture.metrics.provider.factoryConfig?.computer).not.toHaveProperty("windowSwitchAllowedTargets");
      expect(fixture.metrics.provider.factoryConfig?.computer).not.toHaveProperty("managedBrowserProfileRoot");
      expect(fixture.metrics.provider.factoryConfig?.computer).not.toHaveProperty("managedBrowserProfileLabel");
      const reportText = JSON.stringify(report);
      expect(reportText).not.toContain("fixture.example/path?private=query");
      expect(reportText).not.toContain("HarnessOwned");
      expect(reportText).not.toContain("fixture.profile");
      expect(reportText).not.toContain("managedBrowserCompanion");
      expect(reportText).not.toContain("windowSwitchAllowedTargets");
      await fixture.session.close();
    } finally {
      await fixture.session.close();
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("starts on the CUA desktop and exposes the managed browser as a switch target", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "harness-managed-companion-desktop-"));
    const fixture = await createFixture(outputDir, {
      companion: true,
      steps: [
        { kind: "list", callId: "desktop-list" },
        { kind: "switch", callId: "desktop-to-browser", listCallId: "desktop-list", targetTitle: "Managed Edge" },
        { kind: "finish" },
      ],
    });
    try {
      const { handle, outcome } = await runFixture(fixture.session, "opened-windows-v1");
      const report = await handle.report();
      expect(outcome).toBe("succeeded");
      expect(fixture.metrics.delegateOptions[0]).not.toHaveProperty("windowTarget");
      expect(fixture.metrics.delegateOptions[0]).toMatchObject({ grounding: "hybrid-catalog-v1", windowSwitch: "opened-windows-v1" });
      expect(fixture.metrics.hostOptions[0]).toMatchObject({ profileMode: "ephemeral" });
      expect(fixture.metrics.hostOptions[0]).not.toHaveProperty("persistentProfileRoot");
      expect(fixture.metrics.delegateDriver.calls.some((call) => call.name === "get_desktop_state")).toBe(true);
      expect(fixture.metrics.domTargets).toEqual([BROWSER_TARGET]);
      expect(fixture.metrics.hostOptions[0]).toMatchObject({ profileMode: "ephemeral" });
      expect(fixture.metrics.provider.listedWindows[0]?.find((window) => window.title === "Managed Edge")?.isCurrent).toBe(false);
      expect(fixture.metrics.delegateDriver.calls.filter((call) => call.name === "bring_to_front").at(-1)?.input)
        .toMatchObject({ pid: BROWSER_TARGET.pid, window_id: BROWSER_TARGET.windowId });
      await fixture.session.close();
    } finally {
      await fixture.session.close();
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("keeps an ordinary managed-browser initial target on its existing browser binding", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "harness-managed-companion-browser-initial-"));
    const fixture = await createFixture(outputDir, {
      initialGrounding: "hybrid-catalog-v1",
      managedBrowserUrl: "https://fixture.example/browser-initial",
      steps: [{ kind: "list", callId: "browser-initial-list" }, { kind: "finish" }],
    });
    try {
      const { handle, outcome } = await runFixture(fixture.session, "opened-windows-v1");
      const report = await handle.report();
      expect(outcome).toBe("succeeded");
      expect(fixture.metrics.delegateOptions[0]).toMatchObject({ windowTarget: BROWSER_TARGET, grounding: "hybrid-catalog-v1" });
      expect(fixture.metrics.delegateOptions[0]).not.toHaveProperty("managedBrowserCompanion", true);
      expect(fixture.metrics.domTargets).toEqual([BROWSER_TARGET]);
      expect(fixture.metrics.provider.listedWindows[0]?.find((window) => window.title === "Managed Edge")?.isCurrent).toBe(true);
      expect(report.summary.computerTarget).toMatchObject({ mode: "managed-browser" });
      await fixture.session.close();
    } finally {
      await fixture.session.close();
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it.each([
    ["a nonempty exact Host allowlist", [NATIVE_TARGET, NATIVE_TARGET], ["Native Editor", "Managed Edge"]],
    ["an undefined all-open scope", undefined, ["Native Editor", "Managed Edge", "Out of scope"]],
  ] as const)("applies %s to the real list_windows inventory", async (_label, allowedTargets, expectedTitles) => {
    const outputDir = await mkdtemp(join(tmpdir(), "harness-managed-companion-scope-"));
    const fixture = await createFixture(outputDir, {
      companion: true,
      initialTarget: NATIVE_TARGET,
      ...(allowedTargets === undefined ? {} : { allowedTargets }),
      steps: [{ kind: "list", callId: "scope-list" }, { kind: "finish" }],
    });
    try {
      const { handle, outcome } = await runFixture(fixture.session, "opened-windows-v1");
      await handle.report();
      expect(outcome).toBe("succeeded");
      const titles = fixture.metrics.provider.listedWindows[0]?.map((window) => window.title).sort();
      expect(titles).toEqual([...expectedTitles].sort());
      expect(titles?.filter((title) => title === "Managed Edge")).toHaveLength(1);
      if (allowedTargets !== undefined) expect(titles).not.toContain("Out of scope");
      await fixture.session.close();
    } finally {
      await fixture.session.close();
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it.each([
    ["an empty explicit scope", [], NATIVE_TARGET, /empty Host target scope/iu],
    ["an initial target omitted from the explicit scope", [THIRD_TARGET], NATIVE_TARGET, /exact initial window/iu],
  ] as const)("rejects %s before managed Host startup", async (_label, allowedTargets, initialTarget, message) => {
    const outputDir = await mkdtemp(join(tmpdir(), "harness-managed-companion-invalid-scope-"));
    const fixture = await createFixture(outputDir, { companion: true, initialTarget, allowedTargets });
    try {
      await expect(fixture.session.startRun("reject invalid Host scope", { windowSwitch: "opened-windows-v1" })).rejects.toThrow(message);
      expect(fixture.metrics.host.starts).toBe(0);
      expect(fixture.metrics.bootstrap.opens).toBe(0);
      expect(fixture.metrics.provider.inputs).toHaveLength(0);
      await fixture.session.close();
    } finally {
      await fixture.session.close();
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it.each([
    ["bootstrap", 0, 0, 1],
    ["host", 1, 1, 0],
    ["delegate", 1, 1, 0],
  ] as const)("cleans each partially opened %s lifecycle exactly once", async (failure, expectedHostCloses, expectedBootstrapCloses, expectedBootstrapFailureCleanup) => {
    const outputDir = await mkdtemp(join(tmpdir(), `harness-managed-companion-${failure}-failure-`));
    const fixture = await createFixture(outputDir, {
      companion: true,
      initialTarget: NATIVE_TARGET,
      failure,
    });
    try {
      const { handle } = await runFixture(fixture.session, "opened-windows-v1");
      await handle.report();
      expect(fixture.session.lastRun?.outcome).toBe("failed");
      expect(fixture.metrics.host.closes).toBe(expectedHostCloses);
      expect(fixture.metrics.bootstrap.closes).toBe(expectedBootstrapCloses);
      expect(fixture.metrics.bootstrap.failureCleanup).toBe(expectedBootstrapFailureCleanup);
      if (failure === "delegate") {
        expect(fixture.metrics.delegateDriver.calls.filter((call) => call.name === "endSession")).toHaveLength(1);
        expect(fixture.metrics.delegateDriver.calls.filter((call) => call.name === "uniffiDestroy")).toHaveLength(1);
      }
      await fixture.session.close();
    } finally {
      await fixture.session.close();
      await rm(outputDir, { recursive: true, force: true });
    }
  });
});
