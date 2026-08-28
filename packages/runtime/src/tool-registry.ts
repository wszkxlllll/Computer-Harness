import type { JsonValue } from "@computer-harness/protocol";
import type { ModelToolSpec, ToolDefinition } from "./contracts.js";

export class ToolRegistry {
  private readonly definitions = new Map<string, ToolDefinition>();

  public register(definition: ToolDefinition): void {
    if (this.definitions.has(definition.name)) {
      throw new Error(`tool already registered: ${definition.name}`);
    }
    this.definitions.set(definition.name, definition);
  }

  public get(name: string): ToolDefinition | undefined {
    return this.definitions.get(name);
  }

  public list(): readonly ToolDefinition[] {
    return [...this.definitions.values()];
  }

  public modelTools(): ModelToolSpec[] {
    return this.list().map((definition) => {
      const base: ModelToolSpec = {
        name: definition.name,
        description: definition.description,
      };
      if (definition.inputSchema !== undefined) {
        base.inputSchema = definition.inputSchema;
      }
      return base;
    });
  }
}
