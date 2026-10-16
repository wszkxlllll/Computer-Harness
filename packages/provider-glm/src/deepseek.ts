import type { AssetReader } from "@computer-harness/runtime";
import {
  ChatCompletionsAdapter,
  FetchChatCompletionsHttpClient,
  type ChatCompletionsBoundary,
  type GlmHttpClient,
  type GlmHttpDiagnostics,
  type GlmRetryMode,
  type GlmTransportEvidence,
} from "./chat-completions.js";

export type DeepseekHttpDiagnostics = GlmHttpDiagnostics;
export type DeepseekTransportEvidence = GlmTransportEvidence;
export type DeepseekHttpClient = GlmHttpClient;

export class DeepseekProviderError extends Error {
  public readonly retryable: boolean;
  public readonly retryMode: GlmRetryMode;

  public constructor(
    message: string,
    public readonly code = "DEEPSEEK_PROVIDER_ERROR",
    retryable = isRetryableDeepseekResponseCode(code),
    retryMode: GlmRetryMode = "feedback",
  ) {
    super(message);
    this.name = "DeepseekProviderError";
    this.retryable = retryable;
    this.retryMode = retryMode;
  }
}

function isRetryableDeepseekResponseCode(code: string): boolean {
  return code === "DEEPSEEK_UNAVAILABLE_TOOL"
    || code === "DEEPSEEK_INVALID_TOOL_CALL"
    || code === "DEEPSEEK_DUPLICATE_TOOL_CALL"
    || code === "DEEPSEEK_EMPTY_RESPONSE"
    || code === "DEEPSEEK_INVALID_RESPONSE";
}

const deepseekBoundary: ChatCompletionsBoundary = {
  label: "DeepSeek",
  errorCodePrefix: "DEEPSEEK",
  endpoint: "https://api.deepseek.com/chat/completions",
  requestTimeoutMs: 90_000,
  maxOutputTokens: 4096,
  userImagesOnly: true,
  strictResponse: true,
  cacheUsageFormat: "flat-prompt-cache",
  strictResponseRetryable: true,
  error: (message, code, retryable) => new DeepseekProviderError(message, code, retryable),
  isProviderError: (error) => error instanceof DeepseekProviderError,
};

export interface FetchDeepseekHttpClientOptions {
  readonly requestTimeoutMs?: number;
}

export class FetchDeepseekHttpClient extends FetchChatCompletionsHttpClient {
  public constructor(options: FetchDeepseekHttpClientOptions = {}) {
    super(options, deepseekBoundary);
  }

  public override async post(
    url: string,
    body: Record<string, unknown>,
    headers: Readonly<Record<string, string>>,
    signal: AbortSignal,
    diagnostics?: DeepseekHttpDiagnostics,
  ): Promise<unknown> {
    try {
      return await super.post(url, body, headers, signal, diagnostics);
    } catch (error) {
      if (!(error instanceof DeepseekProviderError) || !isRetryableDeepseekTransportCode(error.code)) throw error;
      throw new DeepseekProviderError(error.message, error.code, true, "same_input");
    }
  }
}

function isRetryableDeepseekTransportCode(code: string): boolean {
  return code === "DEEPSEEK_NETWORK_ERROR"
    || code === "DEEPSEEK_HTTP_429"
    || /^DEEPSEEK_HTTP_5\d\d$/u.test(code);
}

export interface DeepseekFlashAdapterOptions {
  readonly apiKey: string;
  readonly assetReader: AssetReader;
  readonly endpoint?: string;
  readonly requestTimeoutMs?: number;
  readonly maxOutputTokens?: number;
  readonly httpClient?: DeepseekHttpClient;
}

/** Official multimodal deepseek-flash: user image_url blocks and native tools. */
export class DeepseekFlashAdapter extends ChatCompletionsAdapter {
  public constructor(options: DeepseekFlashAdapterOptions) {
    let endpoint: string | undefined;
    if (options.endpoint !== undefined) {
      const url = new URL(options.endpoint);
      if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("DeepSeek endpoint must use HTTP(S)");
      url.pathname = /\/chat\/completions\/?$/u.test(url.pathname)
        ? url.pathname.replace(/\/$/u, "")
        : `${url.pathname.replace(/\/$/u, "")}/chat/completions`;
      endpoint = url.href;
    }
    super({
      apiKey: options.apiKey,
      assetReader: options.assetReader,
      profile: {
        name: "deepseek-flash",
        thinking: "disabled",
        coordinateMode: "actual_pixels",
        maxOutputTokens: options.maxOutputTokens ?? deepseekBoundary.maxOutputTokens,
      },
      httpClient: options.httpClient ?? new FetchDeepseekHttpClient({
        ...(options.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: options.requestTimeoutMs }),
      }),
      ...(endpoint === undefined ? {} : { endpoint }),
    }, deepseekBoundary);
  }
}
