import type { JsonValue, SourceLinkedFinishContract } from "@computer-harness/protocol";
import type { ControlToolDefinition } from "./contracts.js";
import { defaultComputerTools } from "./computer-tools.js";
import { ToolRegistry } from "./tool-registry.js";
import { isActionableFinishSummary } from "./finish-summary.js";
import { validateSourceLinkedFinishContract } from "./source-linked-finish.js";

export interface ControlToolFactoryOptions {
  readonly sourceLinkedFinish?: SourceLinkedFinishContract;
}

/**
 * Control decisions are model-visible definitions, not executable GUI tools.
 * Providers map these declarations to ModelTurn.finish/user_input_required.
 */
export function defaultControlTools(options: ControlToolFactoryOptions = {}): readonly ControlToolDefinition[] {
  const sourceLinkedFinish = validateSourceLinkedFinishContract(options.sourceLinkedFinish);
  return [
    {
      name: "terminate",
      description: "Call exactly once to finish, with both required arguments: status must be success or failure, and text must be the complete user-facing result. Use failure when requested deliverables are missing or unverified. A successful tool receipt is not proof of completion.",
      category: "control",
      control: "finish",
      inputSchema: createTerminateInputSchema(sourceLinkedFinish !== undefined),
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
  if (!isRecord(args) || (args.status !== "success" && args.status !== "failure") || typeof args.text !== "string" || !isActionableFinishSummary(args.text)) {
    throw new Error("terminate requires status success/failure and non-empty result text");
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

export function registerDefaultControlTools(
  registry: ToolRegistry,
  options: ControlToolFactoryOptions = {},
): void {
  registry.registerMany(defaultControlTools(options));
}

export function createDefaultToolRegistry(options: ControlToolFactoryOptions = {}): ToolRegistry {
  const registry = new ToolRegistry();
  // Keep the existing Computer-only helper as a compatibility surface while
  // making this function the single default composition entry point.
  registry.registerMany([...defaultComputerTools(), ...defaultControlTools(options)]);
  return registry;
}

function createTerminateInputSchema(sourceLinkedFinish: boolean): JsonValue {
  const properties: Record<string, JsonValue> = {
    status: { type: "string", enum: ["success", "failure"], description: "Whether the user goal is complete." },
    text: { type: "string", minLength: 1, description: "The complete user-facing result. Include every requested deliverable and relevant caveat; do not return only a completion status." },
  };
  if (sourceLinkedFinish) properties.resultEvidence = sourceLinkedFinishSchema();
  return {
    type: "object",
    properties,
    required: sourceLinkedFinish ? ["status", "text", "resultEvidence"] : ["status", "text"],
    additionalProperties: false,
  };
}

function sourceLinkedFinishSchema(): JsonValue {
  return {
    type: "object",
    properties: {
      version: { type: "string", const: "source-linked-finish-v1" },
      fields: {
        type: "array",
        maxItems: 32,
        items: {
          oneOf: [
            {
              type: "object",
              properties: {
                fieldId: { type: "string", minLength: 1, maxLength: 64 },
                disposition: { type: "string", const: "source_bound" },
                sources: {
                  type: "array", minItems: 1, maxItems: 4,
                  items: {
                    type: "object",
                    properties: {
                      observationId: { type: "string", minLength: 1, maxLength: 128 },
                      elementRef: { type: "string", minLength: 1, maxLength: 96 },
                    },
                    required: ["observationId", "elementRef"],
                    additionalProperties: false,
                  },
                },
              },
              required: ["fieldId", "disposition", "sources"],
              additionalProperties: false,
            },
            {
              type: "object",
              properties: {
                fieldId: { type: "string", minLength: 1, maxLength: 64 },
                disposition: { type: "string", const: "inference" },
                reason: { type: "string", minLength: 1, maxLength: 240 },
              },
              required: ["fieldId", "disposition", "reason"],
              additionalProperties: false,
            },
            {
              type: "object",
              properties: {
                fieldId: { type: "string", minLength: 1, maxLength: 64 },
                disposition: { type: "string", const: "unknown" },
                reason: { type: "string", enum: ["not_observed", "no_grounding", "ambiguous_source", "conflicting_sources", "source_unavailable"] },
              },
              required: ["fieldId", "disposition", "reason"],
              additionalProperties: false,
            },
          ],
        },
      },
    },
    required: ["version", "fields"],
    additionalProperties: false,
  };
}
