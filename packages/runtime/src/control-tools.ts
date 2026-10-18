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
      description: sourceLinkedFinish === undefined
        ? "Call exactly once, as the only tool call in the ModelTurn, to finish. Both arguments are required: status is success or failure and text is the complete user-facing result. Status means the requested task and deliverables are complete and verified, not that compared business records agree: a completed audit can succeed while reporting a discrepancy. Use failure for missing or unverified deliverables, preserving verified partial results and each unknown with its reason. Include all required list members, dates, units and caveats; omit unrelated extra facts. A successful tool receipt is not proof of completion."
        : "Call exactly once, as the only tool call in the ModelTurn, to finish. All three arguments are required: status is success or failure, text is the complete user-facing result, and resultEvidence follows the source-linked evidence schema. Source references are checked against this Run's committed observations and elements; they do not semantically verify claims. Status means requested work and deliverables are complete and verified, not that compared business records agree: a completed audit can succeed with a discrepancy. Use failure for missing or unverified deliverables. Preserve partial findings, unknown reasons, all required list members, dates, units and caveats in text; source fields do not replace them. A successful tool receipt is not proof of completion.",
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
    status: { type: "string", enum: ["success", "failure"], description: "Whether requested work and deliverables are complete and verified. A completed comparison may succeed with inconsistent records; failure means requested work is incomplete or unverified." },
    text: { type: "string", minLength: 1, description: "The complete user-facing result, not a status label. Preserve verified Unicode names/values with their dates, units, required lists and relevant caveats; identify unknown requested fields and evidence gaps. Do not expand into unrequested categories." },
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
