import { randomUUID } from "node:crypto";
import {
  CuaDriver,
  EndSessionInput,
  GetSessionInput,
  GetSessionStateInput,
  StartSessionInput,
  type CuaDriverLike,
  type ToolResult,
} from "@trycua/cua-driver";
import type { CuaDriverFactory } from "./cua-driver-computer.js";

const LOCKED_CUA_SDK_VERSION = "0.22.2";
const EXPECTED_DRIVER_CONTRACT_VERSION = "0.7.0";
const EXPECTED_TOOLS_LIST_SCHEMA_VERSION = "1";
const EXPECTED_HEALTH_SCHEMA_VERSION = "1";
const DEFAULT_DOCTOR_TIMEOUT_MS = 2_000;

export type CuaCapabilityStatus = "supported" | "unsupported" | "unknown" | "degraded";

export interface CuaMetadataObservation {
  readonly driverVersion: string;
  readonly contractVersion: string;
  /** Compared against the supported inventory parser version. */
  readonly toolsListSchemaVersion: string;
  /** Observed only; not used as a compatibility proof by this doctor. */
  readonly capabilityVersion: string;
  /** Observed only; not used as a compatibility proof by this doctor. */
  readonly mcpProtocolVersion: string;
  readonly pid: number;
  readonly embedded: boolean;
}

export interface CuaDoctorCheck {
  readonly status: CuaCapabilityStatus;
  /** Stable, redacted diagnostic code; never a daemon error message/path. */
  readonly reasonCode?: string;
}

export interface CuaMetadataCheck extends CuaDoctorCheck {
  readonly observed?: CuaMetadataObservation;
}

export interface CuaDeclaredToolCapabilities {
  /** Declaration only; this is not a fixture or focus verification. */
  readonly windowDiscovery: CuaCapabilityStatus;
  readonly windowForeground: CuaCapabilityStatus;
  readonly windowCapture: CuaCapabilityStatus;
}

export interface CuaCapabilityReport {
  readonly schemaVersion: "cua-doctor-v1";
  readonly backend: "cua-driver-daemon";
  /** SDK/package declaration, kept separate from observed daemon checks. */
  readonly declared: {
    readonly sdkVersion: string;
    readonly expectedDriverContractVersion: string;
    readonly defaultObservation: "desktop";
    readonly windowCapture: "not_integrated";
    readonly tools: CuaDeclaredToolCapabilities;
  };
  /** Safe, content-free observations from this doctor invocation. */
  readonly verified: {
    readonly metadata: CuaMetadataCheck;
    readonly inventory: CuaDoctorCheck & { readonly toolCount?: number };
    readonly session: CuaDoctorCheck;
    readonly health: CuaDoctorCheck;
    readonly permissions: CuaDoctorCheck;
  };
  /** Cleanup is reported separately so an unknown session is never hidden. */
  readonly cleanup: CuaDoctorCheck;
  readonly status: CuaCapabilityStatus;
}

export interface CuaCapabilityDoctorOptions {
  /** Explicit daemon endpoint. No embedded/native fallback is attempted. */
  readonly socketPath: string;
  readonly sessionLabel?: string;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  /** Test seam; production uses CuaDriver.connect. */
  readonly driverFactory?: CuaDriverFactory;
}

interface InventorySummary {
  readonly check: CuaDoctorCheck & { readonly toolCount?: number };
  readonly tools: CuaDeclaredToolCapabilities;
}

interface OperationResult<T> {
  readonly check: CuaDoctorCheck;
  readonly value?: T;
  /** False means native work may still be running; the driver cannot be reused. */
  readonly settled: boolean;
}

class DoctorTimeoutError extends Error {
  public constructor(readonly operation: string) {
    super(`doctor operation timed out: ${operation}`);
    this.name = "DoctorTimeoutError";
  }
}

class DoctorAbortError extends Error {
  public constructor(readonly nativeStarted: boolean) {
    super("doctor operation aborted");
    this.name = "DoctorAbortError";
  }
}

/**
 * Run content-free CUA diagnostics. This deliberately does not discover
 * windows, capture pixels, or dispatch input: those are separate, gated
 * capabilities and must not become an accidental doctor side effect.
 */
export async function inspectCuaCapabilities(options: CuaCapabilityDoctorOptions): Promise<CuaCapabilityReport> {
  if (options.socketPath.trim().length === 0) throw new Error("Cua capability doctor requires an explicit socketPath");
  const timeoutMs = options.timeoutMs ?? DEFAULT_DOCTOR_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new Error("doctor timeoutMs must be a positive integer");
  const parentSignal = options.signal ?? new AbortController().signal;
  if (parentSignal.aborted) return unavailableReport("aborted");
  const sessionLabel = options.sessionLabel ?? `computer-harness-doctor-${Date.now()}-${randomUUID().slice(0, 8)}`;
  let driver: CuaDriverLike;
  try {
    driver = (options.driverFactory ?? ((socketPath) => CuaDriver.connect(socketPath)))(options.socketPath);
  } catch (error) {
    return unavailableReport(reasonCode(error));
  }

  const metadataOperation = await inspectOperation(timeoutMs, parentSignal, (signal) => driver.metadata({ signal }));
  const metadata: CuaMetadataCheck = metadataOperation.check.status === "supported"
    ? validateMetadata(metadataOperation.value)
    : metadataOperation.check;
  if (!metadataOperation.settled) {
    return buildReport(metadata, unknownCheck("not_attempted"), unknownCheck("not_attempted"), unknownCheck("not_attempted"), unknownCheck("not_attempted"), unknownCheck("operation_unsettled"), unknownToolDeclarations());
  }
  if (metadata.status !== "supported") {
    const cleanup = await cleanupAfterSettledProbe(driver, timeoutMs, sessionLabel, false, false);
    return buildReport(metadata, unknownCheck("metadata_invalid"), unknownCheck("metadata_invalid"), unknownCheck("metadata_invalid"), unknownCheck("metadata_invalid"), cleanup, unknownToolDeclarations());
  }

  const inventoryOperation = await inspectOperation(timeoutMs, parentSignal, (signal) => driver.listToolsJson({ signal }));
  const inventory = inventorySummary(inventoryOperation.value, inventoryOperation.check);
  if (!inventoryOperation.settled) {
    return buildReport(metadata, inventory.check, unknownCheck("not_attempted"), unknownCheck("not_attempted"), unknownCheck("not_attempted"), unknownCheck("operation_unsettled"), inventory.tools);
  }
  if (inventory.check.status !== "supported") {
    const cleanup = await cleanupAfterSettledProbe(driver, timeoutMs, sessionLabel, false, false);
    return buildReport(metadata, inventory.check, unknownCheck("inventory_invalid"), unknownCheck("inventory_invalid"), unknownCheck("inventory_invalid"), cleanup, inventory.tools);
  }

  const startOperation = await inspectOperation(timeoutMs, parentSignal, (signal) => driver.startSession(StartSessionInput.new({ session: sessionLabel }), { signal }));
  if (!startOperation.settled) {
    return buildReport(metadata, inventory.check, startOperation.check, unknownCheck("operation_unsettled"), unknownCheck("operation_unsettled"), unknownCheck("operation_unsettled"), inventory.tools);
  }
  const startCheck = startOperation.check.status === "supported"
    ? validateStartSession(startOperation.value, sessionLabel)
    : startOperation.check;
  if (startCheck.status !== "supported") {
    const cleanup = await cleanupAfterSettledProbe(driver, timeoutMs, sessionLabel, true, false);
    return buildReport(metadata, inventory.check, startCheck, unknownCheck("session_start_invalid"), unknownCheck("session_start_invalid"), cleanup, inventory.tools);
  }

  const sessionOperation = await inspectOperation(timeoutMs, parentSignal, (signal) => driver.getSession(GetSessionInput.new({ session: sessionLabel }), { signal }));
  if (!sessionOperation.settled) {
    return buildReport(metadata, inventory.check, unknownCheck("operation_unsettled"), unknownCheck("operation_unsettled"), unknownCheck("operation_unsettled"), unknownCheck("operation_unsettled"), inventory.tools);
  }
  const sessionView = sessionOperation.check.status === "supported"
    ? validateSessionView(sessionOperation.value, sessionLabel)
    : sessionOperation.check;
  if (sessionView.status !== "supported") {
    const cleanup = await cleanupAfterSettledProbe(driver, timeoutMs, sessionLabel, true, true);
    return buildReport(metadata, inventory.check, sessionView, unknownCheck("session_view_invalid"), unknownCheck("session_view_invalid"), cleanup, inventory.tools);
  }

  const stateOperation = await inspectOperation(timeoutMs, parentSignal, (signal) => driver.getSessionState(GetSessionStateInput.new({ session: sessionLabel }), { signal }));
  if (!stateOperation.settled) {
    return buildReport(metadata, inventory.check, unknownCheck("operation_unsettled"), unknownCheck("operation_unsettled"), unknownCheck("operation_unsettled"), unknownCheck("operation_unsettled"), inventory.tools);
  }
  const stateView = stateOperation.check.status === "supported"
    ? validateSessionState(stateOperation.value, sessionLabel)
    : stateOperation.check;
  if (stateView.status !== "supported") {
    const cleanup = await cleanupAfterSettledProbe(driver, timeoutMs, sessionLabel, true, true);
    return buildReport(metadata, inventory.check, stateView, unknownCheck("session_state_invalid"), unknownCheck("session_state_invalid"), cleanup, inventory.tools);
  }

  const healthOperation = await inspectOperation(timeoutMs, parentSignal, (signal) => driver.callTool("health_report", "{}", { signal }));
  if (!healthOperation.settled) {
    return buildReport(metadata, inventory.check, supportedCheck(), unknownCheck("operation_unsettled"), unknownCheck("operation_unsettled"), unknownCheck("operation_unsettled"), inventory.tools);
  }
  const health = healthOperation.check.status === "supported"
    ? validateHealthReport(healthOperation.value, metadata.observed?.driverVersion ?? LOCKED_CUA_SDK_VERSION)
    : healthOperation.check;
  const permissionOperation = await inspectOperation(timeoutMs, parentSignal, (signal) => driver.callTool("check_permissions", JSON.stringify({ prompt: false }), { signal }));
  if (!permissionOperation.settled) {
    return buildReport(metadata, inventory.check, supportedCheck(), health, unknownCheck("operation_unsettled"), unknownCheck("operation_unsettled"), inventory.tools);
  }
  const permissions = permissionOperation.check.status === "supported"
    ? validatePermissionReport(permissionOperation.value)
    : permissionOperation.check;
  const cleanup = await cleanupAfterSettledProbe(driver, timeoutMs, sessionLabel, true, true);
  return buildReport(metadata, inventory.check, supportedCheck(), health, permissions, cleanup, inventory.tools);
}

function buildReport(
  metadata: CuaMetadataCheck,
  inventory: CuaDoctorCheck & { readonly toolCount?: number },
  session: CuaDoctorCheck,
  health: CuaDoctorCheck,
  permissions: CuaDoctorCheck,
  cleanup: CuaDoctorCheck,
  tools: CuaDeclaredToolCapabilities,
): CuaCapabilityReport {
  const verified = { metadata, inventory, session, health, permissions } as const;
  return {
    schemaVersion: "cua-doctor-v1",
    backend: "cua-driver-daemon",
    declared: {
      sdkVersion: LOCKED_CUA_SDK_VERSION,
      expectedDriverContractVersion: EXPECTED_DRIVER_CONTRACT_VERSION,
      defaultObservation: "desktop",
      windowCapture: "not_integrated",
      tools,
    },
    verified,
    cleanup,
    status: aggregateStatus([...Object.values(verified), cleanup]),
  };
}

function unavailableReport(reason: string): CuaCapabilityReport {
  const unknown = unknownCheck(reason);
  return buildReport(unknown, unknownCheck("not_attempted"), unknownCheck("not_attempted"), unknownCheck("not_attempted"), unknownCheck("not_attempted"), unknown, unknownToolDeclarations());
}

async function cleanupAfterSettledProbe(
  driver: CuaDriverLike,
  timeoutMs: number,
  sessionLabel: string,
  startAttempted: boolean,
  sessionStarted: boolean,
): Promise<CuaDoctorCheck> {
  // Cleanup is deliberately independent of the caller's signal. A cancelled
  // doctor still gets one bounded attempt to close a confirmed session.
  const cleanupSignal = new AbortController().signal;
  let sessionEnded = !sessionStarted;
  if (sessionStarted) {
    const firstEnd = await inspectOperation(timeoutMs, cleanupSignal, (signal) => driver.endSession(EndSessionInput.new({ session: sessionLabel }), { signal }));
    const firstOutput = firstEnd.value as { active?: unknown } | undefined;
    sessionEnded = firstEnd.settled && firstEnd.check.status === "supported" && firstOutput?.active === false;
    if (!sessionEnded && firstEnd.settled && firstEnd.check.status === "supported" && firstOutput?.active === true) {
      const secondEnd = await inspectOperation(timeoutMs, cleanupSignal, (signal) => driver.endSession(EndSessionInput.new({ session: sessionLabel }), { signal }));
      const secondOutput = secondEnd.value as { active?: unknown } | undefined;
      sessionEnded = secondEnd.settled && secondEnd.check.status === "supported" && secondOutput?.active === false;
      if (!sessionEnded) return { status: "unknown", reasonCode: secondEnd.check.reasonCode ?? "session_still_active" };
    } else if (!sessionEnded) {
      return { status: "unknown", reasonCode: firstEnd.check.reasonCode ?? "session_cleanup_unknown" };
    }
  }
  const shutdown = await inspectOperation(timeoutMs, cleanupSignal, (signal) => driver.shutdown({ signal }));
  if (!shutdown.settled || shutdown.check.status !== "supported") return shutdown.settled ? shutdown.check : unknownCheck("operation_unsettled");
  // A failed start may have created a session even when no valid output was
  // returned. Closing the transport is useful, but destroying the native
  // driver would hide unresolved ownership.
  if (startAttempted && !sessionStarted) return unknownCheck("session_start_unknown");
  if (sessionEnded) (driver as unknown as { uniffiDestroy?: () => void }).uniffiDestroy?.();
  return supportedCheck();
}

async function inspectOperation<T>(
  timeoutMs: number,
  parentSignal: AbortSignal,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<OperationResult<T>> {
  try {
    const value = await withDeadline(operation, timeoutMs, parentSignal);
    return { check: supportedCheck(), value, settled: true };
  } catch (error) {
    const unsettled = error instanceof DoctorTimeoutError || (error instanceof DoctorAbortError && error.nativeStarted);
    return { check: unknownCheck(reasonCode(error)), settled: !unsettled };
  }
}

async function withDeadline<T>(operation: (signal: AbortSignal) => Promise<T>, timeoutMs: number, parentSignal: AbortSignal): Promise<T> {
  if (parentSignal.aborted) throw new DoctorAbortError(false);
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let parentAbort: (() => void) | undefined;
  let workSettled = false;
  const work = Promise.resolve().then(() => operation(controller.signal)).finally(() => { workSettled = true; });
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort(new DoctorTimeoutError("operation"));
      queueMicrotask(() => reject(new DoctorTimeoutError("operation")));
    }, timeoutMs);
  });
  const aborted = new Promise<never>((_resolve, reject) => {
    parentAbort = () => {
      controller.abort(new DoctorAbortError(true));
      queueMicrotask(() => queueMicrotask(() => queueMicrotask(() => reject(new DoctorAbortError(!workSettled)))));
    };
    parentSignal.addEventListener("abort", parentAbort, { once: true });
  });
  try {
    return await Promise.race([work, timeout, aborted]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (parentAbort !== undefined) parentSignal.removeEventListener("abort", parentAbort);
  }
}

function validateMetadata(value: unknown): CuaMetadataCheck {
  if (!isRecord(value)) return unknownMetadata("metadata_shape");
  const driverVersion = stringField(value, "driverVersion");
  const contractVersion = stringField(value, "contractVersion");
  const toolsListSchemaVersion = stringField(value, "toolsListSchemaVersion");
  const capabilityVersion = stringField(value, "capabilityVersion");
  const mcpProtocolVersion = stringField(value, "mcpProtocolVersion");
  const pid = value.pid;
  const embedded = value.embedded;
  if (driverVersion === undefined || contractVersion === undefined || toolsListSchemaVersion === undefined || capabilityVersion === undefined || mcpProtocolVersion === undefined || typeof pid !== "number" || !Number.isInteger(pid) || pid < 1 || typeof embedded !== "boolean") return unknownMetadata("metadata_schema");
  const observed = { driverVersion, contractVersion, toolsListSchemaVersion, capabilityVersion, mcpProtocolVersion, pid, embedded };
  if (driverVersion !== LOCKED_CUA_SDK_VERSION) return { status: "unknown", reasonCode: "driver_version_mismatch", observed };
  if (contractVersion !== EXPECTED_DRIVER_CONTRACT_VERSION) return { status: "unknown", reasonCode: "contract_version_mismatch", observed };
  if (toolsListSchemaVersion !== EXPECTED_TOOLS_LIST_SCHEMA_VERSION) return { status: "unknown", reasonCode: "tools_list_schema_version_mismatch", observed };
  if (embedded) return { status: "unknown", reasonCode: "embedded_driver_not_allowed", observed };
  return { status: "supported", observed };
}

function validateStartSession(value: unknown, sessionLabel: string): CuaDoctorCheck {
  if (!isRecord(value) || value.active !== true || typeof value.revived !== "boolean") return unknownCheck("session_start_schema");
  return validateSessionState(value.state, sessionLabel);
}

function validateSessionView(value: unknown, sessionLabel: string): CuaDoctorCheck {
  if (!isRecord(value) || value.session !== sessionLabel || value.implicit !== false || typeof value.state !== "number" || typeof value.clientKind !== "number" || typeof value.transport !== "number" || typeof value.cursorVisible !== "boolean" || typeof value.recordingActive !== "boolean" || typeof value.idleSeconds !== "bigint" || typeof value.expiresInSeconds !== "bigint") return unknownCheck("session_view_schema");
  return value.state === 0 ? supportedCheck() : unknownCheck("session_not_active");
}

function validateSessionState(value: unknown, sessionLabel: string): CuaDoctorCheck {
  if (!isRecord(value) || value.session !== sessionLabel || typeof value.captureScope !== "number" || typeof value.effectiveScope !== "number" || typeof value.desktopUnlocked !== "boolean") return unknownCheck("session_state_schema");
  if (value.desktopUnlocked !== true) return unknownCheck("desktop_capture_scope_unconfirmed");
  return supportedCheck();
}

function validateHealthReport(result: ToolResult | undefined, expectedDriverVersion: string): CuaDoctorCheck {
  const envelope = validateToolEnvelope(result);
  if (envelope.status !== "supported") return envelope;
  const value = parseStructured(result?.structuredJson);
  if (!isRecord(value) || value.schema_version !== EXPECTED_HEALTH_SCHEMA_VERSION || !isPlatform(value.platform) || typeof value.driver_version !== "string" || !isHealthOverall(value.overall) || !Array.isArray(value.checks) || value.checks.length === 0 || value.checks.some((check) => !isRecord(check) || typeof check.name !== "string" || check.name.trim().length === 0 || !isHealthCheckStatus(check.status))) return unknownCheck("health_schema");
  if (value.driver_version !== LOCKED_CUA_SDK_VERSION || value.driver_version !== expectedDriverVersion) return unknownCheck("health_driver_version_mismatch");
  const statuses = value.checks.map((check) => (check as Record<string, unknown>).status);
  if (statuses.includes("fail") || value.overall === "failed") return unknownCheck("health_failed");
  if (value.overall === "degraded") return { status: "degraded", reasonCode: "health_degraded" };
  if (statuses.includes("skip")) return { status: "degraded", reasonCode: "health_checks_skipped" };
  return supportedCheck();
}

function validatePermissionReport(result: ToolResult | undefined): CuaDoctorCheck {
  const envelope = validateToolEnvelope(result);
  if (envelope.status !== "supported") return envelope;
  const value = parseStructured(result?.structuredJson);
  if (!isRecord(value) || typeof value.accessibility !== "boolean" || typeof value.screen_recording !== "boolean" || typeof value.source !== "string") return unknownCheck("permission_schema");
  if (!value.accessibility || !value.screen_recording) return unknownCheck("permission_not_granted");
  return supportedCheck();
}

function validateToolEnvelope(result: ToolResult | undefined): CuaDoctorCheck {
  if (result === undefined) return unknownCheck("tool_result_missing");
  if (result.isError) return unknownCheck(errorCode(result.errorCode) ?? "tool_error");
  if (result.degraded) return { status: "degraded", reasonCode: "tool_degraded" };
  return supportedCheck();
}

function inventorySummary(raw: string | undefined, baseCheck: CuaDoctorCheck): InventorySummary {
  if (baseCheck.status !== "supported") return { check: baseCheck, tools: unknownToolDeclarations() };
  if (raw === undefined) return { check: unknownCheck("inventory_missing"), tools: unknownToolDeclarations() };
  let parsed: unknown;
  try { parsed = JSON.parse(raw) as unknown; } catch { return { check: unknownCheck("inventory_malformed"), tools: unknownToolDeclarations() }; }
  const values = Array.isArray(parsed)
    ? parsed
    : isRecord(parsed) && Array.isArray(parsed.tools) ? parsed.tools as unknown[] : undefined;
  if (values === undefined) return { check: unknownCheck("inventory_shape"), tools: unknownToolDeclarations() };
  if (values.length === 0) return { check: unknownCheck("inventory_empty"), tools: unknownToolDeclarations() };
  const names: string[] = [];
  for (const value of values) {
    if (!isRecord(value) || typeof value.name !== "string" || value.name.trim().length === 0) return { check: unknownCheck("inventory_entry_schema"), tools: unknownToolDeclarations() };
    names.push(value.name);
  }
  const nameSet = new Set(names);
  return {
    check: { status: "supported", toolCount: values.length },
    tools: {
      windowDiscovery: nameSet.has("list_windows") ? "supported" : "unknown",
      windowForeground: nameSet.has("bring_to_front") ? "supported" : "unknown",
      windowCapture: nameSet.has("get_window_state") || nameSet.has("verify_state") ? "supported" : "unknown",
    },
  };
}

function aggregateStatus(checks: readonly CuaDoctorCheck[]): CuaCapabilityStatus {
  if (checks.some((check) => check.status === "unknown")) return "unknown";
  if (checks.some((check) => check.status === "degraded")) return "degraded";
  if (checks.some((check) => check.status === "unsupported")) return "unsupported";
  return "supported";
}

function supportedCheck(): CuaDoctorCheck { return { status: "supported" }; }
function unknownCheck(reason: string): CuaDoctorCheck { return { status: "unknown", reasonCode: reason }; }
function unknownMetadata(reason: string): CuaMetadataCheck { return { status: "unknown", reasonCode: reason }; }

function unknownToolDeclarations(): CuaDeclaredToolCapabilities {
  return { windowDiscovery: "unknown", windowForeground: "unknown", windowCapture: "unknown" };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function parseStructured(value: string | undefined): unknown {
  if (value === undefined) return undefined;
  try { return JSON.parse(value) as unknown; } catch { return undefined; }
}

function isPlatform(value: unknown): value is "darwin" | "win32" | "linux" {
  return value === "darwin" || value === "win32" || value === "linux";
}

function isHealthOverall(value: unknown): value is "ok" | "degraded" | "failed" {
  return value === "ok" || value === "degraded" || value === "failed";
}

function isHealthCheckStatus(value: unknown): value is "pass" | "fail" | "skip" {
  return value === "pass" || value === "fail" || value === "skip";
}

function reasonCode(error: unknown): string {
  if (error instanceof DoctorTimeoutError) return "timeout";
  if (error instanceof DoctorAbortError) return "aborted";
  if (error !== null && typeof error === "object") {
    const record = error as Record<string, unknown>;
    const inner = isRecord(record.inner) ? record.inner : undefined;
    if (record.tag === "Transport" || inner?.reason === "closed") return "transport";
    if (inner?.errorCode !== undefined || record.errorCode !== undefined) return errorCode(inner?.errorCode ?? record.errorCode) ?? "tool_error";
  }
  return "error";
}

function errorCode(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  switch (value) {
    case "PERMISSION_DENIED": return "permission_denied";
    case "UNKNOWN_TOOL": return "unknown_tool";
    case "UNSUPPORTED": return "unsupported";
    case "SESSION_NOT_FOUND": return "session_not_found";
    case "TRANSPORT": return "transport";
    case "TIMEOUT": return "timeout";
    default: return "tool_error";
  }
}
