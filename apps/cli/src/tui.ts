import { emitKeypressEvents } from "node:readline";
import type { RuntimeEvent, RunOutcome } from "@computer-harness/protocol";
import type { RunController } from "@computer-harness/runtime";
import type { RunSnapshot } from "@computer-harness/trajectory";

const REFRESH_MS = 120;

export interface TuiMetadata {
  provider: string;
  computer: string;
  output: string;
}

export async function runWithTuiControls(
  controller: RunController,
  goal: string,
  metadata: TuiMetadata,
): Promise<RunOutcome> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("--tui requires an interactive terminal");
  }
  emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  let editMode = false;
  let input = "";
  let notice = "";
  let busy = false;
  const invoke = (operation: () => Promise<void> | void, success: string) => {
    if (busy) return;
    busy = true;
    Promise.resolve().then(operation).then(() => { notice = success; }).catch((error: unknown) => {
      notice = error instanceof Error ? error.message : String(error);
    }).finally(() => { busy = false; });
  };
  const onKeypress = (text: string, key: { name?: string; ctrl?: boolean; sequence?: string }) => {
    if (key.ctrl && key.name === "c") {
      try { controller.cancel("cancelled from TUI"); } catch { /* already finished */ }
      return;
    }
    if (editMode) {
      if (key.name === "escape") { editMode = false; input = ""; return; }
      if (key.name === "backspace") { input = input.slice(0, -1); return; }
      if (key.name === "return") {
        const value = input.trim();
        editMode = false;
        input = "";
        if (value.length > 0) invoke(() => controller.submitUserInput(value), "User input queued");
        return;
      }
      if (!key.ctrl && text.length === 1 && input.length < 500) input += text;
      return;
    }
    const snapshot = controller.getSnapshot();
    if (key.name === "i") { editMode = true; input = ""; return; }
    if (key.name === "a") {
      try { controller.cancel("aborted from TUI"); notice = "Abort requested"; } catch (error) { notice = error instanceof Error ? error.message : String(error); }
      return;
    }
    if (key.name === "p") { invoke(() => controller.pause("paused from TUI"), "Pause requested"); return; }
    if (key.name === "r") { invoke(() => controller.resume(), "Resume requested"); return; }
    if (snapshot.status === "waiting_approval" && snapshot.pendingApproval !== undefined && (key.name === "y" || key.name === "n")) {
      const approved = key.name === "y";
      invoke(() => controller.resolveApproval(snapshot.pendingApproval!.requestId, approved), approved ? "Approval accepted" : "Approval rejected");
    }
  };
  process.stdin.on("keypress", onKeypress);
  process.stdout.write("\u001b[?25l");
  const render = () => {
    const frame = buildTuiFrame(controller.getSnapshot(), controller.getEvents(), goal, metadata, { editMode, input, notice });
    process.stdout.write(`\u001b[H\u001b[2J${frame}`);
  };
  const timer = setInterval(render, REFRESH_MS);
  render();
  try {
    const outcome = await controller.start(goal);
    notice = `Run finished: ${outcome}`;
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
  ui: { editMode: boolean; input: string; notice: string },
): string {
  const width = Math.max(60, Math.min(process.stdout.columns || 100, 140));
  const latestObservation = [...events].reverse().find((event) => event.type === "observation.created");
  const guard = [...events].reverse().find((event) => event.type === "action.guard.evaluated");
  const lines = [
    `Computer Harness TUI  |  ${snapshot.status.toUpperCase()}${snapshot.outcome === undefined ? "" : ` / ${snapshot.outcome}`}`,
    "─".repeat(width),
    `Provider: ${metadata.provider}   Computer: ${metadata.computer}`,
    `Steps: ${snapshot.stepCount}   Model requests: ${snapshot.modelRequestCount}   Guard: ${snapshot.guardEvaluationCount}   Risk model: ${snapshot.riskModelRequestCount}`,
    `Plan: ${snapshot.plan.tasks.filter((task) => task.status !== "completed").length} open / ${snapshot.plan.tasks.length} total   Memory: ${snapshot.memory.facts.length} facts / ${snapshot.memory.entities.length} entities`,
    `Goal: ${clip(goal, width - 6)}`,
    `Observation: ${latestObservation?.type === "observation.created" ? `${latestObservation.observation.id}  ${latestObservation.observation.screenshot.relativePath}` : "not available"}`,
    `Last guard: ${guard?.type === "action.guard.evaluated" ? `${guard.decision} via ${guard.path} (${guard.reasonCode})` : "not evaluated"}`,
    "─".repeat(width),
    "Recent events",
    ...events.slice(-10).map((event) => ` ${String(event.sequence).padStart(4, " ")}  ${formatEvent(event, width - 8)}`),
    "─".repeat(width),
  ];
  if (snapshot.status === "waiting_approval" && snapshot.pendingApproval !== undefined) {
    lines.push(`APPROVAL: ${clip(snapshot.pendingApproval.reason, width - 11)}`, "Press Y to approve or N to reject. Default is reject.");
  } else if (snapshot.status === "waiting_user") {
    lines.push(`USER INPUT: ${clip(snapshot.pendingUserQuestion ?? "Response required", width - 13)}`, "Press I to enter a response.");
  } else {
    lines.push("Keys: I user correction/input   P pause   R resume   A abort   Ctrl+C abort");
  }
  if (ui.editMode) lines.push(`> ${maskSensitiveInput(ui.input)}`);
  if (ui.notice.length > 0) lines.push(`Notice: ${clip(ui.notice, width - 8)}`);
  lines.push(`Artifacts: ${metadata.output}`);
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
  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized.length <= max ? normalized : `${normalized.slice(0, Math.max(0, max - 1))}…`;
}
