// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RunWorkspace } from "./RunWorkspace";
import { PreferencesProvider } from "./PreferencesContext";
import { useRunFeed } from "./hooks/useRunFeed";
import { useRunCommands } from "./hooks/useRunCommands";
import type { RunSnapshot } from "./types";

vi.mock("./hooks/useRunFeed", () => ({ useRunFeed: vi.fn() }));
vi.mock("./hooks/useRunCommands", () => ({ useRunCommands: vi.fn() }));

const refresh = vi.fn().mockResolvedValue(undefined);
const setNotice = vi.fn();
const commands = {
  busyCommand: undefined,
  notice: undefined,
  setNotice,
  actOnApproval: vi.fn(),
  answerRequest: vi.fn(),
  chooseWindow: vi.fn(),
  ignoreNewWindow: vi.fn(),
  correct: vi.fn(),
  control: vi.fn(),
  refreshStatus: vi.fn(),
};

const approval: RunSnapshot = {
  runId: "run-1",
  goal: "Review the current screen",
  status: "waiting_approval",
  outcome: undefined,
  sequence: 1,
  capabilities: { approval: true, pause: true, abort: true },
  pendingRequest: {
    requestId: "approval-A",
    kind: "approval",
    requiresVisualReview: true,
    reason: "Approval A reason",
    preview: {
      actions: [{ operation: "click", kind: "click", points: [{ x: 20, y: 30 }] }],
      evidence: {
        assetId: "asset-A",
        observationId: "obs-A",
        decisionObservationId: "decision-A",
        capturedAt: "2026-09-27T00:00:00.000Z",
        viewport: { width: 640, height: 480, coordinateSpace: "physical" },
      },
    },
    candidates: undefined,
  },
  latestAssetId: "asset-A",
};

let feedState: ReturnType<typeof useRunFeed>;

beforeEach(() => {
  feedState = { snapshot: approval, events: [], connection: "live", refresh };
  vi.mocked(useRunFeed).mockImplementation(() => feedState);
  vi.mocked(useRunCommands).mockReturnValue(commands);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("request-bound screenshot lifecycle", () => {
  it("closes the old approval viewer and never resurrects that request after a newer request resolves", () => {
    const view = render(<PreferencesProvider><RunWorkspace runId="run-1" /></PreferencesProvider>);
    fireEvent.click(screen.getByRole("button", { name: /放大查看/ }));
    expect(screen.getByRole("dialog", { name: "本次请求绑定的电脑画面" })).toBeDefined();

    feedState = {
      ...feedState,
      snapshot: {
        ...approval,
        status: "waiting_user",
        sequence: 2,
        capabilities: { pause: true, abort: true },
        pendingRequest: { requestId: "input-B", kind: "user_input", question: "Which option should the computer use?" },
      },
    };
    view.rerender(<PreferencesProvider><RunWorkspace runId="run-1" /></PreferencesProvider>);

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByLabelText("你的补充")).toBeDefined();
    expect((screen.getByLabelText("你的补充") as HTMLTextAreaElement).disabled).toBe(true);
    expect(screen.queryByText("Approval A reason")).toBeNull();

    feedState = {
      ...feedState,
      snapshot: {
        ...approval,
        status: "running",
        sequence: 3,
        capabilities: { correct: true, pause: true, abort: true },
        pendingRequest: undefined,
      },
    };
    view.rerender(<PreferencesProvider><RunWorkspace runId="run-1" /></PreferencesProvider>);
    expect(screen.queryByRole("heading", { name: "电脑请求你确认一项操作" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "电脑需要你补充信息" })).toBeNull();
  });

  it("keeps the pinned frame while approval B replaces A, then restores focus when B disappears", () => {
    const view = render(<PreferencesProvider><RunWorkspace runId="run-1" /></PreferencesProvider>);
    fireEvent.click(screen.getByRole("button", { name: /放大查看/ }));
    const dialog = screen.getByRole("dialog", { name: "本次请求绑定的电脑画面" });

    feedState = {
      ...feedState,
      snapshot: {
        ...approval,
        sequence: 2,
        pendingRequest: {
          requestId: "approval-B",
          kind: "approval",
          requiresVisualReview: true,
          preview: {
            actions: [{ operation: "click", kind: "click", points: [{ x: 40, y: 50 }] }],
            evidence: {
              assetId: "asset-B",
              observationId: "obs-B",
              decisionObservationId: "decision-B",
              capturedAt: "2026-09-27T00:01:00.000Z",
              viewport: { width: 640, height: 480, coordinateSpace: "physical" },
            },
          },
        },
      },
    };
    view.rerender(<PreferencesProvider><RunWorkspace runId="run-1" /></PreferencesProvider>);
    expect(dialog.querySelector("img")?.getAttribute("src")).toContain("asset-A");
    expect(screen.getByText(/确认请求已变化/)).toBeDefined();

    feedState = {
      ...feedState,
      snapshot: {
        ...approval,
        status: "running",
        sequence: 3,
        capabilities: { correct: true, pause: true, abort: true },
        pendingRequest: undefined,
      },
    };
    view.rerender(<PreferencesProvider><RunWorkspace runId="run-1" /></PreferencesProvider>);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Review the current screen" }));
  });
});
