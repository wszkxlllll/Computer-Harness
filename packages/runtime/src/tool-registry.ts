import type { JsonValue } from "@computer-harness/protocol";
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

function isVisibleTo(definition: ToolDefinition, audience: ToolAudience): boolean {
  return definition.audiences === undefined ? audience === "main" : definition.audiences.includes(audience);
}
