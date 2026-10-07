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
