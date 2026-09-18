import type { AppRuntimeModel } from "@computer-harness/app-runtime";

/** Ordinary Runs must name their Provider; doctor alone may use an internal placeholder. */
export function resolveCliModel(value: string | undefined, doctor: boolean): AppRuntimeModel {
  if (value === undefined) {
    if (doctor) return "glm-5.3-flash";
    throw new Error("--model is required for a Run");
  }
  if (value !== "glm-5.3-flash" && value !== "qwen3.8-flash") {
    throw new Error("--model must be glm-5.3-flash or qwen3.8-flash");
  }
  return value;
}
