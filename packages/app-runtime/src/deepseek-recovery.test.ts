import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ActionIntent, ComputerSessionId, ObservationId, RunId, SurfaceId, Viewport } from "@computer-harness/protocol";
import type { Computer } from "@computer-harness/runtime";
import { createRun, type ResolvedRunConfig } from "./index.js";

vi.mock("@computer-harness/provider-glm", () => import("../../provider-glm/src/index.js"));
vi.mock("@computer-harness/context", () => import("../../context/src/index.js"));

const surfaceRef = { surfaceId: "deepseek-recovery-desktop" as SurfaceId, generation: 1, kind: "desktop" as const };
const viewport: Viewport = { width: 800, height: 600, coordinateSpace: "physical" };

function config(outputDir: string, overrides: Partial<ResolvedRunConfig> = {}): ResolvedRunConfig {
  return {
    runId: "deepseek-recovery-test" as RunId,
    goal: "Inspect the fixture and finish without taking unrelated actions.",
    model: "deepseek-flash",
    computer: { kind: "osworld", bridgeUrl: "http://fixture.invalid" },
    outputDir,
    maxSteps: 4,
    maxModelRequests: 5,
    planning: false,
    memory: "off",
    batching: "off",
    contextMode: "raw",
    contextMaxHistoryEvents: 10,
    riskProfile: "experiment",
    riskGuard: "off",
    riskModel: "off",
    riskMaxModelRequests: 2,
    riskTimeoutMs: 100,
    cleanupDeadlineMs: 100,
    ...overrides,
  };
}

function fixtureComputer(actions: ActionIntent[], groundingRefs?: readonly string[]): Computer {
  const session = {
    id: "deepseek-fixture-session" as ComputerSessionId,
    backend: "fixture",
    viewport,
    capabilities: { screenshot: true, pointer: true, keyboard: true, accessibility: false },
    openedAt: "2026-10-14T00:00:00.000Z",
  };
  return {
    async open() { return session; },
    async observe(_session, observationId) {
      const grounding = groundingRefs === undefined ? undefined : {
        version: "uia-catalog-v1" as const,
        source: "uia" as const,
        observationId: observationId as ObservationId,
        computerSessionId: session.id,
        surfaceRef,
        completeness: "partial" as const,
        degraded: false,
        maxElements: groundingRefs.length,
        elements: groundingRefs.map((elementRef) => ({
          elementRef,
          role: "Button",
          name: "Current fixture button",
          bbox: { x: 10, y: 10, width: 30, height: 20, coordinateSpace: "physical" as const },
          state: { enabled: true },
        })),
      };
      return {
        capturedAt: "2026-10-14T00:00:00.000Z",
        viewport,
        surfaceRef,
        screenshot: { mediaType: "image/png", data: new Uint8Array([1, 2, 3]) },
        ...(grounding === undefined ? {} : { grounding }),
      };
    },
    async execute(_session, action) {
      actions.push(action);
      return { actionId: action.actionId, status: "completed" };
    },
    async close() {},
  };
}

function toolResponse(calls: readonly { readonly id: string; readonly name: string; readonly arguments: unknown }[], finishReason = "tool_calls"): unknown {
  return {
    model: "deepseek-flash",
    choices: [{
      finish_reason: finishReason,
      message: {
        role: "assistant",
        content: null,
        tool_calls: calls.map((call) => ({
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: JSON.stringify(call.arguments) },
        })),
      },
    }],
  };
}

function finishResponse(): unknown {
  return toolResponse([{ id: "finish-call", name: "terminate", arguments: { status: "success", text: "The fixture task is complete." } }]);
}

function installResponseSequence(responses: readonly unknown[]) {
  const requestBodies: Array<Record<string, unknown>> = [];
  const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
    requestBodies.push(JSON.parse(init.body as string) as Record<string, unknown>);
    const response = responses[requestBodies.length - 1];
    if (response === undefined) throw new Error("unexpected fixture request");
    return { ok: true, status: 200, json: async () => response };
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, requestBodies };
}

async function waitFor(predicate: () => boolean, description: string): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("DeepSeek Runtime feedback recovery", () => {
  it("retries a rejected mixed tool group as one unit and executes only the corrected response", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "harness-deepseek-feedback-recovery-"));
    const actions: ActionIntent[] = [];
    const { fetchMock, requestBodies } = installResponseSequence([
      toolResponse([
        { id: "valid-but-rejected", name: "click", arguments: { x: 30, y: 40 } },
        { id: "unavailable", name: "fixture.private.unoffered", arguments: { token: "private-payload" } },
      ]),
      toolResponse([{ id: "corrected-click", name: "click", arguments: { x: 50, y: 60 } }]),
      finishResponse(),
    ]);
    let handle: Awaited<ReturnType<typeof createRun>> | undefined;
    try {
      handle = await createRun(config(outputDir), {
        credentials: { deepseekApiKey: "fixture-deepseek-key" },
        createComputer: () => Promise.resolve(fixtureComputer(actions)),
      });
      await expect(handle.start()).resolves.toBe("succeeded");
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(actions).toHaveLength(1);
      expect(actions[0]).toMatchObject({ kind: "click", point: { x: 50, y: 60 } });
      const secondMessages = JSON.stringify(requestBodies[1]?.messages);
      expect(secondMessages).toContain("The previous model response was rejected before any tool was executed");
      expect(secondMessages).toContain("[DEEPSEEK_UNAVAILABLE_TOOL]");
      expect(secondMessages).not.toContain("fixture.private.unoffered");
      expect(secondMessages).not.toContain("private-payload");
      const failures = (await handle.report()).events.filter((event) => event.type === "model.request.failed");
      expect(failures).toHaveLength(1);
      expect(failures[0]).toMatchObject({
        code: "DEEPSEEK_UNAVAILABLE_TOOL",
        retryable: true,
        message: expect.stringContaining("retrying model request 1/1"),
      });
      expect(JSON.stringify(failures)).not.toContain("fixture.private.unoffered");
    } finally {
      await handle?.close();
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("stops after the finite DeepSeek feedback retry budget without executing any rejected call", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "harness-deepseek-feedback-budget-"));
    const actions: ActionIntent[] = [];
    const unavailable = toolResponse([{ id: "unknown", name: "fixture.private.unoffered", arguments: {} }]);
    const { fetchMock } = installResponseSequence([unavailable, unavailable, unavailable]);
    let handle: Awaited<ReturnType<typeof createRun>> | undefined;
    try {
      handle = await createRun(config(outputDir), {
        credentials: { deepseekApiKey: "fixture-deepseek-key" },
        createComputer: () => Promise.resolve(fixtureComputer(actions)),
      });
      await expect(handle.start()).resolves.toBe("failed");
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(actions).toHaveLength(0);
      const failures = (await handle.report()).events.filter((event) => event.type === "model.request.failed");
      expect(failures).toHaveLength(2);
      expect(failures[1]).toMatchObject({
        code: "DEEPSEEK_UNAVAILABLE_TOOL",
        retryable: true,
        message: expect.stringContaining("retry limit reached after 1 retries"),
      });
      expect(JSON.stringify(failures)).not.toContain("fixture.private.unoffered");
    } finally {
      await handle?.close();
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("does not issue the retry request after Run cancellation during feedback delay", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "harness-deepseek-feedback-abort-"));
    const actions: ActionIntent[] = [];
    const { fetchMock } = installResponseSequence([toolResponse([{ id: "unknown", name: "fixture.private.unoffered", arguments: {} }]), finishResponse()]);
    let handle: Awaited<ReturnType<typeof createRun>> | undefined;
    try {
      handle = await createRun(config(outputDir), {
        credentials: { deepseekApiKey: "fixture-deepseek-key" },
        createComputer: () => Promise.resolve(fixtureComputer(actions)),
      });
      const running = handle.start();
      await waitFor(() => handle!.controller.getEvents().some((event) => event.type === "model.request.failed"), "the protocol rejection event");
      handle.controller.cancel("fixture cancellation during provider feedback delay");
      await expect(running).resolves.toBe("cancelled");
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(actions).toHaveLength(0);
    } finally {
      await handle?.close();
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("lets a user correction supersede automatic feedback and start from the corrected request", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "harness-deepseek-feedback-correction-"));
    const actions: ActionIntent[] = [];
    const correction = "Do not click; just report that the fixture is ready.";
    const { fetchMock, requestBodies } = installResponseSequence([toolResponse([{ id: "unknown", name: "fixture.private.unoffered", arguments: {} }]), finishResponse()]);
    let handle: Awaited<ReturnType<typeof createRun>> | undefined;
    try {
      handle = await createRun(config(outputDir), {
        credentials: { deepseekApiKey: "fixture-deepseek-key" },
        createComputer: () => Promise.resolve(fixtureComputer(actions)),
      });
      const running = handle.start();
      await waitFor(() => handle!.controller.getEvents().some((event) => event.type === "model.request.failed"), "the protocol rejection event");
      const correctionPromise = handle.controller.submitUserInput(correction);
      await correctionPromise;
      await expect(running).resolves.toBe("succeeded");
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(JSON.stringify(requestBodies[1]?.messages)).toContain(correction);
      expect(JSON.stringify(requestBodies[1]?.messages)).not.toContain("The previous model response was rejected before any tool was executed");
      expect(actions).toHaveLength(0);
    } finally {
      await handle?.close();
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it.each([
    ["network interruption", "DEEPSEEK_NETWORK_ERROR", undefined],
    ["HTTP 429", "DEEPSEEK_HTTP_429", 429],
    ["HTTP 503", "DEEPSEEK_HTTP_503", 503],
  ] as const)("same-input retries one transient %s before any tool executes", async (_label, code, status) => {
    const outputDir = await mkdtemp(join(tmpdir(), "harness-deepseek-same-input-retry-"));
    const actions: ActionIntent[] = [];
    const requestBodies: Array<Record<string, unknown>> = [];
    let calls = 0;
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      requestBodies.push(JSON.parse(init.body as string) as Record<string, unknown>);
      calls += 1;
      if (calls === 1 && status === undefined) throw new Error("private network detail");
      if (calls === 1) return { ok: false, status: status!, json: async () => ({ error: { message: "private HTTP body" } }) };
      return { ok: true, status: 200, json: async () => finishResponse() };
    });
    vi.stubGlobal("fetch", fetchMock);
    let handle: Awaited<ReturnType<typeof createRun>> | undefined;
    try {
      handle = await createRun(config(outputDir), {
        credentials: { deepseekApiKey: "fixture-deepseek-key" },
        createComputer: () => Promise.resolve(fixtureComputer(actions)),
      });
      await expect(handle.start()).resolves.toBe("succeeded");
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(requestBodies[0]).toEqual(requestBodies[1]);
      expect(JSON.stringify(requestBodies[1]?.messages)).not.toContain("previous model response was rejected");
      expect(actions).toHaveLength(0);
      const failure = (await handle.report()).events.find((event) => event.type === "model.request.failed");
      expect(failure).toMatchObject({ code, retryable: true, message: expect.stringContaining("retrying model request 1/1") });
    } finally {
      await handle?.close();
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it.each([
    ["unreadable JSON body", async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError("private response body"); } }), "DEEPSEEK_INVALID_RESPONSE"],
    ["truncated finish", async () => ({ ok: true, status: 200, json: async () => toolResponse([{ id: "partial", name: "click", arguments: { x: 1, y: 2 } }], "length") }), "DEEPSEEK_INCOMPLETE_RESPONSE"],
    ["HTTP 400", async () => ({ ok: false, status: 400, json: async () => ({ error: { message: "private HTTP 400 body" } }) }), "DEEPSEEK_HTTP_400"],
    ["HTTP 401", async () => ({ ok: false, status: 401, json: async () => ({ error: { message: "private HTTP 401 body" } }) }), "DEEPSEEK_HTTP_401"],
  ] as const)("does not feedback-retry a %s", async (_label, fetchImplementation, code) => {
    const outputDir = await mkdtemp(join(tmpdir(), "harness-deepseek-no-feedback-"));
    const actions: ActionIntent[] = [];
    const fetchMock = vi.fn(fetchImplementation);
    vi.stubGlobal("fetch", fetchMock);
    let handle: Awaited<ReturnType<typeof createRun>> | undefined;
    try {
      handle = await createRun(config(outputDir), {
        credentials: { deepseekApiKey: "fixture-deepseek-key" },
        createComputer: () => Promise.resolve(fixtureComputer(actions)),
      });
      await expect(handle.start()).resolves.toBe("failed");
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(actions).toHaveLength(0);
      const failure = (await handle.report()).events.find((event) => event.type === "model.request.failed");
      expect(failure).toMatchObject({ code, retryable: false });
      expect(JSON.stringify(failure)).not.toContain("private response body");
      expect(JSON.stringify(failure)).not.toContain("private HTTP");
    } finally {
      await handle?.close();
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("does not retry a DeepSeek request deadline", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "harness-deepseek-timeout-no-retry-"));
    const actions: ActionIntent[] = [];
    const fetchMock = vi.fn(async () => new Promise<never>(() => {}));
    vi.stubGlobal("fetch", fetchMock);
    let handle: Awaited<ReturnType<typeof createRun>> | undefined;
    try {
      handle = await createRun(config(outputDir, { deepseekRequestTimeoutMs: 1000 }), {
        credentials: { deepseekApiKey: "fixture-deepseek-key" },
        createComputer: () => Promise.resolve(fixtureComputer(actions)),
      });
      await expect(handle.start()).resolves.toBe("failed");
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(actions).toHaveLength(0);
      const failure = (await handle.report()).events.find((event) => event.type === "model.request.failed");
      expect(failure).toMatchObject({ code: "DEEPSEEK_REQUEST_TIMEOUT", retryable: false });
    } finally {
      await handle?.close();
      await rm(outputDir, { recursive: true, force: true });
    }
  }, 10_000);

  it.each([
    ["missing catalog", undefined, "unavailable-ref", "GROUNDING_CATALOG_UNAVAILABLE"],
    ["expired element reference", ["current-ref"], "expired-ref", "GROUNDING_REF_NOT_FOUND"],
  ] as const)("rejects a DeepSeek click with a %s before Computer execution", async (_label, refs, elementRef, reasonCode) => {
    const outputDir = await mkdtemp(join(tmpdir(), "harness-deepseek-grounding-ref-"));
    const actions: ActionIntent[] = [];
    const { fetchMock } = installResponseSequence([
      toolResponse([{ id: "stale-grounded-click", name: "click_element", arguments: { elementRef } }]),
      finishResponse(),
    ]);
    let handle: Awaited<ReturnType<typeof createRun>> | undefined;
    try {
      handle = await createRun(config(outputDir, {
        computer: { kind: "cua", socketPath: "fixture.sock", screenshotDir: join(outputDir, "screenshots"), windowTarget: { pid: 71, windowId: 701 } },
        grounding: "uia-catalog-v1",
      }), {
        credentials: { deepseekApiKey: "fixture-deepseek-key" },
        createComputer: () => Promise.resolve(fixtureComputer(actions, refs)),
      });
      await expect(handle.start()).resolves.toBe("succeeded");
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(actions).toHaveLength(0);
      const events = (await handle.report()).events;
      expect(events.some((event) => event.type === "tool.call.rejected" && event.reason.includes(reasonCode))).toBe(true);
      expect(events.filter((event) => event.type === "model.request.failed")).toHaveLength(0);
    } finally {
      await handle?.close();
      await rm(outputDir, { recursive: true, force: true });
    }
  });
});
