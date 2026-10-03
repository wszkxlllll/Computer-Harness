import { afterEach, describe, expect, it, vi } from "vitest";
import {
  appendVoiceAudio,
  completeManagedBrowserLogin,
  createRun,
  finishVoiceInput,
  getManagedBrowserProfileSettings,
  getVoiceInputCapabilities,
  listRuns,
  listWindowTargets,
  prepareManagedBrowserLogin,
  reloginManagedBrowser,
  setManagedBrowserDefaultSession,
  setPhoneCsrfToken,
  startVoiceInput,
} from "./api";

afterEach(() => {
  setPhoneCsrfToken(undefined);
  vi.unstubAllGlobals();
});

describe("API error presentation", () => {
  it("translates relay error codes into plain status copy", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ error: "host_unavailable" }),
      { status: 503, headers: { "Content-Type": "application/json" } },
    )));

    await expect(listRuns()).rejects.toMatchObject({
      message: "电脑当前离线或无法连接。确认电脑已开机并运行 Harness。",
      code: "host_unavailable",
    });
  });
});

describe("managed-browser profile Settings API contract", () => {
  it("uses the frozen read, preference, prepare, complete, and relogin routes", async () => {
    const ready = {
      status: "ready",
      defaultSession: "saved",
      commands: { prepare: "prepare", complete: "complete", relogin: "relogin" },
      profileLabel: "must-not-reach-the-phone",
    };
    const preparing = {
      ...ready,
      status: "preparing",
      operationId: "11111111-1111-4111-8111-111111111111",
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(ready), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ...ready, defaultSession: "temporary" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(preparing), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(ready), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(preparing), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    setPhoneCsrfToken("phone-csrf");

    await expect(getManagedBrowserProfileSettings()).resolves.toEqual({
      status: "ready",
      defaultSession: "saved",
      commands: { prepare: "prepare", complete: "complete", relogin: "relogin" },
    });
    await setManagedBrowserDefaultSession("temporary");
    await prepareManagedBrowserLogin();
    await completeManagedBrowserLogin("11111111-1111-4111-8111-111111111111");
    await reloginManagedBrowser();

    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual([
      "/api/managed-browser-profile",
      "/api/managed-browser-profile/preference",
      "/api/managed-browser-profile/prepare",
      "/api/managed-browser-profile/complete",
      "/api/managed-browser-profile/relogin",
    ]);
    const requests = fetchMock.mock.calls.map(([, init]) => init as RequestInit);
    expect(requests.map((request) => request.method ?? "GET")).toEqual(["GET", "PUT", "POST", "POST", "POST"]);
    expect(requests.slice(1).map((request) => JSON.parse(String(request.body)))).toEqual([
      { defaultSession: "temporary" },
      {},
      { operationId: "11111111-1111-4111-8111-111111111111" },
      {},
    ]);
    for (const request of requests.slice(1)) {
      expect((request.headers as Headers).get("X-CSRF-Token")).toBe("phone-csrf");
    }
  });

  it("rejects malformed sanitized profile state", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      status: "preparing",
      defaultSession: "saved",
      commands: { prepare: "prepare", complete: "complete", relogin: "relogin" },
    }), { status: 200 })));

    await expect(getManagedBrowserProfileSettings()).rejects.toThrow("电脑返回的浏览器准备状态缺少操作标识。");
  });
});

describe("voice input Host API contract", () => {
  it("discovers availability without sending audio and starts with a client idempotency key", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ available: true, sampleRate: 16_000, chunkBytes: 3_200 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ sessionId: "voice-session", events: [], eventCursor: 0 }), { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    setPhoneCsrfToken("phone-csrf");

    await expect(getVoiceInputCapabilities()).resolves.toMatchObject({ available: true, sampleRate: 16_000 });
    await startVoiceInput("voice-start-id");
    const [capabilityPath, startPath] = fetchMock.mock.calls.map(([path]) => path);
    expect(capabilityPath).toBe("/api/voice/capabilities");
    expect(startPath).toBe("/api/voice/sessions");
    const [, startRequest] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(JSON.parse(String(startRequest.body))).toEqual({ requestId: "voice-start-id" });
    expect((startRequest.headers as Headers).get("X-CSRF-Token")).toBe("phone-csrf");
  });

  it("encodes an ordered PCM batch in a same-origin JSON request and never submits a transcript", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ sessionId: "voice-session", events: [], eventCursor: 4 }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    setPhoneCsrfToken("phone-csrf");
    await appendVoiceAudio("voice-session", [
      { sequence: 7, data: new Uint8Array([1, 0, 2, 0]) },
      { sequence: 8, data: new Uint8Array([3, 0]) },
    ], 3);
    const [path, request] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/api/voice/sessions/voice-session/audio");
    expect(JSON.parse(String(request.body))).toEqual({
      chunks: [{ sequence: 7, audio: "AQACAA==" }, { sequence: 8, audio: "AwA=" }],
      afterEventSequence: 3,
    });
    expect(JSON.stringify(JSON.parse(String(request.body)))).not.toContain("transcript");
    expect((request.headers as Headers).get("X-CSRF-Token")).toBe("phone-csrf");
  });

  it("finishes through the explicit finalization route", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ sessionId: "voice-session", events: [], eventCursor: 9 }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    setPhoneCsrfToken("phone-csrf");
    await finishVoiceInput("voice-session", 8);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/voice/sessions/voice-session/finish");
    expect(JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body))).toEqual({ afterEventSequence: 8 });
  });
});

describe("explicit window-target run contract", () => {
  it("loads only the paired host's safe window labels and opaque tokens", async () => {
    const result = { candidates: [{ token: "opaque-window-token", appName: "Browser", title: "Contacts" }], expiresAt: new Date(Date.now() + 600_000).toISOString() };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(result), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(listWindowTargets()).resolves.toEqual(result);
    expect(fetchMock).toHaveBeenCalledWith("/api/windows", expect.objectContaining({ credentials: "same-origin", cache: "no-store" }));
  });

  it("starts with the explicitly chosen opaque window token", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ runId: "run-1", status: "created" }), { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);
    setPhoneCsrfToken("phone-csrf");

    await createRun("Compare these pages", "command-1", { mode: "window", targetToken: "opaque-window-token" });

    const [, request] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(request.body))).toEqual({ commandId: "command-1", goal: "Compare these pages", target: { mode: "window", targetToken: "opaque-window-token" } });
    expect(request.headers).toBeInstanceOf(Headers);
    expect((request.headers as Headers).get("X-CSRF-Token")).toBe("phone-csrf");
  });

  it("sends only the versioned assistant preference whitelist when supplied", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ runId: "run-prefs", status: "created" }), { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);
    await createRun("Summarize this page", "command-prefs", { mode: "auto" }, {
      version: 1,
      responseDetail: "detailed",
      stepExplanation: "more",
      preferredLanguage: "zh-CN",
      additionalGuidance: "Group findings by topic.",
    });

    const [, request] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(request.body))).toEqual({
      commandId: "command-prefs",
      goal: "Summarize this page",
      target: { mode: "auto" },
      assistantPreferences: {
        version: 1,
        responseDetail: "detailed",
        stepExplanation: "more",
        preferredLanguage: "zh-CN",
        additionalGuidance: "Group findings by topic.",
      },
    });
  });

  it("sends the explicit per-run dynamic notice opt-in", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ runId: "run-notice-content", status: "created" }), { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);

    await createRun("Summarize this page", "command-notice-content", { mode: "auto" }, undefined, true);

    const [, request] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(request.body))).toEqual({
      commandId: "command-notice-content",
      goal: "Summarize this page",
      target: { mode: "auto" },
      runNoticeContentEnabled: true,
    });
  });

  it("sends an explicit browser URL as a browser target", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ runId: "run-2", status: "created" }), { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);

    await createRun("Review this site", "command-2", { mode: "browser", url: "https://example.com/reports?q=1" });

    const [, request] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(request.body))).toEqual({
      commandId: "command-2",
      goal: "Review this site",
      target: { mode: "browser", url: "https://example.com/reports?q=1" },
    });
  });

  it("sends a blank-page browser target without inventing a URL", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ runId: "run-blank", status: "created" }), { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);

    await createRun("Find the relevant website", "command-blank", { mode: "browser" });

    const [, request] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(request.body))).toEqual({ commandId: "command-blank", goal: "Find the relevant website", target: { mode: "browser" } });
  });

  it("sends automatic selection as an explicit target mode", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ runId: "run-3", status: "created" }), { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);

    await createRun("Use the matching window", "command-3", { mode: "auto" });

    const [, request] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(request.body))).toEqual({ commandId: "command-3", goal: "Use the matching window", target: { mode: "auto" } });
  });

  it("sends entire-desktop selection as an explicit target mode", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ runId: "run-desktop", status: "created" }), { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);

    await createRun("Inspect a popup", "command-desktop", { mode: "desktop" });

    const [, request] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(request.body))).toEqual({ commandId: "command-desktop", goal: "Inspect a popup", target: { mode: "desktop" } });
  });

  it("maps a stale window response to explicit refresh-and-reselect guidance", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { code: "WINDOW_TARGET_STALE", message: "stale" } }), { status: 409 })));

    await expect(createRun("Goal", "command-1", { mode: "window", targetToken: "expired-token" })).rejects.toMatchObject({
      code: "WINDOW_TARGET_STALE",
      message: "所选窗口已过期或发生变化。请刷新可用窗口并重新选择后再开始。",
    });
  });

  it("maps automatic ambiguity and active-run conflicts to localized guidance", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: "WINDOW_SELECTION_REQUIRED" } }), { status: 409 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: "RUN_BUSY" } }), { status: 409 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(createRun("Goal", "command-4", { mode: "auto" })).rejects.toMatchObject({
      code: "WINDOW_SELECTION_REQUIRED",
      message: "电脑无法唯一确定要操作的窗口。请从刷新后的列表中手动选择一个窗口。",
    });
    await expect(createRun("Goal", "command-5", { mode: "browser", url: "https://example.com" })).rejects.toMatchObject({
      code: "RUN_BUSY",
      message: "电脑正在处理另一个任务。请等待当前任务结束后再开始。",
    });
  });

  it("maps automatic window-discovery failures to a safe retry or manual-selection hint", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { code: "WINDOW_DISCOVERY_FAILED" } }), { status: 503 })));

    await expect(createRun("Goal", "command-6", { mode: "auto" })).rejects.toMatchObject({
      code: "WINDOW_DISCOVERY_FAILED",
      message: "电脑暂时无法安全读取可用窗口。你可以改为手动选择窗口，或稍后重试。",
    });
  });
});
