/** Local supported cap follows the official model's 128K maximum output;
 * a custom gateway may still impose a lower bound. No timeout is changed. */
export function parseGlmOutputBudget(raw = "8192"): number {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > 131072) {
    throw new Error("--glm-max-output-tokens must be a positive integer no greater than 131072.");
  }
  return value;
}

export function parseGlmInputBudgets(
  textRaw = "16384",
  wireRaw = "24576",
): { contextMaxInputTokens: number; contextMaxWireInputTokens: number } {
  const text = Number(textRaw);
  const wire = Number(wireRaw);
  if (![text, wire].every((value) => Number.isSafeInteger(value) && value >= 1 && value <= 131072) || text > wire) {
    throw new Error("GLM input budgets must be integers from 1 to 131072, with text no greater than wire.");
  }
  return { contextMaxInputTokens: text, contextMaxWireInputTokens: wire };
}
export const DEFAULT_GLM_REQUEST_TIMEOUT_MS = 90_000;
export const MIN_GLM_REQUEST_TIMEOUT_MS = 1_000;
export const MAX_GLM_REQUEST_TIMEOUT_MS = 240_000;

export function parseGlmRequestTimeoutMs(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_GLM_REQUEST_TIMEOUT_MS;
  const value = Number(raw.trim());
  if (!Number.isSafeInteger(value) || value < MIN_GLM_REQUEST_TIMEOUT_MS || value > MAX_GLM_REQUEST_TIMEOUT_MS) {
    throw new Error(`GLM_REQUEST_TIMEOUT_MS must be an integer from ${MIN_GLM_REQUEST_TIMEOUT_MS} to ${MAX_GLM_REQUEST_TIMEOUT_MS}.`);
  }
  return value;
}

export function readGlmThinking(value: string | undefined): "enabled" | "low" | "high" | "max" {
  const configured = value?.trim();
  if (configured === undefined || configured === "") return "enabled";
  if (configured === "disabled") return "enabled";
  if (configured === "enabled" || configured === "low" || configured === "high" || configured === "max") return configured;
  throw new Error("GLM_THINKING must be enabled, disabled, low, high, or max.");
}

export function glmReasoningEffort(thinking: string | undefined): "low" | "high" | "max" | "server_default" {
  return thinking === "low" || thinking === "high" || thinking === "max" ? thinking : "server_default";
}
