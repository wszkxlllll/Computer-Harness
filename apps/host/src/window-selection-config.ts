import { createJevWindowSelector, type WindowSelectionStrategy } from "@computer-harness/app-runtime";

/** Host target selection stays local unless an operator explicitly opts in. */
export function resolveHostWindowSelector(
  env: Readonly<Record<string, string | undefined>>,
): WindowSelectionStrategy | undefined {
  const mode = env.HARNESS_WINDOW_SELECTOR;
  if (mode === undefined || mode.trim().length === 0 || mode === "local") return undefined;
  if (mode !== "jev") throw new Error("HARNESS_WINDOW_SELECTOR must be local or jev.");
  const apiKey = env.TYPESAFE_API_KEY;
  if (apiKey === undefined || apiKey.trim().length === 0) {
    throw new Error("HARNESS_WINDOW_SELECTOR=jev requires TYPESAFE_API_KEY.");
  }
  return createJevWindowSelector(apiKey);
}
