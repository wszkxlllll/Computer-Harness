import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_WINDOW_PREVIEW_BYTES } from "@computer-harness/protocol";
import {
  appendVoiceAudio,
  completeManagedBrowserLogin,
  createRun,
  finishVoiceInput,
  getRun,
  getManagedBrowserProfileSettings,
  getVoiceInputCapabilities,
  listRuns,
  listWindowTargets,
  prepareManagedBrowserLogin,
  previewWindowHandoffCandidate,
  previewWindowTarget,
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

  it("maps an unrecognized legacy start error without exposing internal details", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ error: { code: "LEGACY_PROFILE_RETIRED", message: "internal profile detail" } }),
      { status: 409, headers: { "Content-Type": "application/json" } },
    )));

    await expect(createRun("Save the itinerary", "command-document", { mode: "browser" }))
      .rejects.toMatchObject({ message: "internal profile detail" });
  });

});

describe("Run cleanup status API compatibility", () => {
  it("preserves ownerState on current Hosts and accepts older snapshots that omit it", async () => {
    const currentSnapshot = {
      runId: "cleanup-run",
      goal: "A finished task",
      status: "finished",
      sequence: 12,
      ownerState: "pending_cleanup",
      capabilities: { pause: false, resume: false, abort: false, correct: false, approval: false, windowHandoff: false },
    };
    const legacySnapshot = {
      runId: "legacy-run",
      goal: "A finished task from an older Host",
      status: "finished",
      sequence: 12,
      capabilities: { pause: false, resume: false, abort: false, correct: false, approval: false, windowHandoff: false },
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(currentSnapshot), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ runs: [currentSnapshot] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(legacySnapshot), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(getRun("cleanup-run")).resolves.toMatchObject({ ownerState: "pending_cleanup" });
    await expect(listRuns()).resolves.toMatchObject([{ runId: "cleanup-run", ownerState: "pending_cleanup" }]);
    const legacy = await getRun("legacy-run");
    expect(legacy).toMatchObject({ runId: "legacy-run", status: "finished" });
    expect(legacy).not.toHaveProperty("ownerState");
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
    const result = { candidates: [{ token: "T".repeat(32), appName: "Browser", title: "Contacts" }], expiresAt: new Date(Date.now() + 600_000).toISOString() };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(result), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(listWindowTargets()).resolves.toEqual(result);
    expect(fetchMock).toHaveBeenCalledWith("/api/windows", expect.objectContaining({ credentials: "same-origin", cache: "no-store" }));
  });

  it("rejects retired native-profile fields from the public window-list contract", async () => {
    const response = {
      candidates: [],
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
      nativeRecoveryProfile: { profileId: "Opaque_Profile_1234567890", label: "Host TextEdit recovery" },
      nativeWebDocumentProfile: { profileId: "Opaque_Hybrid_Profile_12345", label: "Host Browser and TextEdit recovery" },
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(response), { status: 200 })));
    await expect(listWindowTargets()).rejects.toThrow("窗口列表格式无效");
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

  it("previews only the requested candidate through authenticated no-store routes", async () => {
    const preview = {
      previewToken: "P".repeat(32),
      appName: "Notepad.exe",
      title: "Untitled - Notepad",
      capturedAt: "2026-09-26T00:00:00.000Z",
      expiresAt: "2026-09-26T00:02:00.000Z",
      viewport: { width: 320, height: 240 },
      mediaType: "image/png",
      dataBase64: "iVBORw0KGgo=",
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(preview), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(preview), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    setPhoneCsrfToken("phone-csrf");

    await expect(previewWindowTarget("T".repeat(32))).resolves.toEqual(preview);
    await previewWindowHandoffCandidate("run-1", "action-window-1", "C".repeat(32));

    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual([
      "/api/windows/preview",
      "/api/runs/run-1/window-candidates/preview",
    ]);
    expect(fetchMock.mock.calls.map(([, init]) => JSON.parse(String((init as RequestInit).body)))).toEqual([
      { candidateToken: "T".repeat(32) },
      { requestId: "action-window-1", candidateToken: "C".repeat(32) },
    ]);
    for (const [, init] of fetchMock.mock.calls) {
      expect((init as RequestInit).cache).toBe("no-store");
      expect(((init as RequestInit).headers as Headers).get("X-CSRF-Token")).toBe("phone-csrf");
    }
  });

  it.each([
    { code: "WINDOW_PREVIEW_TIMEOUT", expected: "读取窗口预览超时。请确认目标窗口仍可见，稍后重试。" },
    { code: "WINDOW_PREVIEW_CAPTURE_FAILED", expected: "电脑无法安全读取这个窗口的画面。请在电脑上恢复目标窗口、刷新列表后重试。" },
    { code: "WINDOW_PREVIEW_CLEANUP_PENDING", expected: "电脑端仍在清理窗口预览会话。请先检查 Harness 状态，确认清理完成后再重试。" },
    { code: "WINDOW_PREVIEW_IMAGE_TOO_LARGE", expected: "窗口预览图片超过安全传输上限。请缩小目标窗口，再刷新列表重试。" },
  ])("maps $code to safe window-preview guidance", async ({ code, expected }) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: { code, message: "private window title and native diagnostic detail" },
    }), { status: 409 })));

    let failure: unknown;
    try {
      await previewWindowTarget("T".repeat(32));
    } catch (caught) {
      failure = caught;
    }
    expect(failure).toMatchObject({ code, message: expected });
    expect((failure as Error).message).not.toContain("private window title");
    expect((failure as Error).message).not.toContain("native diagnostic detail");
  });

  it("requires previews for duplicate labels even if the Host omitted that marker", async () => {
    const candidates = [
      { token: "A".repeat(32), appName: "Editor", title: "Untitled" },
      { token: "B".repeat(32), appName: "Editor", title: "Untitled" },
    ];
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      candidates,
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(listWindowTargets()).resolves.toMatchObject({
      candidates: [{ previewRequired: true }, { previewRequired: true }],
    });
  });

  it("deduplicates repeated opaque candidate tokens without collapsing distinct same-label windows", async () => {
    const candidates = [
      { token: "A".repeat(32), appName: "Editor", title: "Untitled" },
      { token: "A".repeat(32), appName: "Editor", title: "Untitled" },
      { token: "B".repeat(32), appName: "Editor", title: "Untitled" },
    ];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      candidates,
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    }), { status: 200 })));

    await expect(listWindowTargets()).resolves.toMatchObject({
      candidates: [
        { token: "A".repeat(32), previewRequired: true },
        { token: "B".repeat(32), previewRequired: true },
      ],
    });
  });

  it("accepts the exact preview byte limit and rejects native identities or over-limit image data", async () => {
    const preview = {
      previewToken: "P".repeat(32),
      appName: "Editor",
      title: "Untitled",
      capturedAt: "2026-10-04T00:00:00.000Z",
      expiresAt: "2026-10-04T00:02:00.000Z",
      viewport: { width: 320, height: 240 },
      mediaType: "image/png",
      dataBase64: Buffer.alloc(MAX_WINDOW_PREVIEW_BYTES + 1).toString("base64"),
    };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ...preview, pid: 451, windowId: 894 }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(previewWindowTarget("T".repeat(32))).rejects.toThrow("窗口预览格式无效");

    fetchMock.mockResolvedValue(new Response(JSON.stringify(preview), { status: 200 }));
    await expect(previewWindowTarget("T".repeat(32))).rejects.toThrow("窗口预览格式无效");

    const atLimitImage = Buffer.alloc(MAX_WINDOW_PREVIEW_BYTES).toString("base64");
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ ...preview, dataBase64: atLimitImage }), { status: 200 }));
    const accepted = await previewWindowTarget("T".repeat(32));
    expect(Buffer.from(accepted.dataBase64, "base64")).toHaveLength(MAX_WINDOW_PREVIEW_BYTES);
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
      message: "电脑暂时无法开始新任务：现有任务尚未结束，或资源收尾尚未确认。请刷新任务列表后再试。",
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
