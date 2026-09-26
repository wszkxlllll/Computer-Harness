import { afterEach, describe, expect, it, vi } from "vitest";
import { createRun, listRuns, listWindowTargets, setPhoneCsrfToken } from "./api";

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

describe("explicit window-target run contract", () => {
  it("loads only the paired host's safe window labels and opaque tokens", async () => {
    const result = { candidates: [{ token: "opaque-window-token", appName: "Browser", title: "Contacts" }], expiresAt: new Date(Date.now() + 600_000).toISOString() };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(result), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(listWindowTargets()).resolves.toEqual(result);
    expect(fetchMock).toHaveBeenCalledWith("/api/windows", expect.objectContaining({ credentials: "same-origin", cache: "no-store" }));
  });

  it("starts only with the explicitly chosen opaque target token", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ runId: "run-1", status: "created" }), { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);
    setPhoneCsrfToken("phone-csrf");

    await createRun("Compare these pages", "command-1", "opaque-window-token");

    const [, request] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(request.body))).toEqual({ commandId: "command-1", goal: "Compare these pages", targetToken: "opaque-window-token" });
    expect(request.headers).toBeInstanceOf(Headers);
    expect((request.headers as Headers).get("X-CSRF-Token")).toBe("phone-csrf");
  });

  it("maps a stale window response to explicit refresh-and-reselect guidance", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { code: "WINDOW_TARGET_STALE", message: "stale" } }), { status: 409 })));

    await expect(createRun("Goal", "command-1", "expired-token")).rejects.toMatchObject({
      code: "WINDOW_TARGET_STALE",
      message: "所选窗口已过期或发生变化。请刷新可用窗口并重新选择后再开始。",
    });
  });
});
