import type { ComputerCapabilities, JsonValue } from "@computer-harness/protocol";
import type { ModelToolSpec, ToolAudience, ToolCategory, ToolDefinition } from "./contracts.js";

export class ToolRegistry {
  private readonly definitions = new Map<string, ToolDefinition>();

  public register(definition: ToolDefinition): void {
    if (this.definitions.has(definition.name)) {
      throw new Error(`tool already registered: ${definition.name}`);
    }
    this.definitions.set(definition.name, definition);
  }

  public registerMany(definitions: readonly ToolDefinition[]): void {
    for (const definition of definitions) this.register(definition);
  }

  public get(name: string): ToolDefinition | undefined {
    return this.definitions.get(name);
  }

  public getForAudience(name: string, audience: ToolAudience = "main"): ToolDefinition | undefined {
    const definition = this.get(name);
    return definition !== undefined && isVisibleTo(definition, audience) ? definition : undefined;
  }

  public list(): readonly ToolDefinition[] {
    return [...this.definitions.values()];
  }

  public modelTools(audience: ToolAudience = "main", options: { enabledCategories?: readonly ToolCategory[]; enabledToolNames?: readonly string[] } = {}): ModelToolSpec[] {
    const enabled = options.enabledCategories === undefined ? undefined : new Set(options.enabledCategories);
    const names = options.enabledToolNames === undefined ? undefined : new Set(options.enabledToolNames);
    return this.list().filter((definition) => isVisibleTo(definition, audience) && (enabled === undefined || enabled.has(definition.category)) && (names === undefined || names.has(definition.name))).map((definition) => {
      const base: ModelToolSpec = {
        name: definition.name,
        description: definition.description,
        category: definition.category,
      };
      if (definition.inputSchema !== undefined) {
        base.inputSchema = definition.inputSchema;
      }
      if (definition.coordinate !== undefined) {
        base.coordinate = { fields: [...definition.coordinate.fields] };
      }
      if (definition.category === "control") {
        base.control = definition.control;
      }
      return base;
    });
  }
}

/**
 * Apply backend capabilities to the model-visible tool set after a Computer
 * session is opened. Runtime still validates every action, but unavailable
 * built-in primitives should not be offered to the Provider in the first
 * place (for example, a window opt-in without verified keyboard focus).
 */
export function restrictToolNamesForCapabilities(
  registry: ToolRegistry,
  capabilities: ComputerCapabilities,
  enabledToolNames: readonly string[] | undefined,
): readonly string[] | undefined {
  if (capabilities.pointer && capabilities.keyboard) return enabledToolNames;
  const enabled = enabledToolNames === undefined ? undefined : new Set(enabledToolNames);
  const disabled = new Set<string>();
  if (!capabilities.pointer) {
    for (const name of ["click", "double_click", "right_click", "scroll", "drag"]) disabled.add(name);
  }
  if (!capabilities.keyboard) {
    for (const name of ["type", "keypress", "hotkey"]) disabled.add(name);
  }
  return registry.list()
    .map((definition) => definition.name)
    .filter((name) => (enabled === undefined || enabled.has(name)) && !disabled.has(name));
}


function isVisibleTo(definition: ToolDefinition, audience: ToolAudience): boolean {
  return definition.audiences === undefined ? audience === "main" : definition.audiences.includes(audience);
}
