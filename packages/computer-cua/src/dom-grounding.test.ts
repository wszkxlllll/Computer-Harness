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

  it("keeps refs observation-bound and preserves screenshot fallback when transport is absent", async () => {
    const transport = createMockDomGroundingTransport({ candidates: [] });
    const first = await transport.collect(request, new AbortController().signal);
    const second = await transport.collect({ ...request, observationId: "dom-observation-2" as ObservationId }, new AbortController().signal);
    expect(first).toEqual({ candidates: [] });
    expect(second).toEqual({ candidates: [] });
    expect(() => validateManagedBrowserTarget(request.browserTarget)).not.toThrow();
    expect(() => validateManagedBrowserTarget({ ...request.browserTarget, profileId: "C:\\Users\\me\\profile" })).toThrow(/profileId|opaque/iu);
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
    expect(() => new CuaDriverComputer({ socketPath: "fixture.sock", screenshotDir: "runs/dom-gate", grounding: "dom-catalog-v1" })).toThrow(/explicit CUA window target/iu);
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
