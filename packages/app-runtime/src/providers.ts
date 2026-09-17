import { resolve } from "node:path";
import { GlmAdapter, glmProfiles, type GlmProfile } from "@computer-harness/provider-glm";
import { Qwen38FlashAdapter } from "@computer-harness/provider-qwen";
import type { ProviderAdapter } from "@computer-harness/runtime";
import { RecordingGlmHttpClient, RecordingQwenHttpClient } from "./diagnostics/recording-clients.js";
import type { ProviderFactory, ProviderFactoryOptions } from "./config.js";

/**
 * Construct one of the supported Providers without reading the ambient environment.
 * Credentials and non-secret endpoint settings are resolved by the CLI and
 * passed through ProviderFactoryOptions.
 */
export const createProvider: ProviderFactory = (options: ProviderFactoryOptions): ProviderAdapter => {
  if (options.model === "qwen3.8-flash") return createQwenProvider(options);
  return createGlmProvider(options);
};

function createQwenProvider(options: ProviderFactoryOptions): ProviderAdapter {
  const apiKey = options.credentials.qwenApiKey;
  if (apiKey === undefined || apiKey.trim().length === 0) {
    throw new Error("DASHSCOPE_API_KEY is required for qwen3.8-flash");
  }
  const coordinateMode = options.config.qwenCoordinateMode ?? "normalized_1000";
  const thinking = options.config.qwenThinking ?? "low";
  const outputMode = options.config.qwenOutputMode ?? "strict_json";
  return new Qwen38FlashAdapter({
    apiKey,
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
  if (apiKey === undefined || apiKey.trim().length === 0) {
    throw new Error("ZHIPUAI_API_KEY is required for GLM profiles");
  }
  const profile: GlmProfile = {
    ...glmProfiles["glm-5.3-flash"],
    thinking: options.config.glmThinking === "disabled" ? "disabled" : "enabled",
  };
  return new GlmAdapter({
    apiKey,
    profile,
    assetReader: options.assetReader,
    httpClient: options.httpClients?.glm ?? new RecordingGlmHttpClient(resolve(options.outputDir, "provider-exchanges.jsonl")),
    ...(options.config.glmEndpoint === undefined ? {} : { endpoint: options.config.glmEndpoint }),
  });
}
