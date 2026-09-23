import { describe, expect, it, vi } from "vitest";
import { createJevWindowSelector } from "./window-selection-jev.js";

const candidates = [
  { pid: 1, windowId: 11, appName: "Notepad.exe", title: "Notes - Notepad" },
  { pid: 2, windowId: 22, appName: "msedge.exe", title: "Inbox - Microsoft Edge" },
];

function response(choice: string, confidence: number, probabilities: Record<string, number>): Response {
  return { ok: true, async json() { return { model: "jev-1.13.0", answers: { target: { type: "choice", choice, confidence, probabilities } } }; } } as Response;
}

describe("Jev window candidate selector", () => {
  it("maps a confident response only to the current candidate and omits PID/handle from the request", async () => {
    const fetcher = vi.fn(async () => response("w1", 1, { w1: 1, w2: 0, none: 0 })) as unknown as typeof fetch;
    const selector = createJevWindowSelector("secret", fetcher);
    const result = await selector.select("打开记事本", candidates, new AbortController().signal);
    expect(result).toEqual({ kind: "matched", target: candidates[0] });
    const call = (fetcher as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(call[1].body as string) as { state: { goal: string; windows: unknown[] } };
    expect(body.state.goal).toBe("打开记事本");
    expect(body.state.windows).toEqual([
      { id: "w1", application: "Notepad.exe", title: "Notes - Notepad" },
      { id: "w2", application: "msedge.exe", title: "Inbox - Microsoft Edge" },
    ]);
    expect(JSON.stringify(body)).not.toContain("windowId");
    expect(JSON.stringify(body)).not.toContain("pid");
  });

  it("abstains on low margin, none, malformed ID, and service failure", async () => {
    const decisions = [
      response("w1", 0.4, { w1: 0.51, w2: 0.49, none: 0 }),
      response("none", 1, { w1: 0, w2: 0, none: 1 }),
      response("w999", 1, { w1: 0, w2: 0, none: 0 }),
      { ok: false } as Response,
    ];
    const fetcher = vi.fn(async () => decisions.shift()!) as unknown as typeof fetch;
    const selector = createJevWindowSelector("secret", fetcher);
    expect(await selector.select("x", candidates, new AbortController().signal)).toEqual({ kind: "abstain", reason: "uncertain" });
    expect(await selector.select("x", candidates, new AbortController().signal)).toEqual({ kind: "abstain", reason: "none" });
    expect(await selector.select("x", candidates, new AbortController().signal)).toEqual({ kind: "abstain", reason: "unavailable" });
    expect(await selector.select("x", candidates, new AbortController().signal)).toEqual({ kind: "abstain", reason: "unavailable" });
  });

  it("does not call TypeSafe for an empty or oversized candidate list", async () => {
    const fetcher = vi.fn() as unknown as typeof fetch;
    const selector = createJevWindowSelector("secret", fetcher);
    expect(await selector.select("x", [], new AbortController().signal)).toEqual({ kind: "abstain", reason: "none" });
    expect(await selector.select("x", Array.from({ length: 65 }, (_, index) => ({ pid: index + 1, windowId: index + 1 })), new AbortController().signal))
      .toEqual({ kind: "abstain", reason: "too_many" });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
