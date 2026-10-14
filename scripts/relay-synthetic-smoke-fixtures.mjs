import { randomBytes } from "node:crypto";

const FIXTURE_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=",
  "base64",
);

export const FIXTURE_SURFACE_REF = Object.freeze({
  surfaceId: "synthetic-relay-smoke-desktop",
  generation: 1,
  kind: "desktop",
});

export function createFixtureComputer(viewport, { surfaceRef = FIXTURE_SURFACE_REF } = {}) {
  const computerSession = {
    id: `synthetic-relay-smoke-session-${randomBytes(6).toString("hex")}`,
    backend: "synthetic-fixture",
    viewport,
    // The fake descriptor retains the same producer-owned Surface identity as
    // the capture below; Runtime remains responsible for validating captures.
    surfaceRef,
    capabilities: { screenshot: true, pointer: true, keyboard: true, accessibility: false },
    openedAt: new Date().toISOString(),
  };
  return {
    async open() { return computerSession; },
    async observe() {
      return {
        capturedAt: new Date().toISOString(),
        viewport,
        surfaceRef,
        screenshot: { mediaType: "image/png", data: new Uint8Array(FIXTURE_PNG) },
      };
    },
    async execute() { return { status: "completed" }; },
    async close() {},
  };
}

const TERMINAL_OUTCOMES = new Set([
  "succeeded", "failed", "cancelled", "budget_exhausted", "outcome_unknown",
]);

/**
 * Wait for a real fake-Provider invocation while observing the Run's public
 * snapshot. A terminal Run wins over the startup deadline and is returned with
 * only a finite, non-sensitive outcome category.
 */
export async function waitForFixtureModelStart({
  readSnapshot,
  hasStarted,
  started,
  timeoutMs = 10_000,
  pollIntervalMs = 100,
}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (hasStarted()) return { kind: "started" };
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) return { kind: "timeout" };
    const controller = new AbortController();
    let deadlineTimer;
    const snapshotPromise = Promise.resolve().then(() => readSnapshot({ signal: controller.signal }));
    const readResult = await new Promise((resolve, reject) => {
      deadlineTimer = setTimeout(() => resolve({ kind: "timeout" }), remainingMs);
      snapshotPromise.then(
        (snapshot) => resolve({ kind: "snapshot", snapshot }),
        reject,
      );
      started?.then(() => resolve({ kind: "started" }));
    }).finally(() => {
      clearTimeout(deadlineTimer);
      controller.abort();
    });
    if (readResult.kind === "timeout") {
      controller.abort();
      return { kind: "timeout" };
    }
    if (readResult.kind === "started") {
      controller.abort();
      return { kind: "started" };
    }
    const { snapshot } = readResult;
    if (hasStarted()) return { kind: "started" };
    if (snapshot?.status === "finished" || TERMINAL_OUTCOMES.has(snapshot?.outcome)) {
      controller.abort();
      return {
        kind: "terminal",
        outcome: TERMINAL_OUTCOMES.has(snapshot?.outcome) ? snapshot.outcome : "unknown",
      };
    }
    controller.abort();
    const pollRemainingMs = deadline - Date.now();
    if (pollRemainingMs <= 0) return { kind: "timeout" };
    await new Promise((resolve) => setTimeout(resolve, Math.min(pollIntervalMs, pollRemainingMs)));
  }
  return { kind: "timeout" };
}
