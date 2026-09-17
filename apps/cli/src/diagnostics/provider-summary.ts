/**
 * Provider response summaries used by the CLI's private recording path.
 *
 * This module intentionally has no CLI entrypoint, environment loading,
 * filesystem access, or HTTP dependency. F06/R02 redaction and strict flat
 * calls[] normalization are a later behavior change; this first extraction
 * preserves the current projection for an independent review.
 */

export function providerToolNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => isPlainRecord(item) && isPlainRecord(item.function) && typeof item.function.name === "string" ? [item.function.name] : []);
}

export function summarizeProviderResponse(value: unknown): Record<string, unknown> {
  if (!isPlainRecord(value)) return { shape: typeof value };
  const choice = Array.isArray(value.choices) && isPlainRecord(value.choices[0]) ? value.choices[0] : undefined;
  const message = choice !== undefined && isPlainRecord(choice.message) ? choice.message : undefined;
  const calls = message !== undefined && Array.isArray(message.tool_calls)
    ? message.tool_calls.map((call) => {
        const record = isPlainRecord(call) ? call : undefined;
        const fn = record !== undefined && isPlainRecord(record.function) ? record.function : undefined;
        return {
          id: record !== undefined && typeof record.id === "string" ? record.id : null,
          type: record !== undefined && typeof record.type === "string" ? record.type : null,
          name: fn !== undefined && typeof fn.name === "string" ? fn.name : null,
          arguments: fn !== undefined && typeof fn.arguments === "string" ? fn.arguments : null,
        };
      })
    : [];
  return {
    model: typeof value.model === "string" ? value.model : null,
    finishReason: choice !== undefined && typeof choice.finish_reason === "string" ? choice.finish_reason : null,
    contentLength: message !== undefined && typeof message.content === "string" ? message.content.length : 0,
    reasoningContentLength: message !== undefined && typeof message.reasoning_content === "string" ? message.reasoning_content.length : 0,
    toolCalls: calls,
    structuredContent: summarizeStructuredContent(message?.content),
    usage: isPlainRecord(value.usage) ? value.usage : null,
  };
}

export function summarizeStructuredContent(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "string") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    return { json: false };
  }
  if (!isPlainRecord(parsed)) return { json: true, rootType: Array.isArray(parsed) ? "array" : typeof parsed };
  return {
    json: true,
    kind: typeof parsed.kind === "string" ? parsed.kind : null,
    id: typeof parsed.id === "string" ? parsed.id : null,
    name: typeof parsed.name === "string" ? parsed.name : null,
    arguments: summarizeProviderArguments(parsed.arguments),
    textLength: typeof parsed.text === "string" ? parsed.text.length : 0,
  };
}

export function summarizeProviderArguments(value: unknown): Record<string, unknown> | null {
  if (!isPlainRecord(value)) return null;
  const result: Record<string, unknown> = {};
  for (const key of ["x", "y", "fromX", "fromY", "toX", "toY", "durationMs", "ticks", "direction", "status"]) {
    const item = value[key];
    if (typeof item === "number" || typeof item === "string") result[key] = item;
  }
  if (typeof value.text === "string") result.textLength = value.text.length;
  if (Array.isArray(value.keys)) result.keyCount = value.keys.length;
  return result;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
