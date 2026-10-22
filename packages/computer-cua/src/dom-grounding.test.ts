import { describe, expect, it } from "vitest";
import type { ComputerSessionId, ObservationId, Viewport } from "@computer-harness/protocol";
import { CuaDriverComputer } from "./cua-driver-computer.js";
import { mergeGroundingElements } from "./cua-driver-computer.js";
import {
  createMockDomGroundingTransport,
  materializeDomGrounding,
  projectDomCssFrame,
  validateManagedBrowserTarget,
  type DomGroundingCollectRequest,
} from "./dom-grounding.js";

const viewport: Viewport = { width: 1_000, height: 800, coordinateSpace: "physical" };
const request: DomGroundingCollectRequest = {
  observationId: "dom-observation-1" as ObservationId,
  computerSessionId: "dom-session-1" as ComputerSessionId,
  viewport,
  browserTarget: { kind: "managed-chromium", browser: "edge", profileId: "fixture-profile", windowTarget: { pid: 123, windowId: 456 }, tabId: "tab-fixture", generation: "generation-1", delivery: "loopback-cdp" },
};

describe("managed DOM grounding transport gate", () => {
  it("materializes visible controls, point/neighbor hits and custom tabindex divs without exposing backend tokens", () => {
    const materialized = materializeDomGrounding(request, {
      complete: true,
      candidates: [
        { tagName: "button", name: "Continue", frame: { x: 100, y: 100, width: 80, height: 30 }, visible: true, interactive: true, state: { enabled: true } },
        { tagName: "input", name: "Search", frame: { x: 150, y: 150, width: 120, height: 24 }, visible: true, interactive: true, state: { enabled: true, editable: true } },
        { tagName: "input", inputType: "checkbox", frame: { x: 280, y: 150, width: 20, height: 20 }, visible: true, interactive: true, state: { enabled: true, selected: true } },
        { tagName: "input", inputType: "radio", frame: { x: 310, y: 150, width: 20, height: 20 }, visible: true, interactive: true, state: { enabled: true } },
        { tagName: "input", inputType: "range", frame: { x: 340, y: 150, width: 80, height: 20 }, visible: true, interactive: true, state: { enabled: true } },
        { tagName: "div", name: "Custom tab", tabIndex: 0, frame: { x: 200, y: 100, width: 80, height: 30 }, visible: true },
        { ariaRole: "button", name: "Point hit", frame: { x: 300, y: 100, width: 80, height: 30 }, visible: true },
        { tagName: "canvas", name: "Canvas control", frame: { x: 400, y: 100, width: 80, height: 30 }, visible: true, interactive: true },
        { tagName: "button", name: "Hidden", frame: { x: 500, y: 100, width: 80, height: 30 }, visible: false, interactive: true },
      ],
    });
    expect(materialized.catalog.source).toBe("dom");
    expect(materialized.catalog.version).toBe("grounding-catalog-v2");
    expect(materialized.catalog.elements.map((element) => element.name)).toEqual(["Continue", "Search", undefined, undefined, undefined, "Custom tab", "Point hit"]);
    expect(materialized.catalog.elements.slice(2, 5).map((element) => element.role)).toEqual(["checkbox", "radio", "slider"]);
    expect(materialized.catalog.elements.every((element) => element.source === "dom" && element.browserRegion === "content")).toBe(true);
    expect(materialized.privateElements.size).toBe(7);
  });

  it("projects whole document blocks and native scroll geometry without clipping or slicing rejected nodes", () => {
    const result = materializeDomGrounding(request, {
      candidates: [], tabId: request.browserTarget.tabId, generation: request.browserTarget.generation,
      coordinateSpace: "css", viewportMetrics: { cssWidth: 500, cssHeight: 350, deviceScaleFactor: 2 },
      visibleDocument: {
        source: "dom-document-v1", scope: "current-viewport", completeness: "partial", truncated: false,
        blocks: [
          { text: "Visible heading", frame: { x: 10, y: 20, width: 120, height: 25 } },
          { text: "Partially outside", frame: { x: 480, y: 40, width: 40, height: 20 } },
          { text: "x".repeat(481), frame: { x: 10, y: 80, width: 200, height: 30 } },
          { text: "Later whole paragraph", frame: { x: 10, y: 120, width: 200, height: 30 } },
        ],
        scrollRegions: [
          { frame: { x: 20, y: 160, width: 200, height: 150 }, scrollTop: 100, scrollHeight: 800, clientHeight: 150 },
          { frame: { x: 240, y: 160, width: 200, height: 150 }, scrollTop: 900, scrollHeight: 800, clientHeight: 150 },
        ],
      },
    }, 256, { x: 0, y: 100, width: 1000, height: 700 });
    expect(result.catalog.visibleDocument).toMatchObject({
      completeness: "partial", truncated: true,
      blocks: [
        { text: "Visible heading", bbox: { x: 20, y: 140, width: 240, height: 50, coordinateSpace: "physical" } },
        { text: "Later whole paragraph", bbox: { x: 20, y: 340, width: 400, height: 60, coordinateSpace: "physical" } },
      ],
      scrollRegions: [{ bbox: { x: 40, y: 420, width: 400, height: 300, coordinateSpace: "physical" },
        scrollTop: 100, scrollHeight: 800, clientHeight: 150 }],
    });
    expect(result.catalog.elements).toEqual([]);
  });

  it("omits document evidence on identity drift and never invents an empty coverage claim", () => {
    const raw = {
      candidates: [], tabId: request.browserTarget.tabId, generation: request.browserTarget.generation,
      coordinateSpace: "css" as const, viewportMetrics: { cssWidth: 500, cssHeight: 350, deviceScaleFactor: 2 },
      visibleDocument: { source: "dom-document-v1", scope: "current-viewport", completeness: "partial", truncated: false,
        blocks: [{ text: "Current paragraph", frame: { x: 10, y: 10, width: 200, height: 30 } }], scrollRegions: [] },
    };
    const contentRect = { x: 0, y: 100, width: 1000, height: 700 };
    expect(materializeDomGrounding(request, { ...raw, tabId: "other-tab" }, 256, contentRect).catalog.visibleDocument).toBeUndefined();
    expect(materializeDomGrounding(request, { ...raw, generation: "other-document" }, 256, contentRect).catalog.visibleDocument).toBeUndefined();
    expect(materializeDomGrounding(request, { ...raw, visibleDocument: { ...raw.visibleDocument, blocks: [] } }, 256, contentRect).catalog.visibleDocument).toBeUndefined();
    expect(materializeDomGrounding(request, raw, 256, { ...contentRect, width: 900 }).catalog.visibleDocument).toBeUndefined();
  });

  it("enforces the document character budget by omitting entire blocks while retaining a later fitting node", () => {
    const full = "a".repeat(479);
    const result = materializeDomGrounding(request, {
      candidates: [], tabId: request.browserTarget.tabId, generation: request.browserTarget.generation,
      coordinateSpace: "css", viewportMetrics: { cssWidth: 500, cssHeight: 350, deviceScaleFactor: 2 },
      visibleDocument: { source: "dom-document-v1", scope: "current-viewport", completeness: "partial", truncated: false,
        blocks: [
          ...Array.from({ length: 10 }, (_, index) => ({ text: full, frame: { x: 10, y: index * 20, width: 200, height: 18 } })),
          { text: "This whole node cannot fit", frame: { x: 10, y: 210, width: 200, height: 18 } },
          { text: "Final", frame: { x: 10, y: 240, width: 50, height: 18 } },
        ], scrollRegions: [] },
    }, 256, { x: 0, y: 100, width: 1000, height: 700 });
    expect(result.catalog.visibleDocument?.blocks.map((block) => block.text)).toEqual([...Array(10).fill(full), "Final"]);
    expect(result.catalog.visibleDocument?.truncated).toBe(true);
    expect(result.catalog.visibleDocument?.limits).toEqual({ maxBlocks: 32, maxCharacters: 4800, maxBlockCharacters: 480, maxScrollRegions: 4 });
  });

  it("keeps refs observation-bound and preserves screenshot fallback when transport is absent", async () => {
    const transport = createMockDomGroundingTransport({ candidates: [] });
    const first = await transport.collect(request, new AbortController().signal);
    const second = await transport.collect({ ...request, observationId: "dom-observation-2" as ObservationId }, new AbortController().signal);
    expect(first).toEqual({ candidates: [] });
    expect(second).toEqual({ candidates: [] });
    expect(() => validateManagedBrowserTarget(request.browserTarget)).not.toThrow();
    expect(() => validateManagedBrowserTarget({ ...request.browserTarget, profileId: "C:\\Users\\me\\profile" })).toThrow(/profileId|opaque/iu);
  });

  it("keeps raw DOM names private when public labels are redacted", () => {
    const materialized = materializeDomGrounding(request, {
      complete: true,
      candidates: [{
        tagName: "button",
        name: "Contact user@example.com at 13800138000",
        frame: { x: 100, y: 100, width: 120, height: 30 },
        visible: true,
        interactive: true,
      }],
    });
    const element = materialized.catalog.elements[0];
    const privateElement = materialized.privateElements.get(element!.elementRef);
    expect(element?.name).toBe("Contact [redacted-email] at [redacted-phone]");
    expect(privateElement?.candidateName).toBe("Contact user@example.com at 13800138000");
  });

  it("projects CDP CSS frames into the current physical window capture", () => {
    const projected = projectDomCssFrame(
      { x: 352, y: 317, width: 164, height: 30 },
      { width: 1_568, height: 1_298, coordinateSpace: "physical" },
      { cssWidth: 1_254.4, cssHeight: 958.4, deviceScaleFactor: 1.25 },
      { x: 0, y: 100, width: 1_568, height: 1_198 },
    );
    // The UIA content rectangle supplies the browser content origin and scale.
    expect(projected).toEqual({ x: 440, y: 496.25, width: 205, height: 37.5 });

    const materialized = materializeDomGrounding({
      ...request,
      viewport: { width: 1_568, height: 1_298, coordinateSpace: "physical" },
    }, {
      complete: true,
      coordinateSpace: "css",
      viewportMetrics: { cssWidth: 1_254.4, cssHeight: 958.4, deviceScaleFactor: 1.25 },
      candidates: [{ tagName: "input", name: "到达城市", frame: { x: 352, y: 317, width: 164, height: 30 }, visible: true, interactive: true }],
    }, 256, { x: 0, y: 100, width: 1_568, height: 1_198 });
    expect(materialized.catalog.elements[0]?.bbox).toMatchObject({ x: 440, y: 496.25, width: 205, height: 37.5, coordinateSpace: "physical" });
    expect(materialized.privateElements.values().next().value?.point).toEqual({ x: 542.5, y: 515 });
  });

  it("projects only bounded native-select option text and enabled state", () => {
    const materialized = materializeDomGrounding(request, {
      complete: true,
      candidates: [{
        tagName: "select",
        ariaRole: "combobox",
        name: "Departure",
        frame: { x: 100, y: 100, width: 120, height: 28 },
        visible: true,
        interactive: true,
        options: [{ text: "08:00", enabled: true }, { text: "09:00", enabled: false }, { text: "secret-value", enabled: true }],
        optionsTruncated: false,
        state: { enabled: true },
      }],
    });
    expect(materialized.catalog.elements[0]).toMatchObject({ options: [{ text: "08:00", enabled: true }, { text: "09:00", enabled: false }, { text: "secret-value", enabled: true }], optionsTruncated: false });
    expect(materialized.catalog.elements[0]).not.toHaveProperty("value");
    const truncated = materializeDomGrounding(request, {
      complete: true,
      candidates: [{
        tagName: "select",
        ariaRole: "combobox",
        frame: { x: 100, y: 100, width: 120, height: 28 },
        visible: true,
        interactive: true,
        options: Array.from({ length: 33 }, (_, index) => ({ text: `option-${index}`, enabled: true })),
        optionsTruncated: true,
      }],
    });
    expect(truncated.catalog.elements[0]?.options).toHaveLength(32);
    expect(truncated.catalog.elements[0]?.optionsTruncated).toBe(true);
  });

  it("recomputes the projection after a resize or DPI change", () => {
    const resized = projectDomCssFrame(
      { x: 352, y: 317, width: 164, height: 30 },
      { width: 1_920, height: 1_080, coordinateSpace: "physical" },
      { cssWidth: 1_280, cssHeight: 720, deviceScaleFactor: 1.5 },
      { x: 0, y: 0, width: 1_920, height: 1_080 },
    );
    expect(resized).toEqual({ x: 528, y: 475.5, width: 246, height: 45 });
    const resampled = projectDomCssFrame(
      { x: 352, y: 317, width: 164, height: 30 },
      { width: 960, height: 740, coordinateSpace: "physical" },
      { cssWidth: 1_280, cssHeight: 720, deviceScaleFactor: 1.5 },
      { x: 20, y: 100, width: 900, height: 600 },
    );
    // x/y scales are independent and the content origin is not guessed.
    expect(resampled.x).toBeCloseTo(267.5, 8);
    expect(resampled.y).toBeCloseTo(364.1666667, 7);
    expect(resampled.width).toBeCloseTo(115.3125, 8);
    expect(resampled.height).toBeCloseTo(25, 8);
    expect(() => materializeDomGrounding({ ...request, viewport: { width: 1_568, height: 1_298, coordinateSpace: "physical" } }, {
      complete: true,
      coordinateSpace: "css",
      viewportMetrics: { cssWidth: 1_254.4, cssHeight: 958.4, deviceScaleFactor: 1.25 },
      candidates: [{ tagName: "input", frame: { x: 352, y: 317, width: 164, height: 30 }, visible: true, interactive: true }],
    })).toThrow(/trusted physical content rectangle/iu);
  });

  it("does not silently attach a personal browser when DOM mode is enabled", () => {
    expect(() => new CuaDriverComputer({ socketPath: "fixture.sock", screenshotDir: "runs/dom-gate", grounding: "dom-catalog-v1" })).toThrow(/explicit managed Chromium\/Edge target/iu);
    expect(() => new CuaDriverComputer({
      socketPath: "fixture.sock",
      screenshotDir: "runs/dom-gate",
      grounding: "dom-catalog-v1",
      windowTarget: { pid: 123, windowId: 456 },
      browserTarget: request.browserTarget,
    })).toThrow(/managed loopback CDP transport|typed surface/iu);
  });

  it("fairly merges a full UIA catalog so DOM candidates reach Runtime", () => {
    const uia = Array.from({ length: 256 }, (_, index) => ({ elementRef: `uia-${index}`, role: "button", source: "uia" as const }));
    const dom = [{ elementRef: "dom-first", role: "button", source: "dom" as const }, { elementRef: "dom-second", role: "button", source: "dom" as const }];
    const merged = mergeGroundingElements(uia, dom);
    expect(merged).toHaveLength(256);
    expect(merged.some((element) => element.elementRef === "dom-first")).toBe(true);
    expect(merged.some((element) => element.elementRef === "dom-second")).toBe(true);
  });
});
