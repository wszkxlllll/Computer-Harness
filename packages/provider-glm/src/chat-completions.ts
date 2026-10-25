import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import type {
  JsonValue,
  ModelUsage,
  ModelTurn,
  ObservationAssessment,
  SourceLinkedFinishReport,
  ToolCall,
  ToolCallId,
  Viewport,
  ModelContinuation,
} from "@computer-harness/protocol";
import type {
  AssetReader,
  ModelContentBlock,
  ModelInput,
  ModelMessage,
  ModelToolSpec,
  ProviderAdapter,
  ProviderRequestContext,
  PreparedProviderRequest,
  ControlKind,
  CoordinateField,
} from "@computer-harness/runtime";
import {
  encodeToolCallArguments,
  HARNESS_EFFECT_KEY,
  isActionableFinishSummary,
  OBSERVATION_ASSESSMENT_GUIDANCE,
  splitActionEffectArguments,
  splitObservationAssessment,
  toolRequiresActionEffect,
  withObservationAssessmentSchema,
} from "@computer-harness/runtime";

export type GlmCoordinateMode = "normalized_1000" | "actual_pixels";
export type GlmThinkingMode = "disabled" | "enabled" | "low" | "high" | "max";

export type GlmProfileName = "glm-5.3-flash";

export interface GlmProfile {
  /** Provider model id; custom profiles may use another id explicitly. */
  readonly name: string;
  readonly thinking: GlmThinkingMode;
  readonly coordinateMode: GlmCoordinateMode;
  /** Bound the model's completion/reasoning output so one GUI turn cannot monopolize the live-run deadline. */
  readonly maxOutputTokens?: number;
}

export const glmProfiles: Readonly<Record<GlmProfileName, GlmProfile>> = {
  "glm-5.3-flash": {
    name: "glm-5.3-flash",
    thinking: "enabled",
    coordinateMode: "actual_pixels",
    maxOutputTokens: 8192,
  },
};

export interface GlmHttpClient {
  post(url: string, body: Record<string, unknown>, headers: Readonly<Record<string, string>>, signal: AbortSignal, diagnostics?: GlmHttpDiagnostics): Promise<unknown>;
}

export type GlmTransportStage = "fetch_invoked" | "headers_received" | "body_received" | "fetch_failed" | "body_failed";
export type GlmTransportOutcome = "pending" | "success" | "http_error" | "network_error" | "timeout" | "cancelled";
export type GlmAbortSource = "local_request_timeout" | "run_cancelled";
export interface GlmRequestConfiguration {
  readonly stream?: false;
  readonly thinking?: "disabled" | "enabled";
  readonly reasoningEffort?: "low" | "high" | "max" | "server_default";
  readonly maxTokens?: number;
  readonly messageCount?: number;
  readonly toolCount?: number;
  readonly imageCount?: number;
}
export interface GlmTransportEvidence {
  readonly stage: GlmTransportStage;
  readonly outcome: GlmTransportOutcome;
  readonly phase: "before_fetch" | "awaiting_headers" | "reading_body" | "complete";
  readonly elapsedMs: number;
  readonly httpStatus?: number;
  readonly deadlineMs?: number;
  readonly serializedBodyBytes?: number;
  readonly abortSource?: GlmAbortSource;
  readonly requestConfiguration?: GlmRequestConfiguration;
}
export interface GlmHttpDiagnostics {
  readonly runId?: string;
  readonly requestId?: string;
  readonly decisionId?: string;
  readonly attempt?: number;
  readonly payloadHash: string;
  readonly estimate?: PreparedProviderRequest["estimate"];
  readonly onTransportEvidence?: (evidence: GlmTransportEvidence) => void;
}

export type GlmRetryMode = "same_input" | "feedback";

export interface FetchGlmHttpClientOptions {
  /** Maximum wall-clock time for fetch plus response-body consumption. */
  readonly requestTimeoutMs?: number;
}

export interface GlmAdapterOptions {
  apiKey: string;
  profile: GlmProfileName | GlmProfile;
  assetReader: AssetReader;
  endpoint?: string;
  httpClient?: GlmHttpClient;
  /** Full-frame, aspect-preserving presentation only; canonical observations remain unchanged. */
  imagePresentation?: {
    readonly maxEdge: number;
    readonly resizePng: (bytes: Uint8Array, source: Viewport, presented: Viewport, signal: AbortSignal) => Uint8Array;
  };
}

export type GlmRecoveryHint =
  | { readonly kind: "ambiguous-headers-timeout-v1"; readonly phase: "awaiting_headers"; readonly abortSource: "local_request_timeout"; readonly noResponse: true; readonly remoteOutcome: "unknown" }
  | { readonly kind: "ambiguous-headers-transport-v1"; readonly phase: "awaiting_headers"; readonly abortSource: "transport_failure"; readonly noResponse: true; readonly transportCode: "ETIMEDOUT"; readonly remoteOutcome: "unknown" };

export class GlmProviderError extends Error {
  public constructor(
    message: string,
    public readonly code = "GLM_PROVIDER_ERROR",
    public readonly retryable = isRetryableGlmErrorCode(code),
    public readonly retryMode: GlmRetryMode = "feedback",
    public readonly recoveryHint?: GlmRecoveryHint,
  ) {
    super(message);
    this.name = "GlmProviderError";
  }
}

/** Internal shared OpenAI-compatible projection and transport boundary. */
export interface ChatCompletionsBoundary {
  readonly label: string;
  readonly errorCodePrefix: string;
  readonly endpoint: string;
  readonly requestTimeoutMs: number;
  readonly maxOutputTokens: number;
  readonly userImagesOnly?: boolean;
  readonly strictResponse?: boolean;
  /** Provider-specific wire shape for cache-read usage; unrelated to strict response parsing. */
  readonly cacheUsageFormat?: "flat-prompt-cache" | "nested-prompt-details";
  /** Whether protocol-shape errors from a complete strict Provider response may use Runtime feedback retry. */
  readonly strictResponseRetryable?: boolean;
  /** Optional provider-specific projection for selected HTTP failures; omitted preserves the status-only strict boundary. */
  readonly httpError?: (failure: ChatCompletionsHttpFailure) => Error | undefined;
  readonly error: (message: string, code?: string, retryable?: boolean, retryMode?: GlmRetryMode, recoveryHint?: GlmRecoveryHint) => Error;
  readonly isProviderError: (error: unknown) => boolean;
}

export interface ChatCompletionsHttpFailure {
  readonly status: number;
  readonly payload: unknown;
  readonly retryAfterHeader: string | null;
}

const glmBoundary: ChatCompletionsBoundary = {
  label: "GLM",
  errorCodePrefix: "GLM",
  endpoint: "https://open.bigmodel.cn/api/paas/v4/chat/completions",
  requestTimeoutMs: 240_000,
  maxOutputTokens: 8192,
  error: (message, code, retryable, retryMode, recoveryHint) => new GlmProviderError(message, code, retryable, retryMode, recoveryHint),
  isProviderError: (error) => error instanceof GlmProviderError,
};

function providerError(boundary: ChatCompletionsBoundary, message: string, code?: string, retryable?: boolean, retryMode?: GlmRetryMode, recoveryHint?: GlmRecoveryHint): Error {
  return boundary.error(message.replace(/\bGLM\b/gu, boundary.label), code?.replace(/^GLM_/u, `${boundary.errorCodePrefix}_`), retryable, retryMode, boundary === glmBoundary ? recoveryHint : undefined);
}

export class ChatCompletionsAdapter implements ProviderAdapter {
  public readonly id: string;
  private readonly profile: GlmProfile;
  private readonly assetReader: AssetReader;
  private readonly endpoint: string;
  private readonly apiKey: string;
  private readonly httpClient: GlmHttpClient;
  private readonly imagePresentation: GlmAdapterOptions["imagePresentation"];
  private readonly preparedRequests = new WeakMap<PreparedProviderRequest, { body: Record<string, unknown>; input: ModelInput; sourceInput: ModelInput }>();

  public constructor(options: GlmAdapterOptions, private readonly boundary: ChatCompletionsBoundary = glmBoundary) {
    if (options.apiKey.trim().length === 0) {
      throw new Error(`${boundary.label} apiKey must be non-empty`);
    }
    const profile = typeof options.profile === "string" ? glmProfiles[options.profile] : options.profile;
    const maxOutputTokens = profile.maxOutputTokens ?? boundary.maxOutputTokens;
    if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > 131072) throw new Error(`${boundary.label} maxOutputTokens must be a positive integer no greater than 131072`);
    if (!["disabled", "enabled", "low", "high", "max"].includes(profile.thinking)) throw new Error(`${boundary.label} thinking mode is invalid`);
    this.profile = Object.freeze({ ...profile, maxOutputTokens });
    this.id = this.profile.name;
    this.assetReader = options.assetReader;
    this.endpoint = options.endpoint ?? boundary.endpoint;
    this.apiKey = options.apiKey;
    this.httpClient = options.httpClient ?? new FetchChatCompletionsHttpClient({}, boundary);
    if (options.imagePresentation !== undefined && (!Number.isSafeInteger(options.imagePresentation.maxEdge)
      || options.imagePresentation.maxEdge < 320 || options.imagePresentation.maxEdge > 4096)) {
      throw new Error("GLM image presentation maxEdge must be an integer from 320 to 4096");
    }
    this.imagePresentation = options.imagePresentation;
  }

  public async generate(input: ModelInput, options: { signal: AbortSignal; requestContext?: ProviderRequestContext }): Promise<ModelTurn> {
    const prepared = await this.prepare(input, options);
    return this.generatePrepared(prepared, options);
  }

  public async prepare(input: ModelInput, options: { signal: AbortSignal; requestContext?: ProviderRequestContext }): Promise<PreparedProviderRequest> {
    const boundary = this.boundary;
    options.signal.throwIfAborted();
    const sourceInput = structuredClone(input);
    const snapshot = this.imagePresentation === undefined ? sourceInput : projectImageCoordinates(sourceInput, this.imagePresentation.maxEdge);
    const body = {
      model: this.profile.name,
      messages: await this.presentMessages(`${snapshot.system}\n${profilePrompt(this.profile, boundary)}\n${OBSERVATION_ASSESSMENT_GUIDANCE}`, snapshot.messages, snapshot.tools, options.signal, sourceInput),
      tools: snapshot.tools.map((tool) => toGlmTool(tool, this.profile, latestViewport(snapshot))),
      stream: false,
      thinking: { type: this.profile.thinking === "disabled" ? "disabled" : "enabled" },
      ...(["low", "high", "max"].includes(this.profile.thinking)
        ? { reasoning_effort: this.profile.thinking }
        : {}),
      max_tokens: this.profile.maxOutputTokens,
    } satisfies Record<string, unknown>;
    assertInputBudget(snapshot, body, boundary.label, boundary);
    const frozenBody = deepFreeze(body);
    const prepared: PreparedProviderRequest = Object.freeze({
      providerId: this.id,
      payloadHash: createHash("sha256").update(JSON.stringify(frozenBody)).digest("hex"),
      estimate: Object.freeze({
        estimatedTextTokens: estimateWireTextTokens(frozenBody),
        estimatedVisualTokens: estimateVisualTokens(snapshot),
        estimatedEnvelopeTokens: 32,
        estimatedTotalTokens: estimateWireTextTokens(frozenBody) + estimateVisualTokens(snapshot) + 32,
        imageCount: countImages(snapshot),
        estimationMethod: "provider_projection",
      } as const),
    });
    this.preparedRequests.set(prepared, { body: frozenBody, input: snapshot, sourceInput });
    return prepared;
  }

  public async generatePrepared(prepared: PreparedProviderRequest, options: { signal: AbortSignal; requestContext?: ProviderRequestContext }): Promise<ModelTurn> {
    const boundary = this.boundary;
    options.signal.throwIfAborted();
    if (prepared.providerId !== this.id || !Object.isFrozen(prepared)) {
      throw providerError(boundary, "GLM prepared request metadata is invalid", "GLM_INVALID_PREPARED_REQUEST");
    }
    const state = this.preparedRequests.get(prepared);
    if (state === undefined) {
      throw providerError(boundary, "GLM prepared request was not created by this adapter", "GLM_INVALID_PREPARED_REQUEST");
    }
    const response = await this.httpClient.post(
      this.endpoint,
      state.body,
      { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
      options.signal,
      {
        ...(options.requestContext ?? {}),
        payloadHash: prepared.payloadHash,
        ...(prepared.estimate === undefined ? {} : { estimate: prepared.estimate }),
      },
    );
    options.signal.throwIfAborted();
    const turn = this.parseResponse(response, state.input);
    return this.imagePresentation === undefined ? turn : restoreImageCoordinates(turn, state.input, state.sourceInput);
  }

  private async presentMessages(system: string, messages: readonly ModelMessage[], tools: readonly ModelToolSpec[], signal: AbortSignal, sourceInput: ModelInput): Promise<unknown[]> {
    const boundary = this.boundary;
    const result: unknown[] = [{ role: "system", content: system }];
    for (const message of messages) {
      signal.throwIfAborted();
      if (boundary.userImagesOnly && message.role !== "user" && message.content.some((block) => block.type === "image")) {
        throw providerError(boundary, "GLM images are supported only in user messages", "GLM_INVALID_HISTORY", false);
      }
      if (boundary.strictResponse && message.role !== "assistant" && message.content.some((block) => block.type === "tool_call")) {
        throw providerError(boundary, "GLM tool calls require assistant history messages", "GLM_INVALID_HISTORY", false);
      }
      if (message.role === "tool") {
        if (boundary.strictResponse) {
          const results = message.content.filter((block): block is Extract<ModelContentBlock, { type: "tool_result" }> => block.type === "tool_result");
          if (results.length === 0) throw providerError(boundary, "GLM tool history requires a tool result", "GLM_INVALID_HISTORY", false);
          for (const block of results) {
            result.push({ role: "tool", tool_call_id: block.result.callId, content: JSON.stringify(block.result) });
          }
          continue;
        }
        const resultBlock = message.content.find((block) => block.type === "tool_result");
        if (resultBlock?.type === "tool_result") {
          result.push({ role: "tool", tool_call_id: resultBlock.result.callId, content: JSON.stringify(resultBlock.result) });
        }
        continue;
      }
      const content: unknown[] = [];
      const toolCalls: unknown[] = [];
      let reasoningContent: string | undefined;
      for (const block of message.content) {
        if (block.type === "text") {
          content.push({ type: "text", text: block.text });
        } else if (block.type === "image") {
          let bytes = await this.assetReader.read(block.asset, signal);
          if (this.imagePresentation !== undefined) {
            const source = sourceInput.messages.flatMap((item) => item.content).find((item) => item.type === "image" && item.asset.assetId === block.asset.assetId);
            if (source?.type !== "image" || block.asset.mediaType !== "image/png") {
              throw providerError(boundary, "GLM image presentation requires a matching PNG observation", "GLM_INVALID_IMAGE", false);
            }
            bytes = this.imagePresentation.resizePng(bytes, source.viewport, block.viewport, signal);
            content.push({ type: "text", text: `Provider image coordinate contract: this complete, uncropped screenshot is ${block.viewport.width}x${block.viewport.height} pixels. Its top-left is (0,0); x increases right and y increases down. For pixel tools use ONLY these displayed-image pixels, not the original capture dimensions or macOS points mentioned in metadata or receipts. Do not subtract window/browser offsets or scale coordinates yourself; the adapter performs the conversion. Locate the current control center anew.` });
          }
          content.push({ type: "image_url", image_url: { url: toDataUrl(block.asset.mediaType, bytes) } });
        } else if (block.type === "provider_continuation") {
          // A disabled-thinking live profile must not replay prior hidden
          // reasoning into every subsequent request.  Some GLM deployments
          // still return reasoning_content despite the disabled flag; keeping
          // it would silently grow the next prompt and worsen latency.
          if (this.profile.thinking === "disabled") continue;
          if (block.continuation.providerId !== this.id || block.continuation.kind !== "reasoning_content") continue;
          if (reasoningContent !== undefined && reasoningContent !== block.continuation.content) {
            throw providerError(boundary, "GLM history contains conflicting reasoning continuations", "GLM_INVALID_HISTORY");
          }
          reasoningContent = block.continuation.content;
        } else if (block.type === "tool_call") {
          const tool = tools.find((item) => item.name === block.call.name);
          const historyArguments = encodeToolCallArguments(tool, block.call);
          toolCalls.push({
            id: block.call.id,
            type: "function",
            function: {
              name: block.call.name,
              arguments: JSON.stringify(encodeCoordinates({ ...block.call, arguments: historyArguments }, block.viewport, this.profile.coordinateMode, tool?.coordinate?.fields)),
            },
          });
        }
      }
      const presented: Record<string, unknown> = {
        role: message.role,
        content: boundary.strictResponse && message.role === "assistant"
          ? message.content.filter((block): block is Extract<ModelContentBlock, { type: "text" }> => block.type === "text").map((block) => block.text).join("\n") || null
          : content,
      };
      if (reasoningContent !== undefined) {
        presented.reasoning_content = reasoningContent;
      }
      if (toolCalls.length > 0) {
        presented.tool_calls = toolCalls;
      }
      result.push(presented);
    }
    return result;
  }

  private parseResponse(value: unknown, input: ModelInput): ModelTurn {
    const boundary = this.boundary;
    const response = readResponse(value, boundary);
    assertCompleteFinishReason(response.finishReason, this.profile, boundary, response.usage, response.reasoningTokens);
    const message = response.message;
    if (boundary.strictResponse && response.finishReason === "tool_calls" &&
        (!Array.isArray(message.tool_calls) || message.tool_calls.length === 0)) {
      throw providerError(boundary, "GLM tool_calls finish reason requires tool calls", "GLM_INVALID_RESPONSE", boundary.strictResponseRetryable ?? false);
    }
    const usage = response.usage;
    const rawToolCalls = message.tool_calls;
    if (rawToolCalls !== undefined) {
      if (!Array.isArray(rawToolCalls) || rawToolCalls.length === 0) {
        throw providerError(boundary, "GLM returned an invalid tool_calls value", "GLM_INVALID_RESPONSE");
      }
      const ids = new Set<string>();
      const calls: ToolCall[] = [];
      let observationAssessment: ObservationAssessment | undefined;
      let assessmentSupplied = false;
      let controlTurn: ModelTurn | undefined;
      for (const raw of rawToolCalls) {
        const parsed = readToolCall(raw, boundary);
        if (ids.has(parsed.id)) {
          throw providerError(boundary, boundary.strictResponse ? "GLM returned duplicate ToolCall ids" : `GLM returned duplicate ToolCall id: ${parsed.id}`, "GLM_DUPLICATE_TOOL_CALL");
        }
        ids.add(parsed.id);
        const assessmentParts = splitObservationAssessment(parsed.arguments);
        if (assessmentParts.supplied) {
          if (assessmentSupplied) observationAssessment = undefined;
          else observationAssessment = assessmentParts.observationAssessment;
          assessmentSupplied = true;
        }
        if (!input.tools.some((tool) => tool.name === parsed.name)) {
          throw providerError(boundary, boundary.strictResponse ? "GLM selected a tool not offered by this run" : `GLM selected a tool not offered by this run: ${parsed.name}`, "GLM_UNAVAILABLE_TOOL");
        }
        const tool = input.tools.find((item) => item.name === parsed.name);
        if (tool?.control !== undefined) {
          if (calls.length > 0 || rawToolCalls.length !== 1) {
            throw providerError(boundary, "GLM control calls cannot be mixed with other tool calls", "GLM_INVALID_TOOL_CALL");
          }
          controlTurn = mapControlCall(tool.control, assessmentParts.arguments, parsed.name, boundary);
          continue;
        }
        let separated: ReturnType<typeof splitActionEffectArguments>;
        try {
          separated = splitActionEffectArguments(tool, assessmentParts.arguments);
        } catch (error) {
          throw providerError(boundary, boundary.strictResponse ? "GLM action effect is invalid" : `GLM action effect is invalid: ${error instanceof Error ? error.message : String(error)}`, "GLM_INVALID_TOOL_CALL");
        }
        const mapped = mapCoordinates({ ...parsed, arguments: separated.arguments }, latestViewport(input), this.profile.coordinateMode, tool?.coordinate?.fields, boundary);
        calls.push({ ...mapped, ...(separated.declaredEffect === undefined ? {} : { declaredEffect: separated.declaredEffect }) });
      }
      if (controlTurn !== undefined) {
        return {
          ...controlTurn,
          ...(observationAssessment === undefined ? {} : { observationAssessment }),
          ...(usage === undefined ? {} : { usage }),
        };
      }
      const assistantText = typeof message.content === "string" && message.content.trim().length > 0
        ? message.content
        : undefined;
      const continuation = boundary.strictResponse && this.profile.thinking === "disabled"
        ? undefined
        : reasoningContinuation(message.reasoning_content, this.id, boundary);
      return assistantText === undefined
        ? { type: "tool_calls", calls, ...(observationAssessment === undefined ? {} : { observationAssessment }), ...(continuation === undefined ? {} : { continuation }), ...(usage === undefined ? {} : { usage }) }
        : { type: "tool_calls", calls, assistantText, ...(observationAssessment === undefined ? {} : { observationAssessment }), ...(continuation === undefined ? {} : { continuation }), ...(usage === undefined ? {} : { usage }) };
    }
    if (typeof message.content === "string" && message.content.trim().length > 0) {
      if (input.tools.some((tool) => tool.control === "finish")) {
        throw providerError(boundary, "GLM must use the exposed terminate control with explicit status success or failure and complete result text; plain text is not a terminal decision", "GLM_INVALID_TOOL_CALL");
      }
      if (message.reasoning_content !== undefined && typeof message.reasoning_content !== "string") {
        throw providerError(boundary, "GLM reasoning_content must be a string", "GLM_INVALID_RESPONSE");
      }
      return { type: "finish", summary: message.content, ...(usage === undefined ? {} : { usage }) };
    }
    throw providerError(boundary, "GLM returned an empty assistant response", "GLM_EMPTY_RESPONSE");
  }
}

export class GlmAdapter extends ChatCompletionsAdapter {}

export class FetchChatCompletionsHttpClient implements GlmHttpClient {
  private readonly requestTimeoutMs: number;

  public constructor(options: FetchGlmHttpClientOptions = {}, private readonly boundary: ChatCompletionsBoundary = glmBoundary) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? boundary.requestTimeoutMs;
    if (!Number.isInteger(this.requestTimeoutMs) || this.requestTimeoutMs <= 0) {
      throw new Error(`${boundary.label} requestTimeoutMs must be a positive integer`);
    }
  }

  public async post(
    url: string,
    body: Record<string, unknown>,
    headers: Readonly<Record<string, string>>,
    signal: AbortSignal,
    diagnostics?: GlmHttpDiagnostics,
  ): Promise<unknown> {
    const boundary = this.boundary;
    signal.throwIfAborted();
    const requestController = new AbortController();
    const startedAt = performance.now();
    const deadlineAt = startedAt + this.requestTimeoutMs;
    const elapsedMs = (): number => Math.max(0, Math.floor(performance.now() - startedAt));
    let firstAbortSource: GlmAbortSource | undefined;
    let firstAbortReason: unknown;
    let rejectAbort: (reason: unknown) => void = () => {};
    const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
    // Cancellation may happen synchronously during serialization or a fetch callback.
    // Keep the losing abort promise observed even before the first transport race.
    void aborted.catch(() => {});
    const recordFirstAbort = (source: GlmAbortSource, reason: unknown): void => {
      if (firstAbortSource !== undefined) return;
      firstAbortSource = source;
      firstAbortReason = reason;
      rejectAbort(reason);
      requestController.abort(reason);
    };
    const expireRequest = (): void => {
      const reason = new Error(`${boundary.label} request deadline exceeded after ${this.requestTimeoutMs}ms`);
      recordFirstAbort("local_request_timeout", reason);
    };
    const timeout = setTimeout(expireRequest, this.requestTimeoutMs);
    const abortRequest = () => {
      recordFirstAbort("run_cancelled", signal.reason);
    };
    if (signal.aborted) {
      abortRequest();
    } else {
      signal.addEventListener("abort", abortRequest, { once: true });
    }
    const emit = (evidence: GlmTransportEvidence): void => {
      try { diagnostics?.onTransportEvidence?.(evidence); } catch { /* diagnostics cannot affect transport */ }
    };
    const checkActive = (): void => {
      if (firstAbortSource === undefined && performance.now() >= deadlineAt) expireRequest();
      if (firstAbortSource !== undefined) throw firstAbortReason;
    };
    const awaitActive = async <T>(operation: () => Promise<T>): Promise<T> => {
      checkActive();
      const result = await Promise.race([operation(), aborted]);
      // A non-cooperative promise can settle after a blocked/delayed timer.
      // Logical expiry or the first cancellation still prevents late success.
      checkActive();
      return result;
    };
    let phase: "before_fetch" | "awaiting_headers" | "reading_body" = "before_fetch";
    let response: Response | undefined;
    let headersElapsedMs: number | undefined;
    try {
      checkActive();
      const serializedBody = JSON.stringify(body);
      checkActive();
      const serializedBodyBytes = new TextEncoder().encode(serializedBody).byteLength;
      const requestConfiguration = safeRequestConfiguration(serializedBody);
      checkActive();
      emit({
        stage: "fetch_invoked",
        outcome: "pending",
        phase: "awaiting_headers",
        elapsedMs: elapsedMs(),
        deadlineMs: this.requestTimeoutMs,
        serializedBodyBytes,
        ...(requestConfiguration === undefined ? {} : { requestConfiguration }),
      });
      // A diagnostics hook may have requested Run cancellation before dispatch.
      checkActive();
      phase = "awaiting_headers";
      response = await awaitActive(() => fetch(url, {
          method: "POST",
          headers,
          body: serializedBody,
          signal: requestController.signal,
      }));
      headersElapsedMs = elapsedMs();
      phase = "reading_body";
      emit({ stage: "headers_received", outcome: response.ok ? "pending" : "http_error", phase: "reading_body", elapsedMs: headersElapsedMs, httpStatus: response.status });
      const receivedResponse = response;
      const payload = await awaitActive(() => receivedResponse.json()) as unknown;
      emit({ stage: "body_received", outcome: response.ok ? "success" : "http_error", phase: "complete", elapsedMs: elapsedMs(), httpStatus: response.status });
      // Preserve the completed HTTP receipt, but do not return a usable result
      // if cancellation or logical expiry occurred during its callback.
      checkActive();
      if (!response.ok) {
        if (boundary.strictResponse) {
          const projectedError = boundary.httpError?.({
            status: response.status,
            payload,
            retryAfterHeader: response.headers.get("retry-after"),
          });
          if (projectedError !== undefined) throw projectedError;
          throw providerError(boundary, `GLM HTTP ${response.status}`, `GLM_HTTP_${response.status}`, false);
        }
        const code = readErrorCode(payload);
        const providerMessage = readErrorMessage(payload);
        const retryable = code === "1305" || response.status === 429 || response.status >= 500;
        throw providerError(boundary, `GLM HTTP ${response.status}${code === undefined ? "" : ` (${code})`}${providerMessage === undefined ? "" : `: ${sanitizeDiagnosticText(providerMessage)}`}`,
        code ?? `GLM_HTTP_${response.status}`,
        retryable,
        retryable ? "same_input" : "feedback",);
      }
      return payload;
    } catch (error) {
      // Also check logical expiry after a rejection, before classifying a network failure.
      if (firstAbortSource === undefined && performance.now() >= deadlineAt) expireRequest();
      const stage = phase === "reading_body" ? "body_failed" : "fetch_failed";
      const status = response === undefined ? {} : { httpStatus: response.status };
      if (firstAbortSource === "run_cancelled") {
        emit({ stage, outcome: "cancelled", phase, elapsedMs: elapsedMs(), deadlineMs: this.requestTimeoutMs, abortSource: firstAbortSource, ...status });
        throw firstAbortReason;
      }
      if (firstAbortSource === "local_request_timeout") {
        emit({ stage, outcome: "timeout", phase, elapsedMs: elapsedMs(), deadlineMs: this.requestTimeoutMs, abortSource: firstAbortSource, ...status });
        throw providerError(boundary, `GLM ${phase === "reading_body" ? "response body" : "request"} timed out after ${this.requestTimeoutMs}ms (phase=${phase} elapsedMs=${elapsedMs()} deadlineMs=${this.requestTimeoutMs}${response === undefined ? "" : ` headersElapsedMs=${headersElapsedMs} httpStatus=${response.status}`})`,
        "GLM_REQUEST_TIMEOUT",
        // Local settlement cannot prove the remote request stopped. Generic
        // retry stays disabled; GLM alone may expose the typed opt-in boundary.
        false,
        "feedback",
        boundary === glmBoundary && phase === "awaiting_headers"
          ? { kind: "ambiguous-headers-timeout-v1", phase: "awaiting_headers", abortSource: "local_request_timeout", noResponse: true, remoteOutcome: "unknown" }
          : undefined);
      }
      if (boundary.isProviderError(error)) throw error;
      if (phase === "before_fetch") throw error;
      if (boundary.strictResponse && response !== undefined && !response.ok) {
        emit({ stage, outcome: "http_error", phase, elapsedMs: elapsedMs(), ...status });
        const projectedError = boundary.httpError?.({
          status: response.status,
          payload: undefined,
          retryAfterHeader: response.headers.get("retry-after"),
        });
        if (projectedError !== undefined) throw projectedError;
        throw providerError(boundary, `GLM HTTP ${response.status}`, `GLM_HTTP_${response.status}`, false);
      }
      if (boundary.strictResponse && phase === "reading_body" && error instanceof SyntaxError) {
        emit({ stage, outcome: "network_error", phase, elapsedMs: elapsedMs(), ...status });
        throw providerError(boundary, "GLM response body is not valid JSON", "GLM_INVALID_RESPONSE", false);
      }
      const typedHeaderTransportTimeout = boundary === glmBoundary && phase === "awaiting_headers"
        && response === undefined && firstAbortSource === undefined
        && error instanceof Error && isRecord(error.cause) && error.cause.code === "ETIMEDOUT";
      emit({ stage, outcome: "network_error", phase, elapsedMs: elapsedMs(), deadlineMs: this.requestTimeoutMs, ...status });
      throw providerError(boundary, `GLM ${phase === "reading_body" ? "response body could not be read" : "network request failed"}${boundary.strictResponse ? "" : ` (${networkDiagnostic(error)})`}`,
      "GLM_NETWORK_ERROR", !boundary.strictResponse, "same_input",
      typedHeaderTransportTimeout
        ? { kind: "ambiguous-headers-transport-v1", phase: "awaiting_headers", abortSource: "transport_failure", noResponse: true, transportCode: "ETIMEDOUT", remoteOutcome: "unknown" }
        : undefined);
    } finally {
      clearTimeout(timeout);
      signal.removeEventListener("abort", abortRequest);
    }
  }
}

export class FetchGlmHttpClient extends FetchChatCompletionsHttpClient {}

function countImages(input: ModelInput): number {
  return input.messages.reduce((total, message) => total + message.content.filter((block) => block.type === "image").length, 0);
}

function estimateVisualTokens(input: ModelInput): number {
  return input.messages.reduce((total, message) => total + message.content.reduce((sum, block) => block.type !== "image"
    ? sum
    : sum + Math.min(480, Math.ceil((block.viewport.width * block.viewport.height) / 750) + 128), 0), 0);
}

function estimateWireTextTokens(body: unknown): number {
  const withoutImagePayload = stripImagePayload(body);
  return Math.ceil(JSON.stringify(withoutImagePayload).length / 4);
}

function assertInputBudget(input: ModelInput, body: unknown, provider: string, boundary: ChatCompletionsBoundary): void {
  const textMax = input.contextBudget?.maxInputTokens;
  const maxWireInputTokens = input.contextBudget?.maxWireInputTokens;
  const max = maxWireInputTokens ?? textMax;
  for (const value of [textMax, maxWireInputTokens]) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 1 || value > 131072)) {
      throw providerError(boundary, "GLM input budgets must be integers from 1 to 131072", "GLM_INPUT_TOO_LARGE", false);
    }
  }
  if (textMax !== undefined && maxWireInputTokens !== undefined && textMax > maxWireInputTokens) {
    throw providerError(boundary, "GLM text budget must not exceed wire budget", "GLM_INPUT_TOO_LARGE", false);
  }
  if (max === undefined) return;
  // Context compilation cannot see provider-specific envelopes or the visual
  // token cost. Keep a conservative provider-side gate immediately before the
  // network call so an oversized image/schema prompt is never sent.
  const visualTokens = estimateVisualTokens(input);
  const textTokens = estimateWireTextTokens(body);
  const estimated = textTokens + visualTokens + 32;
  const exceedsBudget = maxWireInputTokens === undefined
    ? estimated > max && (max < 1_000 || estimated > max + 4_096)
    : estimated > max;
  if (exceedsBudget) {
    throw providerError(boundary, `${provider} prompt exceeds wire input budget (estimated=${estimated}, text=${textTokens}, visual=${visualTokens}, envelope=32, maxWireInputTokens=${maxWireInputTokens ?? "unset"}, maxInputTokens=${textMax ?? "unset"}, effectiveLimit=${max})`, "GLM_INPUT_TOO_LARGE", false);
  }
}

function safeRequestConfiguration(serializedBody: string): GlmRequestConfiguration | undefined {
  try {
    const body: unknown = JSON.parse(serializedBody);
    if (!isRecord(body)) return undefined;
    const thinking = isRecord(body.thinking) ? body.thinking.type : undefined;
    const reasoningEffort = body.reasoning_effort;
    const maxTokens = body.max_tokens;
    return {
      ...(body.stream === false ? { stream: false as const } : {}),
      ...(thinking === "disabled" || thinking === "enabled" ? { thinking } : {}),
      ...(reasoningEffort === "low" || reasoningEffort === "high" || reasoningEffort === "max"
        ? { reasoningEffort }
        : reasoningEffort === undefined ? { reasoningEffort: "server_default" as const } : {}),
      ...(Number.isSafeInteger(maxTokens) && (maxTokens as number) >= 1 ? { maxTokens: maxTokens as number } : {}),
      ...(Array.isArray(body.messages) ? { messageCount: body.messages.length } : {}),
      ...(Array.isArray(body.tools) ? { toolCount: body.tools.length } : {}),
      imageCount: countWireImages(body.messages),
    };
  } catch {
    return undefined;
  }
}

function countWireImages(value: unknown): number {
  if (Array.isArray(value)) return value.reduce((total, item) => total + countWireImages(item), 0);
  if (!isRecord(value)) return 0;
  return (value.type === "image_url" ? 1 : 0) + Object.values(value).reduce<number>((total, item) => total + countWireImages(item), 0);
}

function stripImagePayload(value: unknown, parentKey?: string): unknown {
  if (Array.isArray(value)) return value.map((item) => stripImagePayload(item, parentKey));
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [
    key,
    parentKey === "image_url" && key === "url" && typeof child === "string"
      ? "[image payload omitted]"
      : stripImagePayload(child, key),
  ]));
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function networkDiagnostic(error: unknown): string {
  if (!(error instanceof Error)) return `type=${typeof error}; message=${sanitizeDiagnosticText(String(error))}`;
  const cause = isRecord(error.cause) ? error.cause : undefined;
  const causeCode = cause !== undefined && typeof cause.code === "string" ? cause.code : undefined;
  const causeName = cause !== undefined && typeof cause.name === "string" ? cause.name : undefined;
  const parts = [`name=${error.name}`];
  if (causeCode !== undefined) parts.push(`causeCode=${causeCode}`);
  if (causeName !== undefined) parts.push(`causeName=${causeName}`);
  if (error.message.trim().length > 0) parts.push(`message=${sanitizeDiagnosticText(error.message)}`);
  return parts.join("; ");
}

function sanitizeDiagnosticText(value: string): string {
  return value
    .slice(0, 240)
    .replace(/(authorization\s*[:=]\s*)(?:bearer\s+)?[^\s,;]+/giu, "$1[redacted]")
    .replace(/(bearer\s+)[A-Za-z0-9._~+\-/]+=*/giu, "$1[redacted]")
    .replace(/([?&](?:api[_-]?key|access[_-]?token|auth(?:orization)?|token|secret|password|signature|sig)=)[^&\s]+/giu, "$1[redacted]")
    .replace(/((?:api[_-]?key|access[_-]?token|auth(?:orization)?|token|secret|password|signature|sig)\s*[:=]\s*)[^\s,;]+/giu, "$1[redacted]")
    .replace(/(https?:\/\/)[^/\s@]+@/giu, "$1[redacted]@");
}

function toGlmTool(tool: ModelToolSpec, profile: GlmProfile, viewport: Viewport | undefined): Record<string, unknown> {
  const coordinateHint = tool.coordinate === undefined
    ? ""
    : profile.coordinateMode === "normalized_1000"
      ? ` Coordinates ${tool.coordinate.fields.join(",")} are normalized numbers from 0 to 1000.`
      : viewport === undefined
        ? ` Coordinates ${tool.coordinate.fields.join(",")} are pixels in the current image viewport.`
        : ` Coordinates ${tool.coordinate.fields.join(",")} are pixels in the current image viewport.`;
  const effectHint = tool.category === "computer" && toolRequiresActionEffect(tool)
    && isRecord(tool.inputSchema) && Array.isArray(tool.inputSchema.required) && tool.inputSchema.required.includes(HARNESS_EFFECT_KEY)
    ? ` Include required ${HARNESS_EFFECT_KEY} in this call's JSON arguments, alongside the other parameters. It must be an object with effects (non-empty array of schema-listed effects), target (non-empty string) and summary (non-empty string). Describe this call's actual immediate consequences honestly; use unknown when uncertain. Never omit these fields or assume approval.`
    : "";
  return {
    type: "function",
    function: {
      name: tool.name,
      description: `${tool.description}${coordinateHint}${effectHint}`,
      parameters: addCoordinateBounds(withObservationAssessmentSchema(tool.inputSchema ?? { type: "object", properties: {} }), tool.coordinate?.fields, profile.coordinateMode, viewport),
    },
  };
}

function toDataUrl(mediaType: string, bytes: Uint8Array): string {
  return `data:${mediaType};base64,${Buffer.from(bytes).toString("base64")}`;
}

function readResponse(value: unknown, boundary: ChatCompletionsBoundary): { message: { content?: unknown; tool_calls?: unknown; reasoning_content?: unknown }; finishReason?: string; usage?: ModelUsage; reasoningTokens?: number } {
  if (!isRecord(value) || !Array.isArray(value.choices) || value.choices.length === 0) {
    throw providerError(boundary, "GLM response has no choices", "GLM_INVALID_RESPONSE");
  }
  const first = value.choices[0];
  if (!isRecord(first) || !isRecord(first.message)) {
    throw providerError(boundary, "GLM response has no assistant message", "GLM_INVALID_RESPONSE");
  }
  if (boundary.strictResponse && (first.message.role !== "assistant" || typeof first.finish_reason !== "string")) {
    throw providerError(boundary, "GLM response requires an assistant message and finish_reason", "GLM_INVALID_RESPONSE", boundary.strictResponseRetryable ?? false);
  }
  if (first.finish_reason !== undefined && typeof first.finish_reason !== "string") {
    throw providerError(boundary, "GLM response has an invalid finish_reason", "GLM_INVALID_RESPONSE");
  }
  const usage = readUsage(value, boundary);
  const details = isRecord(value.usage) && isRecord(value.usage.completion_tokens_details) ? value.usage.completion_tokens_details : undefined;
  const reasoningTokens = details?.reasoning_tokens;
  return {
    message: first.message,
    ...(typeof first.finish_reason === "string" ? { finishReason: first.finish_reason } : {}),
    ...(usage === undefined ? {} : { usage }),
    ...(typeof reasoningTokens === "number" && Number.isSafeInteger(reasoningTokens) && reasoningTokens >= 0 ? { reasoningTokens } : {}),
  };
}

function reasoningContinuation(value: unknown, providerId: string, boundary: ChatCompletionsBoundary): ModelContinuation | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw providerError(boundary, "GLM reasoning_content must be a string", "GLM_INVALID_RESPONSE");
  }
  return { providerId, kind: "reasoning_content", content: value };
}

function assertCompleteFinishReason(reason: string | undefined, profile: GlmProfile, boundary: ChatCompletionsBoundary, usage?: ModelUsage, reasoningTokens?: number): void {
  if ((boundary.strictResponse && reason !== "stop" && reason !== "tool_calls") ||
      (reason !== undefined && reason !== "stop" && reason !== "tool_calls" && reason !== "function_call")) {
    const safeReason = reason !== undefined && ["length", "content_filter", "sensitive"].includes(reason) ? reason : "unknown";
    const diagnostic = JSON.stringify({ finish_reason: safeReason, max_tokens: profile.maxOutputTokens, thinking: profile.thinking,
      ...(usage?.inputTokens === undefined ? {} : { prompt_tokens: usage.inputTokens }),
      ...(usage?.outputTokens === undefined ? {} : { completion_tokens: usage.outputTokens }),
      ...(usage?.totalTokens === undefined ? {} : { total_tokens: usage.totalTokens }),
      ...(reasoningTokens === undefined ? {} : { reasoning_tokens: reasoningTokens }),
    });
    throw providerError(boundary, `GLM response ended with incomplete finish_reason: ${safeReason}; diagnostic=${diagnostic}`, "GLM_INCOMPLETE_RESPONSE", false, "feedback");
  }
}

function readUsage(value: unknown, boundary: ChatCompletionsBoundary): ModelUsage | undefined {
  if (!isRecord(value) || !isRecord(value.usage)) return undefined;
  const usage = value.usage;
  const inputTokens = usage.prompt_tokens;
  const outputTokens = usage.completion_tokens;
  const totalTokens = usage.total_tokens;
  const promptDetails = boundary.cacheUsageFormat === "nested-prompt-details" && isRecord(usage.prompt_tokens_details)
    ? usage.prompt_tokens_details
    : undefined;
  const cachedTokens = boundary.cacheUsageFormat === "flat-prompt-cache"
    ? usage.prompt_cache_hit_tokens
    : promptDetails?.cached_tokens;
  const parsed = {
    ...(typeof inputTokens === "number" && Number.isSafeInteger(inputTokens) && inputTokens >= 0 ? { inputTokens } : {}),
    ...(typeof outputTokens === "number" && Number.isSafeInteger(outputTokens) && outputTokens >= 0 ? { outputTokens } : {}),
    ...(typeof totalTokens === "number" && Number.isSafeInteger(totalTokens) && totalTokens >= 0 ? { totalTokens } : {}),
    ...(typeof cachedTokens === "number" && Number.isSafeInteger(cachedTokens) && cachedTokens >= 0 ? { cacheReadTokens: cachedTokens } : {}),
  };
  return Object.keys(parsed).length === 0 ? undefined : parsed;
}

function readToolCall(value: unknown, boundary: ChatCompletionsBoundary): { id: ToolCallId; name: string; arguments: JsonValue } {
  if (!isRecord(value) || typeof value.id !== "string" || value.id.trim().length === 0 || !isRecord(value.function) || typeof value.function.name !== "string") {
    throw providerError(boundary, "GLM returned a malformed ToolCall", "GLM_INVALID_TOOL_CALL");
  }
  if (boundary.strictResponse && (value.type !== "function" || typeof value.function.arguments !== "string")) {
    throw providerError(boundary, "GLM native tool calls require function type and JSON-string arguments", "GLM_INVALID_TOOL_CALL", boundary.strictResponseRetryable ?? false);
  }
  const rawArgs = value.function.arguments;
  let args: unknown = rawArgs;
  if (typeof rawArgs === "string") {
    try {
      args = JSON.parse(rawArgs) as unknown;
    } catch (error) {
      throw providerError(boundary, boundary.strictResponse ? "GLM ToolCall arguments are not JSON" : `GLM ToolCall arguments are not JSON: ${error instanceof Error ? error.message : String(error)}`, "GLM_INVALID_TOOL_CALL");
    }
  }
  if (!isJsonValue(args)) {
    throw providerError(boundary, "GLM ToolCall arguments are not JSON-safe", "GLM_INVALID_TOOL_CALL");
  }
  return { id: value.id as ToolCallId, name: value.function.name, arguments: args };
}

function mapCoordinates(call: { id: ToolCallId; name: string; arguments: JsonValue }, viewport: Viewport | undefined, mode: GlmCoordinateMode, fields: readonly CoordinateField[] | undefined, boundary: ChatCompletionsBoundary): ToolCall {
  if (mode !== "normalized_1000" || fields === undefined || typeof call.arguments !== "object" || call.arguments === null || Array.isArray(call.arguments)) {
    return call;
  }
  const args = { ...(call.arguments as Record<string, JsonValue>) };
  if (viewport === undefined && fields.some((key) => args[key] !== undefined)) {
    throw providerError(boundary, "GLM normalized coordinates require an image viewport", "GLM_MISSING_VIEWPORT");
  }
  if (viewport === undefined) return call;
  for (const key of fields) {
    const value = args[key];
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1000) {
      throw providerError(boundary, `GLM normalized coordinate ${key} is outside 0..1000`, "GLM_COORDINATE_OUT_OF_RANGE");
    }
    args[key] = value * (key.endsWith("X") || key === "x" ? viewport.width : viewport.height) / 1000;
  }
  return { ...call, arguments: args };
}

function encodeCoordinates(call: ToolCall, viewport: Viewport | undefined, mode: GlmCoordinateMode, fields: readonly CoordinateField[] | undefined): JsonValue {
  if (mode !== "normalized_1000" || fields === undefined || viewport === undefined || typeof call.arguments !== "object" || call.arguments === null || Array.isArray(call.arguments)) {
    return call.arguments;
  }
  const args = { ...(call.arguments as Record<string, JsonValue>) };
  for (const key of fields) {
    const value = args[key];
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isFinite(value)) return call.arguments;
    args[key] = value * (key.endsWith("X") || key === "x" ? 1000 / viewport.width : 1000 / viewport.height);
  }
  return args;
}

function addCoordinateBounds(schema: JsonValue, fields: readonly CoordinateField[] | undefined, mode: GlmCoordinateMode, viewport: Viewport | undefined): JsonValue {
  if (fields === undefined) return schema;
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) return schema;
  const record = schema as Record<string, JsonValue>;
  const properties = record.properties;
  if (typeof properties !== "object" || properties === null || Array.isArray(properties)) return schema;
  const nextProperties = { ...(properties as Record<string, JsonValue>) };
  for (const key of fields) {
    const property = nextProperties[key];
    if (typeof property !== "object" || property === null || Array.isArray(property)) continue;
    const isX = key.endsWith("X") || key === "x";
    const maximum = mode === "normalized_1000" ? 1000 : isX ? viewport === undefined ? undefined : viewport.width - 1 : viewport === undefined ? undefined : viewport.height - 1;
    nextProperties[key] = { ...(property as Record<string, JsonValue>), minimum: 0, ...(maximum === undefined ? {} : { maximum }) };
  }
  return { ...record, properties: nextProperties };
}

function profilePrompt(profile: GlmProfile, boundary: ChatCompletionsBoundary): string {
  return profile.coordinateMode === "normalized_1000"
    ? `${boundary.label} GUI contract: follow the Context tool-call and batching contract; absent an explicit permitted batch, emit at most one Computer tool call per turn. Coordinates must be normalized to 0..1000 relative to the current image.`
    : `${boundary.label} GUI contract: follow the Context tool-call and batching contract; absent an explicit permitted batch, emit at most one Computer tool call per turn. Coordinates are pixels in the current image viewport.`;
}

function fitImageViewport(source: Viewport, maxEdge: number): Viewport {
  if (![source.width, source.height].every((n) => Number.isSafeInteger(n) && n > 0)) {
    throw new GlmProviderError("Invalid source image viewport", "GLM_INVALID_IMAGE", false);
  }
  const ratio = Math.min(1, maxEdge / Math.max(source.width, source.height));
  return { ...source, width: Math.max(1, Math.round(source.width * ratio)), height: Math.max(1, Math.round(source.height * ratio)) };
}

function scaleCallToViewport(call: ToolCall, tools: readonly ModelToolSpec[], from: Viewport | undefined, to: Viewport | undefined, validate = false): ToolCall {
  const fields = tools.find((tool) => tool.name === call.name)?.coordinate?.fields;
  if (fields === undefined || !isRecord(call.arguments)) return call;
  if (from === undefined || to === undefined) throw new GlmProviderError("Coordinate presentation requires an image viewport", "GLM_MISSING_VIEWPORT", false);
  const args = { ...call.arguments };
  for (const field of fields) {
    const value = args[field];
    if (value === undefined) continue;
    const x = field === "x" || field.endsWith("X");
    const extent = x ? from.width : from.height;
    if (typeof value !== "number" || !Number.isFinite(value) || (validate && (value < 0 || value >= extent))) {
      throw new GlmProviderError(`Invalid presented coordinate ${field}`, "GLM_COORDINATE_OUT_OF_RANGE");
    }
    args[field] = value * (x ? to.width : to.height) / extent;
  }
  return { ...call, arguments: args as JsonValue };
}

function projectImageCoordinates(input: ModelInput, maxEdge: number): ModelInput {
  return { ...input, messages: input.messages.map((message) => ({ ...message, content: message.content.map((block): ModelContentBlock => {
    if (block.type === "image") return { ...block, viewport: fitImageViewport(block.viewport, maxEdge) };
    if (block.type === "tool_call" && input.tools.some((tool) => tool.name === block.call.name && tool.coordinate !== undefined)) {
      if (block.viewport === undefined) throw new GlmProviderError("Historical coordinate call lacks its source viewport", "GLM_MISSING_VIEWPORT", false);
      const viewport = fitImageViewport(block.viewport, maxEdge);
      return { ...block, viewport, call: scaleCallToViewport(block.call, input.tools, block.viewport, viewport) };
    }
    return block;
  }) })) };
}

function restoreImageCoordinates(turn: ModelTurn, presented: ModelInput, source: ModelInput): ModelTurn {
  if (turn.type !== "tool_calls") return turn;
  return { ...turn, calls: turn.calls.map((call) => scaleCallToViewport(call, source.tools, latestViewport(presented), latestViewport(source), true)) };
}

function latestViewport(input: ModelInput): Viewport | undefined {
  for (let index = input.messages.length - 1; index >= 0; index -= 1) {
    const message = input.messages[index];
    if (message === undefined) continue;
    for (let blockIndex = message.content.length - 1; blockIndex >= 0; blockIndex -= 1) {
      const block = message.content[blockIndex];
      if (block?.type === "image") return block.viewport;
    }
  }
  return undefined;
}

function mapControlCall(control: ControlKind, argumentsValue: JsonValue, name: string, boundary: ChatCompletionsBoundary): ModelTurn {
  if (typeof argumentsValue !== "object" || argumentsValue === null || Array.isArray(argumentsValue)) {
    throw providerError(boundary, `GLM control ${name} arguments must be an object`, "GLM_INVALID_TOOL_CALL");
  }
  const args = argumentsValue as Record<string, JsonValue>;
  if (control === "finish") {
    if (args.status !== "success" && args.status !== "failure") throw providerError(boundary, "GLM terminate requires status success or failure", "GLM_INVALID_TOOL_CALL");
    if (typeof args.text !== "string" || !isActionableFinishSummary(args.text)) {
      throw providerError(boundary, "GLM terminate requires user-facing result text, not only a status label", "GLM_INVALID_TOOL_CALL");
    }
    return {
      type: "finish",
      summary: args.text.trim(),
      reportedStatus: args.status,
      ...(args.resultEvidence === undefined ? {} : { resultEvidence: args.resultEvidence as unknown as SourceLinkedFinishReport }),
    };
  }
  if (typeof args.text !== "string" || args.text.trim().length === 0) throw providerError(boundary, "GLM interact requires text", "GLM_INVALID_TOOL_CALL");
  return { type: "user_input_required", question: args.text };
}

function readErrorCode(value: unknown): string | undefined {
  if (!isRecord(value) || !isRecord(value.error) || typeof value.error.code !== "string") return undefined;
  return value.error.code;
}

function readErrorMessage(value: unknown): string | undefined {
  if (!isRecord(value) || !isRecord(value.error) || typeof value.error.message !== "string" || value.error.message.trim().length === 0) return undefined;
  return value.error.message;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRetryableGlmErrorCode(code: string): boolean {
  return code === "GLM_INVALID_RESPONSE"
    || code === "GLM_INVALID_TOOL_CALL"
    || code === "GLM_DUPLICATE_TOOL_CALL"
    || code === "GLM_UNAVAILABLE_TOOL"
    || code === "GLM_EMPTY_RESPONSE";
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (typeof value === "object") return Object.values(value as Record<string, unknown>).every(isJsonValue);
  return false;
}
