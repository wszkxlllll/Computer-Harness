import { appendFile } from "node:fs/promises";
import { FetchArkHttpClient, FetchGlmHttpClient, FetchDeepseekHttpClient, type ArkHttpClient, type DeepseekHttpClient, type GlmHttpClient, type GlmHttpDiagnostics, type GlmTransportEvidence } from "@computer-harness/provider-glm";
import { FetchQwenHttpClient, type QwenHttpClient, type Qwen38OutputMode, type Qwen38ThinkingMode, type QwenCoordinateMode } from "@computer-harness/provider-qwen";
import {
  providerRequestToolProjection,
  providerRequestRequiresStructuredContent,
  summarizeProviderResponse,
  summarizeTransportError,
  trustedProviderModel,
} from "./provider-summary.js";

class RecordingChatCompletionsHttpClient implements GlmHttpClient {
  private readonly inner: GlmHttpClient;
  private requestNumber = 0;

  public constructor(private readonly path: string, inner: GlmHttpClient = new FetchGlmHttpClient(), private readonly provider: "glm" | "deepseek" | "ark" = "glm") {
    this.inner = inner;
  }

  public async post(url: string, body: Record<string, unknown>, headers: Readonly<Record<string, string>>, signal: AbortSignal, diagnostics?: GlmHttpDiagnostics): Promise<unknown> {
    const requestNumber = ++this.requestNumber;
    const startedAt = Date.now();
    const transportEvidence: Array<Record<string, unknown>> = [];
    const trustedModel = trustedProviderModel(body.model);
    const requestTools = providerRequestToolProjection(body);
    const correlation = safeGlmCorrelation(diagnostics);
    const forwardedDiagnostics: GlmHttpDiagnostics | undefined = diagnostics === undefined ? undefined : {
      ...diagnostics,
      onTransportEvidence: (evidence) => {
        try {
          const safe = projectTransportEvidence(evidence);
          if (safe !== undefined && transportEvidence.length < 8) transportEvidence.push(safe);
        } catch { /* malformed diagnostic evidence is discarded */ }
        try { diagnostics.onTransportEvidence?.(evidence); } catch { /* diagnostic observers cannot affect transport */ }
      },
    };
    const preparedEstimate = safePreparedEstimate(diagnostics);
    try {
      const response = await this.inner.post(url, body, headers, signal, forwardedDiagnostics);
      await appendGlmRecord(this.path, {
        provider: this.provider,
        request: requestNumber,
        latencyMs: Date.now() - startedAt,
        ...correlation,
        ...(preparedEstimate === undefined ? {} : { preparedEstimate }),
        httpEvidence: transportEvidence.length === 0 ? { source: "unavailable", stages: [] } : { source: "fetch", stages: transportEvidence },
        requestedModel: trustedModel,
        toolNames: requestTools.toolNames,
        response: summarizeProviderResponse(response, {
          allowedToolNames: requestTools.allowedToolNames,
          structuredContentExpected: providerRequestRequiresStructuredContent(body),
          ...(trustedModel === null ? {} : { trustedModel }),
        }),
      });
      return response;
    } catch (error) {
      const arkHttpFailure = this.provider === "ark" ? projectArkHttpFailure(error) : undefined;
      await appendGlmRecord(this.path, {
        provider: this.provider,
        request: requestNumber,
        latencyMs: Date.now() - startedAt,
        ...correlation,
        ...(preparedEstimate === undefined ? {} : { preparedEstimate }),
        httpEvidence: transportEvidence.length === 0 ? { source: "unavailable", stages: [] } : { source: "fetch", stages: transportEvidence },
        requestedModel: trustedModel,
        transportError: {
          ...summarizeTransportError(error),
          ...(arkHttpFailure === undefined ? {} : { httpFailure: arkHttpFailure }),
        },
      });
      throw error;
    }
  }
}

function projectArkHttpFailure(error: unknown): Record<string, unknown> | undefined {
  try {
    if (typeof error !== "object" || error === null || (error as { name?: unknown }).name !== "ArkProviderError") return undefined;
    const rawFailure = (error as { httpFailure?: unknown }).httpFailure;
    if (typeof rawFailure !== "object" || rawFailure === null || Array.isArray(rawFailure)) return undefined;
    const failure = rawFailure as Record<string, unknown>;
    const retryAfterState = failure.retryAfterState;
    if (failure.httpStatus !== 429 ||
        (retryAfterState !== "absent" && retryAfterState !== "invalid" && retryAfterState !== "accepted" && retryAfterState !== "too_long")) return undefined;
    const providerErrorCode = safeArkProviderCode(failure.providerErrorCode);
    const providerErrorMessage = safeArkProviderMessage(failure.providerErrorMessage);
    const retryAfterMs = Number.isSafeInteger(failure.retryAfterMs) && (failure.retryAfterMs as number) >= 0 && (failure.retryAfterMs as number) <= 120_000
      ? failure.retryAfterMs as number
      : undefined;
    return {
      httpStatus: 429,
      ...(providerErrorCode === undefined ? {} : { providerErrorCode }),
      ...(providerErrorMessage === undefined ? {} : { providerErrorMessage }),
      retryAfterState,
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    };
  } catch { return undefined; }
}

function safeArkProviderCode(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length < 1 || value.length > 64 || !/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/u.test(value)) return undefined;
  if (/[A-Za-z0-9]{24,}/u.test(value)) return undefined;
  return value;
}

function safeArkProviderMessage(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length < 1 || value.length > 240 ||
      !/^[\p{L}\p{N} .,;:!?()'’_-]+$/u.test(value) ||
      /\b(?:https?|bearer|authorization|api[ _-]*key|access[ _-]*token|secret|credential)\b/iu.test(value) ||
      /\b[A-Za-z0-9_-]{24,}\b/u.test(value)) return undefined;
  return value;
}

export class RecordingGlmHttpClient extends RecordingChatCompletionsHttpClient {}

export class RecordingDeepseekHttpClient extends RecordingChatCompletionsHttpClient {
  public constructor(path: string, inner: DeepseekHttpClient = new FetchDeepseekHttpClient()) {
    super(path, inner, "deepseek");
  }
}

export class RecordingArkHttpClient extends RecordingChatCompletionsHttpClient {
  public constructor(path: string, inner: ArkHttpClient = new FetchArkHttpClient()) {
    super(path, inner, "ark");
  }
}

async function appendGlmRecord(path: string, record: Record<string, unknown>): Promise<void> {
  try { await appendFile(path, `${JSON.stringify(record)}\n`, "utf8"); } catch { /* log failure cannot change a completed/failed request */ }
}

function safeGlmCorrelation(context: GlmHttpDiagnostics | undefined): Record<string, unknown> {
  if (typeof context !== "object" || context === null) return { correlation: "unavailable" };
  const safeId = (value: unknown): string | undefined => typeof value === "string" && value.length <= 128 && /^[a-zA-Z0-9:_-]+$/u.test(value) ? value : undefined;
  const runId = safeId(context.runId);
  const requestId = safeId(context.requestId);
  const decisionId = safeId(context.decisionId);
  const attempt = Number.isSafeInteger(context.attempt) && (context.attempt ?? 0) > 0 ? context.attempt : undefined;
  const payloadHash = typeof context.payloadHash === "string" && /^[a-f0-9]{64}$/u.test(context.payloadHash) ? context.payloadHash : undefined;
  return {
    correlation: runId !== undefined && requestId !== undefined && decisionId !== undefined && attempt !== undefined && payloadHash !== undefined ? "complete" : "partial",
    ...(runId === undefined ? {} : { runId }),
    ...(requestId === undefined ? {} : { requestId }),
    ...(decisionId === undefined ? {} : { decisionId }),
    ...(attempt === undefined ? {} : { attempt }),
    ...(payloadHash === undefined ? {} : { payloadHash }),
  };
}

function safePreparedEstimate(context: GlmHttpDiagnostics | undefined): Record<string, number | string> | undefined {
  try {
    if (typeof context !== "object" || context === null || typeof context.estimate !== "object" || context.estimate === null || Array.isArray(context.estimate)) return undefined;
    const estimate = context.estimate;
    const required = [estimate.estimatedTextTokens, estimate.imageCount];
    const optional = [estimate.estimatedVisualTokens, estimate.estimatedEnvelopeTokens, estimate.estimatedTotalTokens];
    if (required.some((value) => !Number.isSafeInteger(value) || value < 0) ||
        optional.some((value) => value !== undefined && (!Number.isSafeInteger(value) || value < 0)) ||
        (estimate.estimationMethod !== "context_report" && estimate.estimationMethod !== "provider_projection")) return undefined;
    return {
      estimatedTextTokens: estimate.estimatedTextTokens,
      ...(estimate.estimatedVisualTokens === undefined ? {} : { estimatedVisualTokens: estimate.estimatedVisualTokens }),
      ...(estimate.estimatedEnvelopeTokens === undefined ? {} : { estimatedEnvelopeTokens: estimate.estimatedEnvelopeTokens }),
      ...(estimate.estimatedTotalTokens === undefined ? {} : { estimatedTotalTokens: estimate.estimatedTotalTokens }),
      imageCount: estimate.imageCount,
      estimationMethod: estimate.estimationMethod,
    };
  } catch { return undefined; }
}

function projectTransportEvidence(value: GlmTransportEvidence): Record<string, unknown> | undefined {
  if (!["fetch_invoked", "headers_received", "body_received", "fetch_failed", "body_failed"].includes(value.stage) ||
      !["pending", "success", "http_error", "network_error", "timeout", "cancelled"].includes(value.outcome) ||
      !["before_fetch", "awaiting_headers", "reading_body", "complete"].includes(value.phase) ||
      !Number.isSafeInteger(value.elapsedMs) || value.elapsedMs < 0 ||
      (value.httpStatus !== undefined && (!Number.isSafeInteger(value.httpStatus) || value.httpStatus < 100 || value.httpStatus > 599))) return undefined;
  return {
    stage: value.stage,
    outcome: value.outcome,
    phase: value.phase,
    elapsedMs: value.elapsedMs,
    ...(value.httpStatus === undefined ? {} : { httpStatus: value.httpStatus }),
    ...(Number.isSafeInteger(value.deadlineMs) && value.deadlineMs! > 0 && value.deadlineMs! <= 240_000 ? { deadlineMs: value.deadlineMs } : {}),
    ...(Number.isSafeInteger(value.serializedBodyBytes) && value.serializedBodyBytes! >= 0 && value.serializedBodyBytes! <= 512 * 1024 * 1024 ? { serializedBodyBytes: value.serializedBodyBytes } : {}),
    ...(value.abortSource === "local_request_timeout" || value.abortSource === "run_cancelled" ? { abortSource: value.abortSource } : {}),
    ...(isSafeGlmRequestConfiguration(value.requestConfiguration) ? { requestConfiguration: projectGlmRequestConfiguration(value.requestConfiguration) } : {}),
  };
}

function isSafeGlmRequestConfiguration(value: unknown): value is NonNullable<GlmTransportEvidence["requestConfiguration"]> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (record.stream === undefined || record.stream === false)
    && (record.thinking === undefined || record.thinking === "disabled" || record.thinking === "enabled")
    && (record.reasoningEffort === undefined || record.reasoningEffort === "low" || record.reasoningEffort === "high" || record.reasoningEffort === "max" || record.reasoningEffort === "server_default")
    && (record.maxTokens === undefined || (Number.isSafeInteger(record.maxTokens) && (record.maxTokens as number) >= 1 && (record.maxTokens as number) <= 131_072))
    && [record.messageCount, record.toolCount, record.imageCount].every((count) => count === undefined || (typeof count === "number" && Number.isSafeInteger(count) && count >= 0 && count <= 100_000));
}

function projectGlmRequestConfiguration(value: NonNullable<GlmTransportEvidence["requestConfiguration"]>): Record<string, unknown> {
  return {
    ...(value.stream === undefined ? {} : { stream: value.stream }),
    ...(value.thinking === undefined ? {} : { thinking: value.thinking }),
    ...(value.reasoningEffort === undefined ? {} : { reasoningEffort: value.reasoningEffort }),
    ...(value.maxTokens === undefined ? {} : { maxTokens: value.maxTokens }),
    ...(value.messageCount === undefined ? {} : { messageCount: value.messageCount }),
    ...(value.toolCount === undefined ? {} : { toolCount: value.toolCount }),
    ...(value.imageCount === undefined ? {} : { imageCount: value.imageCount }),
  };
}

export class RecordingQwenHttpClient implements QwenHttpClient {
  private readonly inner: QwenHttpClient;
  private requestNumber = 0;

  public constructor(
    private readonly path: string,
    private readonly coordinateMode: QwenCoordinateMode,
    private readonly thinkingMode?: Qwen38ThinkingMode,
    private readonly outputMode: Qwen38OutputMode = "strict_json",
    inner: QwenHttpClient = new FetchQwenHttpClient(),
  ) {
    this.inner = inner;
  }

  public async post(url: string, body: Record<string, unknown>, headers: Readonly<Record<string, string>>, signal: AbortSignal): Promise<unknown> {
    const requestNumber = ++this.requestNumber;
    const startedAt = Date.now();
    try {
      const response = await this.inner.post(url, body, headers, signal);
      await this.recordSafely(() => {
        const trustedModel = trustedProviderModel(body.model);
        const requestTools = providerRequestToolProjection(body);
        return {
          provider: "qwen",
          request: requestNumber,
          latencyMs: Date.now() - startedAt,
          requestedModel: trustedModel,
          coordinateMode: this.coordinateMode,
          thinkingMode: this.thinkingMode ?? null,
          outputMode: this.outputMode,
          toolNames: requestTools.toolNames,
          response: summarizeProviderResponse(response, {
            allowedToolNames: requestTools.allowedToolNames,
            structuredContentExpected: providerRequestRequiresStructuredContent(body),
            ...(trustedModel === null ? {} : { trustedModel }),
          }),
        };
      });
      return response;
    } catch (error) {
      await this.recordSafely(() => {
        const trustedModel = safeQwenDiagnostic(() => trustedProviderModel(body.model));
        return {
          provider: "qwen",
          request: requestNumber,
          latencyMs: Date.now() - startedAt,
          requestedModel: trustedModel ?? null,
          coordinateMode: this.coordinateMode,
          thinkingMode: this.thinkingMode ?? null,
          outputMode: this.outputMode,
          transportError: summarizeTransportError(error),
        };
      });
      throw error;
    }
  }

  private async recordSafely(project: () => Record<string, unknown>): Promise<void> {
    try { await appendFile(this.path, `${JSON.stringify(project())}\n`, "utf8"); } catch { /* optional diagnostics cannot change the provider outcome */ }
  }
}

function safeQwenDiagnostic<T>(project: () => T): T | undefined {
  try { return project(); } catch { return undefined; }
}
