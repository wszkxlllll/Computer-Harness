import { appendFile } from "node:fs/promises";
import { FetchGlmHttpClient, type GlmHttpClient } from "@computer-harness/provider-glm";
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

  public async post(url: string, body: Record<string, unknown>, headers: Readonly<Record<string, string>>, signal: AbortSignal): Promise<unknown> {
    this.requestNumber += 1;
    const startedAt = Date.now();
    const trustedModel = trustedProviderModel(body.model);
    const requestTools = providerRequestToolProjection(body);
    const requestConfiguration = glmRequestConfiguration(body);
    try {
      const response = await this.inner.post(url, body, headers, signal);
      await appendFile(this.path, `${JSON.stringify({
        provider: "glm",
        request: this.requestNumber,
        latencyMs: Date.now() - startedAt,
        requestedModel: trustedModel,
        requestConfiguration,
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
        provider: "glm",
        request: this.requestNumber,
        latencyMs: Date.now() - startedAt,
        requestedModel: trustedModel,
        requestConfiguration,
        toolNames: requestTools.toolNames,
        transportError: summarizeTransportError(error),
      })}\n`, "utf8");
      throw error;
    }
  }
}

/** Bounded wire metadata only: never request text, images, URLs or credentials. */
function glmRequestConfiguration(body: Record<string, unknown>): Record<string, unknown> {
  const thinking = body.thinking !== null && typeof body.thinking === "object" ? (body.thinking as Record<string, unknown>).type : undefined;
  const effort = body.reasoning_effort;
  const messages = Array.isArray(body.messages) ? body.messages : [];
  let imageCount = 0;
  for (const message of messages) {
    if (message === null || typeof message !== "object") continue;
    const content = (message as Record<string, unknown>).content;
    if (Array.isArray(content)) imageCount += content.filter((part) => part !== null && typeof part === "object" && (part as Record<string, unknown>).type === "image_url").length;
  }
  return {
    thinkingType: thinking === "enabled" || thinking === "disabled" ? thinking : null,
    reasoningEffort: effort === undefined ? "server_default" : effort === "low" || effort === "high" || effort === "max" ? effort : "unknown",
    maxTokens: typeof body.max_tokens === "number" && Number.isSafeInteger(body.max_tokens) && body.max_tokens >= 1 && body.max_tokens <= 131072 ? body.max_tokens : null,
    messageCount: messages.length,
    imageCount,
    toolCount: Array.isArray(body.tools) ? body.tools.length : 0,
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
