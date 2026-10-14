import type { AssetReader } from "@computer-harness/runtime";
import {
  ChatCompletionsAdapter,
  FetchChatCompletionsHttpClient,
  type ChatCompletionsBoundary,
  type GlmHttpClient,
  type GlmHttpDiagnostics,
  type GlmTransportEvidence,
} from "./chat-completions.js";

export type DeepseekHttpDiagnostics = GlmHttpDiagnostics;
export type DeepseekTransportEvidence = GlmTransportEvidence;
export type DeepseekHttpClient = GlmHttpClient;

/** DeepSeek errors never request automatic retry or replay of a GUI decision. */
export class DeepseekProviderError extends Error {
  public readonly retryable = false;
  public readonly retryMode = "feedback" as const;

  public constructor(message: string, public readonly code = "DEEPSEEK_PROVIDER_ERROR") {
    super(message);
    this.name = "DeepseekProviderError";
  }
}

const deepseekBoundary: ChatCompletionsBoundary = {
  label: "DeepSeek",
  endpoint: "https://api.deepseek.com/chat/completions",
  requestTimeoutMs: 90_000,
  maxOutputTokens: 4096,
  userImagesOnly: true,
  strictResponse: true,
  error: (message, code) => new DeepseekProviderError(message, code),
  isProviderError: (error) => error instanceof DeepseekProviderError,
};

export interface FetchDeepseekHttpClientOptions {
  readonly requestTimeoutMs?: number;
}

export class FetchDeepseekHttpClient extends FetchChatCompletionsHttpClient {
  public constructor(options: FetchDeepseekHttpClientOptions = {}) {
    super(options, deepseekBoundary);
  }
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
