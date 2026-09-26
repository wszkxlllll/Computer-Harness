import { emitKeypressEvents } from "node:readline";
import type { RuntimeEvent, RunId, RunOutcome } from "@computer-harness/protocol";
import { writeRunReport, type ApplicationSession, type ApplicationSessionRunFeatureOverrides, type ApplicationSessionWindowTarget, type EventFeedNotification, type RunHandle, type WindowTargetInfo } from "@computer-harness/app-runtime";
import type { RunController } from "@computer-harness/runtime";
import type { RunSnapshot } from "@computer-harness/trajectory";
import { initialRunSnapshot } from "@computer-harness/trajectory";
import type { RiskGuardMode, RiskProfile } from "./config.js";
import { sanitizeTerminalText } from "./terminal-output.js";
import { createTuiPainter } from "./tui-painter.js";
import { limitTuiInput, paginateTuiText, removeLastTuiGrapheme, tailTuiInput, wrapTuiText } from "./tui-text.js";
import { matchGoalToWindow } from "./window-target-matcher.js";
import { resolveTuiGrounding, type TuiGroundingChoice } from "./window-grounding-policy.js";
import type { WindowSelectionStrategy } from "./window-selection-jev.js";

const LEGACY_INCREMENTAL_POLL_MS = 250;
const MAX_TUI_INPUT_LENGTH = 500;
const DEFAULT_TUI_LIFECYCLE_WAIT_MS = 1_000;
const HOME_RUN_ID = "tui-home" as RunId;
const TERMINAL_INPUT_SCOPE_NOTICE = "Input scope: this terminal only; no global hotkeys.";

export interface TuiMetadata {
  provider: string;
  computer: string;
  output: string;
  profile: RiskProfile;
  riskGuard: RiskGuardMode;
  /** Explicit host-selected target; omitted means primary desktop. */
  cuaWindowTarget?: { pid: number; windowId: number };
  /** Delivery chosen by the host for the selected window. */
  cuaWindowDeliveryMode?: "background" | "foreground";
  /** Local-only display label; never serialized into a Provider request/report. */
  cuaWindowLabel?: string;
  /** Local-only selection provenance for the TUI; never sent to a Provider. */
  cuaWindowSelectionSource?: "host" | "local_match" | "jev";
  /** False for OSWorld and other environments without host window selection. */
  windowSelectionAvailable?: boolean;
  features?: TuiFeatureSelection;
  /** True only when the explicit endpoint and independent key are present. */
  embeddingReady?: boolean;
  /** Managed-browser URL; only its host is rendered outside the URL editor. */
  managedBrowserUrl?: string;
  /** Managed profile lifecycle; paths are never rendered. */
  managedBrowserProfileMode?: "ephemeral" | "persistent";
  managedBrowserProfileLabel?: string;
  /** A Harness-owned managed browser was explicitly chosen in the picker. */
  managedBrowserSelected?: boolean;
}

export interface TuiFeatureSelection {
  planning: boolean;
  memory: "off" | "facts" | "entities";
  memoryRetrieval: "off" | "lexical" | "hybrid";
  batching: "off" | "same-control-input-v1";
  contextMode: "raw" | "recent";
  riskGuard: RiskGuardMode;
  monitor: "off" | "shadow" | "guidance";
  grounding: TuiGroundingChoice;
}

interface TuiInput extends NodeJS.ReadableStream {
  isTTY?: boolean;
  setRawMode?(mode: boolean): void;
}

interface TuiOutput extends NodeJS.WritableStream {
  isTTY?: boolean;
  columns?: number;
  rows?: number;
}

export interface TuiTerminal {
  input: TuiInput;
  output: TuiOutput;
}

export interface ApplicationTuiOptions {
  initialGoal?: string;
  terminal?: TuiTerminal;
  lifecycleWaitMs?: number;
  /** Optional explicit external window selector; never used for GUI actions. */
  windowSelector?: WindowSelectionStrategy;
}

type TuiMode = "home" | "home_details" | "features" | "windows" | "handoff" | "browser_url" | "run";
type TuiFeedState = "live" | "resync_required" | "closed";

interface PendingCorrection {
  readonly generation: number;
  readonly originHandle: RunHandle;
  pauseSucceeded: boolean;
  pauseFailed: boolean;
  cancelled: boolean;
  submitRequested: boolean;
  submitValue?: string;
}

/**
 * Keep the application session alive after a Run finishes. The terminal is
 * only a command surface; all correction, approval and abort ordering remains
 * in RunController/ApplicationSession.
 */
export async function runApplicationTui(
  session: ApplicationSession,
  metadata: TuiMetadata,
  options: ApplicationTuiOptions = {},
): Promise<void> {
  const terminal = options.terminal ?? { input: process.stdin, output: process.stdout };
  const input = terminal.input;
  const output = terminal.output;
  if (!input.isTTY || !output.isTTY || input.setRawMode === undefined) {
    throw new Error("--tui requires an interactive terminal");
  }
  const lifecycleWaitMs = options.lifecycleWaitMs ?? DEFAULT_TUI_LIFECYCLE_WAIT_MS;
  if (!Number.isInteger(lifecycleWaitMs) || lifecycleWaitMs < 1) throw new Error("TUI lifecycleWaitMs must be a positive integer");

  emitKeypressEvents(input);
  input.setRawMode(true);
  input.resume();
  let mode: TuiMode = "home";
  let activeMetadata = metadata;
  let featureSelection = normalizeTuiFeatureSelection(metadata.features, metadata.riskGuard);
  let draftFeatureSelection = { ...featureSelection };
  let featureCursor = 0;
  let windowCursor = 0;
  let windowTargets: readonly WindowTargetInfo[] = [];
  let browserUrlDraft = "";
  let windowLoading = false;
  let windowError = "";
  let windowMatchReason = "";
  let windowDiscoveryAbort: AbortController | undefined;
  let handoffDiscoveryAbort: AbortController | undefined;
  let goalWindowDiscoveryAbort: AbortController | undefined;
  let goalSubmissionPending = false;
  let goalSubmissionGeneration = 0;
  let selectedWindowTarget: ApplicationSessionWindowTarget | null | undefined = metadata.cuaWindowTarget;
  let selectedWindowDeliveryMode: "background" | "foreground" | null | undefined = metadata.cuaWindowDeliveryMode;
  let managedBrowserSelected = metadata.managedBrowserSelected === true;
  let windowChoiceExplicit = metadata.cuaWindowTarget !== undefined;
  let editMode = true;
  let inputValue = "";
  let notice = options.windowSelector === undefined ? "" : "Jev enabled: initial selection and handoff may send window names and titles to TypeSafe.";
  let lastReply = "";
  let exiting = false;
  let restored = false;
  let commandBusy = false;
  let exitPromiseResolve: (() => void) | undefined;
  let currentHandle: RunHandle | undefined;
  let currentGoal = "";
  let currentSnapshot: RunSnapshot = initialRunSnapshot(HOME_RUN_ID);
  let currentEvents: RuntimeEvent[] = [];
  let lastSequence = -1;
  let activeHandoffReasonCode: "foreground_mismatch" | "new_window_detected" | undefined;
  let feedState: TuiFeedState = "live";
  let detailPage = 0;
  let inputLimitReached = false;
  let nextCorrectionGeneration = 0;
  let pendingCorrection: PendingCorrection | undefined;
  let feedSubscription: { unsubscribe(): void } | undefined;
  let finishPromise: Promise<void> | undefined;
  const commandQueue: Array<{ operation: () => Promise<void> | void; success: string }> = [];

  const write = (value: string): void => {
    try { output.write(value); } catch { /* terminal may disappear during exit */ }
  };
  // The real console uses row-level painting. Synthetic terminal streams keep
  // complete frames so tests and embedders can inspect their output directly.
  const painter = output === process.stdout ? createTuiPainter(write) : undefined;
  const paint = (frame: string): void => {
    if (painter !== undefined) painter.paint(frame);
    else write(`\u001b[H\u001b[2J${frame}`);
  };

  const render = (): void => {
    if (mode === "run" && currentHandle !== undefined) {
      currentSnapshot = currentHandle.controller.getSnapshot();
      paint(buildTuiFrame(currentSnapshot, currentEvents, currentGoal, activeMetadata, {
        editMode,
        input: inputValue,
        notice,
        mode,
        feedState,
        sessionStatus: session.status,
        detailPage,
        inputLimitReached,
        columns: output.columns,
        rows: output.rows,
      }));
      return;
    }
    if (mode === "features") {
      paint(`${buildTuiFeaturesFrame(activeMetadata, draftFeatureSelection, featureCursor, output.columns, output.rows)}\n`);
      return;
    }
    if (mode === "windows") {
      paint(`${buildTuiWindowsFrame(activeMetadata, windowTargets, windowCursor, windowLoading, windowError, windowMatchReason, output.columns, output.rows)}\n`);
      return;
    }
    if (mode === "handoff") {
      paint(`${buildTuiHandoffFrame(activeMetadata, windowTargets, windowCursor, windowLoading, windowError, windowMatchReason, output.columns, output.rows, currentSnapshot.pendingWindowHandoff?.reasonCode ?? activeHandoffReasonCode)}\n`);
      return;
    }
    if (mode === "browser_url") {
      paint(`${buildTuiBrowserUrlFrame(activeMetadata, browserUrlDraft, inputValue, notice, output.columns, output.rows)}\n`);
      return;
    }
    if (mode === "home_details") {
      paint(buildTuiHomeDetailsFrame(activeMetadata, session, {
        editMode,
        input: inputValue,
        notice,
        feedState,
        reply: lastReply,
        detailPage,
        inputLimitReached,
        columns: output.columns,
        rows: output.rows,
      }));
      return;
    }
    paint(buildTuiHomeFrame(activeMetadata, session, {
      editMode,
      input: inputValue,
      notice,
      feedState,
      reply: lastReply,
      detailPage,
      inputLimitReached,
      columns: output.columns,
      rows: output.rows,
    }));
  };

  // Keypress streams can deliver a large paste as many synchronous events.
  // Coalesce only the terminal paint, never the input state: this keeps the
  // editor responsive under PTY backpressure while preserving every chunk.
  let renderScheduled = false;
  let renderScheduledHandle: ReturnType<typeof setImmediate> | undefined;
  const requestRender = (): void => {
    if (renderScheduled || exiting) return;
    renderScheduled = true;
    renderScheduledHandle = setImmediate(() => {
      renderScheduled = false;
      renderScheduledHandle = undefined;
      if (!exiting) render();
    });
  };
  const flushRender = (): void => {
    if (!renderScheduled) return;
    if (renderScheduledHandle !== undefined) clearImmediate(renderScheduledHandle);
    renderScheduled = false;
    renderScheduledHandle = undefined;
    if (!exiting) render();
  };

  const appendEvents = (events: readonly RuntimeEvent[]): void => {
    for (const event of events) {
      if (event.sequence <= lastSequence) continue;
      currentEvents.push(event);
      lastSequence = event.sequence;
    }
    if (currentEvents.length > 80) currentEvents = currentEvents.slice(-80);
  };

  const handleFeedNotification = (handle: RunHandle, notification: EventFeedNotification): void => {
    if (notification.type === "event") {
      appendEvents([notification.event]);
      currentSnapshot = handle.controller.getSnapshot();
      render();
      if (notification.event.type === "computer.window.handoff.requested") void openWindowHandoffPicker(handle);
      return;
    }
    feedState = notification.status;
    render();
    if (notification.status !== "resync_required") return;
    void handle.eventFeed.resync(lastSequence).then((result) => {
      if (result.status !== "ok") {
        feedState = "resync_required";
        notice = `Event feed resync unavailable: ${result.reason ?? "history gap"}`;
        render();
        return;
      }
      appendEvents(result.events);
      feedState = "live";
      // The feed repairs the same subscriber after its captured watermark;
      // events that arrived during the read are deferred and deduplicated.
      render();
    }).catch((error: unknown) => {
      feedState = "resync_required";
      notice = `Event feed resync failed: ${errorMessage(error)}`;
      render();
    });
  };

  const attachRun = (handle: RunHandle, goal: string): void => {
    feedSubscription?.unsubscribe();
    currentHandle = handle;
    currentGoal = goal;
    currentSnapshot = handle.controller.getSnapshot();
    currentEvents = [];
    handoffDiscoveryAbort?.abort();
    handoffDiscoveryAbort = undefined;
    lastSequence = -1;
    feedState = "live";
    detailPage = 0;
    inputLimitReached = false;
    mode = "run";
    editMode = false;
    inputValue = "";
    feedSubscription = handle.eventFeed.subscribe({
      afterSequence: -1,
      listener: (notification) => handleFeedNotification(handle, notification),
    });
    render();
    void session.waitForActiveRun().then(async (outcome) => {
      if (currentHandle !== handle) return;
      if (pendingCorrection?.originHandle === handle) cancelPendingCorrection("Run finished; correction draft discarded.", false, false);
      appendEvents(handle.controller.getEventsAfter(lastSequence));
      currentSnapshot = handle.controller.getSnapshot();
      feedSubscription?.unsubscribe();
      feedSubscription = undefined;
      currentHandle = undefined;
      handoffDiscoveryAbort?.abort();
      handoffDiscoveryAbort = undefined;
      mode = "home";
      editMode = true;
      inputValue = "";
      detailPage = 0;
      inputLimitReached = false;
      const failure = latestFailure(currentEvents);
      const reply = currentSnapshot.summary?.trim();
      lastReply = reply !== undefined && reply.length > 0
        ? reply
        : failure === undefined
          ? session.lastRun?.error === undefined
            ? `No final reply was reported (${outcome ?? currentSnapshot.outcome ?? "unknown"}).`
            : `Run lifecycle failed: ${session.lastRun.error}`
          : `${failure.label}: ${failure.message}`;
      notice = `Run finished: ${outcome ?? currentSnapshot.outcome ?? "unknown"}`;
      render();
      let reportNotice = "";
      let reportUnavailable = false;
      try {
        const report = await handle.report();
        await writeRunReport(report, handle.config.outputDir);
        reportNotice = `; report written to ${handle.config.outputDir}`;
      } catch (error) {
        reportUnavailable = true;
        reportNotice = "; report unavailable";
      }
      if (mode === "home" && currentHandle === undefined) {
        if (reportUnavailable) lastReply = `${lastReply}\nRun report unavailable. Check the output path and write permissions.`;
        notice = `${notice}${reportNotice}`;
        render();
      }
    }).catch((error: unknown) => {
      if (currentHandle !== handle) return;
      lastReply = `Run lifecycle failed: ${errorMessage(error)}`;
      notice = `Run lifecycle error: ${errorMessage(error)}`;
      render();
    });
  };

  const drainCommandQueue = (): void => {
    if (commandBusy || exiting) return;
    const next = commandQueue.shift();
    if (next === undefined) return;
    commandBusy = true;
    Promise.resolve().then(next.operation).then(() => { if (next.success.length > 0) notice = next.success; }).catch((error: unknown) => {
      notice = errorMessage(error);
    }).finally(() => {
      commandBusy = false;
      if (!exiting) {
        render();
        drainCommandQueue();
      }
    });
  };

  const invoke = (operation: () => Promise<void> | void, success: string): void => {
    if (exiting) return;
    commandQueue.push({ operation, success });
    drainCommandQueue();
  };

  const correctionOriginIsActive = (pending: PendingCorrection): boolean =>
    currentHandle === pending.originHandle && session.activeRun === pending.originHandle;

  const startGoal = (goal: string): void => {
    const trimmed = goal.trim();
    if (trimmed.length === 0) {
      notice = "Enter a goal before starting a Run.";
      render();
      return;
    }
    inputValue = trimmed;
    editMode = false;
    if (featureSelection.memoryRetrieval === "hybrid" && activeMetadata.embeddingReady !== true) {
      notice = "Hybrid retrieval needs --memory-embedding-endpoint and MEMORY_EMBEDDING_API_KEY before starting.";
      render();
      return;
    }
    if (managedBrowserSelected && featureSelection.grounding !== "auto" && !isManagedGrounding(featureSelection.grounding)) {
      notice = "The selected managed browser needs auto, DOM or hybrid grounding. Change Grounding in F before starting.";
      render();
      return;
    }
    const effectiveGrounding = resolveTuiGrounding(featureSelection.grounding, managedBrowserSelected ? "managed-browser" : selectedWindowTarget == null ? "desktop" : "host-window");
    const managedGrounding = isManagedGrounding(effectiveGrounding);
    if (!windowChoiceExplicit && !managedGrounding && activeMetadata.computer === "cua") {
      if (activeMetadata.windowSelectionAvailable !== false) {
        resolveGoalWindowLocally(trimmed);
        return;
      }
      requireExplicitDesktopChoice();
      return;
    }
    if (effectiveGrounding === "uia-catalog-v1" && (selectedWindowTarget === undefined || selectedWindowTarget === null)) {
      notice = "UIA grounding requires an explicitly selected CUA window. Press Esc, then W to choose one before starting.";
      render();
      return;
    }
    if (isManagedGrounding(effectiveGrounding)) {
      if (activeMetadata.computer !== "cua") {
        notice = "DOM/Hybrid grounding requires the CUA computer and shared CUA socket; choose off/UIA or relaunch with --computer cua.";
        render();
        return;
      }
      if (!isHttpUrl(activeMetadata.managedBrowserUrl)) {
        notice = "DOM/Hybrid grounding requires --managed-browser-url <http(s)-url>; choose off/UIA or relaunch with an explicit URL.";
        render();
        return;
      }
    }
    startRunForGoal(trimmed, "Starting Run…", "Run started");
  };

  const startRunForGoal = (goal: string, startNotice: string, successNotice: string): void => {
    const effectiveGrounding = resolveTuiGrounding(featureSelection.grounding, managedBrowserSelected ? "managed-browser" : selectedWindowTarget == null ? "desktop" : "host-window");
    if (effectiveGrounding === "uia-catalog-v1" && (selectedWindowTarget === undefined || selectedWindowTarget === null)) {
      notice = "UIA grounding requires an explicitly selected CUA window. Press Esc, then W to choose one before starting.";
      render();
      return;
    }
    notice = startNotice;
    goalSubmissionPending = true;
    render();
    invoke(async () => {
      try {
        const handle = await session.startRun(goal, featureOverrides(featureSelection, selectedWindowTarget, selectedWindowDeliveryMode, managedBrowserSelected, activeMetadata.managedBrowserUrl));
        goalSubmissionPending = false;
        attachRun(handle, goal);
      } catch (error) {
        goalSubmissionPending = false;
        throw error;
      }
    }, successNotice);
  };

  const clearAutomaticWindowSelection = (): void => {
    if (activeMetadata.cuaWindowSelectionSource !== "local_match" && activeMetadata.cuaWindowSelectionSource !== "jev") return;
    selectedWindowTarget = undefined;
    selectedWindowDeliveryMode = undefined;
    const { cuaWindowTarget: _target, cuaWindowDeliveryMode: _deliveryMode, cuaWindowLabel: _label, cuaWindowSelectionSource: _source, ...desktopMetadata } = activeMetadata;
    activeMetadata = desktopMetadata;
  };

  const applyWindowHandoff = async (handle: RunHandle, candidate: WindowTargetInfo): Promise<void> => {
    await handle.controller.handoffWindow(candidate);
    if (currentHandle !== handle) return;
    selectedWindowTarget = { pid: candidate.pid, windowId: candidate.windowId };
    activeHandoffReasonCode = undefined;
    activeMetadata = {
      ...activeMetadata,
      cuaWindowTarget: selectedWindowTarget,
      cuaWindowLabel: windowDisplayLabel(candidate),
      cuaWindowSelectionSource: "host",
    };
    mode = "run";
    notice = "Window handoff completed; the old frame and element references were discarded. Observing the new window.";
    render();
  };

  const ignoreProactiveWindow = (handle: RunHandle): void => {
    if (currentHandle !== handle || handle.controller.getSnapshot().pendingWindowHandoff?.reasonCode !== "new_window_detected") return;
    handoffDiscoveryAbort?.abort();
    handoffDiscoveryAbort = undefined;
    windowLoading = true;
    windowError = "";
    windowMatchReason = "Keeping the bound target. Invalidating the old frame and capturing a fresh observation…";
    mode = "handoff";
    render();
    invoke(async () => {
      try {
        await handle.controller.ignoreNewWindowAndContinueOnCurrentTarget();
        if (currentHandle !== handle) return;
        mode = "run";
        activeHandoffReasonCode = undefined;
        windowTargets = [];
        notice = "Ignored the new window; the bound target was freshly observed. The completed action was not replayed.";
      } catch (error) {
        windowError = errorMessage(error);
        windowMatchReason = "Could not continue on the current target; choose the new window or abort.";
      } finally {
        windowLoading = false;
        if (currentHandle === handle) render();
      }
    }, "");
  };

  const openWindowHandoffPicker = async (handle: RunHandle): Promise<void> => {
    if (currentHandle !== handle || handle.controller.getSnapshot().status !== "waiting_window") return;
    handoffDiscoveryAbort?.abort();
    const abort = new AbortController();
    handoffDiscoveryAbort = abort;
    windowTargets = [];
    windowCursor = 0;
    windowLoading = true;
    windowError = "";
    const handoffReason = handle.controller.getSnapshot().pendingWindowHandoff?.reasonCode;
    activeHandoffReasonCode = handoffReason;
    windowMatchReason = handoffReason === "new_window_detected"
      ? "A new visible window appeared after the completed action. Review candidates; Jev suggestions always require Enter confirmation."
      : "Run is paused after an exact foreground refusal; no input was sent. Recheck the next target.";
    mode = "handoff";
    render();
    try {
      const candidates = await handle.controller.listWindowHandoffCandidates(abort.signal);
      if (abort.signal.aborted || currentHandle !== handle) return;
      windowTargets = candidates.filter((candidate) => candidate.pid !== activeMetadata.cuaWindowTarget?.pid || candidate.windowId !== activeMetadata.cuaWindowTarget?.windowId);
      windowMatchReason = windowTargets.length === 0 ? "No other window is visible. R refreshes; A aborts the Run." : "Select a new window. Enter confirms; Esc keeps the Run waiting.";
      const surfacedCandidates = await handle.controller.listNewWindowHandoffCandidates(abort.signal);
      if (abort.signal.aborted || currentHandle !== handle) return;
      const surfacedWindowTargets = surfacedCandidates.filter((candidate) =>
        windowTargets.some((visible) => visible.pid === candidate.pid && visible.windowId === candidate.windowId &&
          visible.appName === candidate.appName && visible.title === candidate.title));
      if (options.windowSelector !== undefined && surfacedWindowTargets.length > 0) {
        windowMatchReason = "Jev is comparing the paused task with windows surfaced since the last observation.";
        render();
        const decision = await options.windowSelector.select(
          handoffReason === "new_window_detected"
            ? `${currentGoal}\nA visible window appeared after the completed action. Suggest which new candidate fits this task; the host will still require manual confirmation.`
            : `${currentGoal}\nThe previous bound window is no longer the foreground target. Choose a newly opened dialog or window needed to continue this task.`,
          surfacedWindowTargets,
          abort.signal,
          "handoff",
        );
        if (abort.signal.aborted || currentHandle !== handle) return;
        if (decision.kind === "matched") {
          const surfacedIndex = surfacedWindowTargets.findIndex((candidate) => candidate.pid === decision.target.pid && candidate.windowId === decision.target.windowId && candidate.appName === decision.target.appName && candidate.title === decision.target.title);
          const index = surfacedIndex < 0 ? -1 : windowTargets.findIndex((candidate) =>
            candidate.pid === surfacedWindowTargets[surfacedIndex]!.pid &&
            candidate.windowId === surfacedWindowTargets[surfacedIndex]!.windowId &&
            candidate.appName === surfacedWindowTargets[surfacedIndex]!.appName &&
            candidate.title === surfacedWindowTargets[surfacedIndex]!.title);
          if (surfacedIndex < 0) {
            windowMatchReason = "Jev suggestion was not in the eligible newly surfaced candidate set; choose manually.";
          } else if (index >= 0) {
            windowCursor = index;
            const candidate = windowTargets[index]!;
            if (handoffReason === "new_window_detected") {
              windowMatchReason = "Jev suggests the highlighted candidate; press Enter to confirm manually.";
            } else if (candidate.pid !== activeMetadata.cuaWindowTarget?.pid) {
              windowMatchReason = "Automatic handoff is limited to newly surfaced windows in the bound process. Choose manually or abort.";
            } else {
              windowLoading = true;
              windowMatchReason = `Jev selected newly surfaced ${windowDisplayLabel(candidate)} in the bound process; verifying this exact HWND.`;
              render();
              try {
                await applyWindowHandoff(handle, candidate);
              } catch (error) {
                windowError = errorMessage(error);
                windowMatchReason = "Automatic handoff was not applied. Choose a candidate manually or refresh the list.";
              } finally {
                windowLoading = false;
              }
            }
          } else {
            windowMatchReason = "Jev suggestion is no longer in the live candidate list; choose manually.";
          }
        } else {
          windowMatchReason = `Jev abstained (${decision.reason}); choose manually or abort.`;
        }
      } else if (windowTargets.length > 0) {
        windowMatchReason = "No newly surfaced window matches the CUA-reported foreground HWND. Choose manually or abort.";
      }
    } catch (error) {
      if (!abort.signal.aborted && currentHandle === handle) windowError = errorMessage(error);
    } finally {
      if (handoffDiscoveryAbort === abort) {
        handoffDiscoveryAbort = undefined;
        windowLoading = false;
        if (mode === "handoff" && currentHandle === handle) render();
      }
    }
  };

  const cancelGoalWindowDiscovery = (): void => {
    goalSubmissionGeneration += 1;
    goalWindowDiscoveryAbort?.abort();
    goalWindowDiscoveryAbort = undefined;
    goalSubmissionPending = false;
    clearAutomaticWindowSelection();
  };

  const requireExplicitDesktopChoice = (): void => {
    clearAutomaticWindowSelection();
    windowTargets = [];
    windowCursor = 0;
    windowLoading = false;
    windowError = "";
    windowMatchReason = "No window list. Explicitly choose Primary desktop; no target was auto-selected.";
    mode = "windows";
    editMode = false;
    render();
  };

  const resolveGoalWindowLocally = (goal: string): void => {
    goalWindowDiscoveryAbort?.abort();
    const abort = new AbortController();
    const generation = ++goalSubmissionGeneration;
    goalWindowDiscoveryAbort = abort;
    goalSubmissionPending = true;
    windowMatchReason = "";
    notice = "Matching the goal against visible window names locally…";
    render();

    void session.listWindowTargets(abort.signal).then(async (targets) => {
      if (abort.signal.aborted || exiting || generation !== goalSubmissionGeneration) return;
      let pickerTargets = targets;
      let jevReason = "";
      if (options.windowSelector !== undefined) {
        notice = "Asking Jev to choose from visible windows; their application names and titles are sent to TypeSafe. No GUI action yet.";
        render();
        const decision = await options.windowSelector.select(goal, targets, abort.signal, "initial");
        if (abort.signal.aborted || exiting || generation !== goalSubmissionGeneration) return;
        // The external choice can take several seconds. Refresh the exact
        // PID/HWND candidate set before either auto-selection or manual fallback.
        const currentTargets = await session.listWindowTargets(abort.signal);
        if (abort.signal.aborted || exiting || generation !== goalSubmissionGeneration) return;
        pickerTargets = currentTargets;
        if (decision.kind === "matched") {
          const selected = currentTargets.find((target) => target.pid === decision.target.pid && target.windowId === decision.target.windowId &&
            target.appName === decision.target.appName && target.title === decision.target.title);
          if (selected === undefined) {
            jevReason = "Jev choice changed before Run start; pick a window manually.";
          } else {
            goalWindowDiscoveryAbort = undefined;
            goalSubmissionPending = false;
            managedBrowserSelected = false;
            selectedWindowTarget = { pid: selected.pid, windowId: selected.windowId };
            selectedWindowDeliveryMode = "foreground";
            activeMetadata = {
              ...activeMetadata,
              cuaWindowTarget: selectedWindowTarget,
              cuaWindowDeliveryMode: "foreground",
              cuaWindowLabel: windowDisplayLabel(selected),
              cuaWindowSelectionSource: "jev",
              managedBrowserSelected: false,
            };
            startRunForGoal(goal, `Jev selected ${windowDisplayLabel(selected)}; exact PID/HWND rechecked. Starting Run…`, "Run started after Jev window selection.");
            return;
          }
        } else {
          jevReason = `Jev abstained (${decision.reason}); pick a window manually.`;
        }
      } else {
        const result = matchGoalToWindow(goal, targets);
        if (result.kind === "matched") {
          const selected = result.match.target;
          goalWindowDiscoveryAbort = undefined;
          goalSubmissionPending = false;
          managedBrowserSelected = false;
          selectedWindowTarget = { pid: selected.pid, windowId: selected.windowId };
          selectedWindowDeliveryMode = "foreground";
          activeMetadata = {
            ...activeMetadata,
            cuaWindowTarget: selectedWindowTarget,
            cuaWindowDeliveryMode: "foreground",
            cuaWindowLabel: windowDisplayLabel(selected),
            cuaWindowSelectionSource: "local_match",
            managedBrowserSelected: false,
          };
          const label = windowDisplayLabel(selected);
          startRunForGoal(
            goal,
            `Local goal/name matching selected ${label} (no model selected the window). Starting Run…`,
            "Run started after a local goal/name match; the model did not select the window.",
          );
          return;
        }
        jevReason = result.kind === "ambiguous"
          ? "Ambiguous local match; pick a window. Goal kept; no model chose it."
          : "No confident local match; pick a window. Goal kept; no model chose it.";
      }

      goalWindowDiscoveryAbort = undefined;
      goalSubmissionPending = false;
      clearAutomaticWindowSelection();
      windowTargets = pickerTargets;
      windowCursor = 0;
      windowError = "";
      windowMatchReason = jevReason;
      mode = "windows";
      editMode = false;
      render();
    }).catch((error: unknown) => {
      const cleanupFailure = error instanceof Error && error.name === "CuaWindowDiscoveryCleanupError";
      if (exiting) return;
      if (generation !== goalSubmissionGeneration) {
        if (abort.signal.aborted && cleanupFailure && mode === "home") {
          notice = `Window picker cleanup is unconfirmed: ${errorMessage(error)}`;
          render();
        }
        return;
      }
      if (abort.signal.aborted && !cleanupFailure) return;
      goalWindowDiscoveryAbort = undefined;
      goalSubmissionPending = false;
      clearAutomaticWindowSelection();
      windowTargets = [];
      windowCursor = 0;
      windowLoading = false;
      windowError = errorMessage(error);
      windowMatchReason = "Discovery failed. No Run started; goal kept. Refresh or pick a window.";
      mode = "windows";
      editMode = false;
      render();
    });
  };

  const refreshWindowTargets = (): void => {
    if (windowLoading || exiting) return;
    windowDiscoveryAbort?.abort();
    const abort = new AbortController();
    windowDiscoveryAbort = abort;
    windowLoading = true;
    windowError = "";
    windowMatchReason = "";
    windowTargets = [];
    windowCursor = 0;
    render();
    void session.listWindowTargets(abort.signal).then((targets) => {
      if (abort.signal.aborted || exiting) return;
      windowTargets = targets;
      windowCursor = 0;
      notice = `Window list refreshed (${targets.length} visible target${targets.length === 1 ? "" : "s"}).`;
    }).catch((error: unknown) => {
      const cleanupFailure = error instanceof Error && error.name === "CuaWindowDiscoveryCleanupError";
      if (exiting) return;
      if (abort.signal.aborted && !cleanupFailure) return;
      if (windowDiscoveryAbort !== abort) {
        if (cleanupFailure && mode === "home") {
          notice = `Window picker cleanup is unconfirmed: ${errorMessage(error)}`;
          render();
        }
        return;
      }
      windowError = errorMessage(error);
    }).finally(() => {
      if (windowDiscoveryAbort !== abort) return;
      windowDiscoveryAbort = undefined;
      windowLoading = false;
      render();
    });
  };

  const openWindowPicker = (): void => {
    if (!canSelectWindow(activeMetadata)) {
      notice = "Window selection is available only for the CUA computer backend.";
      render();
      return;
    }
    mode = "windows";
    editMode = false;
    windowCursor = 0;
    windowError = "";
    windowMatchReason = "";
    notice = "Choose a host window for subsequent Runs; the selection persists until changed.";
    render();
    refreshWindowTargets();
  };

  const selectWindowTarget = (): void => {
    if (windowLoading) {
      notice = "Window list is still loading.";
      render();
      return;
    }
    if (windowCursor === 0) {
      managedBrowserSelected = false;
      selectedWindowTarget = null;
      selectedWindowDeliveryMode = null;
      windowChoiceExplicit = true;
      const { cuaWindowTarget: _target, cuaWindowDeliveryMode: _deliveryMode, cuaWindowLabel: _label, cuaWindowSelectionSource: _source, managedBrowserSelected: _managed, ...desktopMetadata } = activeMetadata;
      activeMetadata = desktopMetadata;
      notice = inputValue.trim().length > 0
        ? "Primary desktop selected; goal draft kept. Press I, then Enter to start."
        : "Primary desktop selected for subsequent Runs.";
    } else if (featureSelection.grounding === "auto" && windowCursor === 1) {
      browserUrlDraft = "";
      mode = "browser_url";
      notice = "Enter a browser start URL, or press Enter to reuse the previous URL. Goal draft kept.";
      render();
      return;
    } else {
      const selected = windowTargets[windowCursor - 1 - (featureSelection.grounding === "auto" ? 1 : 0)];
      if (selected === undefined) {
        notice = "That window is no longer available; press R to refresh.";
        render();
        return;
      }
      selectedWindowTarget = { pid: selected.pid, windowId: selected.windowId };
      managedBrowserSelected = false;
      selectedWindowDeliveryMode = "foreground";
      windowChoiceExplicit = true;
      activeMetadata = {
        ...activeMetadata,
        cuaWindowTarget: selectedWindowTarget,
        cuaWindowDeliveryMode: "foreground",
        cuaWindowLabel: windowDisplayLabel(selected),
        cuaWindowSelectionSource: "host",
        managedBrowserSelected: false,
      };
      notice = inputValue.trim().length > 0
        ? `Window selected; goal draft kept. Press I, then Enter to start: ${windowDisplayLabel(selected)}. A new Save As/dialog window requires your explicit handoff confirmation.`
        : `Window selected for subsequent Runs: ${windowDisplayLabel(selected)}. A new Save As/dialog window requires your explicit handoff confirmation.`;
    }
    mode = "home";
    windowError = "";
    windowMatchReason = "";
    render();
  };

  const cancelPendingCorrection = (message: string, renderNow = true, resumeIfPaused = true): void => {
    const pending = pendingCorrection;
    const shouldResume = resumeIfPaused && pending?.pauseSucceeded === true && pending.submitRequested === false &&
      correctionOriginIsActive(pending);
    if (pending !== undefined) {
      pending.cancelled = true;
      pendingCorrection = undefined;
      nextCorrectionGeneration += 1;
    }
    editMode = false;
    inputValue = "";
    inputLimitReached = false;
    notice = message;
    if (renderNow && !exiting) render();
    if (shouldResume && pending !== undefined && pending.originHandle.controller.getSnapshot().status === "paused") {
      void pending.originHandle.controller.resume().then(() => { if (!exiting) render(); }).catch((error: unknown) => {
        if (!exiting) {
          notice = `Correction cancelled; resume failed: ${errorMessage(error)}`;
          render();
        }
      });
    }
  };

  const submitAfterPause = async (pending: PendingCorrection, value: string): Promise<void> => {
    if (pending.cancelled || pendingCorrection?.generation !== pending.generation || !correctionOriginIsActive(pending)) {
      if (correctionOriginIsActive(pending) && pending.originHandle.controller.getSnapshot().status === "paused") await pending.originHandle.controller.resume().catch(() => undefined);
      return;
    }
    try {
      await pending.originHandle.controller.submitUserInput(value);
    } catch (error) {
      const originActive = correctionOriginIsActive(pending);
      pendingCorrection = undefined;
      if (originActive && pending.originHandle.controller.getSnapshot().status === "paused") await pending.originHandle.controller.resume().catch(() => undefined);
      notice = `Correction failed: ${errorMessage(error)}`;
      return;
    }
    if (pending.cancelled || pendingCorrection?.generation !== pending.generation) {
      if (correctionOriginIsActive(pending) && pending.originHandle.controller.getSnapshot().status === "paused") await pending.originHandle.controller.resume().catch(() => undefined);
      return;
    }
    const originActive = correctionOriginIsActive(pending);
    pendingCorrection = undefined;
    if (originActive && pending.originHandle.controller.getSnapshot().status === "paused") await pending.originHandle.controller.resume();
    notice = "Correction submitted; old decision invalidated by Controller";
  };

  const submitCorrection = (value: string): void => {
    const trimmed = value.trim();
    if (trimmed.length === 0 || currentHandle === undefined) {
      editMode = true;
      notice = "Enter a correction before submitting.";
      render();
      return;
    }
    const pending = pendingCorrection;
    if (pending !== undefined) {
      if (pending.pauseFailed || pending.cancelled) {
        notice = "Correction was not sent because the pause barrier failed.";
        render();
        return;
      }
      pending.submitRequested = true;
      pending.submitValue = trimmed;
      editMode = false;
      inputValue = "";
      inputLimitReached = false;
      notice = "Correction queued; waiting for the pause barrier.";
      render();
      if (pending.pauseSucceeded) {
        invoke(() => submitAfterPause(pending, trimmed), "");
      }
      return;
    }
    editMode = false;
    inputValue = "";
    inputLimitReached = false;
    invoke(async () => {
      await session.submitUserInput(trimmed);
      if (session.activeRun?.controller.getSnapshot().status === "paused") await session.resume();
    }, "Correction submitted; old decision invalidated by Controller");
  };

  const beginCorrectionPause = (): void => {
    const pending: PendingCorrection = {
      generation: ++nextCorrectionGeneration,
      originHandle: currentHandle!,
      pauseSucceeded: false,
      pauseFailed: false,
      cancelled: false,
      submitRequested: false,
    };
    pendingCorrection = pending;
    editMode = true;
    inputValue = "";
    inputLimitReached = false;
    detailPage = 0;
    notice = "Pausing Run before correction; waiting for in-flight work to quiesce…";
    render();
    void (async () => {
      try {
        await pending.originHandle.controller.pause("paused before TUI correction");
      } catch (error) {
        if (pending.cancelled || pendingCorrection?.generation !== pending.generation) return;
        pending.pauseFailed = true;
        notice = `Correction unavailable: ${errorMessage(error)}`;
        render();
        return;
      }
      if (pending.cancelled || pendingCorrection?.generation !== pending.generation) {
        if (correctionOriginIsActive(pending) && pending.originHandle.controller.getSnapshot().status === "paused") await pending.originHandle.controller.resume().catch(() => undefined);
        return;
      }
      pending.pauseSucceeded = true;
      if (pending.submitRequested && pending.submitValue !== undefined) {
        await submitAfterPause(pending, pending.submitValue);
        return;
      }
      notice = "Run paused; correction draft is ready. Press Enter to submit or Esc to cancel.";
      render();
    })();
  };

  const requestExit = (): void => {
    if (finishPromise !== undefined) return;
    exiting = true;
    windowDiscoveryAbort?.abort();
    goalSubmissionGeneration += 1;
    goalWindowDiscoveryAbort?.abort();
    goalWindowDiscoveryAbort = undefined;
    goalSubmissionPending = false;
    if (pendingCorrection !== undefined) cancelPendingCorrection("Correction draft discarded for exit", false, false);
    commandQueue.length = 0;
    finishPromise = (async () => {
      if (session.activeRun !== undefined) {
        try { session.abort("TUI exit requested"); } catch { /* already finished */ }
      }
      const closing = session.close().catch(() => undefined);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<"timed_out">((resolveTimeout) => {
        timer = setTimeout(() => resolveTimeout("timed_out"), lifecycleWaitMs);
      });
      const result = await Promise.race([closing.then(() => "closed" as const), timeout]);
      if (timer !== undefined) clearTimeout(timer);
      if (result === "timed_out") session.markEnvironmentPending("TUI exited before Run cleanup was confirmed");
      exitPromiseResolve?.();
    })();
  };

  const appendInput = (text: string): void => {
    // Keypress events can carry a complete pasted UTF-8 chunk. Keep it as a
    // single logical input and remove only line separators used by the paste.
    const pasted = text.replace(/[\r\n]+/gu, " ");
    const limited = limitTuiInput(`${inputValue}${pasted}`, MAX_TUI_INPUT_LENGTH);
    inputValue = limited.value;
    inputLimitReached = limited.truncated;
    if (inputLimitReached) notice = `Input limit reached (${MAX_TUI_INPUT_LENGTH} characters)`;
  };

  const detailPageCount = (): number => {
    const width = tuiWidth(output.columns);
    const rows = Math.max(12, output.rows ?? process.stdout.rows ?? 24);
    const homeUi = {
      editMode,
      input: inputValue,
      notice,
      feedState,
      reply: lastReply,
      detailPage: 0,
      inputLimitReached,
      columns: output.columns,
      rows: output.rows,
    };
    if (mode === "home_details") {
      const frame = buildTuiHomeDetailsFrame(activeMetadata, session, homeUi);
      const pageCount = /Details \[1\/(\d+)\]/u.exec(frame)?.[1];
      return pageCount === undefined ? 1 : Number(pageCount);
    }
    if (mode === "home") {
      const frame = buildTuiHomeFrame(activeMetadata, session, homeUi);
      const pageCount = /Details \[1\/(\d+)\]/u.exec(frame)?.[1];
      return pageCount === undefined ? 1 : Number(pageCount);
    }
    const detail = mode === "run" && currentHandle !== undefined
      ? detailForSnapshot(currentHandle.controller.getSnapshot(), currentEvents)
      : undefined;
    if (detail === undefined) return 1;
    return paginateTuiText(detail.text, Math.max(1, width - 4), 0, detailLineLimit(rows, width, {
      editMode, notice, inputLimitReached,
    })).pageCount;
  };

  const changeDetailPage = (delta: number): void => {
    detailPage = Math.min(Math.max(0, detailPage + delta), detailPageCount() - 1);
    render();
  };

  const onKeypress = (text: string | undefined, key: { name?: string; ctrl?: boolean }): void => {
    const printable = typeof text === "string" ? text : "";
    const keyName = typeof key.name === "string"
      ? key.name.toLowerCase()
      : (!editMode && printable.length === 1 ? printable.toLowerCase() : undefined);
    if (key.ctrl && keyName === "c") {
      if (pendingCorrection !== undefined) cancelPendingCorrection("Abort requested; correction draft discarded", false, false);
      if (currentHandle !== undefined) {
        try { session.abort("Ctrl+C from TUI"); notice = "Abort requested"; } catch { /* finished concurrently */ }
        render();
      } else {
        requestExit();
      }
      return;
    }
    if (goalSubmissionPending) {
      if (keyName === "q") {
        requestExit();
        return;
      }
      if (keyName === "escape") {
        if (goalWindowDiscoveryAbort !== undefined) {
          cancelGoalWindowDiscovery();
          mode = "home";
          editMode = false;
          windowMatchReason = "";
          notice = "Local matching cancelled; goal draft kept. Press I then Enter to retry, or W to choose a window.";
        } else {
          notice = "Run creation is still in progress. Press Q or Ctrl-C to exit.";
        }
        render();
        return;
      }
      if (keyName === "w" && goalWindowDiscoveryAbort !== undefined) {
        cancelGoalWindowDiscovery();
        openWindowPicker();
        return;
      }
      if (keyName === "return") {
        notice = "Goal submission is still in progress; wait for local window matching or the Run start.";
        render();
      }
      return;
    }
    if (mode === "browser_url") {
      if (keyName === "escape") {
        browserUrlDraft = "";
        mode = "windows";
        notice = "Browser URL entry cancelled; previous target and goal draft kept.";
        render();
        return;
      }
      if (keyName === "backspace") { browserUrlDraft = removeLastTuiGrapheme(browserUrlDraft); requestRender(); return; }
      if (keyName === "return") {
        const browserUrl = browserUrlDraft.trim() || activeMetadata.managedBrowserUrl;
        if (!isHttpUrl(browserUrl)) {
          notice = "Enter a complete http(s) URL without embedded credentials; no Run started.";
          render();
          return;
        }
        managedBrowserSelected = true;
        selectedWindowTarget = null;
        selectedWindowDeliveryMode = null;
        windowChoiceExplicit = true;
        browserUrlDraft = "";
        const { cuaWindowTarget: _target, cuaWindowDeliveryMode: _deliveryMode, cuaWindowLabel: _label, cuaWindowSelectionSource: _source, ...previousMetadata } = activeMetadata;
        activeMetadata = { ...previousMetadata, managedBrowserUrl: browserUrl.trim(), managedBrowserSelected: true };
        mode = "home";
        editMode = false;
        notice = `Harness-managed browser selected (${new URL(browserUrl).host}); auto grounding will use DOM + UIA. Goal draft kept.`;
        render();
        return;
      }
      if (!key.ctrl && printable.length > 0) {
        browserUrlDraft = limitTuiInput(`${browserUrlDraft}${printable.replace(/[\r\n]+/gu, " ")}`, 2048).value;
        requestRender();
      }
      return;
    }
    if (mode === "handoff") {
      if (keyName === "a" || keyName === "q") {
        handoffDiscoveryAbort?.abort();
        handoffDiscoveryAbort = undefined;
        try { session.abort("window handoff declined from TUI"); } catch { /* finished concurrently */ }
        notice = "Window handoff declined; abort requested.";
        mode = "run";
        render();
        return;
      }
      if (keyName === "escape") {
        handoffDiscoveryAbort?.abort();
        handoffDiscoveryAbort = undefined;
        mode = "run";
        notice = "Window handoff still waiting. Press H to inspect candidates, or A to abort.";
        render();
        return;
      }
      if (keyName === "c") {
        const handle = currentHandle;
        if (handle?.controller.getSnapshot().pendingWindowHandoff?.reasonCode !== "new_window_detected") {
          windowMatchReason = "Continuing on the current target is allowed only for a proactive new-window notice; choose a target or abort this mismatch.";
          render();
          return;
        }
        ignoreProactiveWindow(handle);
        return;
      }
      if (keyName === "up" || keyName === "k") { windowCursor = (windowCursor + windowTargets.length - 1) % Math.max(1, windowTargets.length); render(); return; }
      if (keyName === "down" || keyName === "j") { windowCursor = (windowCursor + 1) % Math.max(1, windowTargets.length); render(); return; }
      if (keyName === "r") { if (currentHandle !== undefined) void openWindowHandoffPicker(currentHandle); return; }
      if (keyName === "return") {
        if (windowLoading) { windowMatchReason = "Wait for the window list before confirming."; render(); return; }
        const candidate = windowTargets[windowCursor];
        const handle = currentHandle;
        if (candidate === undefined || handle === undefined) { windowMatchReason = "No candidate selected; press R to refresh."; render(); return; }
        windowLoading = true;
        windowMatchReason = "Confirming exact window identity and capturing a fresh frame…";
        render();
        invoke(async () => {
          try {
            await applyWindowHandoff(handle, candidate);
          } catch (error) {
            windowError = errorMessage(error);
            windowMatchReason = "Handoff failed without replaying the refused action. Refresh or choose another candidate.";
          } finally {
            windowLoading = false;
          }
        }, "");
      }
      return;
    }
    if (keyName === "pageup" || keyName === "pagedown") {
      if (mode === "home") {
        mode = "home_details";
        detailPage = 0;
        render();
      } else if (mode === "home_details") {
        changeDetailPage(keyName === "pageup" ? -1 : 1);
      } else {
        changeDetailPage(keyName === "pageup" ? -1 : 1);
      }
      return;
    }
    if (mode === "home_details" && (keyName === "escape" || keyName === "q")) {
      mode = "home";
      render();
      return;
    }
    // Details is read-only even when opened from the focused goal editor.
    // Only the navigation/return keys above and Ctrl-C (handled above) act;
    // printable input, Backspace and Enter must not mutate or submit a draft.
    if (mode === "home_details") return;
    if (keyName === "escape" && pendingCorrection !== undefined && !editMode) {
      cancelPendingCorrection("Correction cancelled; draft discarded.");
      return;
    }
    // Uppercase F is an explicit home-screen shortcut, even while the goal
    // editor is focused. Lowercase f remains ordinary goal text.
    if (mode === "home" && editMode && keyName === "f" && printable === "F") {
      editMode = false;
      draftFeatureSelection = { ...featureSelection };
      mode = "features";
      notice = "Choose features for the next Run; arrows move, Space/Left/Right change, Enter saves.";
      render();
      return;
    }
    // Keep D available from the focused goal editor without making ordinary
    // lowercase goal text a navigation shortcut. PageDown is the alternate
    // path for keyboards that cannot send an explicit uppercase character.
    if (mode === "home" && editMode && keyName === "d" && printable === "D") {
      mode = "home_details";
      detailPage = 0;
      render();
      return;
    }
    if (editMode) {
      if (keyName === "escape") {
        if (pendingCorrection !== undefined) {
          cancelPendingCorrection(
            pendingCorrection.pauseSucceeded
              ? "Correction cancelled; resuming Run."
              : "Correction cancelled; pending pause will not submit the draft.",
          );
          return;
        }
        editMode = false;
        if (mode === "home") {
          notice = inputValue.trim().length > 0 ? "Goal draft kept." : "Goal editor closed.";
        } else {
          inputValue = "";
          inputLimitReached = false;
          notice = currentHandle?.controller.getSnapshot().status === "paused"
            ? "Correction cancelled; Run remains paused. Press R to resume."
            : "Correction draft discarded.";
        }
        render();
        return;
      }
      if (keyName === "backspace") { inputValue = removeLastTuiGrapheme(inputValue); inputLimitReached = false; requestRender(); return; }
      if (keyName === "return") {
        // A paste and Enter can arrive in the same event turn. Paint the
        // complete draft once before consuming it so the visible editor does
        // not appear to have dropped the pasted text.
        flushRender();
        const value = inputValue;
        if (mode === "home") {
          startGoal(value);
        } else {
          editMode = false;
          inputValue = "";
          inputLimitReached = false;
          submitCorrection(value);
        }
        render();
        return;
      }
      if (!key.ctrl && printable.length > 0) { appendInput(printable); requestRender(); }
      return;
    }
    if (mode === "features") {
      if (keyName === "escape") {
        draftFeatureSelection = { ...featureSelection };
        mode = "home";
        notice = "Feature selection cancelled; previous settings kept.";
        render();
        return;
      }
      if (keyName === "up" || keyName === "k") {
        featureCursor = (featureCursor + tuiFeatureRows.length - 1) % tuiFeatureRows.length;
        render();
        return;
      }
      if (keyName === "down" || keyName === "j") {
        featureCursor = (featureCursor + 1) % tuiFeatureRows.length;
        render();
        return;
      }
      if (keyName === "return") {
        featureSelection = { ...draftFeatureSelection };
        activeMetadata = { ...activeMetadata, riskGuard: featureSelection.riskGuard, features: { ...featureSelection } };
        mode = "home";
        notice = "Feature selection saved for the next Run.";
        render();
        return;
      }
      if (keyName === "space" || printable === " " || keyName === "left" || keyName === "right") {
        const direction = keyName === "left" ? -1 : 1;
        draftFeatureSelection = changeTuiFeature(draftFeatureSelection, featureCursor, keyName === "space" || printable === " " ? 1 : direction);
        if (draftFeatureSelection.memory === "off") draftFeatureSelection = { ...draftFeatureSelection, memoryRetrieval: "off" };
        if (draftFeatureSelection.memoryRetrieval === "hybrid" && draftFeatureSelection.memory === "off") draftFeatureSelection = { ...draftFeatureSelection, memoryRetrieval: "off" };
        render();
        return;
      }
      return;
    }
    if (mode === "windows") {
      if (keyName === "escape") {
        windowDiscoveryAbort?.abort();
        windowDiscoveryAbort = undefined;
        windowLoading = false;
        mode = "home";
        notice = "Window selection cancelled; previous target kept.";
        render();
        return;
      }
      if (keyName === "up" || keyName === "k") {
        const optionCount = windowTargets.length + 1 + (featureSelection.grounding === "auto" ? 1 : 0);
        windowCursor = (windowCursor + optionCount - 1) % optionCount;
        render();
        return;
      }
      if (keyName === "down" || keyName === "j") {
        const optionCount = windowTargets.length + 1 + (featureSelection.grounding === "auto" ? 1 : 0);
        windowCursor = (windowCursor + 1) % optionCount;
        render();
        return;
      }
      if (keyName === "r") {
        refreshWindowTargets();
        return;
      }
      if (keyName === "return") {
        selectWindowTarget();
        return;
      }
      return;
    }
    if (mode === "home") {
      if (keyName === "d") {
        mode = "home_details";
        detailPage = 0;
        render();
        return;
      }
      if (keyName === "f") {
        featureCursor = 0;
        draftFeatureSelection = { ...featureSelection };
        mode = "features";
        notice = "Choose features for the next Run; arrows move, Space/Left/Right change, Enter saves.";
        render();
        return;
      }
      if (keyName === "w") {
        if (!canSelectWindow(activeMetadata)) {
          notice = "Window selection is available only for the CUA computer backend.";
          render();
        } else {
          openWindowPicker();
        }
        return;
      }
      if (keyName === "i" || keyName === "return") { editMode = true; render(); return; }
      if (keyName === "q" || keyName === "escape") { requestExit(); return; }
      if (!key.ctrl && printable.length > 0) { editMode = true; appendInput(printable); requestRender(); }
      return;
    }
    const snapshot = currentHandle?.controller.getSnapshot();
    if (snapshot === undefined) return;
    if (snapshot.status === "waiting_window") {
      if (keyName === "h") { if (currentHandle !== undefined) void openWindowHandoffPicker(currentHandle); return; }
      if (keyName === "c" && snapshot.pendingWindowHandoff?.reasonCode === "new_window_detected") {
        if (currentHandle !== undefined) ignoreProactiveWindow(currentHandle);
        return;
      }
      if (keyName === "a" || keyName === "q") { try { session.abort("window handoff declined from TUI"); } catch { /* finished concurrently */ } notice = "Window handoff declined; abort requested."; render(); }
      return;
    }
    if (keyName === "i") {
      const enterCorrection = () => {
        pendingCorrection = undefined;
        nextCorrectionGeneration += 1;
        editMode = true;
        inputValue = "";
        inputLimitReached = false;
        detailPage = 0;
        notice = snapshot.status === "waiting_approval"
          ? "Correction will revoke the pending approval before entering the Controller Inbox"
          : "Correction mode: submit to invalidate the old decision";
        render();
      };
      if (snapshot.status === "running") {
        if (commandBusy) {
          notice = "Another Controller command is still in progress; wait before starting correction.";
          render();
        } else {
          beginCorrectionPause();
        }
      } else if (snapshot.status === "paused" || snapshot.status === "waiting_user" || snapshot.status === "waiting_approval") {
        enterCorrection();
      } else {
        notice = `Correction is unavailable while Run is ${snapshot.status}`;
        render();
      }
      return;
    }
    if (keyName === "a") {
      if (pendingCorrection !== undefined) cancelPendingCorrection("Abort requested; correction draft discarded", false, false);
      try { session.abort("aborted from TUI"); notice = "Abort requested"; } catch (error) { notice = errorMessage(error); }
      render();
      return;
    }
    if (keyName === "p") { invoke(() => session.pause(), "Pause requested"); return; }
    if (keyName === "r") { invoke(() => session.resume(), "Resume requested"); return; }
    if (keyName === "s") { notice = "Latest observation is recorded in the Run artifacts"; render(); return; }
    if (snapshot.status === "waiting_approval" && (keyName === "y" || keyName === "n")) {
      invoke(() => session.resolveApproval(keyName === "y"), keyName === "y" ? "Approval accepted" : "Approval rejected");
      return;
    }
    if (keyName === "q" || keyName === "escape") {
      try { session.abort("TUI exit requested"); } catch { /* finished concurrently */ }
      notice = "Abort requested; waiting for cleanup before exit";
      render();
      requestExit();
    }
  };

  const onResize = (): void => { painter?.invalidate(); render(); };
  const onEnd = (): void => requestExit();
  const onSigint = (): void => onKeypress("", { name: "c", ctrl: true });
  input.on("keypress", onKeypress);
  input.once("end", onEnd);
  output.on?.("resize", onResize);
  process.once("SIGINT", onSigint);
  write("\u001b[?25l");
  render();

  try {
    if (options.initialGoal?.trim()) startGoal(options.initialGoal);
    await new Promise<void>((resolveExit) => { exitPromiseResolve = resolveExit; });
    await finishPromise;
  } finally {
    feedSubscription?.unsubscribe();
    handoffDiscoveryAbort?.abort();
    input.off("keypress", onKeypress);
    input.off("end", onEnd);
    output.off?.("resize", onResize);
    process.removeListener("SIGINT", onSigint);
    if (!restored) {
      restored = true;
      try { input.setRawMode?.(false); } catch { /* terminal already closed */ }
      input.pause();
      write("\u001b[?25h\n");
    }
  }
}

/**
 * Compatibility wrapper for callers that already own one Controller. It uses
 * the Controller's incremental event watermark and is not the persistent
 * application session entry used by the CLI.
 */
export async function runWithTuiControls(
  controller: RunController,
  goal: string,
  metadata: TuiMetadata,
  markControllerStarted?: () => void,
): Promise<RunOutcome> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("--tui requires an interactive terminal");
  emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  let events: RuntimeEvent[] = [];
  let lastSequence = -1;
  let editMode = false;
  let input = "";
  let notice = "";
  const render = (): void => {
    const added = controller.getEventsAfter(lastSequence);
    if (added.length > 0) {
      events = [...events, ...added].slice(-80);
      lastSequence = added[added.length - 1]!.sequence;
    }
    process.stdout.write(`\u001b[H\u001b[2J${buildTuiFrame(controller.getSnapshot(), events, goal, metadata, { editMode, input, notice })}`);
  };
  const onKeypress = (text: string | undefined, key: { name?: string; ctrl?: boolean }) => {
    const printable = typeof text === "string" ? text : "";
    const keyName = typeof key.name === "string"
      ? key.name.toLowerCase()
      : (!editMode && printable.length === 1 ? printable.toLowerCase() : undefined);
    if (key.ctrl && keyName === "c") { try { controller.cancel("Ctrl+C from TUI"); } catch { /* already finished */ } return; }
    if (editMode) {
      if (keyName === "escape") { editMode = false; input = ""; return; }
      if (keyName === "backspace") { input = removeLastTuiGrapheme(input); return; }
      if (keyName === "return") { const value = input.trim(); editMode = false; input = ""; if (value.length > 0) void controller.submitUserInput(value); return; }
      if (!key.ctrl && printable.length > 0) input = limitTuiInput(`${input}${printable.replace(/[\r\n]+/gu, " ")}`, MAX_TUI_INPUT_LENGTH).value;
      return;
    }
    if (keyName === "i") { editMode = true; input = ""; return; }
    if (keyName === "a") { try { controller.cancel("aborted from TUI"); } catch { /* already finished */ } return; }
    if (keyName === "p") void controller.pause("paused from TUI").catch(() => undefined);
    if (keyName === "r") void controller.resume().catch(() => undefined);
    const snapshot = controller.getSnapshot();
    if (snapshot.status === "waiting_approval" && (keyName === "y" || keyName === "n")) {
      const requestId = snapshot.pendingApproval?.requestId;
      if (requestId !== undefined) void controller.resolveApproval(requestId, keyName === "y").catch(() => undefined);
    }
  };
  process.stdin.on("keypress", onKeypress);
  const timer = setInterval(render, LEGACY_INCREMENTAL_POLL_MS);
  process.stdout.write("\u001b[?25l");
  render();
  try {
    markControllerStarted?.();
    const outcome = await controller.start(goal);
    render();
    return outcome;
  } finally {
    clearInterval(timer);
    process.stdin.off("keypress", onKeypress);
    process.stdin.setRawMode(false);
    process.stdin.pause();
    process.stdout.write("\u001b[?25h\n");
  }
}

interface TuiFrameUi {
  readonly editMode: boolean;
  readonly input: string;
  readonly notice: string;
  readonly mode?: TuiMode | undefined;
  readonly feedState?: TuiFeedState | undefined;
  readonly sessionStatus?: string | undefined;
  readonly detailPage?: number | undefined;
  readonly inputLimitReached?: boolean | undefined;
  readonly columns?: number | undefined;
  readonly rows?: number | undefined;
}

interface TuiDetail {
  readonly label: "Reply" | "Question" | "Approval" | "Last reply";
  readonly text: string;
}

function detailForSnapshot(snapshot: RunSnapshot, events: readonly RuntimeEvent[] = []): TuiDetail | undefined {
  if (snapshot.status === "waiting_approval" && snapshot.pendingApproval !== undefined) {
    return { label: "Approval", text: approvalDetail(snapshot, events) };
  }
  if (snapshot.status === "waiting_user") {
    return { label: "Question", text: snapshot.pendingUserQuestion ?? "Response required" };
  }
  if (snapshot.status === "finished" && snapshot.summary !== undefined) {
    return { label: "Reply", text: snapshot.summary };
  }
  return undefined;
}

/**
 * Build an approval explanation from already committed event fields. Tool
 * arguments are deliberately not rendered: a `type` call may contain
 * credentials or other private text. Target/summary/effects are model-
 * declared metadata, so they are terminal-sanitized before display.
 */
function approvalDetail(snapshot: RunSnapshot, events: readonly RuntimeEvent[]): string {
  const pending = snapshot.pendingApproval;
  if (pending === undefined) return "Approval is pending.";
  const callEvent = events.find((event): event is Extract<RuntimeEvent, { type: "tool.call.received" }> =>
    event.type === "tool.call.received" && event.call.id === pending.callId);
  const guardEvent = [...events].reverse().find((event): event is Extract<RuntimeEvent, { type: "action.guard.evaluated" }> =>
    event.type === "action.guard.evaluated" && event.callIds.includes(pending.callId));
  const call = callEvent?.call;
  const declaration = call?.declaredEffect;
  const lines = [
    "Approval is pending: the Run is waiting and no GUI action is executing.",
    `Action: ${call?.name === undefined ? "unknown" : sanitizeTerminalText(call.name)}`,
    `Target: ${declaration === undefined ? "not provided" : sanitizeTerminalText(declaration.target)}`,
    `Why: ${sanitizeTerminalText(pending.reason)}`,
    `Intent: ${declaration === undefined ? "not provided" : sanitizeTerminalText(declaration.summary)}`,
    `Effects: ${declaration === undefined || declaration.effects.length === 0 ? "not provided" : declaration.effects.map((effect) => sanitizeTerminalText(effect)).join(", ")}`,
    `Guard detail: ${guardEvent === undefined ? "unknown" : `${guardEvent.decision} via ${guardEvent.path} (${guardEvent.reasonCode})`}`,
    "Review the target and immediate effect before responding.",
    "Y approve · N reject · I correct (revokes this request) · A abort",
  ];
  return lines.join("\n");
}

function detailLineLimit(rows: number, width: number, ui: Pick<TuiFrameUi, "editMode" | "notice" | "inputLimitReached">): number {
  if (width < 72 || rows < 22) {
    const headRows = rows < 16 ? 4 : 6;
    const footerRows = 1 + (ui.editMode ? 1 : 0) + (ui.inputLimitReached ? 1 : 0) + (ui.notice.length > 0 ? 1 : 0);
    return Math.max(1, rows - 2 - headRows - footerRows - 1);
  }
  return Math.max(1, Math.floor(rows) - 20);
}

function renderDetailBlock(detail: TuiDetail, width: number, pageIndex: number, linesPerPage: number): string[] {
  const page = paginateTuiText(detail.text, Math.max(1, width - 4), pageIndex, linesPerPage);
  return [
    clip(`${detail.label} [${page.pageIndex + 1}/${page.pageCount}] (PageUp/PageDown to view):`, width),
    ...page.lines.map((line) => `  ${line}`),
  ];
}

function tuiWidth(columns: number | undefined): number {
  return Math.max(20, Math.min(columns ?? process.stdout.columns ?? 100, 140));
}

export function buildTuiFrame(
  snapshot: RunSnapshot,
  events: readonly RuntimeEvent[],
  goal: string,
  metadata: TuiMetadata,
  ui: TuiFrameUi,
): string {
  const width = tuiWidth(ui.columns);
  const rows = Math.max(12, ui.rows ?? process.stdout.rows ?? 24);
  if (width < 72 || rows < 22) return buildCompactTuiFrame(snapshot, events, goal, metadata, ui, width, rows);
  const latestObservation = [...events].reverse().find((event) => event.type === "observation.created");
  const guard = [...events].reverse().find((event) => event.type === "action.guard.evaluated");
  const latestModelRequest = [...events].reverse().find((event) => event.type === "model.request.started");
  const latestModelCompletion = [...events].reverse().find((event) => event.type === "model.response.received" || event.type === "model.request.failed");
  const waitingForModel = snapshot.status === "running" && latestModelRequest !== undefined &&
    (latestModelCompletion === undefined || latestModelCompletion.sequence < latestModelRequest.sequence);
  const detail = detailForSnapshot(snapshot, events);
  const detailPage = detail === undefined
    ? undefined
    : paginateTuiText(detail.text, Math.max(1, width - 4), ui.detailPage ?? 0, detailLineLimit(rows, width, ui));
  const approvalWaiting = snapshot.status === "waiting_approval" && snapshot.pendingApproval !== undefined;
  const handoffWaiting = snapshot.status === "waiting_window";
  const staticBeforeEvents = 13 + (waitingForModel ? 1 : 0) + (approvalWaiting ? 1 : 0) + (handoffWaiting ? 1 : 0);
  const afterEvents = 1 + (detailPage === undefined ? 0 : 1 + detailPage.lines.length) + 1 +
    (ui.editMode ? 1 : 0) + (ui.inputLimitReached ? 1 : 0) + (ui.notice.length > 0 ? 1 : 0) + 1;
  const maxRecentEvents = Math.max(0, Math.min(10, rows - staticBeforeEvents - afterEvents));
  const lines = [
    `Computer Harness TUI  |  ${snapshot.status.toUpperCase()}${snapshot.outcome === undefined ? "" : ` / ${snapshot.outcome}`}`,
    "─".repeat(width),
    `Provider: ${clip(metadata.provider, width - 30)}   Computer: ${clip(metadata.computer, width - 30)}   Target: ${formatCuaTarget(metadata)}`,
    `Profile: ${metadata.profile}   Risk Guard: ${metadata.riskGuard === "layered" ? "ENABLED" : "DISABLED"} (${metadata.riskGuard})`,
    `Focus evidence: ${metadata.computer === "cua" ? "UNKNOWN (generic foreground input is not fixture-verified)" : "UNKNOWN (backend metadata is not focus proof)"}`,
    `Session: ${ui.sessionStatus ?? "single-run"}   Event feed: ${ui.feedState ?? "legacy"}`,
    `Features: ${formatTuiFeatures(metadata.features, metadata.riskGuard)}`,
    ...(waitingForModel ? ["WAITING: provider request in progress; correction will pause safely before editing."] : []),
    ...(approvalWaiting
      ? ["APPROVAL REQUIRED: Run is waiting; choose Y/N, correct with I, or abort with A."]
      : []),
    ...(handoffWaiting
      ? [snapshot.pendingWindowHandoff?.reasonCode === "new_window_detected"
        ? "NEW WINDOW: H chooses a target; C keeps the current target after a fresh observation; A aborts."
        : "FOREGROUND MISMATCH: H chooses a target; A aborts. The refused action is not retried."]
      : []),
    `Steps: ${snapshot.stepCount}   Model requests: ${snapshot.modelRequestCount}   Guard: ${snapshot.guardEvaluationCount}   Risk model: ${snapshot.riskModelRequestCount}`,
    `Plan: ${snapshot.plan.tasks.filter((task) => task.status !== "completed").length} open / ${snapshot.plan.tasks.length} total   Memory: ${snapshot.memory.facts.length} facts / ${snapshot.memory.entities.length} entities`,
    `Goal: ${clip(goal, width - 6)}`,
    `Observation: ${latestObservation?.type === "observation.created" ? clip(`${latestObservation.observation.id}  ${latestObservation.observation.screenshot.relativePath}`, width - 15) : "not available"}`,
    `Last guard: ${guard?.type === "action.guard.evaluated" ? `${guard.decision} via ${guard.path} (${guard.reasonCode})` : "not evaluated"}`,
    "─".repeat(width),
    "Recent committed events",
    ...(maxRecentEvents === 0 ? [] : events.slice(-maxRecentEvents).map((event) => ` ${String(event.sequence).padStart(4, " ")}  ${formatEvent(event, width - 8)}`)),
    "─".repeat(width),
  ];
  if (detail !== undefined) lines.push(...renderDetailBlock(detail, width, ui.detailPage ?? 0, detailLineLimit(rows, width, ui)));
  if (ui.editMode) {
    lines.push("Editing: Enter submit   Esc cancel   Ctrl-C abort");
  } else if (snapshot.status === "waiting_approval") {
    lines.push("Approval controls: Y approve   N reject   I correct   A abort");
  } else if (snapshot.status === "waiting_user") {
    lines.push("Press I to enter a response or correction.");
  } else if (snapshot.status === "waiting_window") {
    lines.push(snapshot.pendingWindowHandoff?.reasonCode === "new_window_detected"
      ? "Keys: H choose new window   C continue current target   A abort   Q exit"
      : "Keys: H choose new window   A abort   Q exit", TERMINAL_INPUT_SCOPE_NOTICE);
  } else {
    lines.push("Keys: I correction/input   P pause   R resume   A abort   S screenshot   Q exit", TERMINAL_INPUT_SCOPE_NOTICE);
  }
  if (ui.editMode) lines.push(`> ${tailTuiInput(ui.input, Math.max(1, width - 2))}`);
  if (ui.inputLimitReached) lines.push(`Input is limited to ${MAX_TUI_INPUT_LENGTH} characters; newest characters remain visible.`);
  if (ui.notice.length > 0) lines.push(`Notice: ${clip(ui.notice, width - 8)}`);
  lines.push(`Artifacts: ${clip(metadata.output, width - 11)}`);
  return `${lines.join("\n")}\n`;
}

function buildCompactTuiFrame(
  snapshot: RunSnapshot,
  events: readonly RuntimeEvent[],
  goal: string,
  metadata: TuiMetadata,
  ui: TuiFrameUi,
  width: number,
  rows: number,
): string {
  const latestEvent = events.at(-1);
  const compactStatus = snapshot.status === "waiting_approval"
    ? "APPROVAL REQUIRED"
    : snapshot.status === "waiting_window"
      ? "WINDOW HANDOFF REQUIRED"
    : snapshot.status === "waiting_user"
      ? "USER INPUT REQUIRED"
      : latestEvent === undefined ? snapshot.status : formatEvent(latestEvent, width - 8);
  const head = [
    `Harness | ${snapshot.status.toUpperCase()}`,
    ...(rows >= 16 ? [`Model: ${metadata.provider}`, `Steps: ${snapshot.stepCount}  Requests: ${snapshot.modelRequestCount}`] : []),
    `Target: ${formatCuaTarget(metadata)}`,
    `Goal: ${goal}`,
    `Status: ${compactStatus}`,
  ];
  const controls = snapshot.status === "waiting_approval"
    ? "Y approve  N reject  I correct  A abort"
    : snapshot.status === "waiting_window"
      ? "H choose window  A abort"
    : snapshot.status === "waiting_user"
      ? "I respond  A abort  Q exit"
      : ui.editMode ? "Enter submit  Esc cancel" : "I input  P pause  R resume  A abort  Q exit";
  const footer = [
    controls,
    ...(ui.editMode ? [`> ${tailTuiInput(ui.input, Math.max(1, width - 2))}`] : []),
    ...(ui.inputLimitReached ? [`Max ${MAX_TUI_INPUT_LENGTH} characters reached`] : []),
    ...(ui.notice.length > 0 ? [`Notice: ${ui.notice}`] : []),
  ];
  const detail = detailForSnapshot(snapshot, events);
  const detailLines = detail === undefined ? [] : renderDetailBlock(
    detail, width, ui.detailPage ?? 0, detailLineLimit(rows, width, ui),
  );
  return `${[...head, ...detailLines, ...footer].map((line) => clipHomeLine(line, width).text).join("\n")}\n`;
}

function buildTuiHomeFrame(
  metadata: TuiMetadata,
  session: ApplicationSession,
  ui: TuiFrameUi & { readonly feedState: TuiFeedState; readonly reply?: string },
): string {
  const width = tuiWidth(ui.columns);
  const rows = Math.max(12, ui.rows ?? process.stdout.rows ?? 24);
  // Leave room for the terminal cursor and the newline written on exit.
  const visibleRows = Math.max(1, rows - 3);
  const last = session.lastRun;
  const hasGoalDraft = ui.input.trim().length > 0;
  const goalPrefix = ui.editMode ? "Goal: >" : hasGoalDraft ? "Goal draft:" : "Goal:";
  const goalBudget = Math.max(1, width - goalPrefix.length - 1);
  const goalValue = hasGoalDraft
    ? tailTuiInput(ui.input, goalBudget)
    : ui.editMode ? "" : "not entered";
  const goalTruncated = hasGoalDraft && wrapHomeText(ui.input, goalBudget).length > 1;
  const goal = clipHomeLine(`${goalPrefix}${goalValue.length === 0 ? "" : ` ${goalValue}`}`, width);
  const targetValue = formatHomeTarget(metadata);
  const target = clipHomeField("Target", targetValue, width);
  const safety = clipHomeField("Risk Guard", metadata.riskGuard === "layered" ? "ON" : "OFF", width);
  // A long notice must never erase the more important ownership barrier.
  // The complete notice remains available from the keyboard-accessible page.
  const statusValue = session.status === "blocked"
    ? "BLOCKED"
    : ui.inputLimitReached
      ? `Input limit reached (${MAX_TUI_INPUT_LENGTH} characters)`
      : ui.notice.length > 0 ? ui.notice : session.status;
  const status = clipHomeField("Status", statusValue, width);
  const next = clipHomeField("Next", ui.editMode
    ? "Enter starts; Esc keeps draft"
    : hasGoalDraft ? "I resumes; Enter edits" : "I/Enter edits", width);
  const keysText = ui.editMode
    ? canSelectWindow(metadata) ? "D details; Esc then W; F options" : "D details; F options; Ctrl-C exit"
    : canSelectWindow(metadata) ? "D details; F options; W target" : "D details; F options; Esc/Q exit";
  const keys = clipHomeField("Keys", keysText, width);
  const scope = clipHomeLine("TTY only; no global hotkeys", width);
  const model = clipHomeField("Model", metadata.provider, width);
  const computer = clipHomeField("Computer", metadata.computer, width);
  const featureSet = clipHomeField("Features", describeTuiFeatureSet(metadata.features), width);
  const output = clipHomeField("Output", metadata.output, width);
  const coreLines = [
    "Harness | HOME",
    goal.text,
    model.text,
    computer.text,
    target.text,
    featureSet.text,
    safety.text,
    status.text,
    next.text,
    keys.text,
    scope.text,
  ];
  const needsInlineDetails = status.truncated || ui.notice.length > 0 || (ui.reply?.length ?? 0) > 0 ||
    ((goal.truncated || goalTruncated) && hasGoalDraft) || target.truncated || ui.inputLimitReached ||
    next.truncated || keys.truncated || last !== undefined || output.truncated;
  const details = needsInlineDetails ? buildHomeDetailsText(metadata, session, ui) : [];

  const lines = [...coreLines];
  const optionalRows = Math.max(0, visibleRows - lines.length);
  if (last !== undefined && optionalRows > 2) lines.push(clipHomeField("Last Run", last.outcome ?? last.error ?? "not completed", width).text);
  if (output.truncated === false && optionalRows > 3) lines.push(output.text);
  const detailLineCount = details.length === 0 ? 0 : Math.max(0, visibleRows - lines.length - 1);
  if (detailLineCount > 0) {
    const page = paginateHomeText(details.join("\n\n"), width, ui.detailPage ?? 0, detailLineCount);
    lines.push(clipHomeLine(`Details [${page.pageIndex + 1}/${page.pageCount}] PageUp/PageDown`, width).text);
    lines.push(...page.lines);
  }
  return `${lines.join("\n")}\n`;
}

function buildHomeDetailsText(
  metadata: TuiMetadata,
  session: ApplicationSession,
  ui: TuiFrameUi & { readonly feedState: TuiFeedState; readonly reply?: string },
): string[] {
  const sections: string[] = [];
  const ownership = session.inspectEnvironment();
  const notice = ui.notice.trim();
  const goal = ui.input.trim();

  if (ui.reply !== undefined && ui.reply.length > 0) sections.push(`Last reply:\n${ui.reply}`);
  sections.push(`Current status / notice:\n${notice.length === 0 ? "No additional status." : notice}`);
  sections.push(`Full target:\n${formatHomeTarget(metadata)}`);
  sections.push(`Full goal:\n${goal.length === 0 ? "not entered" : goal}`);
  sections.push(`Model: ${metadata.provider}`);
  sections.push(`Computer / environment: ${metadata.computer}`);
  sections.push(`Preset: ${describeTuiFeatureSet(metadata.features)}\nAdvanced features: ${formatTuiFeatures(metadata.features, metadata.riskGuard)}`);
  sections.push(formatTuiSafety(metadata));
  if (session.status === "blocked") {
    sections.push(`Session status: BLOCKED. Another Run or pending cleanup owns this environment.${ownership?.reason === undefined ? "" : `\nOwnership reason: ${ownership.reason}`}`);
  } else {
    sections.push(`Session status: ${session.status}.`);
  }
  sections.push(`Next: ${ui.editMode ? "Enter starts the Run; Esc keeps the goal draft." : goal.length > 0 ? "I resumes the goal draft; Enter opens the editor." : "I or Enter opens the goal editor."}`);
  sections.push(`Keyboard:\nD opens these details; PageDown also opens them. PageUp/PageDown change pages; Esc or Q returns home.\nF opens advanced options.${canSelectWindow(metadata) ? " In the goal editor, Esc then W opens the CUA window chooser; W changes the target from setup." : ""}\nCtrl-C exits from the goal editor.\n${TERMINAL_INPUT_SCOPE_NOTICE}`);
  if (ui.inputLimitReached) sections.push(`Goal input is limited to ${MAX_TUI_INPUT_LENGTH} characters. The newest characters remain visible in the editor.`);
  const last = session.lastRun;
  if (last !== undefined) {
    sections.push(`Last Run:\n${last.outcome ?? last.error ?? "not completed"}\nGoal: ${last.goal}${last.error === undefined ? "" : `\nError: ${last.error}`}`);
  }
  sections.push(`Output directory:\n${metadata.output}`);
  return sections;
}

function buildTuiHomeDetailsFrame(
  metadata: TuiMetadata,
  session: ApplicationSession,
  ui: TuiFrameUi & { readonly feedState: TuiFeedState; readonly reply?: string },
): string {
  const width = tuiWidth(ui.columns);
  const rows = Math.max(12, ui.rows ?? process.stdout.rows ?? 24);
  const visibleRows = Math.max(1, rows - 3);
  const blocked = session.status === "blocked";
  const notice = ui.notice.trim();
  // Reserve a fixed, text-only context and return path on every page. The
  // complete notice is paginated below, never substituted for BLOCKED.
  const fixedRows = 7;
  const page = paginateHomeText(
    buildHomeDetailsText(metadata, session, ui).join("\n\n"),
    width,
    ui.detailPage ?? 0,
    Math.max(1, visibleRows - fixedRows),
  );
  const statusText = blocked ? "BLOCKED" : notice.length > 0 ? notice : session.status;
  const lines = [
    clipHomeLine("Harness | DETAILS", width).text,
    clipHomeField("Risk Guard", metadata.riskGuard === "layered" ? "ON" : "OFF", width).text,
    clipHomeField("Session", blocked ? "BLOCKED" : session.status, width).text,
    clipHomeField("Status", statusText, width).text,
    clipHomeLine(`Details [${page.pageIndex + 1}/${page.pageCount}]`, width).text,
    ...page.lines,
    clipHomeLine("PgUp/PgDn page", width).text,
    clipHomeLine("Esc/Q: home", width).text,
  ];
  return `${lines.slice(0, visibleRows).join("\n")}\n`;
}

function clipHomeField(label: string, value: string, width: number): { readonly text: string; readonly truncated: boolean } {
  const prefix = `${label}: `;
  const clipped = clipHomeLine(value, Math.max(1, width - prefix.length));
  return { text: `${prefix}${clipped.text}`, truncated: clipped.truncated };
}

function clipHomeLine(value: string, width: number): { readonly text: string; readonly truncated: boolean } {
  const normalized = sanitizeTerminalText(value).replace(/\s+/gu, " ").trim();
  if (wrapHomeText(normalized, width).length <= 1) return { text: wrapHomeText(normalized, width)[0] ?? "", truncated: false };
  const first = wrapHomeText(normalized, Math.max(1, width - 1))[0] ?? "";
  return { text: `${first}…`, truncated: true };
}

function paginateHomeText(value: string, width: number, pageIndex: number, linesPerPage: number): { readonly lines: readonly string[]; readonly pageIndex: number; readonly pageCount: number } {
  const wrapped = value.split(/\r?\n/u).flatMap((line) => wrapHomeText(line, Math.max(1, width)));
  const pageSize = Math.max(1, Math.floor(linesPerPage));
  const pageCount = Math.max(1, Math.ceil(wrapped.length / pageSize));
  const currentPage = Math.min(Math.max(0, Math.floor(pageIndex)), pageCount - 1);
  return {
    lines: wrapped.slice(currentPage * pageSize, (currentPage + 1) * pageSize),
    pageIndex: currentPage,
    pageCount,
  };
}

function wrapHomeText(value: string, width: number): string[] {
  const normalized = sanitizeTerminalText(value).replace(/\s+/gu, " ").trim();
  if (normalized.length === 0) return [""];
  const lines: string[] = [];
  let current = "";
  for (const word of normalized.split(" ")) {
    const candidate = current.length === 0 ? word : `${current} ${word}`;
    const candidateLines = wrapTuiText(candidate, Math.max(1, width));
    if (candidateLines.length === 1) {
      current = candidateLines[0]!;
      continue;
    }
    if (current.length > 0) lines.push(current);
    const wordLines = wrapTuiText(word, Math.max(1, width));
    lines.push(...wordLines.slice(0, -1));
    current = wordLines[wordLines.length - 1] ?? "";
  }
  if (current.length > 0 || lines.length === 0) lines.push(current);
  return lines;
}

function describeTuiFeatureSet(features: TuiFeatureSelection | undefined): string {
  const selected = normalizeTuiFeatureSelection(features);
  const matches = (expected: Pick<TuiFeatureSelection, "planning" | "memory" | "memoryRetrieval" | "batching" | "contextMode" | "monitor">): boolean =>
    selected.planning === expected.planning &&
    selected.memory === expected.memory &&
    selected.memoryRetrieval === expected.memoryRetrieval &&
    selected.batching === expected.batching &&
    selected.contextMode === expected.contextMode &&
    selected.monitor === expected.monitor &&
    selected.grounding === "off";
  if (matches({ planning: false, memory: "off", memoryRetrieval: "off", batching: "off", contextMode: "raw", monitor: "off" })) return "Baseline";
  if (matches({ planning: true, memory: "facts", memoryRetrieval: "lexical", batching: "same-control-input-v1", contextMode: "recent", monitor: "shadow" })) return "Assisted";
  if (matches({ planning: true, memory: "entities", memoryRetrieval: "lexical", batching: "same-control-input-v1", contextMode: "recent", monitor: "guidance" })) return "Research";
  return "Custom";
}

function formatTuiSafety(metadata: TuiMetadata): string {
  const guard = metadata.riskGuard === "layered"
    ? "Risk Guard ON (layered)"
    : "Risk Guard OFF; automatic review disabled";
  return guard;
}

function formatHomeTarget(metadata: TuiMetadata): string {
  if (metadata.computer !== "cua") return "N/A";
  if (metadata.managedBrowserSelected === true) return `Harness-managed browser (${isHttpUrl(metadata.managedBrowserUrl) ? new URL(metadata.managedBrowserUrl!).host : "URL unavailable"}); grounding=${metadata.features?.grounding ?? "off"}`;
  if (metadata.cuaWindowTarget === undefined) return "Primary desktop (default)";
  const label = metadata.cuaWindowLabel === undefined
    ? "Selected window"
    : sanitizeTerminalText(metadata.cuaWindowLabel).replace(/\s+\(pid=\d+,\s*window=\d+\)$/u, "");
  const source = metadata.cuaWindowSelectionSource === "local_match"
    ? "; selected by local goal/name match (not the model)"
    : metadata.cuaWindowSelectionSource === "jev" ? "; selected by Jev; host rechecked" : "";
  return `${label}; pid=${metadata.cuaWindowTarget.pid}; window=${metadata.cuaWindowTarget.windowId}; delivery=${metadata.cuaWindowDeliveryMode ?? "background"}${source}`;
}

const tuiFeatureRows = [
  { label: "Planning tasks", values: ["off", "on"] as const },
  { label: "Memory", values: ["off", "facts", "entities"] as const },
  { label: "Memory retrieval", values: ["off", "lexical", "hybrid"] as const },
  { label: "Action batching", values: ["off", "same-control-input-v1"] as const },
  { label: "Context history", values: ["raw", "recent"] as const },
  { label: "Risk Guard", values: ["off", "layered"] as const },
  { label: "Progress Monitor", values: ["off", "shadow", "guidance"] as const },
  { label: "Grounding", values: ["off", "auto", "uia-catalog-v1", "dom-catalog-v1", "hybrid-catalog-v1"] as const },
] as const;

function normalizeTuiFeatureSelection(features: TuiFeatureSelection | undefined, defaultRiskGuard: RiskGuardMode = "layered"): TuiFeatureSelection {
  return {
    planning: features?.planning ?? false,
    memory: features?.memory ?? "off",
    memoryRetrieval: features?.memoryRetrieval ?? "off",
    batching: features?.batching ?? "off",
    contextMode: features?.contextMode ?? "raw",
    riskGuard: features?.riskGuard ?? defaultRiskGuard,
    monitor: features?.monitor ?? "off",
    grounding: features?.grounding ?? "off",
  };
}

function featureOverrides(
  features: TuiFeatureSelection,
  windowTarget: ApplicationSessionWindowTarget | null | undefined,
  windowDeliveryMode: "background" | "foreground" | null | undefined,
  managedBrowserSelected = false,
  managedBrowserUrl?: string,
): ApplicationSessionRunFeatureOverrides {
  const grounding = resolveTuiGrounding(features.grounding, managedBrowserSelected ? "managed-browser" : windowTarget == null ? "desktop" : "host-window");
  const managedGrounding = isManagedGrounding(grounding);
  return {
    planning: features.planning,
    memory: features.memory,
    memoryRetrieval: features.memory === "off" ? "off" : features.memoryRetrieval,
    batching: features.batching,
    contextMode: features.contextMode,
    riskGuard: features.riskGuard,
    monitor: features.monitor,
    grounding,
    windowHandoff: !managedGrounding && windowTarget != null ? "confirm-v1" : "off",
    ...(managedBrowserSelected && managedBrowserUrl !== undefined ? { managedBrowserUrl } : {}),
    ...(managedGrounding
      ? { windowTarget: null, windowDeliveryMode: null }
      : {
          ...(windowTarget === undefined ? {} : { windowTarget }),
          ...(windowDeliveryMode === undefined ? {} : { windowDeliveryMode }),
        }),
  };
}

function changeTuiFeature(features: TuiFeatureSelection, rowIndex: number, delta: number): TuiFeatureSelection {
  const row = tuiFeatureRows[rowIndex];
  if (row === undefined) return features;
  const key: keyof TuiFeatureSelection = rowIndex === 0
    ? "planning"
    : rowIndex === 1
      ? "memory"
      : rowIndex === 2
        ? "memoryRetrieval"
        : rowIndex === 3
        ? "batching"
        : rowIndex === 4
      ? "contextMode"
          : rowIndex === 5
            ? "riskGuard"
            : rowIndex === 6
              ? "monitor"
              : "grounding";
  const current = features[key] as string | boolean;
  if (typeof current === "boolean") return { ...features, [key]: !current } as TuiFeatureSelection;
  const currentIndex = row.values.indexOf(current as never);
  const nextIndex = (currentIndex + delta + row.values.length) % row.values.length;
  return { ...features, [key]: row.values[nextIndex] } as TuiFeatureSelection;
}

function featureValue(features: TuiFeatureSelection, rowIndex: number): string {
  if (rowIndex === 0) return features.planning ? "on" : "off";
  if (rowIndex === 1) return features.memory;
  if (rowIndex === 2) return features.memoryRetrieval;
  if (rowIndex === 3) return features.batching;
  if (rowIndex === 4) return features.contextMode;
  if (rowIndex === 5) return features.riskGuard;
  if (rowIndex === 6) return features.monitor;
  if (rowIndex === 7) return features.grounding;
  return features.grounding;
}

function formatTuiFeatures(features: TuiFeatureSelection | undefined, defaultRiskGuard?: RiskGuardMode): string {
  const normalized = normalizeTuiFeatureSelection(features, defaultRiskGuard);
  return `plan=${normalized.planning ? "on" : "off"}, memory=${normalized.memory}/${normalized.memoryRetrieval}, batch=${normalized.batching}, context=${normalized.contextMode}, guard=${normalized.riskGuard}, monitor=${normalized.monitor}, grounding=${normalized.grounding}`;
}

function formatCuaTarget(metadata: TuiMetadata): string {
  if (metadata.computer !== "cua") return `${metadata.computer} environment`;
  if (metadata.managedBrowserSelected === true) return `Harness-managed browser (grounding=${metadata.features?.grounding ?? "off"}; auto resolves to DOM + UIA)`;
  if (metadata.cuaWindowTarget === undefined) return "primary desktop (default)";
  const label = metadata.cuaWindowLabel === undefined ? "selected window" : sanitizeTerminalText(metadata.cuaWindowLabel).slice(0, 96);
  const source = metadata.cuaWindowSelectionSource === "local_match"
    ? "local goal/name match (not model-selected)"
    : metadata.cuaWindowSelectionSource === "jev" ? "Jev-selected; host rechecked" : "host-selected";
  return `window ${label} pid=${metadata.cuaWindowTarget.pid} id=${metadata.cuaWindowTarget.windowId} (${source}, delivery=${metadata.cuaWindowDeliveryMode ?? "background"})`;
}

function canSelectWindow(metadata: TuiMetadata): boolean {
  return metadata.computer === "cua" && metadata.windowSelectionAvailable !== false;
}

function buildTuiFeaturesFrame(
  metadata: TuiMetadata,
  features: TuiFeatureSelection,
  cursor: number,
  columns?: number,
  rows?: number,
): string {
  const width = tuiWidth(columns);
  const terminalRows = Math.max(12, rows ?? process.stdout.rows ?? 24);
  const header = [
    "Computer Harness TUI  |  FEATURES",
    "─".repeat(width),
    `Provider: ${clip(metadata.provider, width - 30)}   Computer: ${clip(metadata.computer, width - 30)}   Target: ${formatCuaTarget(metadata)}`,
    "Choose features for the next Run. Changes apply when the next goal starts.",
    "Arrow keys/J-K move   Space toggles   Left/Right changes   Enter saves   Esc cancels",
  ];
  const footer = [
    `Risk Guard: ${features.riskGuard === "layered" ? "ENABLED" : "DISABLED"} (${features.riskGuard}; applies to the next Run)`,
    ...(terminalRows >= 18 ? [
      `Embedding config: ${metadata.embeddingReady === true ? "ready" : "not configured (hybrid cannot start)"}`,
      ...(isManagedGrounding(features.grounding) ? [managedBrowserFeatureLine(metadata)] : []),
    ] : []),
    clip(uiFeatureHint(features, metadata), width),
  ];
  const visibleCount = Math.max(1, Math.min(tuiFeatureRows.length, terminalRows - header.length - footer.length - 1));
  const first = Math.min(Math.max(0, cursor - Math.floor(visibleCount / 2)), tuiFeatureRows.length - visibleCount);
  const visibleRows = tuiFeatureRows.slice(first, first + visibleCount).map((row, offset) => {
    const index = first + offset;
    return `${index === cursor ? "❯" : " "} ${row.label.padEnd(20, " ")} ${featureValue(features, index)}`;
  });
  const lines = [...header, `Feature ${cursor + 1} of ${tuiFeatureRows.length}; showing ${first + 1}-${first + visibleRows.length}`, ...visibleRows, ...footer];
  return `${lines.slice(0, terminalRows).join("\n")}\n`;
}

function buildTuiBrowserUrlFrame(
  metadata: TuiMetadata,
  draft: string,
  goalDraft: string,
  notice: string,
  columns?: number,
  rows?: number,
): string {
  const width = tuiWidth(columns);
  const currentHost = isHttpUrl(metadata.managedBrowserUrl) ? new URL(metadata.managedBrowserUrl).host : "none";
  const profile = metadata.managedBrowserProfileMode === "persistent"
    ? `persistent (${metadata.managedBrowserProfileLabel ?? "label missing"})`
    : "temporary";
  const lines = [
    "Computer Harness TUI  |  MANAGED BROWSER",
    "─".repeat(width),
    `Current start site: ${currentHost}   Profile: ${profile}`,
    "Enter a complete http(s) URL. Enter reuses the current site if input is blank; Esc returns to window selection.",
    `Goal draft kept: ${clip(goalDraft || "(empty)", Math.max(1, width - 17))}`,
    `> ${tailTuiInput(draft, Math.max(1, width - 2))}`,
    clip(notice, width),
    "This does not attach to a personal browser. The new Run opens a Harness-owned browser window.",
  ];
  return `${lines.slice(0, Math.max(12, rows ?? process.stdout.rows ?? 24)).join("\n")}\n`;
}

function buildTuiWindowsFrame(
  metadata: TuiMetadata,
  targets: readonly WindowTargetInfo[],
  cursor: number,
  loading: boolean,
  error: string,
  matchReason: string,
  columns?: number,
  rows?: number,
): string {
  const width = tuiWidth(columns);
  const terminalRows = Math.max(12, rows ?? process.stdout.rows ?? 24);
  const optionLabels = [
    "Primary desktop (no window target)",
    ...(metadata.features?.grounding === "auto"
      ? [`Harness-managed browser (${isHttpUrl(metadata.managedBrowserUrl) ? new URL(metadata.managedBrowserUrl).host : "enter URL"}; DOM + UIA)`]
      : []),
    ...targets.map(windowDisplayLabel),
  ];
  const safeCursor = Math.min(Math.max(cursor, 0), optionLabels.length - 1);
  const headerLines = [
    "Computer Harness TUI  |  WINDOW TARGET",
    "─".repeat(width),
    `Provider: ${clip(metadata.provider, width - 30)}   Computer: ${clip(metadata.computer, width - 30)}`,
    `Current: ${formatCuaTarget(metadata)}`,
    "Native windows should be fully visible, unobscured; choose one, desktop or managed browser. Window layout is user-managed; Harness does not move/resize windows.",
    "Foreground delivery may activate the target; occlusion support is limited and focus restoration is not guaranteed.",
    ...(matchReason.length > 0 ? [`Status: ${clip(matchReason, width - 8)}`] : []),
    ...(error.length > 0 ? [`Window discovery error: ${clip(error, width - 24)}`] : []),
    "Arrow keys/J-K move   Enter selects   R refreshes   Esc cancels",
  ];
  const footerLines = ["A closed or invalidated window never falls back to the desktop automatically."];
  const reservedRows = headerLines.length + 1 + footerLines.length;
  const visibleOptionCount = Math.max(1, Math.min(optionLabels.length, terminalRows - reservedRows));
  const firstVisibleOption = Math.min(
    Math.max(0, safeCursor - Math.floor(visibleOptionCount / 2)),
    Math.max(0, optionLabels.length - visibleOptionCount),
  );
  const lastVisibleOption = Math.min(optionLabels.length, firstVisibleOption + visibleOptionCount);
  const positionLine = loading
    ? "Window options are loading."
    : `Option ${safeCursor + 1} of ${optionLabels.length}; showing ${firstVisibleOption + 1}-${lastVisibleOption}`;
  const visibleOptions = loading
    ? ["  Loading visible windows…"]
    : optionLabels.slice(firstVisibleOption, lastVisibleOption).map((label, offset) => {
        const optionIndex = firstVisibleOption + offset;
        return `  ${safeCursor === optionIndex ? "❯" : " "} ${clip(label, width - 4)}`;
      });
  const lines = [...headerLines, positionLine, ...visibleOptions, ...footerLines];
  return `${lines.slice(0, terminalRows).join("\n")}\n`;
}

function buildTuiHandoffFrame(
  metadata: TuiMetadata,
  targets: readonly WindowTargetInfo[],
  cursor: number,
  loading: boolean,
  error: string,
  reason: string,
  columns?: number,
  rows?: number,
  handoffReasonCode?: "foreground_mismatch" | "new_window_detected",
): string {
  const width = tuiWidth(columns);
  const height = Math.max(12, rows ?? process.stdout.rows ?? 24);
  const header = [
    "Harness | WINDOW HANDOFF",
    handoffReasonCode === "new_window_detected"
      ? "A GUI action completed and a new visible window appeared."
      : "Action refused: no mouse input was sent to the other window.",
    `Previous: ${formatCuaTarget(metadata)}`,
    `Status: ${error || reason}`,
  ];
  const footer = handoffReasonCode === "new_window_detected"
    ? ["Enter handoff  C keep current target  R refresh  Esc wait  A abort", "Keeping current target invalidates this frame and captures a fresh one."]
    : ["Enter confirm  R refresh  Esc wait  A abort", "Jev only suggests; your confirmation changes the target."];
  const capacity = Math.max(1, height - header.length - footer.length - 2);
  const first = Math.max(0, Math.min(cursor - Math.floor(capacity / 2), targets.length - capacity));
  const visible = targets.slice(first, first + capacity).map((target, index) => `${first + index === cursor ? "❯" : " "} ${windowDisplayLabel(target)}`);
  const lines = [...header, loading ? "Searching visible windows…" : `Candidate ${targets.length === 0 ? 0 : cursor + 1}/${targets.length}`, ...visible, ...footer];
  return lines.slice(0, height - 1).map((line) => clipHomeLine(line, width).text).join("\n");
}

function windowDisplayLabel(target: WindowTargetInfo): string {
  const app = target.appName?.trim() || "Unknown application";
  const title = target.title?.trim() || "Untitled window";
  return `${app} — ${title} (pid=${target.pid}, window=${target.windowId})`;
}

function uiFeatureHint(features: TuiFeatureSelection, metadata?: TuiMetadata): string {
  if (features.memory === "off" && features.memoryRetrieval !== "off") return "Memory retrieval requires Memory facts or entities; it will be forced off.";
  if (features.memoryRetrieval === "hybrid") return "Hybrid retrieval needs an explicit embedding endpoint and MEMORY_EMBEDDING_API_KEY; TUI checks this before start.";
  if (features.grounding === "auto") return "Auto: native window -> UIA; explicitly selected Harness-managed browser -> DOM + UIA; desktop -> off. Ordinary Edge does not grant DOM.";
  if (isManagedGrounding(features.grounding)) {
    if (metadata === undefined || !isHttpUrl(metadata.managedBrowserUrl)) return "DOM/Hybrid requires a start URL. Switch Grounding to auto, choose Managed browser in W, and enter the URL.";
    return "DOM/Hybrid grounding uses a visible managed browser; personal browser login is not reused. Element references expire after each observation.";
  }
  if (features.riskGuard === "off") return "Risk Guard is disabled for the next Run; schema/policy/budget/stale checks remain active.";
  if (features.monitor === "guidance") return "Guidance is advisory only; it cannot execute, approve or retry actions.";
  if (features.grounding === "uia-catalog-v1") return "UIA grounding requires an explicit CUA window target; click_element references expire after each observation.";
  return "Provider and Computer are selected by the launch command; this page changes Run features only.";
}

function isManagedGrounding(grounding: TuiFeatureSelection["grounding"]): boolean {
  return grounding === "dom-catalog-v1" || grounding === "hybrid-catalog-v1";
}

function isHttpUrl(value: string | undefined): value is string {
  if (value === undefined || value.trim().length === 0) return false;
  try {
    const parsed = new URL(value);
    return (parsed.protocol === "http:" || parsed.protocol === "https:") && parsed.hostname.length > 0 && parsed.username.length === 0 && parsed.password.length === 0;
  } catch {
    return false;
  }
}

function managedBrowserFeatureLine(metadata: TuiMetadata): string {
  const host = isHttpUrl(metadata.managedBrowserUrl)
    ? new URL(metadata.managedBrowserUrl!).host
    : "not configured";
  const persistent = metadata.managedBrowserProfileMode === "persistent";
  const profile = persistent
    ? `persistent Harness-owned profile${metadata.managedBrowserProfileLabel === undefined ? "" : ` label=${metadata.managedBrowserProfileLabel}`}`
    : "temporary profile";
  const login = persistent ? "manual login required; Harness never reads credentials" : "no personal login reuse";
  return `Managed browser: ${profile}; delivery=foreground; ${login}; do not operate this window concurrently; active tab is revalidated each observation (same-tab navigation continues; ambiguous/popup tabs degrade); URL host=${host} (query hidden).`;
}

function formatEvent(event: RuntimeEvent, width: number): string {
  if (event.type === "computer.window.handoff.requested") return event.reasonCode === "new_window_detected"
    ? "window.handoff: new visible window; manual confirmation required"
    : "window.handoff: foreground mismatch; host confirmation required";
  if (event.type === "computer.window.handoff.completed") return clip(`window.handoff: pid=${event.target.pid} id=${event.target.windowId}`, width);
  if (event.type === "computer.window.handoff.ignored") return "window.handoff: popup ignored; current target freshly observed";
  if (event.type === "model.response.received") {
    return clip(event.turn.type === "tool_calls"
      ? `model.response: ${event.turn.calls.map((call) => `${call.name}${call.declaredEffect === undefined ? "" : `[${call.declaredEffect.effects.join("+")}]`}`).join(", ")}`
      : `model.response: ${event.turn.type}`, width);
  }
  if (event.type === "model.request.failed") return clip(`model.request.failed: ${event.message}`, width);
  if (event.type === "action.guard.evaluated") return clip(`guard: ${event.decision} / ${event.path} / ${event.reasonCode}`, width);
  if (event.type === "approval.requested") return clip(`approval.requested: ${event.reason}`, width);
  if (event.type === "tool.call.received") return clip(`tool.call: ${event.call.name}`, width);
  if (event.type === "tool.call.rejected") return clip(`tool.rejected: ${event.reason}`, width);
  if (event.type === "tool.call.failed") return clip(`tool.failed: ${event.result.error.message}`, width);
  if (event.type === "action.execution.started") return `action.started: ${event.action.kind}`;
  if (event.type === "action.execution.completed" || event.type === "action.execution.failed") {
    return clip(`${event.type}: ${event.receipt.status}${event.receipt.message === undefined ? "" : ` / ${event.receipt.message}`}`, width);
  }
  if (event.type === "runtime.error") return clip(`runtime.error: ${event.category} / ${event.message}`, width);
  return event.type;
}

function latestFailure(events: readonly RuntimeEvent[]): { label: string; message: string } | undefined {
  for (const event of [...events].reverse()) {
    if (event.type === "model.request.failed") {
      return {
        label: event.category === "cancelled" ? "Run cancelled" : event.category === "transport" ? "Provider request failed" : "Model request failed",
        message: event.message,
      };
    }
    if (event.type === "runtime.error") return { label: "Runtime error", message: event.message };
    if (event.type === "tool.call.rejected") return { label: "Computer action rejected", message: event.reason };
    if (event.type === "tool.call.failed") return { label: "Computer tool failed", message: event.result.error.message };
    if (event.type === "action.execution.failed") {
      return { label: event.receipt.status === "refused" ? "Computer action refused" : "Computer action failed", message: event.receipt.message ?? event.receipt.status };
    }
  }
  return undefined;
}

function clip(value: string, max: number): string {
  const normalized = sanitizeTerminalText(value).replace(/\s+/gu, " ").trim();
  const limit = Math.max(1, Math.floor(max));
  return normalized.length <= limit ? normalized : `${normalized.slice(0, Math.max(0, limit - 1))}…`;
}

function errorMessage(error: unknown): string {
  return sanitizeTerminalText(error instanceof Error ? error.message : String(error));
}
