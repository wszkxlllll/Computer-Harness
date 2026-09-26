export type TuiGroundingChoice = "auto" | "off" | "uia-catalog-v1" | "dom-catalog-v1" | "hybrid-catalog-v1";
export type RunGrounding = Exclude<TuiGroundingChoice, "auto">;

/** A title or browser-looking process never proves that Harness owns CDP. */
export function resolveTuiGrounding(
  choice: TuiGroundingChoice,
  selection: "desktop" | "host-window" | "managed-browser",
): RunGrounding {
  if (choice !== "auto") return choice;
  if (selection === "managed-browser") return "hybrid-catalog-v1";
  if (selection === "host-window") return "uia-catalog-v1";
  return "off";
}
