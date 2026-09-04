import { randomUUID } from "node:crypto";
import type { Viewport } from "@computer-harness/protocol";
import type {
  OsworldBridge,
  OsworldBridgeCapture,
  OsworldBridgeDescription,
  OsworldBridgeExecuteResult,
  OsworldBridgeCapabilities,
  OsworldTypedAction,
} from "./bridge.js";

export interface OsworldResetResult {
  taskId: string;
  instruction: string;
}

export interface OsworldEvaluationResult {
  score: number;
  details?: unknown;
}

export interface OsworldHealthResult {
  status: "ok";
  protocolVersion: string;
  osworldVersion?: string;
}

export interface OsworldBridgeClientOptions {
  baseUrl: string;
  token?: string;
  /** Timeout for health/describe/observe/execute requests. */
  requestTimeoutMs?: number;
  /** Environment operations may include VM boot, snapshot restore, or evaluator postconfig. */
  environmentRequestTimeoutMs?: number;
  requestIdFactory?: () => string;
  fetchImpl?: typeof fetch;
}

interface RpcEnvelope {
  requestId: string;
  method: string;
  params?: unknown;
}

interface RpcSuccess {
  requestId: string;
  ok: true;
  result: unknown;
}

interface RpcFailure {
  requestId: string;
  ok: false;
  error: { code: string; message: string };
}

export class OsworldBridgeClient implements OsworldBridge {
  public static readonly computerRequestTimeoutMs = 30_000;
  public static readonly environmentRequestTimeoutMs = 300_000;
  private readonly baseUrl: string;
  private readonly token: string | undefined;
  private readonly computerRequestTimeoutMs: number;
  private readonly environmentRequestTimeoutMs: number;
  private readonly requestIdFactory: () => string;
  private readonly fetchImpl: typeof fetch;

  public constructor(options: OsworldBridgeClientOptions) {
    const baseUrl = options.baseUrl.trim().replace(/\/+$/u, "");
    if (baseUrl.length === 0) throw new Error("OsworldBridgeClient requires a non-empty baseUrl");
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(baseUrl);
    } catch {
      throw new Error("OsworldBridgeClient baseUrl must be a valid URL");
    }
    if (parsedUrl.protocol !== "http:" || !isLoopbackHost(parsedUrl.hostname)) {
      throw new Error("OsworldBridgeClient baseUrl must use HTTP loopback (127.0.0.1, localhost, or ::1)");
    }
    this.baseUrl = baseUrl;
    this.token = options.token;
    this.computerRequestTimeoutMs = options.requestTimeoutMs ?? OsworldBridgeClient.computerRequestTimeoutMs;
    this.environmentRequestTimeoutMs = options.environmentRequestTimeoutMs ?? OsworldBridgeClient.environmentRequestTimeoutMs;
    if (!Number.isInteger(this.computerRequestTimeoutMs) || this.computerRequestTimeoutMs <= 0) {
      throw new Error("OsworldBridgeClient requestTimeoutMs must be a positive integer");
    }
    if (!Number.isInteger(this.environmentRequestTimeoutMs) || this.environmentRequestTimeoutMs <= 0) {
      throw new Error("OsworldBridgeClient environmentRequestTimeoutMs must be a positive integer");
    }
    this.requestIdFactory = options.requestIdFactory ?? (() => randomUUID());
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  public async health(signal: AbortSignal): Promise<OsworldHealthResult> {
    return this.call("health", {}, parseHealth, signal);
  }

  public async reset(taskId: string, signal: AbortSignal): Promise<OsworldResetResult> {
    if (taskId.trim().length === 0) throw new Error("OSWorld reset requires a taskId");
    const result = await this.call("environment.reset", { taskId }, parseReset, signal);
    if (result.taskId !== taskId) throw new OsworldBridgeClientError("BRIDGE_INVALID_RESULT", "OSWorld reset returned a different taskId");
    return result;
  }

  public async describe(signal: AbortSignal): Promise<OsworldBridgeDescription> {
    return this.call("computer.describe", {}, parseDescription, signal);
  }

  public async observe(signal: AbortSignal): Promise<OsworldBridgeCapture> {
    return this.call("computer.observe", {}, parseCapture, signal);
  }

  public async execute(action: OsworldTypedAction, signal: AbortSignal): Promise<OsworldBridgeExecuteResult> {
    return this.call("computer.execute", { action }, parseExecuteResult, signal);
  }

  public async evaluate(signal: AbortSignal): Promise<OsworldEvaluationResult> {
    return this.call("environment.evaluate", {}, parseEvaluation, signal);
  }

  public async close(signal: AbortSignal): Promise<void> {
    await this.call("environment.close", {}, parseClosed, signal);
  }

  private async call<T>(method: string, params: unknown, parse: (value: unknown) => T, signal: AbortSignal): Promise<T> {
    signal.throwIfAborted();
    const request: RpcEnvelope = { requestId: this.requestIdFactory(), method, params };
    const requestTimeoutMs = method.startsWith("environment.") ? this.environmentRequestTimeoutMs : this.computerRequestTimeoutMs;
    const controller = new AbortController();
    const onAbort = () => controller.abort(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    const timeout = setTimeout(() => controller.abort(new Error(`OSWorld bridge request timed out after ${requestTimeoutMs}ms`)), requestTimeoutMs);
    try {
      const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json" };
      if (this.token !== undefined && this.token.length > 0) headers.authorization = `Bearer ${this.token}`;
      let response: Response;
      try {
        response = await this.fetchImpl(`${this.baseUrl}/rpc`, {
          method: "POST",
          headers,
          body: JSON.stringify(request),
          signal: controller.signal,
        });
      } catch (error) {
        if (signal.aborted) throw signal.reason ?? error;
        if (controller.signal.aborted) {
          throw new OsworldBridgeClientError("BRIDGE_TIMEOUT", `${method} request timed out after ${requestTimeoutMs}ms`);
        }
        throw new OsworldBridgeClientError("BRIDGE_TRANSPORT_ERROR", `${method} request failed: ${errorMessage(error)}`);
      }
      let body: unknown;
      try {
        body = await response.json() as unknown;
      } catch (error) {
        throw new OsworldBridgeClientError("BRIDGE_INVALID_JSON", `${method} returned invalid JSON: ${errorMessage(error)}`);
      }
      const envelope = parseEnvelope(body, request.requestId);
      if (!response.ok) {
        if (envelope.ok === false) throw new OsworldBridgeClientError(envelope.error.code, envelope.error.message);
        throw new OsworldBridgeClientError("BRIDGE_HTTP_ERROR", `${method} returned HTTP ${response.status}`);
      }
      if (envelope.ok === false) throw new OsworldBridgeClientError(envelope.error.code, envelope.error.message);
      return parse(envelope.result);
    } finally {
      clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
    }
  }
}

export class OsworldBridgeClientError extends Error {
  public constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "OsworldBridgeClientError";
  }
}

function parseEnvelope(value: unknown, requestId: string): RpcSuccess | RpcFailure {
  if (!isRecord(value) || value.requestId !== requestId || typeof value.ok !== "boolean") {
    throw new OsworldBridgeClientError("BRIDGE_INVALID_RESPONSE", "OSWorld bridge returned an invalid response envelope");
  }
  if (value.ok) {
    return { requestId, ok: true, result: value.result };
  }
  if (!isRecord(value.error) || typeof value.error.code !== "string" || typeof value.error.message !== "string") {
    throw new OsworldBridgeClientError("BRIDGE_INVALID_RESPONSE", "OSWorld bridge returned an invalid error envelope");
  }
  return { requestId, ok: false, error: { code: value.error.code, message: value.error.message } };
}

function parseHealth(value: unknown): OsworldHealthResult {
  if (!isRecord(value) || value.status !== "ok" || value.protocolVersion !== "1") {
    throw new OsworldBridgeClientError("BRIDGE_INVALID_RESULT", "OSWorld health result is invalid");
  }
  return {
    status: "ok",
    protocolVersion: value.protocolVersion,
    ...(typeof value.osworldVersion === "string" ? { osworldVersion: value.osworldVersion } : {}),
  };
}

function parseReset(value: unknown): OsworldResetResult {
  if (!isRecord(value) || typeof value.taskId !== "string" || value.taskId.trim().length === 0 || typeof value.instruction !== "string" || value.instruction.trim().length === 0) {
    throw new OsworldBridgeClientError("BRIDGE_INVALID_RESULT", "OSWorld reset result is invalid");
  }
  return { taskId: value.taskId, instruction: value.instruction };
}

function parseDescription(value: unknown): OsworldBridgeDescription {
  if (!isRecord(value)) throw new OsworldBridgeClientError("BRIDGE_INVALID_RESULT", "OSWorld description is invalid");
  const viewport = parseViewport(value.viewport);
  const capabilities = parseCapabilities(value.capabilities);
  return { viewport, capabilities };
}

function parseCapture(value: unknown): OsworldBridgeCapture {
  if (!isRecord(value) || value.mediaType !== "image/png" || typeof value.dataBase64 !== "string" || value.dataBase64.length === 0 || !positiveInteger(value.width) || !positiveInteger(value.height) || typeof value.capturedAt !== "string" || value.capturedAt.trim().length === 0) {
    throw new OsworldBridgeClientError("BRIDGE_INVALID_RESULT", "OSWorld screenshot result is invalid");
  }
  return {
    mediaType: "image/png",
    dataBase64: value.dataBase64,
    width: value.width,
    height: value.height,
    capturedAt: value.capturedAt,
  };
}

function parseExecuteResult(value: unknown): OsworldBridgeExecuteResult {
  if (!isRecord(value) || typeof value.status !== "string") {
    throw new OsworldBridgeClientError("BRIDGE_INVALID_RESULT", "OSWorld execute result is invalid");
  }
  if (value.status === "refused" && typeof value.code === "string" && typeof value.message === "string") {
    return { status: "refused", code: value.code, message: value.message };
  }
  if (value.status === "completed") {
    const postActionCapture = parseCapture(value.postActionCapture);
    return { status: "completed", postActionCapture, ...(typeof value.message === "string" ? { message: value.message } : {}) };
  }
  throw new OsworldBridgeClientError("BRIDGE_INVALID_RESULT", "OSWorld execute result has an unsupported status");
}

function parseEvaluation(value: unknown): OsworldEvaluationResult {
  if (!isRecord(value) || typeof value.score !== "number" || !Number.isFinite(value.score)) {
    throw new OsworldBridgeClientError("BRIDGE_INVALID_RESULT", "OSWorld evaluation result is invalid");
  }
  return { score: value.score, ...("details" in value ? { details: value.details } : {}) };
}

function parseClosed(value: unknown): true {
  if (!isRecord(value) || value.closed !== true) throw new OsworldBridgeClientError("BRIDGE_INVALID_RESULT", "OSWorld close result is invalid");
  return true;
}

function parseViewport(value: unknown): Viewport {
  if (!isRecord(value) || !positiveInteger(value.width) || !positiveInteger(value.height) || (value.coordinateSpace !== "physical" && value.coordinateSpace !== "logical" && value.coordinateSpace !== "reference")) {
    throw new OsworldBridgeClientError("BRIDGE_INVALID_RESULT", "OSWorld viewport is invalid");
  }
  return { width: value.width, height: value.height, coordinateSpace: value.coordinateSpace };
}

function parseCapabilities(value: unknown): OsworldBridgeCapabilities {
  if (!isRecord(value) || typeof value.screenshot !== "boolean" || typeof value.pointer !== "boolean" || typeof value.keyboard !== "boolean") {
    throw new OsworldBridgeClientError("BRIDGE_INVALID_RESULT", "OSWorld capabilities are invalid");
  }
  return { screenshot: value.screenshot, pointer: value.pointer, keyboard: value.keyboard };
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  return normalized === "127.0.0.1" || normalized === "localhost" || normalized === "::1";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
