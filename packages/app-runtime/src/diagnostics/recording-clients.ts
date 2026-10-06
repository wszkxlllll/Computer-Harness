import { appendFile } from "node:fs/promises";
import { FetchGlmHttpClient, type GlmHttpClient, type GlmHttpDiagnostics, type GlmTransportEvidence } from "@computer-harness/provider-glm";
import { FetchQwenHttpClient, type QwenHttpClient, type Qwen38OutputMode, type Qwen38ThinkingMode, type QwenCoordinateMode } from "@computer-harness/provider-qwen";
import {
  providerRequestToolProjection,
  providerRequestRequiresStructuredContent,
  summarizeProviderResponse,
  summarizeTransportError,
  trustedProviderModel,
} from "./provider-summary.js";

export class RecordingGlmHttpClient implements GlmHttpClient {
  private readonly inner: GlmHttpClient;
  private requestNumber = 0;

  public constructor(private readonly path: string, inner: GlmHttpClient = new FetchGlmHttpClient()) {
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
        provider: "glm",
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
      await appendGlmRecord(this.path, {
        provider: "glm",
        request: requestNumber,
        latencyMs: Date.now() - startedAt,
        ...correlation,
        ...(preparedEstimate === undefined ? {} : { preparedEstimate }),
        httpEvidence: transportEvidence.length === 0 ? { source: "unavailable", stages: [] } : { source: "fetch", stages: transportEvidence },
        requestedModel: trustedModel,
        transportError: summarizeTransportError(error),
      });
      throw error;
    }
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
    this.requestNumber += 1;
    const startedAt = Date.now();
    const trustedModel = trustedProviderModel(body.model);
    const requestTools = providerRequestToolProjection(body);
    try {
      const response = await this.inner.post(url, body, headers, signal);
      await appendFile(this.path, `${JSON.stringify({
        provider: "qwen",
        request: this.requestNumber,
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
      })}\n`, "utf8");
      return response;
    } catch (error) {
      await appendFile(this.path, `${JSON.stringify({
        provider: "qwen",
        request: this.requestNumber,
        latencyMs: Date.now() - startedAt,
        requestedModel: trustedModel,
        coordinateMode: this.coordinateMode,
        thinkingMode: this.thinkingMode ?? null,
        outputMode: this.outputMode,
        transportError: summarizeTransportError(error),
      })}\n`, "utf8");
      throw error;
    }
  }
}
