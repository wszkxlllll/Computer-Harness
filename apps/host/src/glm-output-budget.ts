/** Local supported cap follows the official model's 128K maximum output;
 * a custom gateway may still impose a lower bound. No timeout is changed. */
export function parseGlmOutputBudget(raw = "8192"): number {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > 131072) {
    throw new Error("--glm-max-output-tokens must be a positive integer no greater than 131072.");
  }
  return value;
}

export function parseGlmInputBudgets(textRaw = "16384", wireRaw = "24576"): { contextMaxInputTokens: number; contextMaxWireInputTokens: number } {
  const text = Number(textRaw);
  const wire = Number(wireRaw);
  if (![text, wire].every((value) => Number.isSafeInteger(value) && value >= 1 && value <= 131072) || text > wire) throw new Error("GLM input budgets must be integers from 1 to 131072, with text no greater than wire.");
  return { contextMaxInputTokens: text, contextMaxWireInputTokens: wire };
}

/** Interactive Host default only; the provider profile retains its own default. */
export function readGlmThinking(value: string | undefined): "enabled" | "low" | "high" | "max" {
  const configured = value?.trim();
  if (configured === undefined || configured === "") return "low";
  // Preserve the existing GLM-5.3 compatibility mapping: thinking cannot be disabled.
  if (configured === "disabled") return "enabled";
  if (configured === "enabled" || configured === "low" || configured === "high" || configured === "max") return configured;
  throw new Error("GLM_THINKING must be enabled, disabled, low, high, or max.");
}

/** server_default means omitted on the wire, not a verified gateway choice. */
export function glmReasoningEffort(thinking: string | undefined): "low" | "high" | "max" | "server_default" {
  return thinking === "low" || thinking === "high" || thinking === "max" ? thinking : "server_default";
}
