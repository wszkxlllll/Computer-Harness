import { describe, expect, it } from "vitest";
import { createDefaultComputerTools } from "./computer-tools.js";
import { createDefaultToolRegistry } from "./control-tools.js";

describe("default Computer tools", () => {
  it("exposes one canonical definition for each V1 action", () => {
    const registry = createDefaultComputerTools();
    expect(registry.list().map((tool) => tool.name)).toEqual([
      "click", "type", "keypress", "hotkey", "scroll", "drag", "wait",
    ]);
    expect(registry.modelTools().every((tool) => tool.inputSchema !== undefined)).toBe(true);
  });

  it("keeps model-facing fields explicit and required", () => {
    const tools = createDefaultComputerTools().modelTools();
    const click = tools.find((tool) => tool.name === "click");
    expect(click?.inputSchema).toMatchObject({
      properties: {
        x: { description: expect.stringContaining("coordinate") },
        y: { description: expect.stringContaining("coordinate") },
      },
      required: ["x", "y"],
      additionalProperties: false,
    });
    const scroll = tools.find((tool) => tool.name === "scroll");
    expect(scroll?.inputSchema).toMatchObject({ required: ["x", "y", "direction", "ticks"] });
  });

  it("validates and maps canonical arguments without provider-specific logic", () => {
    const registry = createDefaultComputerTools();
    const context = {
      runId: "run" as never,
      session: {} as never,
      signal: new AbortController().signal,
    };
    const scroll = registry.get("scroll");
    expect(scroll?.category).toBe("computer");
    if (scroll?.category === "computer") {
      expect(scroll.toAction({ x: 4, y: 5, direction: "down", ticks: 2 }, context)).toEqual({
        kind: "scroll", point: { x: 4, y: 5 }, direction: "down", ticks: 2,
      });
      expect(() => scroll.validate({ x: 4, y: 5, direction: "down", ticks: 0 })).toThrow(/positive integer/);
    }
    const drag = registry.get("drag");
    if (drag?.category === "computer") {
      expect(drag.toAction({ fromX: 1, fromY: 2, toX: 3, toY: 4 }, context)).toEqual({
        kind: "drag", from: { x: 1, y: 2 }, to: { x: 3, y: 4 },
      });
    }
  });

  it("projects controls and audience permissions from one registry", () => {
    const registry = createDefaultToolRegistry();
    registry.register({
      name: "advisor_note",
      description: "Read-only advisor note.",
      category: "side",
      audiences: ["advisor"],
      inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
      validate: () => undefined,
      execute: async () => ({ ok: true }),
    });
    expect(registry.modelTools().map((tool) => tool.name)).toContain("terminate");
    expect(registry.modelTools().map((tool) => tool.name)).not.toContain("advisor_note");
    expect(registry.modelTools("advisor").map((tool) => tool.name)).toEqual(["advisor_note"]);
    expect(registry.getForAudience("advisor_note")).toBeUndefined();
    expect(registry.getForAudience("advisor_note", "advisor")?.category).toBe("side");
    expect(registry.modelTools().find((tool) => tool.name === "click")).toMatchObject({ category: "computer", coordinate: { fields: ["x", "y"] } });
    expect(registry.modelTools().find((tool) => tool.name === "terminate")).toMatchObject({ category: "control", control: "finish" });
  });
});
