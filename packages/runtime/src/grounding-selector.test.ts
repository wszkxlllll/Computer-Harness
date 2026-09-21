import { describe, expect, it } from "vitest";
import type { GroundingCatalog, ObservationId, ComputerSessionId } from "@computer-harness/protocol";
import { DeterministicGroundingSelector } from "./grounding-selector.js";
import { groundingComputerTools } from "./computer-tools.js";

function catalog(elements: GroundingCatalog["elements"]): GroundingCatalog {
  return {
    version: "uia-catalog-v1",
    source: "uia",
    observationId: "observation-selector" as ObservationId,
    computerSessionId: "session-selector" as ComputerSessionId,
    completeness: "partial",
    degraded: false,
    maxElements: 256,
    elements,
  };
}

describe("DeterministicGroundingSelector", () => {
  it("admits a goal-matching element beyond the generic first sixteen", () => {
    const elements = Array.from({ length: 19 }, (_, index) => ({
      elementRef: `uia-source-${index}`,
      role: "Button",
      name: `Generic action ${index}`,
      bbox: { x: index, y: index, width: 20, height: 20, coordinateSpace: "physical" as const },
      state: { enabled: true },
    }));
    elements.push({
      elementRef: "uia-source-target",
      role: "Button",
      name: "Departure station",
      bbox: { x: 100, y: 100, width: 20, height: 20, coordinateSpace: "physical" as const },
      state: { enabled: true },
    });
    const selected = new DeterministicGroundingSelector().select(catalog(elements), {
      goal: "Choose the departure station",
      latestUserCorrections: [],
    });
    expect(selected.elements).toHaveLength(16);
    expect(selected.elements.some((element) => element.elementRef === "uia-source-target")).toBe(true);
    expect(selected.selection).toMatchObject({
      strategy: "deterministic-lexical-v1",
      candidateElementCount: 20,
      truncated: true,
    });
    expect(selected.selection?.reasons.find((item) => item.elementRef === "uia-source-target")?.codes).toContain("query_match");
  });

  it("uses state hints only as a deterministic fallback and preserves disabled evidence", () => {
    const selected = new DeterministicGroundingSelector().select(catalog([
      {
        elementRef: "uia-disabled",
        role: "Button",
        name: "Delete account",
        bbox: { x: 0, y: 0, width: 20, height: 20, coordinateSpace: "physical" },
        state: { enabled: false },
      },
      {
        elementRef: "uia-editable",
        role: "Edit",
        name: "Search",
        bbox: { x: 30, y: 0, width: 20, height: 20, coordinateSpace: "physical" },
        state: { enabled: true, editable: true },
      },
    ]), {
      goal: "",
      latestUserCorrections: [],
    });
    expect(selected.elements.map((element) => element.elementRef)).toEqual(["uia-editable", "uia-disabled"]);
    expect(selected.elements.find((element) => element.elementRef === "uia-disabled")?.state?.enabled).toBe(false);
  });

  it("does not turn one-character Chinese overlaps into goal matches", () => {
    const selected = new DeterministicGroundingSelector().select(catalog([
      {
        elementRef: "uia-tab-shanghai",
        role: "TabItem",
        name: "上海",
        bbox: { x: 0, y: 0, width: 20, height: 20, coordinateSpace: "physical" },
        state: { enabled: true },
      },
      {
        elementRef: "uia-tab-station",
        role: "TabItem",
        name: "站",
        bbox: { x: 30, y: 0, width: 20, height: 20, coordinateSpace: "physical" },
        state: { enabled: true },
      },
      {
        elementRef: "uia-target-station",
        role: "Edit",
        name: "人民广场地铁站",
        bbox: { x: 60, y: 0, width: 80, height: 20, coordinateSpace: "physical" },
        state: { enabled: true, editable: true },
      },
    ]), {
      goal: "查询人民广场地铁站的路线",
      latestUserCorrections: [],
    });
    const targetReason = selected.selection?.reasons.find((item) => item.elementRef === "uia-target-station");
    expect(targetReason?.codes).toContain("query_match");
    expect(selected.selection?.reasons.find((item) => item.elementRef === "uia-tab-station")?.codes).not.toContain("query_match");
  });

  it("uses the latest correction to select an input target", () => {
    const elements = Array.from({ length: 19 }, (_, index) => ({
      elementRef: `uia-tab-${index}`,
      role: "TabItem",
      name: `Page ${index}`,
      bbox: { x: index, y: index, width: 20, height: 20, coordinateSpace: "physical" as const },
      state: { enabled: true },
    }));
    elements.push({
      elementRef: "uia-origin-input",
      role: "Edit",
      name: "起点输入框",
      bbox: { x: 100, y: 100, width: 80, height: 20, coordinateSpace: "physical" },
      state: { enabled: true, editable: true },
    });
    const selected = new DeterministicGroundingSelector().select(catalog(elements), {
      goal: "请输入起点",
      latestUserCorrections: ["点击起点输入框"],
    });
    expect(selected.elements.some((element) => element.elementRef === "uia-origin-input")).toBe(true);
    expect(selected.selection?.reasons.find((item) => item.elementRef === "uia-origin-input")?.codes).toContain("query_match");
  });

  it("keeps a correction-matching Edit beyond 64 candidates executable by click_element", () => {
    const elements: GroundingCatalog["elements"] = Array.from({ length: 80 }, (_, index) => ({
      elementRef: `uia-chrome-${index}`,
      role: "TabItem",
      name: `Browser tab ${index}`,
      bbox: { x: index, y: index, width: 20, height: 20, coordinateSpace: "physical" as const },
      state: { enabled: true },
    }));
    elements.push({
      elementRef: "uia-deep-origin-input",
      role: "Edit",
      name: "起点输入框",
      description: "输入出发地",
      bbox: { x: 300, y: 200, width: 100, height: 24, coordinateSpace: "physical" },
      state: { enabled: true, editable: true },
    });
    const selected = new DeterministicGroundingSelector().select(catalog(elements), {
      goal: "查询路线",
      latestUserCorrections: ["点击起点输入框"],
    });
    expect(selected.selection?.candidateElementCount).toBe(81);
    const target = selected.elements.find((element) => element.elementRef === "uia-deep-origin-input");
    expect(target).toBeDefined();
    const definition = groundingComputerTools()[0];
    if (definition === undefined || definition.category !== "computer" || target === undefined) throw new Error("grounding click_element fixture missing");
    const action = definition.toAction({ elementRef: target.elementRef }, {
      runId: "run-selector" as never,
      session: {} as never,
      signal: new AbortController().signal,
      observation: {
        id: "observation-selector" as never,
        runId: "run-selector" as never,
        computerSessionId: "session-selector" as never,
        capturedAt: "2026-09-20T00:00:00.000Z",
        viewport: { width: 1000, height: 800, coordinateSpace: "physical" },
        screenshot: { assetId: "asset-selector" as never, relativePath: "screenshots/selector.png", mediaType: "image/png", byteLength: 1 },
        grounding: selected,
      },
    });
    expect(action).toMatchObject({ kind: "click", groundingRef: "uia-deep-origin-input", point: { x: 350, y: 212 } });
  });
});
