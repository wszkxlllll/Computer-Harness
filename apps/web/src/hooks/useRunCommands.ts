import { useState } from "react";
import { ApiError, getCommand, sendCommand } from "../api";
import { approvalCommand, controlCommand, correctionCommand, ignoreWindowCommand, responseCommand, windowChoiceCommand } from "../command-contract";
import { CommandIdRegistry, shouldClearAfterFailure } from "../command-id-registry";
import type { CommandReceipt, RunSnapshot, WindowCandidate } from "../types";

export interface CommandNotice {
  text: string;
  tone: "calm" | "warning" | "error";
}

interface UseRunCommandsOptions {
  runId: string;
  snapshot?: RunSnapshot;
  refresh: () => Promise<void>;
}

export function useRunCommands({ runId, snapshot, refresh }: UseRunCommandsOptions) {
  const [busyCommand, setBusyCommand] = useState<string>();
  const [notice, setNotice] = useState<CommandNotice>();
  const [commandIds] = useState(() => new CommandIdRegistry());

  async function execute(key: string, command: Record<string, unknown>, pendingLabel: string): Promise<boolean> {
    if (!snapshot || busyCommand) return false;
    const commandId = commandIds.forAction(key);
    setBusyCommand(key);
    setNotice({ text: pendingLabel, tone: "calm" });

    try {
      let receipt: CommandReceipt;
      try {
        receipt = await sendCommand(runId, commandId, command);
      } catch (caught) {
        if (!(caught instanceof ApiError) || caught.status !== 0) throw caught;
        try {
          receipt = await getCommand(runId, commandId);
        } catch {
          setNotice({
            text: "暂时无法确认电脑是否收到这项操作。页面不会自动重复发送；检查电脑当前状态后再点一次。",
            tone: "warning",
          });
          return false;
        }
      }

      if (receipt.status === "accepted") {
        setNotice({ text: "电脑已收到请求，正在确认是否已生效…", tone: "calm" });
        receipt = await waitForReceipt(runId, commandId, receipt);
      }

      if (receipt.status === "accepted") {
        setNotice({ text: "电脑仍在处理这项请求。任务状态以电脑稍后回报为准。", tone: "calm" });
        return false;
      }
      if (receipt.status === "applied") {
        commandIds.complete(key);
        setNotice({ text: receipt.message || "电脑已确认这项操作。", tone: "calm" });
        await refresh().catch(() => undefined);
        return true;
      }
      if (receipt.status === "outcome_unknown") {
        setNotice({ text: "电脑无法确认这项操作是否完成。请先检查最新截图和任务状态，不要重复执行。", tone: "warning" });
        await refresh().catch(() => undefined);
        return false;
      }
      commandIds.complete(key);
      setNotice({ text: receipt.message || "电脑没有执行这项操作。请刷新状态后再试。", tone: "error" });
      await refresh().catch(() => undefined);
      return false;
    } catch (caught) {
      if (shouldClearAfterFailure(caught)) commandIds.complete(key);
      setNotice({ text: caught instanceof Error ? caught.message : "操作失败，请刷新任务状态。", tone: "error" });
      await refresh().catch(() => undefined);
      return false;
    } finally {
      setBusyCommand(undefined);
    }
  }

  async function actOnApproval(approved: boolean) {
    const pending = snapshot?.pendingRequest;
    if (!snapshot || !pending) return;
    const command = approvalCommand(snapshot, pending.requestId, approved);
    if (!command) {
      setNotice({ text: "这项确认已过期。正在重新读取电脑状态。", tone: "warning" });
      await refresh().catch(() => undefined);
      return;
    }
    await execute(
      `${approved ? "approve" : "reject"}:${pending.requestId}`,
      command,
      approved ? "已发送确认请求，等待电脑回执。" : "已发送拒绝请求，等待电脑回执。",
    );
  }

  async function answerRequest(text: string): Promise<boolean> {
    const pending = snapshot?.pendingRequest;
    if (!snapshot || !pending) return false;
    const command = responseCommand(snapshot, pending.requestId, text);
    if (!command) {
      setNotice({ text: "这条补充请求已经变化。请先查看最新状态。", tone: "warning" });
      await refresh().catch(() => undefined);
      return false;
    }
    return execute(`respond:${pending.requestId}:${text}`, command, "补充内容已发送，等待电脑回执。");
  }

  async function chooseWindow(candidate: WindowCandidate) {
    const pending = snapshot?.pendingRequest;
    if (!snapshot || !pending) return;
    const command = windowChoiceCommand(snapshot, pending.requestId, candidate.token);
    if (!command) {
      setNotice({ text: "这个窗口已不在当前选择列表中。正在刷新任务状态。", tone: "warning" });
      await refresh().catch(() => undefined);
      return;
    }
    await execute(`window:${pending.requestId}:${candidate.token}`, command, "已发送窗口选择，等待电脑确认。");
  }

  async function ignoreNewWindow() {
    const pending = snapshot?.pendingRequest;
    if (!snapshot || !pending) return;
    const command = ignoreWindowCommand(snapshot, pending.requestId);
    if (!command) {
      setNotice({ text: "当前窗口不能忽略，任务状态可能已经变化。", tone: "warning" });
      await refresh().catch(() => undefined);
      return;
    }
    await execute(`ignore:${pending.requestId}`, command, "已发送忽略请求，等待电脑确认。");
  }

  async function correct(text: string): Promise<boolean> {
    if (!snapshot) return false;
    const command = correctionCommand(snapshot, text);
    if (!command) {
      setNotice({ text: "电脑正在等待一项确认或补充信息。请先处理当前请求。", tone: "warning" });
      return false;
    }
    return execute(`correct:${text}`, command, "补充要求已发送，等待电脑回执。");
  }

  async function control(type: "pause" | "resume" | "abort") {
    if (type === "abort" && !window.confirm("停止当前任务？已经完成的电脑操作无法撤销。")) return;
    const copy = type === "pause" ? "暂停" : type === "resume" ? "继续" : "停止";
    const command = snapshot ? controlCommand(snapshot, type) : undefined;
    if (!command) {
      setNotice({ text: "电脑当前不支持这项控制，或状态已经变化。", tone: "warning" });
      await refresh().catch(() => undefined);
      return;
    }
    await execute(type, command, `已发送${copy}请求，等待电脑回执。`);
  }

  async function refreshStatus() {
    try {
      await refresh();
    } catch (caught) {
      setNotice({ text: caught instanceof Error ? caught.message : "暂时无法刷新任务状态。", tone: "warning" });
    }
  }

  return { busyCommand, notice, setNotice, actOnApproval, answerRequest, chooseWindow, ignoreNewWindow, correct, control, refreshStatus };
}

async function waitForReceipt(runId: string, commandId: string, initial: CommandReceipt): Promise<CommandReceipt> {
  let receipt = initial;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    await new Promise<void>((resolve) => window.setTimeout(resolve, 900));
    try {
      receipt = await getCommand(runId, commandId);
    } catch {
      return receipt;
    }
    if (receipt.status !== "accepted") return receipt;
  }
  return receipt;
}
