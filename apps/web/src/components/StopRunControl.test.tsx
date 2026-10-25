// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, getCommand, sendCommand } from "../api";
import { useRunCommands } from "../hooks/useRunCommands";
import type { CommandReceipt, RunSnapshot } from "../types";
import { StopRunControl } from "./StopRunControl";

vi.mock("../api", async (importOriginal) => {
  const api = await importOriginal<typeof import("../api")>();
  return { ...api, getCommand: vi.fn(), sendCommand: vi.fn() };
});

const initial: RunSnapshot = {
  runId: "stop-run-1", goal: "Save the document", status: "running", sequence: 8,
  capabilities: { abort: true, pause: true },
};
const refresh = vi.fn().mockResolvedValue(undefined);
const applied: CommandReceipt = { commandId: "receipt", status: "applied" };

function Harness({ snapshot = initial, runId = snapshot.runId }: { snapshot?: RunSnapshot; runId?: string }) {
  const commands = useRunCommands({ runId, snapshot, refresh });
  return <>
    <StopRunControl key={runId} disabled={commands.busyCommand !== undefined} onConfirm={() => commands.control("abort")} />
    {commands.notice && <p role="status">{commands.notice.text}</p>}
  </>;
}

beforeEach(() => {
  vi.mocked(sendCommand).mockReset().mockResolvedValue(applied);
  vi.mocked(getCommand).mockReset();
  refresh.mockReset().mockResolvedValue(undefined);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("in-page stop confirmation", () => {
  it("opens and cancels without sending a command or blocking the browser, restoring focus", () => {
    const nativeConfirm = vi.spyOn(window, "confirm");
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "停止任务" }));
    expect(screen.getByRole("group", { name: "确认停止任务" })).toBeDefined();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "取消" }));
    expect(sendCommand).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(screen.queryByRole("group", { name: "确认停止任务" })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "停止任务" }));
    expect(sendCommand).not.toHaveBeenCalled();
    expect(nativeConfirm).not.toHaveBeenCalled();
  });

  it("uses the latest sequence on confirmation and dispatches only once for a rapid double click", async () => {
    let resolve!: (receipt: CommandReceipt) => void;
    vi.mocked(sendCommand).mockImplementation(() => new Promise((done) => { resolve = done; }));
    const view = render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "停止任务" }));
    view.rerender(<Harness snapshot={{ ...initial, sequence: 12 }} />);
    const confirm = screen.getByRole("button", { name: "确认停止" });
    act(() => { fireEvent.click(confirm); fireEvent.click(confirm); });
    expect(sendCommand).toHaveBeenCalledTimes(1);
    expect(sendCommand).toHaveBeenCalledWith(initial.runId, expect.any(String), { type: "abort", expectedSequence: 12 });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    await act(async () => resolve(applied));
    expect(screen.queryByRole("group", { name: "确认停止任务" })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "停止任务" }));
  });

  it("does not carry an open confirmation to another Run", () => {
    const view = render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "停止任务" }));
    view.rerender(<Harness snapshot={{ ...initial, runId: "stop-run-2" }} />);
    expect(screen.queryByRole("group", { name: "确认停止任务" })).toBeNull();
    expect(sendCommand).not.toHaveBeenCalled();
  });

  it.each(["another control", "window blur"])("does not reclaim focus after %s while waiting for a receipt", async (change) => {
    let resolve!: (receipt: CommandReceipt) => void;
    vi.mocked(sendCommand).mockImplementation(() => new Promise((done) => { resolve = done; }));
    render(<><Harness /><button type="button">Refresh status</button></>);
    fireEvent.click(screen.getByRole("button", { name: "停止任务" }));
    fireEvent.click(screen.getByRole("button", { name: "确认停止" }));
    const refreshButton = screen.getByRole("button", { name: "Refresh status" });
    if (change === "another control") refreshButton.focus();
    else fireEvent(window, new Event("blur"));
    await act(async () => resolve(applied));
    expect(document.activeElement).not.toBe(screen.getByRole("button", { name: "停止任务" }));
    if (change === "another control") expect(document.activeElement).toBe(refreshButton);
  });

  it.each([
    { ...initial, status: "finished" as const },
    { ...initial, capabilities: { abort: false } },
  ])("refuses a confirmation when the latest state no longer permits abort", async (snapshot) => {
    const view = render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "停止任务" }));
    view.rerender(<Harness snapshot={snapshot} />);
    fireEvent.click(screen.getByRole("button", { name: "确认停止" }));
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    expect(sendCommand).not.toHaveBeenCalled();
  });

  it("looks up an unknown response once without automatically resending abort", async () => {
    vi.mocked(sendCommand).mockRejectedValue(new ApiError("connection dropped", 0, "HOST_UNREACHABLE"));
    vi.mocked(getCommand).mockRejectedValue(new Error("receipt unavailable"));
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "停止任务" }));
    fireEvent.click(screen.getByRole("button", { name: "确认停止" }));
    expect(await screen.findByText(/页面不会自动重复发送/)).toBeDefined();
    expect(sendCommand).toHaveBeenCalledTimes(1);
    expect(getCommand).toHaveBeenCalledTimes(1);
    expect(getCommand).toHaveBeenCalledWith(initial.runId, vi.mocked(sendCommand).mock.calls[0]?.[1]);
    expect(screen.queryByRole("group", { name: "确认停止任务" })).toBeNull();
  });

  it("does not send an old Run's snapshot to the new Run during navigation", async () => {
    render(<Harness runId="stop-run-2" />);
    fireEvent.click(screen.getByRole("button", { name: "停止任务" }));
    fireEvent.click(screen.getByRole("button", { name: "确认停止" }));
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    expect(sendCommand).not.toHaveBeenCalled();
  });
});
