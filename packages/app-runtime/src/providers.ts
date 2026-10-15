import { resolve } from "node:path";
import { DeepseekFlashAdapter, FetchDeepseekHttpClient, FetchGlmHttpClient, GlmAdapter, glmProfiles, type GlmProfile } from "@computer-harness/provider-glm";
import { Qwen38FlashAdapter } from "@computer-harness/provider-qwen";
import type { ProviderAdapter } from "@computer-harness/runtime";
import { RecordingDeepseekHttpClient, RecordingGlmHttpClient, RecordingQwenHttpClient } from "./diagnostics/recording-clients.js";
import { DEFAULT_DEEPSEEK_REQUEST_TIMEOUT_MS, DEFAULT_GLM_REQUEST_TIMEOUT_MS, validateDeepseekMaxOutputTokens, validateDeepseekRequestTimeoutMs, validateGlmRequestTimeoutMs, type ProviderFactory, type ProviderFactoryOptions } from "./config.js";

export class ProviderConfigurationError extends Error {
  public readonly code = "PROVIDER_CREDENTIALS_MISSING";

  public constructor() {
    super("The selected built-in model has no configured credentials.");
    this.name = "ProviderConfigurationError";
  }
}

/** Pure preflight shared by Run allocation and the Provider boundary. */
export function assertBuiltInProviderCredentials(options: Pick<ProviderFactoryOptions, "model" | "credentials">): void {
  if (typeof options.model !== "string") return;
  if (options.model !== "glm-5.3-flash" && options.model !== "qwen3.8-flash" && options.model !== "deepseek-flash") return;
  const key = options.model === "glm-5.3-flash"
    ? options.credentials.glmApiKey
    : options.model === "qwen3.8-flash"
      ? options.credentials.qwenApiKey
      : options.credentials.deepseekApiKey;
  if (key === undefined || key.trim().length === 0) throw new ProviderConfigurationError();
}

/**
 * Construct one of the supported Providers without reading the ambient environment.
 * Credentials and non-secret endpoint settings are resolved by the CLI and
 * passed through ProviderFactoryOptions.
 */
export const createProvider: ProviderFactory = (options: ProviderFactoryOptions): ProviderAdapter => {
  if (options.model === "glm-5.3-flash") validateGlmRequestTimeoutMs(options.config.glmRequestTimeoutMs);
  if (options.model === "glm-5.3-flash") {
    const text = options.config.contextMaxInputTokens;
    const wire = options.config.contextMaxWireInputTokens;
    for (const value of [text, wire]) {
      if (value !== undefined && (!Number.isSafeInteger(value) || value < 1 || value > 131072)) throw new Error("GLM input budgets must be integers from 1 to 131072");
    }
    if (text !== undefined && wire !== undefined && text > wire) throw new Error("GLM text budget must not exceed wire budget");
  }
  assertBuiltInProviderCredentials(options);
  if (typeof options.model !== "string") {
    throw new Error(`external Provider '${options.model.id}' requires an injected createProvider factory`);
  }
  if (options.model === "qwen3.8-flash") return createQwenProvider(options);
  if (options.model === "deepseek-flash") return createDeepseekProvider(options);
  if (options.model === "glm-5.3-flash") return createGlmProvider(options);
  throw new Error(`unsupported Provider model '${options.model}'`);
};

function createQwenProvider(options: ProviderFactoryOptions): ProviderAdapter {
  const apiKey = options.credentials.qwenApiKey;
  const coordinateMode = options.config.qwenCoordinateMode ?? "normalized_1000";
  const thinking = options.config.qwenThinking ?? "low";
  const outputMode = options.config.qwenOutputMode ?? "strict_json";
  return new Qwen38FlashAdapter({
    apiKey: apiKey!,
    assetReader: options.assetReader,
    httpClient: options.httpClients?.qwen ?? new RecordingQwenHttpClient(resolve(options.outputDir, "provider-exchanges.jsonl"), coordinateMode, thinking, outputMode),
    coordinateMode,
    thinking,
    outputMode,
    ...(options.config.qwenEndpoint === undefined ? {} : { endpoint: options.config.qwenEndpoint }),
    ...(options.config.qwenWorkspaceId === undefined ? {} : { workspaceId: options.config.qwenWorkspaceId }),
  });
}

function createGlmProvider(options: ProviderFactoryOptions): ProviderAdapter {
  const apiKey = options.credentials.glmApiKey;
  const profile: GlmProfile = {
    ...glmProfiles["glm-5.3-flash"],
    // The configured glm-5.3-flash deployment is reasoning-only and rejects
    // thinking=disabled with HTTP 400/1210. Keep this provider boundary
    // compatible even if an older caller passes the legacy disabled setting.
    thinking: options.config.glmThinking === "disabled" ? "enabled" : options.config.glmThinking ?? "enabled",
    ...(options.config.glmMaxOutputTokens === undefined ? {} : { maxOutputTokens: options.config.glmMaxOutputTokens }),
  };
  return new GlmAdapter({
    apiKey: apiKey!,
    profile,
    assetReader: options.assetReader,
    httpClient: options.httpClients?.glm ?? new RecordingGlmHttpClient(
      resolve(options.outputDir, "provider-exchanges.jsonl"),
      new FetchGlmHttpClient({ requestTimeoutMs: options.config.glmRequestTimeoutMs ?? DEFAULT_GLM_REQUEST_TIMEOUT_MS }),
    ),
    ...(options.config.glmEndpoint === undefined ? {} : { endpoint: options.config.glmEndpoint }),
  });
}

function createDeepseekProvider(options: ProviderFactoryOptions): ProviderAdapter {
  validateDeepseekRequestTimeoutMs(options.config.deepseekRequestTimeoutMs);
  validateDeepseekMaxOutputTokens(options.config.deepseekMaxOutputTokens);
  const apiKey = options.credentials.deepseekApiKey;
  if (apiKey === undefined || apiKey.trim().length === 0) {
    throw new Error("DEEPSEEK_API_KEY is required for deepseek-flash");
  }
  return new DeepseekFlashAdapter({
    apiKey,
    assetReader: options.assetReader,
    httpClient: options.httpClients?.deepseek ?? new RecordingDeepseekHttpClient(
      resolve(options.outputDir, "provider-exchanges.jsonl"),
      new FetchDeepseekHttpClient({ requestTimeoutMs: options.config.deepseekRequestTimeoutMs ?? DEFAULT_DEEPSEEK_REQUEST_TIMEOUT_MS }),
    ),
    ...(options.config.deepseekEndpoint === undefined ? {} : { endpoint: options.config.deepseekEndpoint }),
    ...(options.config.deepseekMaxOutputTokens === undefined ? {} : { maxOutputTokens: options.config.deepseekMaxOutputTokens }),
  });
}
