import { emitKeypressEvents } from "node:readline";
import type { RuntimeEvent, RunId, RunOutcome } from "@computer-harness/protocol";
import { writeRunReport, type ApplicationSession, type EventFeedNotification, type RunHandle } from "@computer-harness/app-runtime";
import type { RunController } from "@computer-harness/runtime";
import type { RunSnapshot } from "@computer-harness/trajectory";
import { initialRunSnapshot } from "@computer-harness/trajectory";
import type { RiskGuardMode, RiskProfile } from "./config.js";
import { sanitizeTerminalText } from "./terminal-output.js";

const LEGACY_INCREMENTAL_POLL_MS = 250;
const MAX_TUI_INPUT_LENGTH = 500;
const DEFAULT_TUI_LIFECYCLE_WAIT_MS = 1_000;
const HOME_RUN_ID = "tui-home" as RunId;

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
      })}`);
      return;
    }
    write(`\u001b[H\u001b[2J${buildTuiHomeFrame(metadata, session, {
      editMode,
      input: inputValue,
      notice,
      feedState,
    })}`);
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
      currentSnapshot = handle.controller.getSnapshot();
      feedSubscription?.unsubscribe();
      feedSubscription = undefined;
      currentHandle = undefined;
      mode = "home";
      editMode = true;
      inputValue = "";
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
      notice = `Run lifecycle error: ${errorMessage(error)}`;
      render();
    });
  };

  const drainCommandQueue = (): void => {
    if (commandBusy || exiting) return;
    const next = commandQueue.shift();
    if (next === undefined) return;
    commandBusy = true;
    Promise.resolve().then(next.operation).then(() => { notice = next.success; }).catch((error: unknown) => {
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

  const submitCorrection = (value: string): void => {
    const trimmed = value.trim();
    if (trimmed.length === 0 || currentHandle === undefined) return;
    invoke(async () => {
      await session.submitUserInput(trimmed);
      if (session.activeRun?.controller.getSnapshot().status === "paused") await session.resume();
    }, "Correction queued; old decision invalidated by Controller");
  };

  const requestExit = (): void => {
    if (finishPromise !== undefined) return;
    exiting = true;
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
    inputValue = `${inputValue}${pasted}`.slice(0, MAX_TUI_INPUT_LENGTH);
  };

  const onKeypress = (text: string | undefined, key: { name?: string; ctrl?: boolean }): void => {
    const printable = typeof text === "string" ? text : "";
    if (key.ctrl && key.name === "c") {
      if (currentHandle !== undefined) {
        try { session.abort("Ctrl+C from TUI"); notice = "Abort requested"; } catch { /* finished concurrently */ }
        render();
      } else {
        requestExit();
      }
      return;
    }
    if (mode === "home" && editMode && key.name === "q" && inputValue.length === 0) {
      requestExit();
      return;
    }
    if (editMode) {
      if (key.name === "escape") {
        editMode = false;
        inputValue = "";
        if (mode === "run" && currentHandle?.controller.getSnapshot().status === "paused") {
          notice = "Correction cancelled; Run remains paused. Press R to resume.";
        }
        render();
        return;
      }
      if (key.name === "backspace") { inputValue = inputValue.slice(0, -1); render(); return; }
      if (key.name === "return") {
        const value = inputValue;
        editMode = false;
        inputValue = "";
        if (mode === "home") startGoal(value); else submitCorrection(value);
        render();
        return;
      }
      if (!key.ctrl && printable.length > 0) { appendInput(printable); render(); }
      return;
    }
    if (mode === "home") {
      if (key.name === "i" || key.name === "return") { editMode = true; render(); return; }
      if (key.name === "q" || key.name === "escape") { requestExit(); return; }
      if (!key.ctrl && printable.length > 0) { editMode = true; appendInput(printable); render(); }
      return;
    }
    const snapshot = currentHandle?.controller.getSnapshot();
    if (snapshot === undefined) return;
    if (key.name === "i") {
      const enterCorrection = () => {
        editMode = true;
        inputValue = "";
        notice = snapshot.status === "waiting_approval"
          ? "Correction will revoke the pending approval before entering the Controller Inbox"
          : "Correction mode: submit to invalidate the old decision";
        render();
      };
      if (snapshot.status === "running") {
        invoke(async () => {
          await session.pause("paused before TUI correction");
          enterCorrection();
        }, "Run paused; correction input is ready");
      } else if (snapshot.status === "paused" || snapshot.status === "waiting_user" || snapshot.status === "waiting_approval") {
        enterCorrection();
      } else {
        notice = `Correction is unavailable while Run is ${snapshot.status}`;
        render();
      }
      return;
    }
    if (key.name === "a") {
      try { session.abort("aborted from TUI"); notice = "Abort requested"; } catch (error) { notice = errorMessage(error); }
      render();
      return;
    }
    if (key.name === "p") { invoke(() => session.pause(), "Pause requested"); return; }
    if (key.name === "r") { invoke(() => session.resume(), "Resume requested"); return; }
    if (key.name === "s") { notice = "Latest observation is recorded in the Run artifacts"; render(); return; }
    if (snapshot.status === "waiting_approval" && (key.name === "y" || key.name === "n")) {
      invoke(() => session.resolveApproval(key.name === "y"), key.name === "y" ? "Approval accepted" : "Approval rejected");
      return;
    }
    if (key.name === "q" || key.name === "escape") {
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
    if (key.ctrl && key.name === "c") { try { controller.cancel("Ctrl+C from TUI"); } catch { /* already finished */ } return; }
    if (editMode) {
      if (key.name === "escape") { editMode = false; input = ""; return; }
      if (key.name === "backspace") { input = input.slice(0, -1); return; }
      if (key.name === "return") { const value = input.trim(); editMode = false; input = ""; if (value.length > 0) void controller.submitUserInput(value); return; }
      if (!key.ctrl && printable.length > 0) input = `${input}${printable.replace(/[\r\n]+/gu, " ")}`.slice(0, MAX_TUI_INPUT_LENGTH);
      return;
    }
    if (key.name === "i") { editMode = true; input = ""; return; }
    if (key.name === "a") { try { controller.cancel("aborted from TUI"); } catch { /* already finished */ } return; }
    if (key.name === "p") void controller.pause("paused from TUI").catch(() => undefined);
    if (key.name === "r") void controller.resume().catch(() => undefined);
    const snapshot = controller.getSnapshot();
    if (snapshot.status === "waiting_approval" && (key.name === "y" || key.name === "n")) {
      const requestId = snapshot.pendingApproval?.requestId;
      if (requestId !== undefined) void controller.resolveApproval(requestId, key.name === "y").catch(() => undefined);
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

export function buildTuiFrame(
  snapshot: RunSnapshot,
  events: readonly RuntimeEvent[],
  goal: string,
  metadata: TuiMetadata,
  ui: {
    editMode: boolean;
    input: string;
    notice: string;
    mode?: TuiMode;
    feedState?: TuiFeedState;
    sessionStatus?: string;
  },
): string {
  const width = Math.max(60, Math.min(process.stdout.columns || 100, 140));
  const latestObservation = [...events].reverse().find((event) => event.type === "observation.created");
  const guard = [...events].reverse().find((event) => event.type === "action.guard.evaluated");
  const lines = [
    `Computer Harness TUI  |  ${snapshot.status.toUpperCase()}${snapshot.outcome === undefined ? "" : ` / ${snapshot.outcome}`}`,
    "─".repeat(width),
    `Provider: ${clip(metadata.provider, width - 30)}   Computer: ${clip(metadata.computer, width - 30)}`,
    `Profile: ${metadata.profile}   Risk Guard: ${metadata.riskGuard === "layered" ? "ENABLED" : "DISABLED"} (${metadata.riskGuard})`,
    `Focus evidence: ${metadata.computer === "cua" ? "UNKNOWN (generic foreground input is not fixture-verified)" : "UNKNOWN (backend metadata is not focus proof)"}`,
    `Session: ${ui.sessionStatus ?? "single-run"}   Event feed: ${ui.feedState ?? "legacy"}`,
    `Steps: ${snapshot.stepCount}   Model requests: ${snapshot.modelRequestCount}   Guard: ${snapshot.guardEvaluationCount}   Risk model: ${snapshot.riskModelRequestCount}`,
    `Plan: ${snapshot.plan.tasks.filter((task) => task.status !== "completed").length} open / ${snapshot.plan.tasks.length} total   Memory: ${snapshot.memory.facts.length} facts / ${snapshot.memory.entities.length} entities`,
    `Goal: ${clip(goal, width - 6)}`,
    `Observation: ${latestObservation?.type === "observation.created" ? clip(`${latestObservation.observation.id}  ${latestObservation.observation.screenshot.relativePath}`, width - 15) : "not available"}`,
    `Last guard: ${guard?.type === "action.guard.evaluated" ? `${guard.decision} via ${guard.path} (${guard.reasonCode})` : "not evaluated"}`,
    "─".repeat(width),
    "Recent committed events",
    ...events.slice(-10).map((event) => ` ${String(event.sequence).padStart(4, " ")}  ${formatEvent(event, width - 8)}`),
    "─".repeat(width),
  ];
  if (snapshot.status === "waiting_approval" && snapshot.pendingApproval !== undefined) {
    lines.push(`APPROVAL: ${clip(snapshot.pendingApproval.reason, width - 11)}`, "Press Y to approve, N to reject, or I to correct.");
  } else if (snapshot.status === "waiting_user") {
    lines.push(`USER INPUT: ${clip(snapshot.pendingUserQuestion ?? "Response required", width - 13)}`, "Press I to enter a response or correction.");
  } else {
    lines.push("Keys: I correction/input   P pause   R resume   A abort   S screenshot   Q exit");
  }
  if (ui.editMode) lines.push(`> ${maskSensitiveInput(ui.input)}`);
  if (ui.notice.length > 0) lines.push(`Notice: ${clip(ui.notice, width - 8)}`);
  lines.push(`Artifacts: ${clip(metadata.output, width - 11)}`);
  return `${lines.join("\n")}\n`;
}

function buildTuiHomeFrame(
  metadata: TuiMetadata,
  session: ApplicationSession,
  ui: { editMode: boolean; input: string; notice: string; feedState: TuiFeedState },
): string {
  const width = Math.max(60, Math.min(process.stdout.columns || 100, 140));
  const last = session.lastRun;
  const lines = [
    "Computer Harness TUI  |  HOME",
    "─".repeat(width),
    `Profile: ${metadata.profile}   Risk Guard: ${metadata.riskGuard === "layered" ? "ENABLED" : "DISABLED"} (${metadata.riskGuard})`,
    `Session: ${session.status}   Event feed: ${ui.feedState}`,
    `Provider: ${clip(metadata.provider, width - 30)}   Computer: ${clip(metadata.computer, width - 30)}`,
    `Focus evidence: ${metadata.computer === "cua" ? "UNKNOWN (generic foreground input is not fixture-verified)" : "UNKNOWN (backend metadata is not focus proof)"}`,
    "",
    session.status === "blocked"
      ? "Environment ownership is held by another Run or pending cleanup; this session cannot start another Run."
      : "Enter a goal to start a fresh Run. Finished Runs never reuse their Controller, approval, or Memory store.",
    last === undefined ? "Last Run: none" : `Last Run: ${clip(last.goal, width - 12)} → ${last.outcome ?? last.error ?? "not completed"}`,
    "",
    "Keys: type/paste goal   Enter start   Q exit",
  ];
  if (ui.editMode) lines.push(`> ${maskSensitiveInput(ui.input)}`);
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
  if (event.type === "action.guard.evaluated") return clip(`guard: ${event.decision} / ${event.path} / ${event.reasonCode}`, width);
  if (event.type === "approval.requested") return clip(`approval.requested: ${event.reason}`, width);
  if (event.type === "tool.call.received") return clip(`tool.call: ${event.call.name}`, width);
  if (event.type === "tool.call.rejected") return clip(`tool.rejected: ${event.reason}`, width);
  if (event.type === "action.execution.started") return `action.started: ${event.action.kind}`;
  if (event.type === "action.execution.completed" || event.type === "action.execution.failed") return `${event.type}: ${event.receipt.status}`;
  if (event.type === "runtime.error") return clip(`runtime.error: ${event.category} / ${event.message}`, width);
  return event.type;
}

function maskSensitiveInput(value: string): string {
  return `(${value.length} characters hidden)`;
}

function clip(value: string, max: number): string {
  const normalized = sanitizeTerminalText(value).replace(/\s+/gu, " ").trim();
  return normalized.length <= max ? normalized : `${normalized.slice(0, Math.max(0, max - 1))}…`;
}

function errorMessage(error: unknown): string {
  return sanitizeTerminalText(error instanceof Error ? error.message : String(error));
}
