import { afterEach, describe, expect, it, vi } from "vitest";
import { performance } from "node:perf_hooks";
import { LayeredRiskGuard, type SemanticRiskAssessment } from "./index.js";
import { initialRunSnapshot } from "@computer-harness/trajectory";

type Context = Parameters<LayeredRiskGuard["evaluate"]>[0];
const runId = "independent-guard-run" as Parameters<typeof initialRunSnapshot>[0];
function context(): Context {
  return {
    runId, goal: "Inspect the synthetic draft", recentUserInputs: [], snapshot: initialRunSnapshot(runId),
    candidate: {
      calls: [{ id: "call", name: "click", arguments: { x: 10, y: 20 }, declaredEffect: { effects: ["unknown"], target: "Details", summary: "Open details" } }],
      actions: [{ actionId: "action", basedOn: "observation", kind: "click", point: { x: 10, y: 20 } }],
      decisionObservation: { id: "observation", runId, computerSessionId: "computer", capturedAt: "2026-10-07T00:00:00Z", viewport: { width: 800, height: 600, coordinateSpace: "physical" }, screenshot: { assetId: "image", relativePath: "synthetic.png", mediaType: "image/png", byteLength: 1 } },
      session: { id: "computer", backend: "fake", viewport: { width: 800, height: 600, coordinateSpace: "physical" }, capabilities: { screenshot: true, pointer: true, keyboard: true, accessibility: false }, openedAt: "2026-10-07T00:00:00Z" },
    },
  } as unknown as Context;
}
const aligned = (): SemanticRiskAssessment => ({ effects: ["local_edit"], alignment: "aligned", evidence: "Synthetic assessment" });
function deferred<T>() { let resolve!: (v: T) => void; let reject!: (v: unknown) => void; const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
function clock() { let logical = 0; vi.useFakeTimers(); vi.spyOn(performance, "now").mockImplementation(() => logical); return { set: (n: number) => { logical = n; } }; }
const fallback = { decision: "require_approval", path: "fallback", reasonCode: "risk_model_failed", modelRequestCount: 1 };
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("independent Guard deadline and Run withdrawal", () => {
  it("settles an assessor that never answers without retry", async () => {
    const t = clock(); let calls = 0; let internal: AbortSignal | undefined;
    const guard = new LayeredRiskGuard({ timeoutMs: 10, assessor: { id: "never", classify: (_c, s) => { calls++; internal = s; return new Promise(() => {}); } } });
    const pending = guard.evaluate(context(), new AbortController().signal); t.set(10); await vi.advanceTimersByTimeAsync(10);
    await expect(pending).resolves.toMatchObject(fallback); expect(calls).toBe(1); expect(internal?.aborted).toBe(true); expect(vi.getTimerCount()).toBe(0);
  });
  it("late aligned resolution cannot replace the settled approval", async () => {
    const t = clock(), d = deferred<ReturnType<typeof aligned>>(); let calls = 0;
    const guard = new LayeredRiskGuard({ timeoutMs: 10, assessor: { id: "late", classify: () => { calls++; return d.promise; } } });
    const pending = guard.evaluate(context(), new AbortController().signal); t.set(10); await vi.advanceTimersByTimeAsync(10);
    const result = await pending; expect(result).toMatchObject(fallback); d.resolve(aligned()); await Promise.resolve(); await Promise.resolve(); expect(result).toMatchObject(fallback); expect(calls).toBe(1);
  });
  it("late rejection stays observed", async () => {
    const t = clock(), d = deferred<ReturnType<typeof aligned>>(); const unhandled: unknown[] = []; const handler = (v: unknown) => unhandled.push(v); process.on("unhandledRejection", handler);
    try { const pending = new LayeredRiskGuard({ timeoutMs: 10, assessor: { id: "late-reject", classify: () => d.promise } }).evaluate(context(), new AbortController().signal); t.set(10); await vi.advanceTimersByTimeAsync(10); await expect(pending).resolves.toMatchObject(fallback); d.reject(Error("synthetic late")); await vi.advanceTimersByTimeAsync(0); expect(unhandled).toEqual([]); } finally { process.removeListener("unhandledRejection", handler); }
  });
  it("synchronous blocking expiry rejects aligned without waiting for timer", async () => {
    const t = clock(); const pending = new LayeredRiskGuard({ timeoutMs: 10, assessor: { id: "sync-expiry", classify: () => { t.set(10); return Promise.resolve(aligned()); } } }).evaluate(context(), new AbortController().signal);
    await expect(pending).resolves.toMatchObject(fallback); expect(vi.getTimerCount()).toBe(0);
  });
  it("post-await logical expiry refuses a just-resolved assessment", async () => {
    const t = clock(), d = deferred<ReturnType<typeof aligned>>(); const pending = new LayeredRiskGuard({ timeoutMs: 10, assessor: { id: "await-expiry", classify: () => d.promise } }).evaluate(context(), new AbortController().signal); t.set(10); d.resolve(aligned()); await expect(pending).resolves.toMatchObject(fallback);
  });
  it.each([null, 0, { kind: "original-reason" }])("preabort preserves raw reason %j and performs zero classify", async (reason) => {
    const c = new AbortController(); c.abort(reason); let calls = 0;
    await expect(new LayeredRiskGuard({ assessor: { id: "pre", classify: async () => { calls++; return aligned(); } } }).evaluate(context(), c.signal)).rejects.toBe(reason); expect(calls).toBe(0);
  });
  it("Run cancellation settles never assessor immediately with exact reason", async () => {
    clock(); const c = new AbortController(), reason = { withdrawal: true }; const pending = new LayeredRiskGuard({ timeoutMs: 10, assessor: { id: "cancel", classify: () => new Promise(() => {}) } }).evaluate(context(), c.signal); const assertion = expect(pending).rejects.toBe(reason); c.abort(reason); await assertion; expect(vi.getTimerCount()).toBe(0);
  });
  it("timeout internal abort reentrancy cannot suppress Run withdrawal", async () => {
    const t = clock(), c = new AbortController(), reason = { reentrant: true };
    const pending = new LayeredRiskGuard({ timeoutMs: 10, assessor: { id: "reentry", classify: (_c, s) => { s.addEventListener("abort", () => c.abort(reason), { once: true }); return new Promise(() => {}); } } }).evaluate(context(), c.signal); const assertion = expect(pending).rejects.toBe(reason); t.set(10); await vi.advanceTimersByTimeAsync(10); await assertion;
  });
  it("Run withdrawal queued after timeout but before fallback settlement wins", async () => {
    const t = clock(), c = new AbortController(), reason = 0;
    const pending = new LayeredRiskGuard({ timeoutMs: 10, assessor: { id: "queued-withdrawal", classify: (_c, s) => { s.addEventListener("abort", () => queueMicrotask(() => c.abort(reason)), { once: true }); return new Promise(() => {}); } } }).evaluate(context(), c.signal); const assertion = expect(pending).rejects.toBe(reason); t.set(10); await vi.advanceTimersByTimeAsync(10); await assertion;
  });
  it("assessor resolution concurrent with cancellation throws original Run reason", async () => {
    clock(); const c = new AbortController(), reason = { same_turn: true }, d = deferred<ReturnType<typeof aligned>>(); const pending = new LayeredRiskGuard({ assessor: { id: "race", classify: () => d.promise } }).evaluate(context(), c.signal); const assertion = expect(pending).rejects.toBe(reason); d.resolve(aligned()); c.abort(reason); await assertion;
  });
  it("assessment evidence getter cancellation cannot return allow or approval", async () => {
    const c = new AbortController(), reason = { getter: true }; const assessment: SemanticRiskAssessment = { effects: ["local_edit"], alignment: "aligned", get evidence() { c.abort(reason); return "Synthetic evidence"; } };
    await expect(new LayeredRiskGuard({ assessor: { id: "getter", classify: async () => assessment } }).evaluate(context(), c.signal)).rejects.toBe(reason);
  });
  it("error-summary getter cancellation cannot return fallback", async () => {
    const c = new AbortController(), reason = { error_getter: true }, error = Error("synthetic"); Object.defineProperty(error, "message", { get() { c.abort(reason); return "Synthetic safe error"; } });
    await expect(new LayeredRiskGuard({ assessor: { id: "error-getter", classify: async () => { throw error; } } }).evaluate(context(), c.signal)).rejects.toBe(reason);
  });
  it("finally listener cleanup cancellation is checked before returning", async () => {
    const c = new AbortController(), reason = { cleanup: true }, original = c.signal.removeEventListener.bind(c.signal); vi.spyOn(c.signal, "removeEventListener").mockImplementation((...args) => { original(...args); c.abort(reason); });
    await expect(new LayeredRiskGuard({ assessor: { id: "cleanup", classify: async () => aligned() } }).evaluate(context(), c.signal)).rejects.toBe(reason);
  });
  it("ordinary synchronous classifier error remains one-request fallback", async () => {
    let calls = 0; await expect(new LayeredRiskGuard({ assessor: { id: "throw", classify: () => { calls++; throw Error("Synthetic classifier error"); } } }).evaluate(context(), new AbortController().signal)).resolves.toMatchObject(fallback); expect(calls).toBe(1);
  });
  it("successful settlement cleans one timer/listener and later Run cancellation does not rewrite it", async () => {
    clock(); const c = new AbortController(); const added = vi.spyOn(c.signal, "addEventListener"), removed = vi.spyOn(c.signal, "removeEventListener"), cleared = vi.spyOn(globalThis, "clearTimeout"); let calls = 0;
    const result = await new LayeredRiskGuard({ assessor: { id: "success-cleanup", classify: async () => { calls++; return aligned(); } } }).evaluate(context(), c.signal);
    expect(result).toMatchObject({ decision: "allow", path: "model", modelRequestCount: 1 }); expect(added).toHaveBeenCalledTimes(1); expect(removed).toHaveBeenCalledTimes(1); expect(cleared).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0); c.abort({ later: true }); expect(result.decision).toBe("allow"); expect(calls).toBe(1);
  });
  it("budget exhaustion retains zero classifier calls", async () => {
    let calls = 0; await expect(new LayeredRiskGuard({ maxModelRequests: 0, assessor: { id: "budget", classify: async () => { calls++; return aligned(); } } }).evaluate(context(), new AbortController().signal)).resolves.toMatchObject({ decision: "require_approval", path: "fallback", reasonCode: "risk_model_budget_exhausted", modelRequestCount: 0 }); expect(calls).toBe(0);
  });
  it("protected input remains local approval without assessor", async () => {
    const value = context(); value.candidate.calls[0] = { ...value.candidate.calls[0]!, name: "type", arguments: { text: "password=SYNTHETIC_ONLY" } }; value.candidate.actions[0] = { actionId: "protected" as never, basedOn: "observation" as never, kind: "type", text: "password=SYNTHETIC_ONLY" }; let calls = 0;
    await expect(new LayeredRiskGuard({ assessor: { id: "protected", classify: async () => { calls++; return aligned(); } } }).evaluate(value, new AbortController().signal)).resolves.toMatchObject({ decision: "require_approval", path: "local", reasonCode: "protected_input", modelRequestCount: 0 }); expect(calls).toBe(0);
  });
  it("local Run-scoped switch remains model-free", async () => {
    const value = context(); value.candidate.calls[0] = { id: "switch" as never, name: "switch_window", arguments: { windowRef: "opaque-synthetic" } }; value.candidate.actions[0] = { actionId: "switch" as never, basedOn: "observation" as never, kind: "switch_window", windowRef: "opaque-synthetic" }; let calls = 0;
    await expect(new LayeredRiskGuard({ assessor: { id: "switch", classify: async () => { calls++; return aligned(); } } }).evaluate(value, new AbortController().signal)).resolves.toMatchObject({ decision: "allow", path: "local", reasonCode: "run_scoped_window_switch", modelRequestCount: 0 }); expect(calls).toBe(0);
  });
});
