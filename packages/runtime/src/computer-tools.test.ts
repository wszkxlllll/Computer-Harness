import { describe, expect, it } from "vitest";
import { createDefaultComputerTools, groundingComputerTools, windowSwitchTools } from "./computer-tools.js";
import { createDefaultToolRegistry } from "./control-tools.js";
import { restrictToolNamesForCapabilities } from "./tool-registry.js";

const surfaceRef = { surfaceId: "computer-tools-desktop" as never, generation: 1, kind: "desktop" as const };

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
    const type = tools.find((tool) => tool.name === "type");
    expect(type?.description).toContain("appends to the end of the target's current value regardless of caret or selection");
    expect(type?.description).toContain("prefer a current UIA editable elementRef");
    expect(type?.description).toContain("complete and identifies one unambiguous editable UIA control");
    expect(type?.description).toContain("partial catalog may be refused rather than guessed");
    expect(type?.description).toContain("soft-wrapped visual lines are not paragraph boundaries");
    expect(type?.description).toContain("Windows desktop-wide CUA multiline input is not supported by this path");
    expect(type?.description).toContain("only when the target is confirmed to accept line breaks and the Goal calls for them");
    expect(type?.description).toContain("Enter is a real key event and can submit/send");
    expect(type?.description).toContain("Other platforms keep their native multiline typing route");
    expect(type?.description).not.toContain("let the backend resolve an unambiguous current editor");
    expect(type?.inputSchema).toMatchObject({
      properties: {
        text: { type: "string", description: expect.stringContaining("partial evidence may be refused") },
        elementRef: { type: "string", minLength: 1, maxLength: 96, description: expect.stringContaining("does not replace a selection") },
      },
      required: ["text"],
      additionalProperties: false,
    });
    expect(type?.description).toContain("On macOS, omit elementRef and use the native focused-control typing route");
    expect(JSON.stringify(type?.inputSchema)).toContain("On macOS, omit elementRef");
    expect(JSON.stringify(type?.inputSchema)).toContain("Omit on macOS");
    expect(JSON.stringify(type?.inputSchema)).toContain("only when the target is confirmed to support line breaks and the Goal requires them");
    expect(JSON.stringify(type?.inputSchema)).toContain("Enter is a real key event and may submit/send in search or message controls");
  });

  it("maps an optional current UIA elementRef into the type action without exposing driver tokens", () => {
    const type = createDefaultComputerTools().get("type");
    if (type?.category !== "computer") throw new Error("type tool missing");
    const observation = {
      id: "type-observation" as never,
      runId: "run" as never,
      computerSessionId: "session" as never,
      surfaceRef,
      capturedAt: "2026-10-02T00:00:00Z",
      viewport: { width: 800, height: 600, coordinateSpace: "physical" as const },
      screenshot: { assetId: "asset" as never, relativePath: "screenshots/a.png", mediaType: "image/png" as const, byteLength: 1 },
      grounding: {
        version: "uia-catalog-v1" as const,
        source: "uia" as const,
        observationId: "type-observation" as never,
        computerSessionId: "session" as never,
        surfaceRef,
        completeness: "complete" as const,
        degraded: false,
        maxElements: 16,
        elements: [{ elementRef: "uia-current-1", role: "Edit", source: "uia" as const, state: { enabled: true, editable: true }, bbox: { x: 10, y: 10, width: 300, height: 250, coordinateSpace: "physical" as const } }],
      },
    };
    const context = { runId: "run" as never, session: {} as never, signal: new AbortController().signal, observation };
    const windowsContext = { ...context, session: { platform: "win32" } as never };
    expect(type.toAction({ text: "first\nsecond", elementRef: "uia-current-1" }, windowsContext)).toEqual({
      kind: "type", text: "first\nsecond", groundingRef: "uia-current-1",
    });
    expect(type.toAction({ text: "first\nsecond" }, context)).toEqual({
      kind: "type", text: "first\nsecond",
    });
    const partialObservation = { ...observation, grounding: { ...observation.grounding, completeness: "partial" as const } };
    expect(type.toAction({ text: "first\nsecond" }, { ...context, observation: partialObservation })).toEqual({
      kind: "type", text: "first\nsecond",
    });
    expect(type.toAction({ text: "ordinary single line" }, { ...context, observation: undefined })).toEqual({
      kind: "type", text: "ordinary single line",
    });
    expect(() => type.toAction({ text: "one line", elementRef: "uia-current-1" }, context)).toThrow(/only valid for multiline/iu);
    expect(() => type.toAction({ text: "first\nsecond", elementRef: "dom-current-1" }, context)).toThrow(/not in the current observation/iu);
    expect(() => type.validate({ text: "first\nsecond", elementRef: "" })).toThrow(/non-empty/iu);

    const domObservation = {
      ...observation,
      grounding: { ...observation.grounding, source: "dom" as const, version: "grounding-catalog-v2" as const,
        elements: [{ ...observation.grounding.elements[0]!, source: "dom" as const }] },
    };
    expect(() => type.toAction({ text: "first\nsecond", elementRef: "uia-current-1" }, { ...context, observation: domObservation })).toThrow(/UIA_REQUIRED/iu);

    const darwinContext = { ...context, session: { platform: "darwin" } as never };
    expect(() => type.toAction({ text: "first\nsecond", elementRef: "uia-current-1" }, darwinContext))
      .toThrow(/omit elementRef and use native focused-control typing on macOS/iu);
    expect(() => type.toAction({ text: "single line", elementRef: "uia-current-1" }, darwinContext))
      .toThrow(/omit elementRef and use native focused-control typing on macOS/iu);
    expect(type.toAction({ text: "first\nsecond" }, { ...darwinContext, observation })).toEqual({ kind: "type", text: "first\nsecond" });

    // The Windows Computer privately binds a unique UIA target; the tool projection does not synthesize a public groundingRef.
    expect(type.toAction({ text: "first\nsecond" }, { ...windowsContext, observation })).toEqual({
      kind: "type", text: "first\nsecond",
    });
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

  it("provides one shared read-only inventory tool and one isolated Computer switch action", async () => {
    const definitions = windowSwitchTools();
    const list = definitions.find((definition) => definition.name === "list_windows");
    const change = definitions.find((definition) => definition.name === "switch_window");
    expect(list?.category).toBe("side");
    expect(list?.description).toContain("a dialog may be a separate window");
    expect(list?.description).toContain("wait for a fresh observation before interacting");
    expect(change).toMatchObject({ category: "computer", isolatedTurn: true });
    expect(change?.category === "computer" ? change.description : "").toContain("Desktop capture/input stays full");
    expect(change?.category === "computer" ? change.description : "").toContain("native-window scope rebinds");
    expect(change?.category === "computer" ? change.description : "").toContain("Already foreground: no-op");
    expect(change?.category === "computer" ? change.description : "").toContain("Sole call this turn");
    expect(change?.category === "computer" ? change.description : "").toContain("reobserve before next action");
    expect(createDefaultComputerTools().get("list_windows")).toBeUndefined();
    expect(createDefaultComputerTools().get("switch_window")).toBeUndefined();

    if (list?.category !== "side" || change?.category !== "computer") throw new Error("window switch definitions missing");
    const inventory = await list.execute({}, {
      runId: "run" as never,
      session: {} as never,
      signal: new AbortController().signal,
      listWindows: async () => ({
        options: [{ windowRef: "opaque-1", title: "Search", isCurrent: false, firstObservedAfterAction: true, sourceActionId: "save-action" as never }],
        truncated: true,
        omittedCount: 3,
      }),
    });
    expect(inventory).toEqual({
      windows: [{ windowRef: "opaque-1", title: "Search", isCurrent: false, firstObservedAfterAction: true, sourceActionId: "save-action" }],
      truncated: true,
      omittedCount: 3,
    });
    expect(() => change.validate({ windowRef: "" })).toThrow(/opaque reference/iu);
    expect(() => change.validate({ windowRef: "opaque-1", pid: 123 })).toThrow(/only the windowRef argument/iu);
    expect(() => change.validate({ windowRef: "opaque-1", windowId: 456 })).toThrow(/only the windowRef argument/iu);
    expect(() => change.validate({ windowRef: "opaque-1", adapterMetadata: "unexpected" })).toThrow(/only the windowRef argument/iu);
    expect(() => change.toAction({ windowRef: "opaque-1", pid: 123 }, {
      runId: "run" as never,
      session: {} as never,
      signal: new AbortController().signal,
    })).toThrow(/only the windowRef argument/iu);
    expect(change.toAction({ windowRef: "opaque-1" }, {
      runId: "run" as never,
      session: {} as never,
      signal: new AbortController().signal,
    })).toEqual({ kind: "switch_window", windowRef: "opaque-1" });
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
    expect(definition.description).toContain("UIA or DOM grounding");
    expect(definition.description).toContain("not proof of clickability or effect");
    expect(definition.description).toContain("catalog is bounded");
    expect(definition.description).toContain("do not retry the same target with another reference");
    expect(JSON.stringify(definition.inputSchema)).toContain("UIA or DOM grounding catalog");
    expect(definition.description).toContain("current catalog");
    expect(definition.description).toContain("For managed page content, use a DOM ref");
    expect(JSON.stringify(definition.inputSchema)).toContain("Use a DOM ref for managed page content");
    const context = {
      runId: "run" as never,
      session: {} as never,
      signal: new AbortController().signal,
      observation: {
        id: "observation" as never,
        runId: "run" as never,
        computerSessionId: "session" as never,
        surfaceRef,
        capturedAt: "2026-09-20T00:00:00Z",
        viewport: { width: 800, height: 600, coordinateSpace: "physical" as const },
        screenshot: { assetId: "asset" as never, relativePath: "screenshots/a.png", mediaType: "image/png", byteLength: 1 },
        grounding: {
          version: "uia-catalog-v1" as const,
          source: "uia" as const,
          observationId: "observation" as never,
          computerSessionId: "session" as never,
          surfaceRef,
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

  it("refuses managed-browser window containers during tool preflight", () => {
    const definition = groundingComputerTools()[0];
    if (definition === undefined || definition.category !== "computer") throw new Error("grounding tool missing");
    const observation = {
      id: "browser-window-observation" as never,
      runId: "run" as never,
      computerSessionId: "session" as never,
      capturedAt: "2026-09-29T00:00:00Z",
      viewport: { width: 800, height: 600, coordinateSpace: "physical" as const },
      screenshot: { assetId: "asset" as never, relativePath: "screenshots/a.png", mediaType: "image/png" as const, byteLength: 1 },
      grounding: {
        version: "grounding-catalog-v2" as const,
        source: "hybrid" as const,
        observationId: "browser-window-observation" as never,
        computerSessionId: "session" as never,
        completeness: "partial" as const,
        degraded: true,
        maxElements: 16,
        elements: [{ elementRef: "uia-window", role: "AXWindow", source: "uia" as const, bbox: { x: 0, y: 0, width: 800, height: 600, coordinateSpace: "physical" as const }, state: { enabled: false } }],
      },
    };
    const context = { runId: "run" as never, session: {} as never, signal: new AbortController().signal, observation };
    expect(() => definition.toAction({ elementRef: "uia-window" }, context)).toThrow(/MANAGED_BROWSER_CONTAINER_NOT_INTERACTIVE/iu);
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
      surfaceRef,
      capturedAt: "2026-09-20T00:00:00Z",
      viewport: { width: 800, height: 600, coordinateSpace: "physical" as const },
      screenshot: { assetId: "asset" as never, relativePath: "screenshots/a.png", mediaType: "image/png" as const, byteLength: 1 },
      grounding: {
        version: "grounding-catalog-v2" as const,
        source: "dom" as const,
        observationId: "dom-observation" as never,
        computerSessionId: "session" as never,
        surfaceRef,
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

  it("uses exact observed option evidence even when the native-select list is truncated", () => {
    const definition = groundingComputerTools({ includeSelectOption: true }).find((tool) => tool.name === "select_option");
    if (definition === undefined || definition.category !== "computer") throw new Error("select_option tool missing");
    const observation = {
      id: "dom-options" as never,
      runId: "run" as never,
      computerSessionId: "session" as never,
      surfaceRef,
      capturedAt: "2026-09-20T00:00:00Z",
      viewport: { width: 800, height: 600, coordinateSpace: "physical" as const },
      screenshot: { assetId: "asset" as never, relativePath: "screenshots/a.png", mediaType: "image/png" as const, byteLength: 1 },
      grounding: {
        version: "grounding-catalog-v2" as const,
        source: "dom" as const,
        observationId: "dom-options" as never,
        computerSessionId: "session" as never,
        surfaceRef,
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
    expect(definition.toAction({ elementRef: "dom-options-ref", optionText: "08:00" }, { ...context, observation: { ...observation, grounding: { ...observation.grounding, elements: [{ ...observation.grounding.elements[0]!, optionsTruncated: true }] } } })).toEqual({ kind: "select_option", groundingRef: "dom-options-ref", optionText: "08:00" });
    expect(() => definition.toAction({ elementRef: "dom-options-ref", optionText: "09:00" }, { ...context, observation: { ...observation, grounding: { ...observation.grounding, elements: [{ ...observation.grounding.elements[0]!, optionsTruncated: true }] } } })).toThrow(/OPTION_MISSING/iu);
    expect(() => definition.toAction({ elementRef: "dom-options-ref", optionText: "08:00" }, { ...context, observation: { ...observation, grounding: { ...observation.grounding, elements: [{ ...observation.grounding.elements[0]!, optionsTruncated: true, options: [{ text: "08:00", enabled: true }, { text: "08:00", enabled: true }] }] } } })).toThrow(/OPTION_AMBIGUOUS/iu);
    expect(() => definition.toAction({ elementRef: "dom-options-ref", optionText: "08:00" }, { ...context, observation: { ...observation, grounding: { ...observation.grounding, elements: [{ ...observation.grounding.elements[0]!, optionsTruncated: true, options: [{ text: "08:00", enabled: false }] }] } } })).toThrow(/OPTION_DISABLED/iu);
  });

});
