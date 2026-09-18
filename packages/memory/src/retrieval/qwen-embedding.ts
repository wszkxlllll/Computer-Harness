import type {
  MemoryEmbeddingBatch,
  MemoryEmbeddingInput,
  MemoryEmbeddingProvider,
} from "./types.js";

const QWEN_V4_DIMENSIONS = new Set([64, 128, 256, 512, 768, 1024, 1536, 2048]);

export interface QwenTextEmbeddingOptions {
  readonly endpoint: string;
  readonly apiKey: string;
  readonly model?: "text-embedding-v4";
  readonly dimensions?: number;
  readonly fetchImpl?: typeof fetch;
}

export class QwenEmbeddingError extends Error {
  public constructor(
    message: string,
    public readonly code: string,
    public readonly retryable = false,
  ) {
    super(message);
    this.name = "QwenEmbeddingError";
  }
}

/**
 * Qwen's OpenAI-compatible embedding adapter.  Endpoint and credentials are
 * explicit dependencies: this class never reads environment variables and
 * never falls back to the chat-completions endpoint.
 */
export class QwenTextEmbeddingProvider implements MemoryEmbeddingProvider {
  public readonly id = "qwen";
  public readonly model: "text-embedding-v4";
  public readonly dimensions: number;
  private readonly endpoint: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;

  public constructor(options: QwenTextEmbeddingOptions) {
    if (options.apiKey.trim().length === 0) throw new Error("Qwen embedding apiKey must be non-empty");
    const endpoint = new URL(options.endpoint);
    if (endpoint.protocol !== "https:") throw new Error("Qwen embedding endpoint must use https");
    const dimensions = options.dimensions ?? 1024;
    if (!QWEN_V4_DIMENSIONS.has(dimensions)) throw new Error("Qwen text-embedding-v4 dimensions are invalid");
    this.endpoint = endpoint.toString();
    this.apiKey = options.apiKey;
    this.model = options.model ?? "text-embedding-v4";
    this.dimensions = dimensions;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  public async embed(input: MemoryEmbeddingInput, options: { readonly signal: AbortSignal }): Promise<MemoryEmbeddingBatch> {
    if (input.texts.length === 0) throw new QwenEmbeddingError("Qwen embedding input is empty", "QWEN_EMBEDDING_EMPTY_INPUT");
    if (input.texts.length > 10) throw new QwenEmbeddingError("Qwen embedding batch exceeds the v4 limit", "QWEN_EMBEDDING_BATCH_LIMIT");
    for (const text of input.texts) {
      if (text.trim().length === 0) throw new QwenEmbeddingError("Qwen embedding input contains empty text", "QWEN_EMBEDDING_EMPTY_TEXT");
    }
    options.signal.throwIfAborted();
    const body = {
      model: this.model,
      input: input.texts.length === 1 ? input.texts[0]! : [...input.texts],
      dimensions: this.dimensions,
      encoding_format: "float",
    };
    let response: Response;
    try {
      response = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: options.signal,
      });
    } catch (error) {
      if (options.signal.aborted) throw options.signal.reason ?? error;
      throw new QwenEmbeddingError("Qwen embedding network request failed", "QWEN_EMBEDDING_NETWORK", true);
    }

    let payload: unknown;
    try {
      payload = await response.json() as unknown;
    } catch (error) {
      if (options.signal.aborted) throw options.signal.reason ?? error;
      throw new QwenEmbeddingError("Qwen embedding response was not JSON", "QWEN_EMBEDDING_INVALID_JSON", response.status >= 500);
    }
    if (!response.ok) {
      throw new QwenEmbeddingError(
        `Qwen embedding HTTP ${response.status}`,
        `QWEN_EMBEDDING_HTTP_${response.status}`,
        response.status === 429 || response.status >= 500,
      );
    }
    return parseQwenEmbeddingResponse(payload, input.texts.length, this.dimensions);
  }
}

function parseQwenEmbeddingResponse(value: unknown, expectedCount: number, dimensions: number): MemoryEmbeddingBatch {
  if (!isRecord(value) || !Array.isArray(value.data) || value.data.length !== expectedCount) {
    throw new QwenEmbeddingError("Qwen embedding response data shape is invalid", "QWEN_EMBEDDING_INVALID_RESPONSE");
  }
  const vectors: (readonly number[] | undefined)[] = new Array(expectedCount);
  for (const item of value.data) {
    if (!isRecord(item) || !Object.prototype.hasOwnProperty.call(item, "index")) {
      throw new QwenEmbeddingError("Qwen embedding response is missing an index", "QWEN_EMBEDDING_MISSING_INDEX");
    }
    const index = item.index;
    if (typeof index !== "number" || !Number.isSafeInteger(index) || index < 0 || index >= expectedCount || !Array.isArray(item.embedding)) {
      throw new QwenEmbeddingError("Qwen embedding response item shape is invalid", "QWEN_EMBEDDING_INVALID_RESPONSE");
    }
    const vectorIndex = index as number;
    if (vectors[vectorIndex] !== undefined) throw new QwenEmbeddingError("Qwen embedding response has duplicate indices", "QWEN_EMBEDDING_DUPLICATE_INDEX");
    const vector = item.embedding.map((component) => {
      if (typeof component !== "number" || !Number.isFinite(component)) throw new QwenEmbeddingError("Qwen embedding response has a non-finite component", "QWEN_EMBEDDING_INVALID_VECTOR");
      return component;
    });
    if (vector.length !== dimensions) throw new QwenEmbeddingError("Qwen embedding response dimension is invalid", "QWEN_EMBEDDING_INVALID_DIMENSIONS");
    const norm = Math.sqrt(vector.reduce((sum, component) => sum + component * component, 0));
    if (!Number.isFinite(norm) || norm === 0) throw new QwenEmbeddingError("Qwen embedding response contains a zero vector", "QWEN_EMBEDDING_ZERO_VECTOR");
    vectors[vectorIndex] = vector;
  }
  if (vectors.some((vector) => vector === undefined)) throw new QwenEmbeddingError("Qwen embedding response is missing an index", "QWEN_EMBEDDING_MISSING_INDEX");
  const usageRecord = isRecord(value.usage) ? value.usage : undefined;
  const totalTokens = usageRecord?.total_tokens;
  const usage = typeof totalTokens === "number" && Number.isSafeInteger(totalTokens) && totalTokens >= 0 ? { totalTokens } : undefined;
  return {
    vectors: vectors as readonly (readonly number[])[],
    ...(usage === undefined ? {} : { usage }),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
