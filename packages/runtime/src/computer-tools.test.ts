import { describe, expect, it } from "vitest";
import { createDefaultComputerTools, groundingComputerTools } from "./computer-tools.js";
import { createDefaultToolRegistry } from "./control-tools.js";
import { restrictToolNamesForCapabilities } from "./tool-registry.js";

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
    const terminate = registry.modelTools().find((tool) => tool.name === "terminate");
    const terminateDefinition = registry.get("terminate");
    expect(terminate).toMatchObject({ category: "control", control: "finish", inputSchema: { required: ["status", "text"] } });
    expect(terminateDefinition?.category).toBe("control");
    if (terminateDefinition?.category === "control") {
      expect(() => terminateDefinition.validate({ status: "success" })).toThrow(/non-empty.*text/iu);
      expect(() => terminateDefinition.validate({ status: "success", text: "  " })).toThrow(/non-empty.*text/iu);
      expect(() => terminateDefinition.validate({ status: "success", text: "done" })).toThrow(/result text/iu);
      expect(() => terminateDefinition.validate({ status: "success", text: "Observed result" })).not.toThrow();
    }
  });

  it("does not offer keyboard primitives when keyboard focus is not verified", () => {
    const registry = createDefaultToolRegistry();
    const names = restrictToolNamesForCapabilities(registry, { screenshot: true, pointer: true, keyboard: false, accessibility: false }, undefined);
    expect(names).toContain("click");
    expect(names).not.toContain("type");
    expect(names).not.toContain("keypress");
    expect(names).not.toContain("hotkey");
  });

  it("maps click_element to a bounded current-catalog center", () => {
    const definition = groundingComputerTools()[0];
    expect(definition?.name).toBe("click_element");
    if (definition === undefined || definition.category !== "computer") throw new Error("grounding tool missing");
    const context = {
      runId: "run" as never,
      session: {} as never,
      signal: new AbortController().signal,
      observation: {
        id: "observation" as never,
        runId: "run" as never,
        computerSessionId: "session" as never,
        capturedAt: "2026-09-20T00:00:00Z",
        viewport: { width: 800, height: 600, coordinateSpace: "physical" as const },
        screenshot: { assetId: "asset" as never, relativePath: "screenshots/a.png", mediaType: "image/png", byteLength: 1 },
        grounding: {
          version: "uia-catalog-v1" as const,
          source: "uia" as const,
          observationId: "observation" as never,
          computerSessionId: "session" as never,
          completeness: "partial" as const,
          degraded: false,
          maxElements: 16,
          elements: [{ elementRef: "uia-1", role: "ComboBox", name: "Departure", bbox: { x: 100, y: 200, width: 80, height: 20, coordinateSpace: "physical" as const }, state: { enabled: true } }],
        },
      },
    };
    expect(definition.toAction({ elementRef: "uia-1" }, context)).toEqual({ kind: "click", point: { x: 140, y: 210 }, groundingRef: "uia-1" });
    expect(() => definition.toAction({ elementRef: "uia-1" }, { ...context, observation: undefined })).toThrow(/GROUNDING_CATALOG_UNAVAILABLE/iu);
    expect(() => definition.toAction({ elementRef: "uia-old-1" }, context)).toThrow(/GROUNDING_REF_NOT_FOUND/iu);
    const disabledContext = {
      ...context,
      observation: {
        ...context.observation,
        grounding: { ...context.observation!.grounding!, elements: [{ ...context.observation!.grounding!.elements[0]!, state: { enabled: false } }] },
      },
    };
    expect(() => definition.toAction({ elementRef: "uia-1" }, disabledContext)).toThrow(/GROUNDING_ELEMENT_DISABLED/iu);
  });

  it("exposes select_option only for managed DOM grounding and binds exact option text", () => {
    expect(groundingComputerTools().map((tool) => tool.name)).toEqual(["click_element"]);
    const definition = groundingComputerTools({ includeSelectOption: true }).find((tool) => tool.name === "select_option");
    expect(definition?.inputSchema).toMatchObject({
      properties: {
        elementRef: { type: "string", minLength: 1, maxLength: 96 },
        optionText: { type: "string", minLength: 1, maxLength: 160 },
      },
      required: ["elementRef", "optionText"],
      additionalProperties: false,
    });
    if (definition === undefined || definition.category !== "computer") throw new Error("select_option tool missing");
    expect(() => definition.validate({ elementRef: "dom-1", optionText: "  " })).toThrow(/non-empty/iu);
    expect(() => definition.validate({ elementRef: "dom-1", optionText: "x".repeat(161) })).toThrow(/160/iu);
    const observation = {
      id: "dom-observation" as never,
      runId: "run" as never,
      computerSessionId: "session" as never,
      capturedAt: "2026-09-20T00:00:00Z",
      viewport: { width: 800, height: 600, coordinateSpace: "physical" as const },
      screenshot: { assetId: "asset" as never, relativePath: "screenshots/a.png", mediaType: "image/png" as const, byteLength: 1 },
      grounding: {
        version: "grounding-catalog-v2" as const,
        source: "dom" as const,
        observationId: "dom-observation" as never,
        computerSessionId: "session" as never,
        completeness: "complete" as const,
        degraded: false,
        maxElements: 16,
        elements: [{ elementRef: "dom-1", role: "combobox", name: "Departure", source: "dom" as const, browserRegion: "content" as const, bbox: { x: 100, y: 200, width: 80, height: 20, coordinateSpace: "physical" as const }, options: [{ text: "08:00", enabled: true }], optionsTruncated: false, state: { enabled: true } }],
      },
    };
    const context = { runId: "run" as never, session: {} as never, signal: new AbortController().signal, observation };
    expect(definition.toAction({ elementRef: "dom-1", optionText: "  08:00  " }, context)).toEqual({ kind: "select_option", groundingRef: "dom-1", optionText: "08:00" });
    expect(() => definition.toAction({ elementRef: "dom-1", optionText: "08:00" }, { ...context, observation: { ...observation, grounding: { ...observation.grounding!, source: "uia", version: "uia-catalog-v1", elements: [{ ...observation.grounding!.elements[0]!, source: "uia" }] } } })).toThrow(/DOM_REQUIRED/iu);
  });

  it("fails closed when the listed native-select options are missing, duplicate, disabled, or truncated", () => {
    const definition = groundingComputerTools({ includeSelectOption: true }).find((tool) => tool.name === "select_option");
    if (definition === undefined || definition.category !== "computer") throw new Error("select_option tool missing");
    const observation = {
      id: "dom-options" as never,
      runId: "run" as never,
      computerSessionId: "session" as never,
      capturedAt: "2026-09-20T00:00:00Z",
      viewport: { width: 800, height: 600, coordinateSpace: "physical" as const },
      screenshot: { assetId: "asset" as never, relativePath: "screenshots/a.png", mediaType: "image/png" as const, byteLength: 1 },
      grounding: {
        version: "grounding-catalog-v2" as const,
        source: "dom" as const,
        observationId: "dom-options" as never,
        computerSessionId: "session" as never,
        completeness: "complete" as const,
        degraded: false,
        maxElements: 16,
        elements: [{ elementRef: "dom-options-ref", role: "combobox", source: "dom" as const, bbox: { x: 1, y: 1, width: 100, height: 20, coordinateSpace: "physical" as const }, state: { enabled: true }, options: [{ text: "08:00", enabled: true }], optionsTruncated: false }],
      },
    };
    const context = { runId: "run" as never, session: {} as never, signal: new AbortController().signal, observation };
    expect(() => definition.toAction({ elementRef: "dom-options-ref", optionText: "09:00" }, context)).toThrow(/OPTION_MISSING/iu);
    expect(() => definition.toAction({ elementRef: "dom-options-ref", optionText: "08:00" }, { ...context, observation: { ...observation, grounding: { ...observation.grounding, elements: [{ ...observation.grounding.elements[0]!, options: [{ text: "08:00", enabled: false }] }] } } })).toThrow(/OPTION_DISABLED/iu);
    expect(() => definition.toAction({ elementRef: "dom-options-ref", optionText: "08:00" }, { ...context, observation: { ...observation, grounding: { ...observation.grounding, elements: [{ ...observation.grounding.elements[0]!, options: [{ text: "08:00", enabled: true }, { text: "08:00", enabled: true }] }] } } })).toThrow(/OPTION_AMBIGUOUS/iu);
    expect(() => definition.toAction({ elementRef: "dom-options-ref", optionText: "08:00" }, { ...context, observation: { ...observation, grounding: { ...observation.grounding, elements: [{ ...observation.grounding.elements[0]!, optionsTruncated: true }] } } })).toThrow(/OPTIONS_TRUNCATED/iu);
  });

});
