import { appendFile } from "node:fs/promises";
import { FetchGlmHttpClient, type GlmHttpClient } from "@computer-harness/provider-glm";
import { FetchQwenHttpClient, type QwenHttpClient, type Qwen38OutputMode, type Qwen38ThinkingMode, type QwenCoordinateMode } from "@computer-harness/provider-qwen";
import {
  providerRequestToolProjection,
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
    try {
      const response = await this.inner.post(url, body, headers, signal);
      await appendFile(this.path, `${JSON.stringify({
        provider: "glm",
        request: this.requestNumber,
        latencyMs: Date.now() - startedAt,
        requestedModel: trustedModel,
        toolNames: requestTools.toolNames,
        response: summarizeProviderResponse(response, {
          allowedToolNames: requestTools.allowedToolNames,
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
        transportError: summarizeTransportError(error),
      })}\n`, "utf8");
      throw error;
    }
  }
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
