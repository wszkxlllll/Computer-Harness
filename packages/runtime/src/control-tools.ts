import type { JsonValue } from "@computer-harness/protocol";
import type { ControlToolDefinition } from "./contracts.js";
import { defaultComputerTools } from "./computer-tools.js";
import { ToolRegistry } from "./tool-registry.js";

/**
 * Control decisions are model-visible definitions, not executable GUI tools.
 * Providers map these declarations to ModelTurn.finish/user_input_required.
 */
export function defaultControlTools(): readonly ControlToolDefinition[] {
  return [
    {
      name: "terminate",
      description: "Finish the task and report whether the user's goal is complete. A successful tool receipt is not proof of completion.",
      category: "control",
      control: "finish",
      inputSchema: {
        type: "object",
        properties: {
          status: { type: "string", enum: ["success", "failure"], description: "Whether the user goal is complete." },
          text: { type: "string", description: "A concise final summary." },
        },
        required: ["status"],
        additionalProperties: false,
      },
      validate: validateTerminate,
    },
    {
      name: "interact",
      description: "Ask the user for information or confirmation when the task cannot safely proceed without it.",
      category: "control",
      control: "user_input_required",
      inputSchema: {
        type: "object",
        properties: { text: { type: "string", minLength: 1, description: "The question or requested information." } },
        required: ["text"],
        additionalProperties: false,
      },
      validate: validateInteract,
    },
  ];
}

function validateTerminate(args: JsonValue): void {
  if (!isRecord(args) || (args.status !== "success" && args.status !== "failure") || (args.text !== undefined && typeof args.text !== "string")) {
    throw new Error("terminate requires status success/failure and optional text");
  }
}

function validateInteract(args: JsonValue): void {
  if (!isRecord(args) || typeof args.text !== "string" || args.text.trim().length === 0) {
    throw new Error("interact requires non-empty text");
  }
}

function isRecord(value: JsonValue): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function registerDefaultControlTools(registry: ToolRegistry): void {
  registry.registerMany(defaultControlTools());
}

export function createDefaultToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  // Keep the existing Computer-only helper as a compatibility surface while
  // making this function the single default composition entry point.
  registry.registerMany([...defaultComputerTools(), ...defaultControlTools()]);
  return registry;
}
