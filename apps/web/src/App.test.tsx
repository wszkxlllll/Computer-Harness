// @vitest-environment happy-dom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, getPhoneSession, getVoiceInputCapabilities } from "./api";
import { App } from "./App";

vi.mock("./api", async (importOriginal) => {
  const api = await importOriginal<typeof import("./api")>();
  return {
    ...api,
    getPhoneSession: vi.fn(async () => ({ csrfToken: "csrf-test", expiresAt: new Date(Date.now() + 60_000).toISOString() })),
    getVoiceInputCapabilities: vi.fn(async () => ({ available: false })),
  };
});

vi.mock("./HomeScreen", () => ({
  HomeScreen: ({ commonSiteChoices = [] }: { commonSiteChoices?: readonly { label: string; url: string }[] }) => (
    <main id="main-content" tabIndex={-1}>
      <button type="button">首页操作</button>
      {commonSiteChoices.map((choice) => <span key={choice.url}>{choice.label}</span>)}
    </main>
  ),
}));

vi.mock("./ConnectPhoneScreen", () => ({
  ConnectPhoneScreen: () => <main id="main-content" tabIndex={-1}><h1 tabIndex={-1}>连接管理</h1></main>,
}));

vi.mock("./PairingScreen", () => ({
  PairingScreen: () => <main id="main-content" tabIndex={-1}><h1 tabIndex={-1}>等待电脑确认</h1></main>,
}));

vi.mock("./RunWorkspace", () => ({
  RunWorkspace: () => <main id="main-content" tabIndex={-1}><h1 tabIndex={-1}>任务目标</h1></main>,
}));

afterEach(() => {
  cleanup();
  localStorage.clear();
  window.history.replaceState(null, "", "/");
});

describe("App composition", () => {
  it("forwards injected common-site choices to HomeScreen", async () => {
    render(<App commonSiteChoices={[{ label: "Example portal", url: "https://portal.example/" }]} />);

    expect(await screen.findByText("Example portal")).toBeDefined();
  });

  it("focuses the main landmark after the phone session is ready and does not refocus on later updates", async () => {
    let resolveSession!: (session: { csrfToken: string; expiresAt: string }) => void;
    let resolveVoiceCapabilities!: (capabilities: { available: false }) => void;
    vi.mocked(getPhoneSession).mockReturnValueOnce(new Promise((resolve) => { resolveSession = resolve; }));
    vi.mocked(getVoiceInputCapabilities).mockReturnValueOnce(new Promise((resolve) => { resolveVoiceCapabilities = resolve; }));

    render(<App />);
    const loadingMain = screen.getByRole("main");
    expect(document.activeElement).not.toBe(loadingMain);

    await act(async () => {
      resolveSession({ csrfToken: "csrf-ready", expiresAt: new Date(Date.now() + 60_000).toISOString() });
      await Promise.resolve();
    });

    const main = screen.getByRole("main");
    expect(document.activeElement).toBe(main);

    const action = screen.getByRole("button", { name: "首页操作" });
    action.focus();
    await act(async () => {
      resolveVoiceCapabilities({ available: false });
      await Promise.resolve();
    });
    expect(document.activeElement).toBe(action);
  });

  it.each([
    ["/connect", "连接管理"],
    ["/pair", "等待电脑确认"],
  ])("focuses the ready standalone route %s", (path, heading) => {
    window.history.replaceState(null, "", path);
    render(<App />);

    const pageHeading = screen.getByRole("heading", { name: heading });
    expect(pageHeading).toBeDefined();
    expect(document.activeElement).toBe(pageHeading);
  });

  it("focuses a ready task title instead of an unnamed main landmark", async () => {
    window.history.replaceState(null, "", "/run/route-focus-test");
    render(<App />);

    const heading = await screen.findByRole("heading", { name: "任务目标" });
    await waitFor(() => expect(document.activeElement).toBe(heading));
  });

  it.each([
    [401, "先连接你的电脑"],
    [503, "电脑暂时没有响应"],
  ])("waits for the session check before focusing the gate state for status %s", async (status, heading) => {
    let rejectSession!: (error: unknown) => void;
    vi.mocked(getPhoneSession).mockReturnValueOnce(new Promise((_resolve, reject) => { rejectSession = reject; }));

    render(<App />);
    const loadingMain = screen.getByRole("main");
    expect(document.activeElement).not.toBe(loadingMain);

    await act(async () => {
      rejectSession(new ApiError("本次连接未完成。", status));
      await Promise.resolve();
    });

    const pageHeading = screen.getByRole("heading", { name: heading });
    await waitFor(() => expect(document.activeElement).toBe(pageHeading));
  });
});
