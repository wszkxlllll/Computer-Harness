import { describe, expect, it } from "vitest";
import type { GroundingCatalog, ObservationId, ComputerSessionId, SurfaceId, SurfaceRef } from "@computer-harness/protocol";
import { runtimeEventSchema } from "@computer-harness/trajectory";
import { DeterministicGroundingSelector } from "./grounding-selector.js";
import { groundingComputerTools } from "./computer-tools.js";

const desktopSurfaceRef: SurfaceRef = { surfaceId: "selector-desktop" as SurfaceId, generation: 1, kind: "desktop" };

function catalog(elements: GroundingCatalog["elements"]): GroundingCatalog {
  return {
    version: "uia-catalog-v1",
    source: "uia",
    observationId: "observation-selector" as ObservationId,
    computerSessionId: "session-selector" as ComputerSessionId,
    surfaceRef: desktopSurfaceRef,
    completeness: "partial",
    degraded: false,
    maxElements: 256,
    elements,
  };
}

function hybridCatalog(elements: GroundingCatalog["elements"]): GroundingCatalog {
  return {
    version: "grounding-catalog-v2",
    source: "hybrid",
    observationId: "observation-hybrid" as ObservationId,
    computerSessionId: "session-hybrid" as ComputerSessionId,
    surfaceRef: desktopSurfaceRef,
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
    expect(selected.selection?.reasons.find((item) => item.elementRef === "uia-source-target")?.codes).toContain("goal_match");
  });

  it("keeps an executable Mac mini DOM ref in a partial hybrid hot set", () => {
    const sameBox = { x: 760, y: 490, width: 82, height: 138, coordinateSpace: "physical" as const };
    const elements: GroundingCatalog["elements"] = [
      ...["MacBook Air", "MacBook Pro", "iMac", "Mac Studio", "MacBook Neo", "Mac 机型比较", "Apple 支持", "Mac 页面"].map((name, index) => ({
        elementRef: `dom-product-${index}`,
        role: "link",
        name,
        source: "dom" as const,
        browserRegion: "content" as const,
        bbox: { x: 100 + index * 100, y: 300, width: 80, height: 100, coordinateSpace: "physical" as const },
        state: { enabled: true },
      })),
      {
        elementRef: "dom-mac-mini",
        role: "link",
        name: "Mac mini新款",
        source: "dom",
        browserRegion: "content",
        bbox: sameBox,
        state: { enabled: true },
      },
      {
        elementRef: "uia-mac-mini",
        role: "AXLink",
        name: "Mac mini 新款",
        source: "uia",
        browserRegion: "content",
        bbox: sameBox,
        state: { enabled: true },
      },
      {
        elementRef: "uia-different-overlap",
        role: "AXLink",
        name: "Different nearby control",
        source: "uia",
        browserRegion: "content",
        bbox: sameBox,
        state: { enabled: true },
      },
      {
        elementRef: "uia-toolbar",
        role: "AXLink",
        name: "Mac browser toolbar",
        source: "uia",
        browserRegion: "chrome",
        bbox: { x: 10, y: 10, width: 80, height: 30, coordinateSpace: "physical" },
        state: { enabled: true },
      },
      {
        elementRef: "uia-only-content",
        role: "AXLink",
        name: "UIA only content",
        source: "uia",
        browserRegion: "content",
        bbox: { x: 700, y: 700, width: 80, height: 30, coordinateSpace: "physical" },
        state: { enabled: true },
      },
    ];
    const selected = new DeterministicGroundingSelector().select(hybridCatalog(elements), {
      goal: "请查询 Mac mini、MacBook Air、iMac 三个产品系列当前最低价的标准配置，并逐项记录官网来源。",
      latestUserCorrections: [],
    });
    const refs = new Set(selected.elements.map((element) => element.elementRef));
    expect(refs.has("dom-mac-mini")).toBe(true);
    expect(refs.has("uia-mac-mini")).toBe(false);
    expect(refs.has("uia-different-overlap")).toBe(true);
    expect(refs.has("uia-toolbar")).toBe(true);
    expect(refs.has("uia-only-content")).toBe(true);
    expect(selected.selection?.candidateElementCount).toBe(elements.length);
  });

  it("uses one existing global fallback slot for an enabled bounded radio without displacing intent", () => {
    // Synthetic pressure fixture, not a reconstruction of the historical
    // 112-candidate catalog. The query and radio label are copied from safe
    // public task/UIA evidence; the other labels model lexical page content.
    const taskGoal = "只做公开网页查询比较，不登录、不下单、不支付。请在Apple中国大陆官网当前公开销售页面，分别查询Mac mini、MacBook Air、iMac三个产品系列当前最低价的标准配置。预算上限9000元人民币。逐项记录产品名称/型号、官网最低价格及币种、芯片、内存、存储、是否带显示屏、页面来源URL和查询时间。";
    const activePlanText = "查询MacBook Air/Mac mini/iMac官网最低价标准配置: 在 Apple 中国大陆官网公开页面逐项查看 MacBook Air、Mac mini、iMac 当前销售的最低价标准配置：记录产品名称/型号、官网最低价格及币种、芯片、内存、存储、是否带显示屏、来源URL、查询时间。";
    const matches = Array.from({ length: 20 }, (_, index) => ({
      elementRef: `synthetic-uia-plan-match-${index}`,
      role: "AXStaticText",
      name: `MacBook Air 当前销售最低价标准配置 页面字段 ${index}`,
      source: "uia" as const,
      browserRegion: "content" as const,
      bbox: { x: 20 + index * 24, y: 120, width: 18, height: 18, coordinateSpace: "physical" as const },
      state: { enabled: true },
    }));
    const noise = Array.from({ length: 83 }, (_, index) => ({
      elementRef: `synthetic-uia-neutral-${index}`,
      role: "AXStaticText",
      name: `Neutral page label ${index}`,
      source: "uia" as const,
      browserRegion: "content" as const,
      bbox: { x: 20 + index * 24, y: 180, width: 18, height: 18, coordinateSpace: "physical" as const },
      state: { enabled: true },
    }));
    const radio = {
      elementRef: "synthetic-near-time-ax-radio",
      role: "AXRadioButton",
      name: "15 英寸 脚注 1 RMB 11,999 起 或 RMB 500/月 (24 期) 起",
      source: "uia" as const,
      browserRegion: "content" as const,
      bbox: { x: 20, y: 260, width: 150, height: 30, coordinateSpace: "physical" as const },
      state: { enabled: true, selected: false },
    };
    const local = {
      elementRef: "synthetic-local-recovery-target",
      role: "AXButton",
      name: "Neutral recovery target",
      source: "uia" as const,
      browserRegion: "content" as const,
      bbox: { x: 400, y: 400, width: 40, height: 24, coordinateSpace: "physical" as const },
      state: { enabled: true },
    };
    const focused = {
      elementRef: "synthetic-focused-control",
      role: "AXTextField",
      name: "Focused generic control",
      source: "uia" as const,
      browserRegion: "content" as const,
      bbox: { x: 460, y: 400, width: 80, height: 24, coordinateSpace: "physical" as const },
      state: { enabled: true, focused: true, editable: true },
    };
    const dom = [
      ["link", "MacBook Air"],
      ["link", "咨询 Mac Specialist 专家 (在新窗口中打开)"],
      ["button", "下一张图库图片"],
      ["tab", "图库图片 2"],
      ["tab", "图库图片 3"],
      ["button", "上一张图库图片"],
    ].map(([role, name], index) => ({
      elementRef: `synthetic-dom-selected-${index}`,
      role: role!,
      name: name!,
      source: "dom" as const,
      browserRegion: "content" as const,
      bbox: { x: 20 + index * 24, y: 320, width: 18, height: 18, coordinateSpace: "physical" as const },
      state: { enabled: index < 3 },
    }));
    const elements = [...matches, ...noise, local, focused, radio, ...dom];
    expect(elements).toHaveLength(112);
    const query = {
      goal: taskGoal,
      activePlanText,
      latestUserCorrections: [],
      recoveryHint: {
        reason: "no_observed_change" as const,
        attempt: 1,
        region: { x: 390, y: 390, width: 60, height: 50 },
      },
    };
    const selected = new DeterministicGroundingSelector().select(hybridCatalog(elements), query);

    expect(selected.elements).toHaveLength(16);
    expect(selected.elements.some((element) => element.elementRef === radio.elementRef)).toBe(true);
    // Six DOM candidates and the UIA cap leave two natural tail slots; the
    // radio can use one only after cap-respecting filling leaves that room.
    expect(selected.elements.filter((element) => element.source === "uia")).toHaveLength(10);
    expect(selected.elements.filter((element) => element.source === "dom")).toHaveLength(6);
    expect(selected.selection?.reasons.find((reason) => reason.elementRef === radio.elementRef)?.codes).toContain("enabled_bounded_radio");
    expect(selected.selection?.reasons.find((reason) => reason.elementRef === radio.elementRef)?.codes).not.toContain("structured_control");
    expect(runtimeEventSchema.safeParse({
      eventId: "selector-radio-schema-event",
      runId: "selector-radio-schema-run",
      sequence: 1,
      occurredAt: "2026-10-16T00:00:00.000Z",
      schemaVersion: 2,
      type: "observation.created",
      observation: {
        id: "selector-radio-schema-observation",
        runId: "selector-radio-schema-run",
        computerSessionId: "session-hybrid",
        surfaceRef: desktopSurfaceRef,
        capturedAt: "2026-10-16T00:00:00.000Z",
        viewport: { width: 1280, height: 800, coordinateSpace: "physical" },
        screenshot: { assetId: "selector-radio-schema-asset", relativePath: "selector-radio-schema.png", mediaType: "image/png", byteLength: 0 },
        grounding: selected,
      },
    }).success).toBe(true);
    expect(selected.elements.some((element) => element.elementRef === local.elementRef)).toBe(true);
    expect(selected.elements.some((element) => element.elementRef === focused.elementRef)).toBe(true);
    expect(selected.elements.some((element) => element.elementRef === "synthetic-uia-plan-match-0")).toBe(true);
    expect(selected.elements.some((element) => element.elementRef === "synthetic-dom-selected-0")).toBe(true);

    const disabled = new DeterministicGroundingSelector().select(hybridCatalog([
      ...elements.filter((element) => element.elementRef !== radio.elementRef),
      { ...radio, elementRef: "synthetic-disabled-radio", state: { enabled: false, selected: false } },
    ]), query);
    expect(disabled.selection?.reasons.find((reason) => reason.elementRef === "synthetic-disabled-radio")?.codes ?? []).not.toContain("enabled_bounded_radio");
    expect(disabled.elements.some((element) => element.elementRef === "synthetic-disabled-radio")).toBe(false);

    const notBounded = new DeterministicGroundingSelector().select(hybridCatalog([
      ...elements.filter((element) => element.elementRef !== radio.elementRef),
      { ...radio, elementRef: "synthetic-unbounded-radio", bbox: undefined },
    ]), query);
    expect(notBounded.selection?.reasons.find((reason) => reason.elementRef === "synthetic-unbounded-radio")?.codes ?? []).not.toContain("enabled_bounded_radio");
    expect(notBounded.elements.some((element) => element.elementRef === "synthetic-unbounded-radio")).toBe(false);

    const otherControls = new DeterministicGroundingSelector().select(hybridCatalog([
      ...elements.filter((element) => element.elementRef !== radio.elementRef),
      { ...radio, elementRef: "synthetic-button", role: "button" },
      { ...radio, elementRef: "synthetic-checkbox", role: "checkbox" },
    ]), query);
    expect(otherControls.selection?.reasons.some((reason) => reason.codes.includes("enabled_bounded_radio"))).toBe(false);
    expect(otherControls.selection?.selectedElementRefs).not.toContain("synthetic-button");
    expect(otherControls.selection?.selectedElementRefs).not.toContain("synthetic-checkbox");

    const unusableRadios = [
      { ...radio, elementRef: "synthetic-unknown-enabled", state: { selected: false } },
      { ...radio, elementRef: "synthetic-zero-bbox", bbox: { ...radio.bbox, width: 0 } },
      { ...radio, elementRef: "synthetic-negative-bbox", bbox: { ...radio.bbox, width: -1 } },
      { ...radio, elementRef: "synthetic-negative-x", bbox: { ...radio.bbox, x: -1 } },
      { ...radio, elementRef: "synthetic-negative-y", bbox: { ...radio.bbox, y: -1 } },
      { ...radio, elementRef: "synthetic-nonphysical-bbox", bbox: { ...radio.bbox, coordinateSpace: "css" as const } },
      { ...radio, elementRef: "synthetic-ambiguous-radio-role", role: "AXMenuItemRadio" },
    ];
    for (const unusableRadio of unusableRadios) {
      const one = new DeterministicGroundingSelector().select(hybridCatalog([unusableRadio]), {
        goal: "unrelated query",
        latestUserCorrections: [],
      });
      expect(one.elements).toHaveLength(1);
      expect(one.selection?.reasons[0]?.codes).not.toContain("enabled_bounded_radio");
    }
    const sourceUnknownRadio = { ...radio, elementRef: "synthetic-source-unknown", source: undefined };
    const sourceUnknown = new DeterministicGroundingSelector().select(hybridCatalog([sourceUnknownRadio]), {
      goal: "unrelated query",
      latestUserCorrections: [],
    });
    expect(sourceUnknown.elements[0]?.source).toBeUndefined();
    expect(sourceUnknown.selection?.reasons[0]?.codes).not.toContain("enabled_bounded_radio");

    const sameNameUiA = { ...radio, elementRef: "synthetic-same-name-uia", name: "Same-name option", source: "uia" as const, browserRegion: "content" as const };
    const sameNameDisabledDom = { ...radio, elementRef: "synthetic-same-name-disabled-dom", role: "radio", name: "Same-name option", source: "dom" as const, browserRegion: "content" as const, state: { enabled: false } };
    const sameNameSelection = new DeterministicGroundingSelector().select(hybridCatalog([sameNameUiA, sameNameDisabledDom]), {
      goal: "unrelated query",
      latestUserCorrections: [],
    });
    expect(sameNameSelection.selection?.candidateElementCount).toBe(2);
    expect(sameNameSelection.selection?.deduplicatedElementCount).toBe(2);
    expect(sameNameSelection.selection?.sourceCounts).toEqual({ uia: 1, dom: 1 });

    const balancedUia = Array.from({ length: 16 }, (_, index) => ({
      elementRef: "synthetic-balanced-uia-" + index,
      role: "AXStaticText",
      name: "Neutral UIA label " + index,
      source: "uia" as const,
      bbox: { x: 10 + index * 12, y: 500, width: 8, height: 8, coordinateSpace: "physical" as const },
      state: { enabled: true },
    }));
    const balancedRadio = { ...radio, elementRef: "synthetic-balanced-radio", name: "Neutral radio at UIA tail" };
    const balancedDom = Array.from({ length: 16 }, (_, index) => ({
      elementRef: "synthetic-balanced-dom-" + index,
      role: "button",
      name: "Neutral label " + index,
      source: "dom" as const,
      browserRegion: (index < 8 ? "content" : "unknown") as "content" | "unknown",
      bbox: { x: 10 + index * 12, y: 540, width: 8, height: 8, coordinateSpace: "physical" as const },
      state: { enabled: true },
    }));
    const balancedDomWithIntent = balancedDom.map((element, index) => ({
      ...element,
      name: index < 8 ? "ZebraNeedle " + index : element.name,
    }));
    const balanced = new DeterministicGroundingSelector().select(hybridCatalog([
      ...balancedUia,
      balancedRadio,
      ...balancedDomWithIntent,
    ]), { goal: "ZebraNeedle", latestUserCorrections: [] });
    expect(balanced.elements).toHaveLength(16);
    expect(balanced.elements.filter((element) => element.source === "uia")).toHaveLength(8);
    expect(balanced.elements.filter((element) => element.source === "dom")).toHaveLength(8);
    expect(balanced.selection?.selectedElementRefs).not.toContain(balancedRadio.elementRef);

    const intentRadio = { ...radio, elementRef: "synthetic-intent-radio", name: "MacBook Air current configuration" };
    const secondIntentRadio = { ...radio, elementRef: "synthetic-second-intent-radio", name: "MacBook Air lowest price option" };
    const intentSelection = new DeterministicGroundingSelector().select(hybridCatalog([
      intentRadio,
      secondIntentRadio,
      ...balancedDom,
    ]), { goal: "MacBook Air lowest price", latestUserCorrections: [] });
    expect(intentSelection.selection?.selectedElementRefs).toContain(intentRadio.elementRef);
    expect(intentSelection.selection?.reasons.find((reason) => reason.elementRef === intentRadio.elementRef)?.codes).toContain("goal_match");
    expect(intentSelection.selection?.selectedElementRefs).toContain(secondIntentRadio.elementRef);

    const localRadio = { ...radio, elementRef: "synthetic-local-radio", bbox: { ...radio.bbox, x: 450, y: 450 } };
    const localRadioSelection = new DeterministicGroundingSelector().select(hybridCatalog([localRadio]), {
      goal: "unrelated query",
      latestUserCorrections: [],
      recoveryHint: { reason: "no_observed_change", attempt: 1, region: { x: 440, y: 440, width: 80, height: 80 } },
    });
    expect(localRadioSelection.selection?.selectedElementRefs).toContain(localRadio.elementRef);
    expect(localRadioSelection.selection?.reasons.find((reason) => reason.elementRef === localRadio.elementRef)?.codes).toContain("local_recovery_region");

    const focusedRadio = { ...radio, elementRef: "synthetic-focused-radio", state: { enabled: true, focused: true } };
    const focusedRadioSelection = new DeterministicGroundingSelector().select(hybridCatalog([focusedRadio]), {
      goal: "unrelated query",
      latestUserCorrections: [],
    });
    expect(focusedRadioSelection.selection?.selectedElementRefs).toContain(focusedRadio.elementRef);
    expect(focusedRadioSelection.selection?.reasons.find((reason) => reason.elementRef === focusedRadio.elementRef)?.codes).toContain("focused");

    const limitOne = new DeterministicGroundingSelector({ hotLimit: 1, localQuota: 0, focusedEditableQuota: 0, globalQuota: 0, structuredControlQuota: 0 })
      .select(hybridCatalog([
        { ...radio, elementRef: "synthetic-ranked-radio-first", name: "Alpha radio" },
        { ...radio, elementRef: "synthetic-ranked-radio-second", name: "Beta radio" },
      ]), { goal: "unrelated query", latestUserCorrections: [] });
    expect(limitOne.elements).toHaveLength(1);
    expect(limitOne.elements[0]?.elementRef).toBe("synthetic-ranked-radio-first");
    expect(limitOne.selection?.reasons[0]?.codes.length).toBeLessThanOrEqual(8);
  });

  it("keeps UIA and DOM state distinct when DOM enabled state is false or unknown", () => {
    const selected = new DeterministicGroundingSelector().select(hybridCatalog([
      { elementRef: "dom-disabled", role: "link", name: "Disabled control", source: "dom", browserRegion: "content", bbox: { x: 100, y: 100, width: 80, height: 30, coordinateSpace: "physical" }, state: { enabled: false } },
      { elementRef: "uia-disabled", role: "AXLink", name: "Disabled control", source: "uia", browserRegion: "content", bbox: { x: 100, y: 100, width: 80, height: 30, coordinateSpace: "physical" }, state: { enabled: true } },
      { elementRef: "dom-unknown", role: "link", name: "Unknown control", source: "dom", browserRegion: "content", bbox: { x: 220, y: 100, width: 80, height: 30, coordinateSpace: "physical" } },
      { elementRef: "uia-unknown", role: "AXLink", name: "Unknown control", source: "uia", browserRegion: "content", bbox: { x: 220, y: 100, width: 80, height: 30, coordinateSpace: "physical" }, state: { enabled: true } },
    ]), { goal: "Disabled control and Unknown control", latestUserCorrections: [] });
    expect(selected.elements.find((element) => element.elementRef === "dom-disabled")?.state?.enabled).toBe(false);
    expect(selected.elements.find((element) => element.elementRef === "dom-unknown")?.state?.enabled).toBeUndefined();
    expect(selected.elements.some((element) => element.elementRef === "uia-disabled")).toBe(true);
    expect(selected.elements.some((element) => element.elementRef === "uia-unknown")).toBe(true);
  });

  it("does not compact UIA-only labels while matching cross-source content aliases", () => {
    const selected = new DeterministicGroundingSelector().select(catalog([
      { elementRef: "uia-spaced", role: "Button", name: "A B", bbox: { x: 10, y: 10, width: 40, height: 20, coordinateSpace: "physical" } },
      { elementRef: "uia-compact", role: "Button", name: "AB", bbox: { x: 10, y: 10, width: 40, height: 20, coordinateSpace: "physical" } },
    ]), { goal: "", latestUserCorrections: [] });
    expect(selected.elements.map((element) => element.elementRef)).toEqual(["uia-spaced", "uia-compact"]);
  });

  it("matches Latin, digits, and Han terms when they are adjacent in a label", () => {
    const selected = new DeterministicGroundingSelector().select(catalog([
      { elementRef: "uia-mixed-script", role: "Link", name: "2026 Mac mini新款上海", bbox: { x: 10, y: 10, width: 140, height: 30, coordinateSpace: "physical" }, state: { enabled: true } },
    ]), { goal: "查询 2026 Mac mini 上海产品", latestUserCorrections: [] });
    expect(selected.selection?.reasons.find((item) => item.elementRef === "uia-mixed-script")?.codes).toContain("goal_match");
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
    expect(targetReason?.codes).toContain("goal_match");
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
    expect(selected.selection?.reasons.find((item) => item.elementRef === "uia-origin-input")?.codes).toContain("correction_match");
  });

  it("compresses selection reasons to the trajectory cap without dropping specific matches", () => {
    const selected = new DeterministicGroundingSelector().select(hybridCatalog([{
      elementRef: "dom-focused-editable",
      role: "combobox",
      name: "Choose route options",
      source: "dom",
      browserRegion: "content",
      bbox: { x: 10, y: 10, width: 120, height: 24, coordinateSpace: "physical" },
      state: { enabled: true, focused: true, editable: true },
    }]), {
      goal: "Choose route options",
      latestUserCorrections: [],
      activePlanText: "Choose route options",
    });
    const codes = selected.selection?.reasons.find((item) => item.elementRef === "dom-focused-editable")?.codes ?? [];
    expect(codes.length).toBeLessThanOrEqual(8);
    expect(codes).toEqual(expect.arrayContaining([
      "plan_match",
      "goal_match",
      "focused",
      "editable",
      "dom_content_priority",
    ]));
    expect(codes).not.toEqual(expect.arrayContaining(["query_match", "query_substring_match"]));
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

  it("uses a bounded local recovery quota and records its source in the trace", () => {
    const selected = new DeterministicGroundingSelector().select(hybridCatalog([
      {
        elementRef: "dom-nearby",
        role: "button",
        name: "More options",
        source: "dom",
        browserRegion: "content",
        bbox: { x: 100, y: 100, width: 40, height: 30, coordinateSpace: "physical" },
        state: { enabled: true },
      },
      {
        elementRef: "dom-distant-goal",
        role: "button",
        name: "Departure station",
        source: "dom",
        browserRegion: "content",
        bbox: { x: 800, y: 500, width: 80, height: 30, coordinateSpace: "physical" },
        state: { enabled: true },
      },
    ]), {
      goal: "Choose the departure station",
      latestUserCorrections: [],
      recoveryHint: {
        actionId: "action-recovery" as never,
        reason: "no_observed_change",
        attempt: 1,
        localIntent: "open the options near the failed click",
        localIntentSource: "user_correction",
        region: { x: 80, y: 80, width: 80, height: 70, coordinateSpace: "physical" },
      },
    });
    expect(selected.elements[0]?.elementRef).toBe("dom-nearby");
    expect(selected.selection?.strategy).toBe("bounded-fusion-v1");
    expect(selected.selection?.recovery).toMatchObject({ reason: "no_observed_change", attempt: 1, regionApplied: true, localIntentSource: "user_correction" });
    expect(selected.selection?.reasons[0]?.codes).toContain("local_recovery_region");
  });

  it("deduplicates overlapping UIA/DOM content while preferring DOM content and UIA chrome", () => {
    const selected = new DeterministicGroundingSelector().select(hybridCatalog([
      {
        elementRef: "uia-content",
        role: "button",
        name: "Route options",
        source: "uia",
        bbox: { x: 100, y: 100, width: 80, height: 30, coordinateSpace: "physical" },
        state: { enabled: true },
      },
      {
        elementRef: "dom-content",
        role: "button",
        name: "Route options",
        source: "dom",
        browserRegion: "content",
        bbox: { x: 101, y: 101, width: 78, height: 28, coordinateSpace: "physical" },
        state: { enabled: true },
      },
      {
        elementRef: "dom-chrome",
        role: "tab",
        name: "Route options",
        source: "dom",
        browserRegion: "chrome",
        bbox: { x: 300, y: 10, width: 80, height: 30, coordinateSpace: "physical" },
        state: { enabled: true },
      },
      {
        elementRef: "uia-chrome",
        role: "tab",
        name: "Route options",
        source: "uia",
        browserRegion: "chrome",
        bbox: { x: 301, y: 11, width: 78, height: 28, coordinateSpace: "physical" },
        state: { enabled: true },
      },
    ]), { goal: "", latestUserCorrections: [] });
    expect(selected.elements.map((element) => element.elementRef)).toEqual(expect.arrayContaining(["dom-content", "uia-chrome"]));
    expect(selected.elements).not.toEqual(expect.arrayContaining(["uia-content", "dom-chrome"]));
    expect(selected.selection?.deduplicatedElementCount).toBe(2);
  });

  it("borrows unused source capacity and keeps a scarce DOM source visible", () => {
    const selected = new DeterministicGroundingSelector().select(hybridCatalog([
      { elementRef: "dom-only", role: "button", name: "Rare DOM control", source: "dom", browserRegion: "content", bbox: { x: 10, y: 10, width: 30, height: 20, coordinateSpace: "physical" }, state: { enabled: true } },
      ...Array.from({ length: 20 }, (_, index) => ({
        elementRef: `uia-${index}`,
        role: "tab",
        name: `Native item ${index}`,
        source: "uia" as const,
        browserRegion: "chrome" as const,
        bbox: { x: 100 + index * 10, y: 100, width: 8, height: 20, coordinateSpace: "physical" as const },
        state: { enabled: true },
      })),
    ]), { goal: "", latestUserCorrections: [] });
    expect(selected.elements).toHaveLength(16);
    expect(selected.elements.some((element) => element.elementRef === "dom-only")).toBe(true);
  });

  it("traces low-trust provider recovery source without persisting its hint text", () => {
    const hintText = "provider-only target text must stay out of trace";
    const selected = new DeterministicGroundingSelector().select(catalog([
      {
        elementRef: "uia-provider-hint",
        role: "Button",
        name: "Provider target",
        bbox: { x: 10, y: 10, width: 30, height: 20, coordinateSpace: "physical" },
        state: { enabled: true },
      },
    ]), {
      goal: "",
      latestUserCorrections: [],
      recoveryHint: { reason: "no_observed_change", attempt: 1, localIntent: hintText, localIntentSource: "provider_hint" },
    });
    expect(selected.selection?.recovery).toMatchObject({ localIntentApplied: true, localIntentSource: "provider_hint" });
    expect(JSON.stringify(selected.selection)).not.toContain(hintText);
  });

  it("reserves at most two enabled bounded DOM select controls among 256 noise elements", () => {
    const noise = Array.from({ length: 256 }, (_, index) => ({
      elementRef: `uia-noise-${index}`,
      role: "Button",
      name: `Noise control ${index}`,
      source: "uia" as const,
      browserRegion: "chrome" as const,
      bbox: { x: 10 + (index % 32) * 24, y: 10 + Math.floor(index / 32) * 24, width: 16, height: 16, coordinateSpace: "physical" as const },
      state: { enabled: true },
    }));
    const selected = new DeterministicGroundingSelector().select(hybridCatalog([
      ...noise,
      {
        elementRef: "dom-select-first",
        role: "select",
        name: "Departure time",
        source: "dom",
        browserRegion: "content",
        bbox: { x: 100, y: 500, width: 120, height: 26, coordinateSpace: "physical" },
        state: { enabled: true },
      },
      {
        elementRef: "dom-select-second",
        role: "combobox",
        name: "Arrival time",
        source: "dom",
        browserRegion: "content",
        bbox: { x: 240, y: 500, width: 120, height: 26, coordinateSpace: "physical" },
        state: { enabled: true },
      },
      {
        elementRef: "dom-select-third",
        role: "select",
        name: "Passenger type",
        source: "dom",
        browserRegion: "content",
        bbox: { x: 380, y: 500, width: 120, height: 26, coordinateSpace: "physical" },
        state: { enabled: true },
      },
      {
        elementRef: "dom-select-disabled",
        role: "select",
        name: "Disabled option",
        source: "dom",
        browserRegion: "content",
        bbox: { x: 520, y: 500, width: 120, height: 26, coordinateSpace: "physical" },
        state: { enabled: false },
      },
      {
        elementRef: "dom-select-unbounded",
        role: "select",
        name: "Missing bounds",
        source: "dom",
        browserRegion: "content",
        state: { enabled: true },
      },
      {
        elementRef: "uia-select",
        role: "ComboBox",
        name: "Native combo",
        source: "uia",
        browserRegion: "content",
        bbox: { x: 660, y: 500, width: 120, height: 26, coordinateSpace: "physical" },
        state: { enabled: true },
      },
    ]), {
      goal: "",
      latestUserCorrections: [],
      preferredRoles: ["select", "combobox"],
      structuredToolHints: [{ toolName: "select_option", preferredRoles: ["select", "combobox"], preferredSources: ["dom"] }],
    });
    const structured = selected.selection?.reasons.filter((reason) => reason.codes.includes("structured_control")) ?? [];
    expect(selected.elements).toHaveLength(16);
    expect(structured.map((reason) => reason.elementRef)).toEqual(["dom-select-first", "dom-select-second"]);
    expect(selected.elements.some((element) => element.elementRef === "dom-select-third")).toBe(false);
    expect(selected.elements.some((element) => element.elementRef === "dom-select-disabled")).toBe(false);
    expect(selected.elements.some((element) => element.elementRef === "dom-select-unbounded")).toBe(false);
    expect(selected.elements.some((element) => element.elementRef === "uia-select")).toBe(false);
    expect(structured.every((reason) => reason.codes.length <= 8)).toBe(true);
  });

  it("does not inject structured select hints when the tool is off or the catalog is UIA-only", () => {
    const select = {
      elementRef: "dom-only-select",
      role: "combobox",
      name: "Only DOM select",
      source: "dom" as const,
      browserRegion: "content" as const,
      bbox: { x: 20, y: 20, width: 100, height: 24, coordinateSpace: "physical" as const },
      state: { enabled: true },
    };
    const query = {
      goal: "",
      latestUserCorrections: [],
      preferredRoles: ["select", "combobox"],
      structuredToolHints: [{ toolName: "select_option", preferredRoles: ["select", "combobox"], preferredSources: ["dom"] }],
    } as const;
    const enabled = new DeterministicGroundingSelector().select(hybridCatalog([select]), query);
    expect(enabled.selection?.reasons[0]?.codes).toContain("structured_control");

    const toolOff = new DeterministicGroundingSelector().select(hybridCatalog([select]), {
      goal: "",
      latestUserCorrections: [],
    });
    expect(toolOff.selection?.reasons[0]?.codes).not.toContain("structured_control");

    const uiaOnly = new DeterministicGroundingSelector().select(catalog([{ ...select, source: "uia", elementRef: "uia-select" }]), query);
    expect(uiaOnly.selection?.reasons[0]?.codes).not.toContain("structured_control");
  });

  it("keeps a configured structured-control quota bounded", () => {
    const elements = Array.from({ length: 8 }, (_, index) => ({
      elementRef: `dom-select-${index}`,
      role: "select",
      name: `Choice ${index}`,
      source: "dom" as const,
      browserRegion: "content" as const,
      bbox: { x: 20 + index * 110, y: 20, width: 90, height: 24, coordinateSpace: "physical" as const },
      state: { enabled: true },
    }));
    const query = {
      goal: "",
      latestUserCorrections: [],
      structuredToolHints: [{ toolName: "select_option", preferredRoles: ["select"], preferredSources: ["dom"] }],
    } as const;
    const selected = new DeterministicGroundingSelector({ structuredControlQuota: 99 }).select(hybridCatalog(elements), query);
    expect(selected.selection?.reasons.filter((reason) => reason.codes.includes("structured_control"))).toHaveLength(4);
  });
});
