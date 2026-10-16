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

export type ArkHttpClient = GlmHttpClient;
export type ArkHttpDiagnostics = GlmHttpDiagnostics;
export type ArkTransportEvidence = GlmTransportEvidence;

export class ArkProviderError extends Error {
  public constructor(
    message: string,
    public readonly code = "ARK_PROVIDER_ERROR",
    public readonly retryable = /^ARK_(UNAVAILABLE_TOOL|INVALID_TOOL_CALL|DUPLICATE_TOOL_CALL|EMPTY_RESPONSE|INVALID_RESPONSE)$/u.test(code),
    public readonly retryMode: GlmRetryMode = "feedback",
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
  strictResponseRetryable: true,
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
      if (!(error instanceof ArkProviderError) || !(error.code === "ARK_NETWORK_ERROR" || error.code === "ARK_HTTP_429" || /^ARK_HTTP_5\d\d$/u.test(error.code))) throw error;
      throw new ArkProviderError(error.message, error.code, true, "same_input");
    }
  }
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
