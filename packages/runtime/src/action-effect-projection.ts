import type {
  ActionEffectDeclaration,
  DeclaredActionEffect,
  JsonValue,
  ToolCall,
} from "@computer-harness/protocol";
import type { ModelToolSpec } from "./contracts.js";

export const HARNESS_EFFECT_KEY = "_harnessEffect";
export const declaredActionEffects = [
  "observe",
  "navigate",
  "local_edit",
  "destructive",
  "financial",
  "external_commitment",
  "sensitive_disclosure",
  "security_change",
  "unknown",
] as const satisfies readonly DeclaredActionEffect[];

const effectSchema: JsonValue = {
  type: "object",
  description: "Describe the immediate expected effect of this Computer call. Report this call only, not the eventual goal. Use unknown when uncertain.",
  properties: {
    effects: {
      type: "array",
      minItems: 1,
      maxItems: declaredActionEffects.length,
      uniqueItems: true,
      items: { type: "string", enum: [...declaredActionEffects] },
    },
    target: { type: "string", minLength: 1, maxLength: 120, description: "Short visible or intended target; do not include secrets." },
    summary: { type: "string", minLength: 1, maxLength: 240, description: "Immediate expected effect; do not include private content or reasoning." },
  },
  required: ["effects", "target", "summary"],
  additionalProperties: false,
};

export function decorateToolsWithActionEffects(tools: readonly ModelToolSpec[]): ModelToolSpec[] {
  return tools.map((tool) => tool.category === "computer" ? decorateComputerTool(tool) : structuredClone(tool));
}

function decorateComputerTool(tool: ModelToolSpec): ModelToolSpec {
  if (!isRecord(tool.inputSchema)) throw new Error(`Computer tool ${tool.name} requires an object inputSchema for action effects`);
  const properties = isRecord(tool.inputSchema.properties) ? tool.inputSchema.properties : {};
  const required = Array.isArray(tool.inputSchema.required)
    ? tool.inputSchema.required.filter((item): item is string => typeof item === "string")
    : [];
  return {
    ...tool,
    inputSchema: {
      ...tool.inputSchema,
      type: "object",
      properties: { ...properties, [HARNESS_EFFECT_KEY]: effectSchema },
      required: [...new Set([...required, HARNESS_EFFECT_KEY])],
    },
  };
}

export function splitActionEffectArguments(
  tool: ModelToolSpec | undefined,
  argumentsValue: JsonValue,
): { arguments: JsonValue; declaredEffect?: ActionEffectDeclaration } {
  if (tool?.category !== "computer" || !toolRequiresActionEffect(tool)) return { arguments: argumentsValue };
  if (!isRecord(argumentsValue)) throw new Error(`Computer tool ${tool.name} arguments must be an object`);
  const raw = argumentsValue[HARNESS_EFFECT_KEY];
  const declaredEffect = parseActionEffectDeclaration(raw);
  const clean: Record<string, JsonValue> = { ...argumentsValue };
  delete clean[HARNESS_EFFECT_KEY];
  return { arguments: clean, declaredEffect };
}

export function encodeToolCallArguments(tool: ModelToolSpec | undefined, call: ToolCall): JsonValue {
  if (call.declaredEffect === undefined || tool?.category !== "computer" || !toolRequiresActionEffect(tool)) return call.arguments;
  if (!isRecord(call.arguments)) throw new Error(`Computer tool ${call.name} history arguments must be an object`);
  return { ...call.arguments, [HARNESS_EFFECT_KEY]: call.declaredEffect as unknown as JsonValue };
}

export function toolRequiresActionEffect(tool: ModelToolSpec): boolean {
  return isRecord(tool.inputSchema) && isRecord(tool.inputSchema.properties) && HARNESS_EFFECT_KEY in tool.inputSchema.properties;
}

export function parseActionEffectDeclaration(value: JsonValue | undefined): ActionEffectDeclaration {
  if (!isRecord(value)) throw new Error(`${HARNESS_EFFECT_KEY} must be an object`);
  const keys = Object.keys(value);
  if (keys.some((key) => key !== "effects" && key !== "target" && key !== "summary")) {
    throw new Error(`${HARNESS_EFFECT_KEY} contains an unsupported field`);
  }
  if (!Array.isArray(value.effects) || value.effects.length === 0 || value.effects.length > declaredActionEffects.length) {
    throw new Error(`${HARNESS_EFFECT_KEY}.effects must be a non-empty array`);
  }
  const effects: DeclaredActionEffect[] = [];
  for (const item of value.effects) {
    if (typeof item !== "string" || !declaredActionEffects.includes(item as DeclaredActionEffect)) {
      throw new Error(`${HARNESS_EFFECT_KEY}.effects contains an unknown effect`);
    }
    if (effects.includes(item as DeclaredActionEffect)) throw new Error(`${HARNESS_EFFECT_KEY}.effects must be unique`);
    effects.push(item as DeclaredActionEffect);
  }
  if (typeof value.target !== "string" || value.target.trim().length === 0 || value.target.length > 120) {
    throw new Error(`${HARNESS_EFFECT_KEY}.target must be 1-120 characters`);
  }
  if (typeof value.summary !== "string" || value.summary.trim().length === 0 || value.summary.length > 240) {
    throw new Error(`${HARNESS_EFFECT_KEY}.summary must be 1-240 characters`);
  }
  if (containsLikelySecret(`${value.target}\n${value.summary}`)) {
    throw new Error(`${HARNESS_EFFECT_KEY} must not contain credentials or financial identifiers`);
  }
  return { effects, target: value.target.trim(), summary: value.summary.trim() };
}

function containsLikelySecret(value: string): boolean {
  return /(?:sk-[A-Za-z0-9_-]{16,}|\b\d{13,19}\b|(?:password|token|secret|验证码|密码)\s*[:：=]\s*\S+)/iu.test(value);
}

function isRecord(value: unknown): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
