/** Local supported cap follows the official model's 128K maximum output;
 * a custom gateway may still impose a lower bound. No timeout is changed. */
export function parseGlmOutputBudget(raw = "8192"): number {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > 131072) {
    throw new Error("--glm-max-output-tokens must be a positive integer no greater than 131072.");
  }
  return value;
}
