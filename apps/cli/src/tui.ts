import { emitKeypressEvents } from "node:readline";
import type { RuntimeEvent, RunId, RunOutcome } from "@computer-harness/protocol";
import { writeRunReport, type ApplicationSession, type EventFeedNotification, type RunHandle } from "@computer-harness/app-runtime";
import type { RunController } from "@computer-harness/runtime";
import type { RunSnapshot } from "@computer-harness/trajectory";
import { initialRunSnapshot } from "@computer-harness/trajectory";
import type { RiskGuardMode, RiskProfile } from "./config.js";
import { sanitizeTerminalText } from "./terminal-output.js";
import { limitTuiInput, paginateTuiText, removeLastTuiGrapheme, tailTuiInput } from "./tui-text.js";

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
}

type TuiMode = "home" | "run";
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
  let editMode = true;
  let inputValue = "";
  let notice = "";
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

  const render = (): void => {
    if (mode === "run" && currentHandle !== undefined) {
      currentSnapshot = currentHandle.controller.getSnapshot();
      write(`\u001b[H\u001b[2J${buildTuiFrame(currentSnapshot, currentEvents, currentGoal, metadata, {
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
      })}`);
      return;
    }
    write(`\u001b[H\u001b[2J${buildTuiHomeFrame(metadata, session, {
      editMode,
      input: inputValue,
      notice,
      feedState,
      reply: lastReply,
      detailPage,
      inputLimitReached,
      columns: output.columns,
      rows: output.rows,
    })}`);
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
      try {
        const report = await handle.report();
        await writeRunReport(report, handle.config.outputDir);
        reportNotice = `; report written to ${handle.config.outputDir}`;
      } catch (error) {
        reportNotice = `; report unavailable: ${errorMessage(error)}`;
      }
      if (mode === "home" && currentHandle === undefined) {
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
    invoke(async () => {
      const handle = await session.startRun(trimmed);
      attachRun(handle, trimmed);
    }, "Run started");
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
    const detail = mode === "run" && currentHandle !== undefined
      ? detailForSnapshot(currentHandle.controller.getSnapshot())
      : lastReply.length > 0 ? { label: "Last reply", text: lastReply } : undefined;
    return detail === undefined ? 1 : paginateTuiText(detail.text, Math.max(1, width - 4), 0, detailLineLimit(rows)).pageCount;
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
    if (keyName === "pageup") { changeDetailPage(-1); return; }
    if (keyName === "pagedown") { changeDetailPage(1); return; }
    if (keyName === "escape" && pendingCorrection !== undefined && !editMode) {
      cancelPendingCorrection("Correction cancelled; draft discarded.");
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
        inputValue = "";
        inputLimitReached = false;
        if (mode === "run" && currentHandle?.controller.getSnapshot().status === "paused") {
          notice = "Correction cancelled; Run remains paused. Press R to resume.";
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
          editMode = false;
          inputValue = "";
          inputLimitReached = false;
          startGoal(value);
        } else {
          submitCorrection(value);
        }
        render();
        return;
      }
      if (!key.ctrl && printable.length > 0) { appendInput(printable); requestRender(); }
      return;
    }
    if (mode === "home") {
      if (keyName === "i" || keyName === "return") { editMode = true; render(); return; }
      if (keyName === "q" || keyName === "escape") { requestExit(); return; }
      if (!key.ctrl && printable.length > 0) { editMode = true; appendInput(printable); requestRender(); }
      return;
    }
    const snapshot = currentHandle?.controller.getSnapshot();
    if (snapshot === undefined) return;
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

  const onResize = (): void => render();
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

function detailForSnapshot(snapshot: RunSnapshot): TuiDetail | undefined {
  if (snapshot.status === "waiting_approval" && snapshot.pendingApproval !== undefined) {
    return { label: "Approval", text: snapshot.pendingApproval.reason };
  }
  if (snapshot.status === "waiting_user") {
    return { label: "Question", text: snapshot.pendingUserQuestion ?? "Response required" };
  }
  if (snapshot.status === "finished" && snapshot.summary !== undefined) {
    return { label: "Reply", text: snapshot.summary };
  }
  return undefined;
}

function detailLineLimit(rows: number): number {
  return Math.max(1, Math.floor(rows) - 20);
}

function renderDetailBlock(detail: TuiDetail, width: number, rows: number, pageIndex: number): string[] {
  const page = paginateTuiText(detail.text, Math.max(1, width - 4), pageIndex, detailLineLimit(rows));
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
  const latestObservation = [...events].reverse().find((event) => event.type === "observation.created");
  const guard = [...events].reverse().find((event) => event.type === "action.guard.evaluated");
  const latestModelRequest = [...events].reverse().find((event) => event.type === "model.request.started");
  const latestModelCompletion = [...events].reverse().find((event) => event.type === "model.response.received" || event.type === "model.request.failed");
  const waitingForModel = snapshot.status === "running" && latestModelRequest !== undefined &&
    (latestModelCompletion === undefined || latestModelCompletion.sequence < latestModelRequest.sequence);
  const detail = detailForSnapshot(snapshot);
  const detailPage = detail === undefined
    ? undefined
    : paginateTuiText(detail.text, Math.max(1, width - 4), ui.detailPage ?? 0, detailLineLimit(rows));
  const staticBeforeEvents = 13 + (waitingForModel ? 1 : 0);
  const afterEvents = 1 + (detailPage === undefined ? 0 : 1 + detailPage.lines.length) + 1 +
    (ui.editMode ? 1 : 0) + (ui.inputLimitReached ? 1 : 0) + (ui.notice.length > 0 ? 1 : 0) + 1;
  const maxRecentEvents = Math.max(0, Math.min(10, rows - staticBeforeEvents - afterEvents));
  const lines = [
    `Computer Harness TUI  |  ${snapshot.status.toUpperCase()}${snapshot.outcome === undefined ? "" : ` / ${snapshot.outcome}`}`,
    "─".repeat(width),
    `Provider: ${clip(metadata.provider, width - 30)}   Computer: ${clip(metadata.computer, width - 30)}`,
    `Profile: ${metadata.profile}   Risk Guard: ${metadata.riskGuard === "layered" ? "ENABLED" : "DISABLED"} (${metadata.riskGuard})`,
    `Focus evidence: ${metadata.computer === "cua" ? "UNKNOWN (generic foreground input is not fixture-verified)" : "UNKNOWN (backend metadata is not focus proof)"}`,
    `Session: ${ui.sessionStatus ?? "single-run"}   Event feed: ${ui.feedState ?? "legacy"}`,
    ...(waitingForModel ? ["WAITING: provider request in progress; correction will pause safely before editing."] : []),
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
  if (detail !== undefined) lines.push(...renderDetailBlock(detail, width, rows, ui.detailPage ?? 0));
  if (ui.editMode) {
    lines.push("Editing: Enter submit   Esc cancel   Ctrl-C abort");
  } else if (snapshot.status === "waiting_approval") {
    lines.push("Press Y to approve, N to reject, or I to correct.");
  } else if (snapshot.status === "waiting_user") {
    lines.push("Press I to enter a response or correction.");
  } else {
    lines.push("Keys: I correction/input   P pause   R resume   A abort   S screenshot   Q exit", TERMINAL_INPUT_SCOPE_NOTICE);
  }
  if (ui.editMode) lines.push(`> ${tailTuiInput(ui.input, Math.max(1, width - 2))}`);
  if (ui.inputLimitReached) lines.push(`Input is limited to ${MAX_TUI_INPUT_LENGTH} characters; newest characters remain visible.`);
  if (ui.notice.length > 0) lines.push(`Notice: ${clip(ui.notice, width - 8)}`);
  lines.push(`Artifacts: ${clip(metadata.output, width - 11)}`);
  return `${lines.join("\n")}\n`;
}

function buildTuiHomeFrame(
  metadata: TuiMetadata,
  session: ApplicationSession,
  ui: TuiFrameUi & { readonly feedState: TuiFeedState; readonly reply?: string },
): string {
  const width = tuiWidth(ui.columns);
  const rows = Math.max(12, ui.rows ?? process.stdout.rows ?? 24);
  const last = session.lastRun;
  const lines = [
    "Computer Harness TUI  |  HOME",
    "─".repeat(width),
    `Profile: ${metadata.profile}   Risk Guard: ${metadata.riskGuard === "layered" ? "ENABLED" : "DISABLED"} (${metadata.riskGuard})`,
    `Session: ${session.status}   Event feed: ${ui.feedState}`,
    `Provider: ${clip(metadata.provider, width - 30)}   Computer: ${clip(metadata.computer, width - 30)}`,
    `Focus evidence: ${metadata.computer === "cua" ? "UNKNOWN (generic foreground input is not fixture-verified)" : "UNKNOWN (backend metadata is not focus proof)"}`,
    TERMINAL_INPUT_SCOPE_NOTICE,
    "",
    session.status === "blocked"
      ? "Environment ownership is held by another Run or pending cleanup; this session cannot start another Run."
      : "Enter a goal to start a fresh Run. Finished Runs never reuse their Controller, approval, or Memory store.",
    last === undefined ? "Last Run: none" : `Last Run: ${clip(last.goal, width - 12)} → ${last.outcome ?? last.error ?? "not completed"}`,
    "",
    ...(ui.reply === undefined || ui.reply.length === 0 ? [] : renderDetailBlock({ label: "Last reply", text: ui.reply }, width, rows, ui.detailPage ?? 0)),
    "",
    ui.editMode ? "Editing: Enter start   Esc cancel   Ctrl-C abort" : "Keys: I/Enter edit   Esc/Q exit",
  ];
  if (ui.editMode) lines.push(`> ${tailTuiInput(ui.input, Math.max(1, width - 2))}`);
  if (ui.inputLimitReached) lines.push(`Input is limited to ${MAX_TUI_INPUT_LENGTH} characters; newest characters remain visible.`);
  if (ui.notice.length > 0) lines.push(`Notice: ${clip(ui.notice, width - 8)}`);
  lines.push(`Artifacts root: ${clip(metadata.output, width - 17)}`);
  return `${lines.join("\n")}\n`;
}

function formatEvent(event: RuntimeEvent, width: number): string {
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
