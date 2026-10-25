import type { AssetReader } from "@computer-harness/runtime";
import {
  ChatCompletionsAdapter,
  FetchChatCompletionsHttpClient,
  type ChatCompletionsBoundary,
  type ChatCompletionsHttpFailure,
  type GlmHttpClient,
  type GlmHttpDiagnostics,
  type GlmRetryMode,
  type GlmTransportEvidence,
} from "./chat-completions.js";

export type ArkHttpClient = GlmHttpClient;
export type ArkHttpDiagnostics = GlmHttpDiagnostics;
export type ArkTransportEvidence = GlmTransportEvidence;

export type ArkRetryAfterState = "absent" | "invalid" | "accepted" | "too_long";

/** Safe, bounded details from an Ark HTTP 429 response. Never contains the raw body or header. */
export interface ArkHttpFailureDetails {
  readonly httpStatus: 429;
  readonly providerErrorCode?: string;
  readonly providerErrorMessage?: string;
  readonly retryAfterState: ArkRetryAfterState;
  readonly retryAfterMs?: number;
}

// Keep parsing within the Runtime's current retry window; Runtime still makes
// the final admission decision after reserving time for one Provider attempt.
const MAX_ARK_RETRY_AFTER_MS = 120_000;

export class ArkProviderError extends Error {
  public constructor(
    message: string,
    public readonly code = "ARK_PROVIDER_ERROR",
    public readonly retryable = /^ARK_(UNAVAILABLE_TOOL|INVALID_TOOL_CALL|DUPLICATE_TOOL_CALL|EMPTY_RESPONSE|INVALID_RESPONSE)$/u.test(code),
    public readonly retryMode: GlmRetryMode = "feedback",
    public readonly httpFailure?: ArkHttpFailureDetails,
  ) {
    super(message);
    this.name = "ArkProviderError";
  }
}

const arkBoundary: ChatCompletionsBoundary = {
  label: "Ark",
  errorCodePrefix: "ARK",
  endpoint: "https://ark.cn-beijing.volces.com/api/plan/v3/chat/completions",
  requestTimeoutMs: 90_000,
  maxOutputTokens: 4096,
  userImagesOnly: true,
  strictResponse: true,
  cacheUsageFormat: "nested-prompt-details",
  strictResponseRetryable: true,
  httpError: (failure) => ark429Error(failure),
  error: (message, code, retryable, retryMode) => new ArkProviderError(message, code, retryable, retryMode),
  isProviderError: (error) => error instanceof ArkProviderError,
};

export interface FetchArkHttpClientOptions {
  readonly requestTimeoutMs?: number;
}

export class FetchArkHttpClient extends FetchChatCompletionsHttpClient {
  public constructor(options: FetchArkHttpClientOptions = {}) {
    super(options, arkBoundary);
  }

  public override async post(
    url: string,
    body: Record<string, unknown>,
    headers: Readonly<Record<string, string>>,
    signal: AbortSignal,
    diagnostics?: ArkHttpDiagnostics,
  ): Promise<unknown> {
    try {
      return await super.post(url, body, headers, signal, diagnostics);
    } catch (error) {
      if (!(error instanceof ArkProviderError) || !(error.code === "ARK_NETWORK_ERROR" || /^ARK_HTTP_5\d\d$/u.test(error.code))) throw error;
      throw new ArkProviderError(error.message, error.code, true, "same_input", error.httpFailure);
    }
  }
}

function ark429Error(failure: ChatCompletionsHttpFailure): ArkProviderError | undefined {
  if (failure.status !== 429) return undefined;
  const providerErrorCode = safeArkProviderCode(readArkErrorField(failure.payload, "code"));
  const providerErrorMessage = safeArkProviderMessage(readArkErrorField(failure.payload, "message"));
  const retryAfter = parseArkRetryAfter(failure.retryAfterHeader, Date.now());
  const httpFailure: ArkHttpFailureDetails = {
    httpStatus: 429,
    ...(providerErrorCode === undefined ? {} : { providerErrorCode }),
    ...(providerErrorMessage === undefined ? {} : { providerErrorMessage }),
    retryAfterState: retryAfter.state,
    ...(retryAfter.delayMs === undefined ? {} : { retryAfterMs: retryAfter.delayMs }),
  };
  const rawProviderMessage = readArkErrorField(failure.payload, "message");
  const retryable = retryAfter.state !== "too_long" && !isPermanentArk429Failure(providerErrorCode, rawProviderMessage);
  const message = `Ark HTTP 429${providerErrorMessage === undefined ? "" : `: ${providerErrorMessage}`}`;
  return new ArkProviderError(message, "ARK_HTTP_429", retryable, retryable ? "same_input" : "feedback", httpFailure);
}

function readArkErrorField(payload: unknown, field: "code" | "message"): unknown {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return undefined;
  const error = (payload as Record<string, unknown>).error;
  if (typeof error !== "object" || error === null || Array.isArray(error)) return undefined;
  return (error as Record<string, unknown>)[field];
}

function safeArkProviderCode(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length < 1 || value.length > 64 || !/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/u.test(value)) return undefined;
  if (/[A-Za-z0-9]{24,}/u.test(value)) return undefined;
  return value;
}

function safeArkProviderMessage(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const message = value.trim();
  if (message.length < 1 || message.length > 240 ||
      !/^[\p{L}\p{N} .,;:!?()'’_-]+$/u.test(message) ||
      /\b(?:https?|bearer|authorization|api[ _-]*key|access[ _-]*token|secret|credential)\b/iu.test(message) ||
      /\b[A-Za-z0-9_-]{24,}\b/u.test(message)) return undefined;
  return message;
}

function isPermanentArk429Failure(code: string | undefined, rawMessage: unknown): boolean {
  const codeText = code ?? "";
  const compactCode = codeText.toLowerCase().replace(/[^a-z0-9]/gu, "");
  const message = typeof rawMessage === "string" ? rawMessage.slice(0, 512) : "";
  const hardFailureCode = /insufficientquota|billing(?:account)?(?:error|failed|failure|disabled|suspended|unavailable|issue)|^billing$|payment(?:required|failed|declined|pastdue|issue|error)|insufficient(?:account)?balance|(?:account)?balance(?:insufficient|empty|zero|exhausted|depleted|overdrawn)|insufficient(?:account)?credits?|credits?(?:exhausted|depleted)|account(?:disabled|suspended|deactivated|frozen)|unauthorized|authenticationfailed|invalidapikey|permissiondenied/iu.test(compactCode);
  if (hardFailureCode) return true;

  const description = `${codeText} ${message}`;
  const timeWindowLimit = /per[ _-]?(?:minute|min|second|sec|hour|hr)|\b(?:rpm|tpm)\b|(?:requests?|tokens?)\s*(?:\/|per)\s*(?:minute|min|second|sec|hour|hr)/iu.test(description);
  if (timeWindowLimit) return false;

  const normalizedMessage = message.toLowerCase().replace(/[^a-z0-9]+/gu, " ").trim();
  const quotaExhaustionCode = /(?:^|)quota(?:exhausted|depleted)$/u.test(compactCode)
    || /(?:account|total|subscription)quota(?:exhausted|depleted)/u.test(compactCode);
  const durableQuotaMessage = /\b(?:insufficient quota|quota (?:is )?(?:exhausted|depleted)|(?:account|total|subscription) quota (?:exceeded|exhausted|depleted))\b/u.test(normalizedMessage);
  const billingOrAccountMessage = /\b(?:billing (?:account )?(?:failed|disabled|suspended|unavailable|error|issue|problem|configuration missing)|payment (?:required|failed|declined|past due|error|issue)|insufficient (?:account )?(?:balance|credits?)|(?:account )?(?:balance|credits?) (?:is )?(?:insufficient|empty|zero|exhausted|depleted|overdrawn)|account (?:disabled|suspended|deactivated|frozen)|unauthorized|authentication failed|invalid api key|permission denied)\b/u.test(normalizedMessage);
  return quotaExhaustionCode || durableQuotaMessage || billingOrAccountMessage;
}

function parseArkRetryAfter(value: string | null, nowMs: number): { state: ArkRetryAfterState; delayMs?: number } {
  if (value === null || value.trim().length === 0) return { state: "absent" };
  const header = value.trim();
  let delayMs: number;
  if (/^\d+$/u.test(header)) {
    if (header.length > 9) return { state: "too_long" };
    const seconds = Number(header);
    if (!Number.isSafeInteger(seconds)) return { state: "too_long" };
    delayMs = seconds * 1_000;
  } else if (/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/u.test(header)) {
    const retryAtMs = Date.parse(header);
    if (!Number.isFinite(retryAtMs)) return { state: "invalid" };
    delayMs = Math.max(0, retryAtMs - nowMs);
  } else {
    return { state: "invalid" };
  }
  if (delayMs > MAX_ARK_RETRY_AFTER_MS) return { state: "too_long" };
  return { state: "accepted", delayMs };
}

export interface ArkDeepseekFlashAdapterOptions {
  readonly apiKey: string;
  readonly assetReader: AssetReader;
  readonly endpoint?: string;
  readonly requestTimeoutMs?: number;
  readonly maxOutputTokens?: number;
  readonly httpClient?: ArkHttpClient;
}

/** Volcengine Ark Agent Plan channel, independent of official DeepSeek. */
export class ArkDeepseekFlashAdapter extends ChatCompletionsAdapter {
  public constructor(options: ArkDeepseekFlashAdapterOptions) {
    let endpoint: string | undefined;
    if (options.endpoint !== undefined) {
      const url = new URL(options.endpoint);
      if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Ark endpoint must use HTTP(S)");
      url.pathname = /\/chat\/completions\/?$/u.test(url.pathname)
        ? url.pathname.replace(/\/$/u, "")
        : `${url.pathname.replace(/\/$/u, "")}/chat/completions`;
      endpoint = url.href;
    }
    super({
      apiKey: options.apiKey,
      assetReader: options.assetReader,
      profile: {
        name: "deepseek-v4.1-flash",
        thinking: "disabled",
        coordinateMode: "actual_pixels",
        maxOutputTokens: options.maxOutputTokens ?? arkBoundary.maxOutputTokens,
      },
      httpClient: options.httpClient ?? new FetchArkHttpClient({
        ...(options.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: options.requestTimeoutMs }),
      }),
      ...(endpoint === undefined ? {} : { endpoint }),
    }, arkBoundary);
  }
}
