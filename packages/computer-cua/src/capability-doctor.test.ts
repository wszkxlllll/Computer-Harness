import { describe, expect, it } from "vitest";
import type { CuaDriverLike, ToolResult } from "@trycua/cua-driver";
import { inspectCuaCapabilities } from "./capability-doctor.js";

function toolResult(overrides: Partial<ToolResult> = {}): ToolResult {
  return {
    text: "private daemon text must not escape the report",
    images: [],
    isError: false,
    degraded: false,
    rawJson: "{\"private\":true}",
    ...overrides,
  };
}

function fakeDriver(options: {
  inventory?: string;
  metadata?: Record<string, unknown>;
  metadataFailure?: unknown;
  health?: ToolResult;
  healthFailure?: unknown;
  permissionFailure?: unknown;
  permission?: ToolResult;
  sessionState?: Record<string, unknown>;
  hangEnd?: boolean;
  hangMetadata?: boolean;
  hangStart?: boolean;
  onStart?: () => void;
  captureCleanupSignal?: (signal: AbortSignal | undefined) => void;
} = {}): { driver: CuaDriverLike; calls: string[]; destroyed: () => number } {
  const calls: string[] = [];
  let destroyCount = 0;
  let activeLabel = "private-session";
  const driver = {
    async metadata() {
      calls.push("metadata");
      if (options.hangMetadata === true) return await new Promise<never>(() => undefined);
      if (options.metadataFailure !== undefined) throw options.metadataFailure;
      return {
        driverVersion: "0.22.2",
        contractVersion: "0.7.0",
        toolsListSchemaVersion: "1",
        capabilityVersion: "1",
        mcpProtocolVersion: "1",
        pid: 1234,
        embedded: false,
        ...options.metadata,
      } as never;
    },
    async listToolsJson() {
      calls.push("listToolsJson");
      return options.inventory ?? JSON.stringify({ tools: [{ name: "list_windows" }, { name: "bring_to_front" }, { name: "get_desktop_state" }] });
    },
    async startSession(input: { session?: string }) {
      calls.push("startSession");
      if (typeof input.session === "string") activeLabel = input.session;
      options.onStart?.();
      if (options.hangStart === true) return await new Promise<never>(() => undefined);
      return { active: true, revived: false, state: { session: activeLabel, captureScope: 2, effectiveScope: 1, desktopUnlocked: true } } as never;
    },
    async getSession() {
      calls.push("getSession");
      return { session: activeLabel, implicit: false, state: 0, clientKind: 4, transport: 1, cursorVisible: true, recordingActive: false, idleSeconds: 0n, expiresInSeconds: 60n } as never;
    },
    async getSessionState() { calls.push("getSessionState"); return { session: activeLabel, captureScope: 2, effectiveScope: 1, desktopUnlocked: true, ...options.sessionState } as never; },
    async endSession(_input?: unknown, callOptions?: { signal?: AbortSignal }) {
      calls.push("endSession");
      options.captureCleanupSignal?.(callOptions?.signal);
      if (options.hangEnd === true) return await new Promise<never>(() => undefined);
      return { active: false, session: activeLabel } as never;
    },
    async shutdown() { calls.push("shutdown"); },
    async callTool(name: string) {
      calls.push(name);
      if (name === "health_report" && options.healthFailure !== undefined) throw options.healthFailure;
      if (name === "check_permissions" && options.permissionFailure !== undefined) throw options.permissionFailure;
      if (name === "check_permissions" && options.permission !== undefined) return options.permission;
      if (name === "health_report") return options.health ?? toolResult({ structuredJson: JSON.stringify({ schema_version: "1", platform: "win32", driver_version: "0.22.2", overall: "ok", checks: [{ name: "binary_version", status: "pass" }] }) });
      if (name === "check_permissions") return toolResult({ structuredJson: JSON.stringify({ accessibility: true, screen_recording: true, source: "cua-driver" }) });
      return toolResult();
    },
    uniffiDestroy() { destroyCount += 1; },
  } as unknown as CuaDriverLike;
  return { driver, calls, destroyed: () => destroyCount };
}

describe("CUA capability doctor", () => {
  it("returns redacted daemon checks without discovering windows or dispatching actions", async () => {
    const fake = fakeDriver();
    const report = await inspectCuaCapabilities({ socketPath: "fixture-socket", driverFactory: () => fake.driver });

    expect(report.status).toBe("supported");
    expect(report.declared.sdkVersion).toBe("0.22.2");
    expect(report.declared.defaultObservation).toBe("desktop");
    expect(report.declared.tools.windowDiscovery).toBe("supported");
    expect(report.declared.tools.windowCapture).toBe("unknown");
    expect(report.verified.metadata.status).toBe("supported");
    expect(report.verified.session.status).toBe("supported");
    expect(report.verified.health.status).toBe("supported");
    expect(report.verified.permissions.status).toBe("supported");
    expect(report.cleanup.status).toBe("supported");
    expect(JSON.stringify(report)).not.toContain("private-daemon-version");
    expect(JSON.stringify(report)).not.toContain("private daemon text");
    expect(fake.calls).not.toContain("list_windows");
    expect(fake.calls).not.toContain("bring_to_front");
    expect(fake.calls).not.toContain("get_window_state");
    expect(fake.destroyed()).toBe(1);
  });

  it("uses a cleanup signal independent from the caller signal", async () => {
    const caller = new AbortController();
    let cleanupSignal: AbortSignal | undefined;
    const fake = fakeDriver({ captureCleanupSignal: (signal) => { cleanupSignal = signal; } });
    const report = await inspectCuaCapabilities({ socketPath: "fixture-socket", signal: caller.signal, driverFactory: () => fake.driver });

    expect(report.cleanup.status).toBe("supported");
    expect(cleanupSignal).toBeDefined();
    expect(cleanupSignal).not.toBe(caller.signal);
  });

  it("keeps malformed or missing declarations unknown instead of guessing support", async () => {
    const fake = fakeDriver({ inventory: "not-json" });
    const report = await inspectCuaCapabilities({ socketPath: "fixture-socket", driverFactory: () => fake.driver });

    expect(report.status).toBe("unknown");
    expect(report.verified.inventory).toMatchObject({ status: "unknown", reasonCode: "inventory_malformed" });
    expect(report.declared.tools).toEqual({ windowDiscovery: "unknown", windowForeground: "unknown", windowCapture: "unknown" });
    expect(report.cleanup.status).toBe("supported");
  });

  it("surfaces permission errors as unknown while retaining cleanup evidence", async () => {
    const fake = fakeDriver({ permission: toolResult({ isError: true, errorCode: "PERMISSION_DENIED", text: "private permission detail" }) });
    const report = await inspectCuaCapabilities({ socketPath: "fixture-socket", driverFactory: () => fake.driver });

    expect(report.status).toBe("unknown");
    expect(report.verified.permissions).toEqual({ status: "unknown", reasonCode: "permission_denied" });
    expect(report.cleanup.status).toBe("supported");
    expect(JSON.stringify(report)).not.toContain("private permission detail");
  });

  it("does not destroy a driver when session cleanup times out", async () => {
    const fake = fakeDriver({ hangEnd: true });
    const report = await inspectCuaCapabilities({ socketPath: "fixture-socket", timeoutMs: 5, driverFactory: () => fake.driver });

    expect(report.status).toBe("unknown");
    expect(report.cleanup).toEqual({ status: "unknown", reasonCode: "timeout" });
    expect(fake.destroyed()).toBe(0);
    expect(fake.calls).not.toContain("shutdown");
  });

  it("turns a connection construction failure into a redacted unknown report", async () => {
    const report = await inspectCuaCapabilities({
      socketPath: "missing-socket",
      driverFactory: () => { throw Object.assign(new Error("\\\\.\\pipe\\private"), { tag: "Transport" }); },
    });

    expect(report.status).toBe("unknown");
    expect(report.verified.metadata).toEqual({ status: "unknown", reasonCode: "transport" });
    expect(JSON.stringify(report)).not.toContain("private");
  });

  it("stops after metadata timeout without reusing or destroying the unresolved driver", async () => {
    const fake = fakeDriver({ hangMetadata: true });
    const report = await inspectCuaCapabilities({ socketPath: "fixture-socket", timeoutMs: 5, driverFactory: () => fake.driver });

    expect(report.status).toBe("unknown");
    expect(report.verified.metadata).toEqual({ status: "unknown", reasonCode: "timeout" });
    expect(report.cleanup).toEqual({ status: "unknown", reasonCode: "operation_unsettled" });
    expect(fake.calls).toEqual(["metadata"]);
    expect(fake.destroyed()).toBe(0);
  });

  it("stops after start timeout without issuing concurrent cleanup calls", async () => {
    const fake = fakeDriver({ hangStart: true });
    const report = await inspectCuaCapabilities({ socketPath: "fixture-socket", timeoutMs: 5, driverFactory: () => fake.driver });

    expect(report.status).toBe("unknown");
    expect(report.verified.session).toEqual({ status: "unknown", reasonCode: "timeout" });
    expect(report.cleanup).toEqual({ status: "unknown", reasonCode: "operation_unsettled" });
    expect(fake.calls).toEqual(["metadata", "listToolsJson", "startSession"]);
    expect(fake.destroyed()).toBe(0);
  });

  it("fails closed without reusing a driver when abort races the session view", async () => {
    const controller = new AbortController();
    const fake = fakeDriver();
    let getSessionCalls = 0;
    fake.driver.getSession = async () => {
      getSessionCalls += 1;
      controller.abort();
      return { session: "private-session", implicit: false, state: 0, clientKind: 4, transport: 1, cursorVisible: true, recordingActive: false, idleSeconds: 0n, expiresInSeconds: 60n } as never;
    };
    fake.driver.getSessionState = async () => ({ session: "private-session", captureScope: 2, effectiveScope: 1, desktopUnlocked: true } as never);
    const report = await inspectCuaCapabilities({ socketPath: "fixture-socket", signal: controller.signal, driverFactory: () => fake.driver });

    expect(getSessionCalls).toBe(1);
    expect(report.status).toBe("unknown");
    expect(report.cleanup).toEqual({ status: "unknown", reasonCode: "operation_unsettled" });
    expect(fake.calls).not.toContain("endSession");
    expect(fake.calls).not.toContain("shutdown");
    expect(fake.destroyed()).toBe(0);
  });

  it("rejects an inventory entry without a name and redacts arbitrary tool codes", async () => {
    const fake = fakeDriver({ inventory: JSON.stringify({ tools: [{}] }) });
    const report = await inspectCuaCapabilities({ socketPath: "fixture-socket", driverFactory: () => fake.driver });
    expect(report.verified.inventory).toEqual({ status: "unknown", reasonCode: "inventory_entry_schema" });

    const denied = fakeDriver({ permission: toolResult({ isError: true, errorCode: "SECRET_PATH_TOKEN" }) });
    const deniedReport = await inspectCuaCapabilities({ socketPath: "fixture-socket", driverFactory: () => denied.driver });
    expect(deniedReport.verified.permissions.reasonCode).toBe("tool_error");
    expect(JSON.stringify(deniedReport)).not.toContain("SECRET_PATH_TOKEN");
  });

  it("freezes the supported tools-list schema instead of treating any non-empty version as compatible", async () => {
    const fake = fakeDriver({ metadata: { toolsListSchemaVersion: "2" } });
    const report = await inspectCuaCapabilities({ socketPath: "fixture-socket", driverFactory: () => fake.driver });

    expect(report.verified.metadata).toEqual({
      status: "unknown",
      reasonCode: "tools_list_schema_version_mismatch",
      observed: expect.objectContaining({ toolsListSchemaVersion: "2" }),
    });
    expect(fake.calls).toEqual(["metadata", "shutdown"]);
  });

  it("does not report a contradictory or version-mismatched health result as healthy", async () => {
    const failedCheck = fakeDriver({
      health: toolResult({ structuredJson: JSON.stringify({ schema_version: "1", platform: "win32", driver_version: "0.22.2", overall: "ok", checks: [{ name: "binary_version", status: "fail" }] }) }),
    });
    const failedReport = await inspectCuaCapabilities({ socketPath: "fixture-socket", driverFactory: () => failedCheck.driver });
    expect(failedReport.verified.health).toEqual({ status: "unknown", reasonCode: "health_failed" });

    const skippedCheck = fakeDriver({
      health: toolResult({ structuredJson: JSON.stringify({ schema_version: "1", platform: "win32", driver_version: "0.22.2", overall: "ok", checks: [{ name: "optional_permission", status: "skip" }] }) }),
    });
    const skippedReport = await inspectCuaCapabilities({ socketPath: "fixture-socket", driverFactory: () => skippedCheck.driver });
    expect(skippedReport.verified.health).toEqual({ status: "degraded", reasonCode: "health_checks_skipped" });

    const mismatchedVersion = fakeDriver({
      health: toolResult({ structuredJson: JSON.stringify({ schema_version: "1", platform: "win32", driver_version: "0.22.1", overall: "ok", checks: [{ name: "binary_version", status: "pass" }] }) }),
    });
    const mismatchedReport = await inspectCuaCapabilities({ socketPath: "fixture-socket", driverFactory: () => mismatchedVersion.driver });
    expect(mismatchedReport.verified.health).toEqual({ status: "unknown", reasonCode: "health_driver_version_mismatch" });
  });

  it("preserves settled transport failures instead of replacing them with shape errors", async () => {
    const transport = Object.assign(new Error("private transport detail"), { tag: "Transport" });
    const metadataFailure = fakeDriver({ metadataFailure: transport });
    const metadataReport = await inspectCuaCapabilities({ socketPath: "fixture-socket", driverFactory: () => metadataFailure.driver });
    expect(metadataReport.verified.metadata).toEqual({ status: "unknown", reasonCode: "transport" });

    const healthFailure = fakeDriver({ healthFailure: transport });
    const healthReport = await inspectCuaCapabilities({ socketPath: "fixture-socket", driverFactory: () => healthFailure.driver });
    expect(healthReport.verified.health).toEqual({ status: "unknown", reasonCode: "transport" });

    const permissionFailure = fakeDriver({ permissionFailure: transport });
    const permissionReport = await inspectCuaCapabilities({ socketPath: "fixture-socket", driverFactory: () => permissionFailure.driver });
    expect(permissionReport.verified.permissions).toEqual({ status: "unknown", reasonCode: "transport" });
  });

  it("does not call an unknown desktop unlock field locked", async () => {
    const malformed = fakeDriver({ sessionState: { desktopUnlocked: null } });
    const malformedReport = await inspectCuaCapabilities({ socketPath: "fixture-socket", driverFactory: () => malformed.driver });
    expect(malformedReport.verified.session).toEqual({ status: "unknown", reasonCode: "session_state_schema" });

    const locked = fakeDriver({ sessionState: { desktopUnlocked: false } });
    const lockedReport = await inspectCuaCapabilities({ socketPath: "fixture-socket", driverFactory: () => locked.driver });
    expect(lockedReport.verified.session).toEqual({ status: "unknown", reasonCode: "desktop_locked" });
  });
});
