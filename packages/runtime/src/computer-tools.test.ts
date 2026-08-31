import { describe, expect, it } from "vitest";
import { createDefaultComputerTools } from "./computer-tools.js";

describe("default Computer tools", () => {
  it("exposes one canonical definition for each V1 action", () => {
    const registry = createDefaultComputerTools();
    expect(registry.list().map((tool) => tool.name)).toEqual([
      "click", "type", "keypress", "hotkey", "scroll", "drag", "wait",
    ]);
    expect(registry.modelTools().every((tool) => tool.inputSchema !== undefined)).toBe(true);
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
});
