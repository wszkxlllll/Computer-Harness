// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, getCommand, sendCommand } from "../api";
import type { RunSnapshot } from "../types";
import { useRunCommands } from "./useRunCommands";

vi.mock("../api", async (importOriginal) => {
  const api = await importOriginal<typeof import("../api")>();
  return { ...api, getCommand: vi.fn(), sendCommand: vi.fn() };
});

const snapshot: RunSnapshot = {
  runId: "run-unknown-command",
  goal: "Complete the requested task",
  status: "running",
  sequence: 8,
  capabilities: { pause: true, resume: false, abort: true, correct: true },
};

function Probe() {
  const commands = useRunCommands({ runId: snapshot.runId, snapshot, refresh: async () => snapshot });
  return (
    <main>
      <button type="button" onClick={() => void commands.control("pause")}>Pause</button>
      {commands.notice && <p role="status">{commands.notice.text}</p>}
    </main>
  );
}

beforeEach(() => {
  vi.mocked(sendCommand).mockReset();
  vi.mocked(getCommand).mockReset();
});

afterEach(() => cleanup());

describe("run command uncertainty", () => {
  it("looks up an unknown command once and never resends it automatically", async () => {
    vi.mocked(sendCommand).mockRejectedValue(new ApiError("connection dropped", 0, "HOST_UNREACHABLE"));
    vi.mocked(getCommand).mockRejectedValue(new Error("receipt unavailable"));
    render(<Probe />);

    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    expect(await screen.findByText(/页面不会自动重复发送/)).toBeDefined();
    await waitFor(() => expect(sendCommand).toHaveBeenCalledTimes(1));
    expect(getCommand).toHaveBeenCalledTimes(1);
    expect(getCommand).toHaveBeenCalledWith(snapshot.runId, expect.any(String));
  });
});
