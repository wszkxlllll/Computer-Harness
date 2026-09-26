import { describe, expect, it } from "vitest";
import type { GroundingCatalog, GroundingElement } from "@computer-harness/protocol";
import {
  DeterministicGroundingRetrieval,
  normalizeGroundingLabel,
  normalizeGroundingRetrievalQuery,
  retrieveGroundingClusters,
} from "./grounding-retrieval.js";

const box = (x: number, y: number, width = 100, height = 30) => ({ x, y, width, height, coordinateSpace: "physical" as const });

function element(
  elementRef: string,
  role: string,
  name: string | undefined,
  options: Partial<GroundingElement> = {},
): GroundingElement {
  return {
    elementRef,
    role,
    ...(name === undefined ? {} : { name }),
    ...options,
  };
}

function catalog(elements: readonly GroundingElement[], source: GroundingCatalog["source"] = "hybrid"): GroundingCatalog {
  return {
    version: "grounding-catalog-v2",
    source,
    observationId: "retrieval-observation" as GroundingCatalog["observationId"],
    computerSessionId: "retrieval-session" as GroundingCatalog["computerSessionId"],
    completeness: "complete",
    degraded: false,
    maxElements: 256,
    elements,
  };
}

const query = {
  goal: "Find the search button",
  latestUserCorrections: ["use the search control"],
  activePlanText: "search the route",
  localExecutionIntent: "search",
  recoveryHint: { reason: "no_observed_change" as const, attempt: 1, localIntent: "search" },
};

function clusterFor(result: ReturnType<typeof retrieveGroundingClusters>, ref: string) {
  return result.clusters.find((cluster) => cluster.memberRefs.includes(ref));
}

describe("experimental semantic grounding retrieval", () => {
  it("normalizes NFKC/case/space/punctuation and preserves one query structure", () => {
    expect(normalizeGroundingLabel("  Ｓｅａｒｃｈ — BUTTON。 ")).toBe("search button");
    expect(normalizeGroundingRetrievalQuery(query)).toEqual({
      goal: "find the search button",
      corrections: ["use the search control"],
      plan: "search the route",
      localIntent: "search",
      recovery: "no observed change search",
    });
  });

  it("merges audited actionable role aliases across DOM/UIA and keeps evidence", () => {
    const result = retrieveGroundingClusters(catalog([
      element("dom-search", "button", "Search", { source: "dom", browserRegion: "content", bbox: box(100, 100), state: { enabled: true } }),
      element("uia-search", "Push Button", "Search", { source: "uia", browserRegion: "content", bbox: box(101, 101), state: { enabled: true } }),
    ]), query);
    expect(result.rawElementCount).toBe(2);
    expect(result.observationId).toBe("retrieval-observation");
    expect(result.computerSessionId).toBe("retrieval-session");
    expect(result.clusters).toHaveLength(1);
    const cluster = result.clusters[0]!;
    expect(cluster.rank).toBe(1);
    expect(cluster.memberRefs).toEqual(["dom-search", "uia-search"]);
    expect(cluster.members.map((member) => member.elementRef)).toEqual(cluster.memberRefs);
    expect(cluster.representativeRef).toBe("dom-search");
    expect(cluster.representative.source).toBe("dom");
    expect(cluster.aliases).toHaveLength(1);
    expect(cluster.aliases[0]).toMatchObject({ elementRef: "uia-search", relation: "peer_alias", role: "Push Button", source: "uia", normalizedLabel: "search" });
    expect(cluster.aliases[0]!.evidence[0]).toMatchObject({ leftRef: "dom-search", rightRef: "uia-search", relation: "peer_alias", labelStrength: "exact" });
    expect(cluster.evidence[0]).toMatchObject({ iou: expect.any(Number), centerDistance: expect.any(Number) });
    expect(cluster.reasonCodes).toContain("local_intent_match");
    expect(cluster.score).toBeGreaterThan(0);
  });

  it("recognizes common DOM/UIA actionable role families without merging separate leaves", () => {
    const rolePairs: readonly [string, string][] = [
      ["CheckBox", "UIA_CheckBoxControlTypeId"],
      ["RadioButton", "Radio Button"],
      ["ComboBox", "Combo Box"],
      ["ListBox", "List Box"],
      ["MenuItem", "Menu Item"],
      ["Option", "ListItem"],
      ["TabItem", "Tab Item"],
      ["Switch", "Toggle Button"],
      ["Slider", "Range Control"],
      ["SpinButton", "Spin Button"],
      ["TreeItem", "Tree Item"],
      ["CalendarCell", "Date Cell"],
    ];
    const elements = rolePairs.flatMap(([domRole, uiaRole], index) => {
      const x = 20 + index * 100;
      return [
        element(`dom-role-${index}`, domRole, `role target ${index}`, {
          source: "dom",
          browserRegion: "content",
          bbox: box(x, 100),
          state: { enabled: true },
        }),
        element(`uia-role-${index}`, uiaRole, `role target ${index}`, {
          source: "uia",
          browserRegion: "content",
          bbox: box(x + 1, 101),
          state: { enabled: true },
        }),
      ];
    });
    const result = retrieveGroundingClusters(catalog(elements), { goal: "role target" });
    expect(result.clusters).toHaveLength(rolePairs.length);
    for (let index = 0; index < rolePairs.length; index += 1) {
      const cluster = clusterFor(result, `dom-role-${index}`)!;
      expect(cluster.memberRefs).toEqual([`dom-role-${index}`, `uia-role-${index}`]);
      expect(cluster.aliases).toHaveLength(1);
    }

    const separateLeaves = retrieveGroundingClusters(catalog([
      element("checkbox-a", "CheckBox", "Remember", { source: "dom", browserRegion: "content", bbox: box(20, 220), state: { enabled: true } }),
      element("checkbox-a-uia", "Check Box", "Remember", { source: "uia", browserRegion: "content", bbox: box(21, 221), state: { enabled: true } }),
      element("checkbox-b", "CheckBox", "Remember", { source: "dom", browserRegion: "content", bbox: box(220, 220), state: { enabled: true } }),
      element("checkbox-b-uia", "Check Box", "Remember", { source: "uia", browserRegion: "content", bbox: box(221, 221), state: { enabled: true } }),
    ]), { goal: "Remember" });
    expect(separateLeaves.clusters).toHaveLength(2);
    expect(separateLeaves.clusters.every((cluster) => cluster.memberRefs.length === 2)).toBe(true);
  });

  it("keeps long menus and result rows behind short named controls on a Goal-only query", () => {
    const longResultRows = Array.from({ length: 40 }, (_, index) => element(
      `long-result-${index}`,
      "MenuItem",
      `候选车次 ${index + 1} 北京南 上海虹桥 G${(1200 + index).toString()}`,
      {
        source: "dom",
        browserRegion: "content",
        description: "这是一个很长的结果行，包含线路、席别、价格、出发日期、查询按钮和筛选条件等背景文本",
        bbox: box(20, 300 + index * 32, 600, 28),
        state: { enabled: true },
      },
    ));
    const result = retrieveGroundingClusters(catalog([
      element("query-button", "Button", "查询", { source: "dom", browserRegion: "content", bbox: box(40, 80), state: { enabled: true } }),
      element("remember-checkbox", "CheckBox", "记住选项", { source: "dom", browserRegion: "content", bbox: box(40, 120), state: { enabled: true } }),
      element("departure-combobox", "ComboBox", "出发日期", { source: "dom", browserRegion: "content", bbox: box(40, 160), state: { enabled: true } }),
      element("calendar-cell", "CalendarCell", "15", { source: "dom", browserRegion: "content", bbox: box(40, 200), state: { enabled: true } }),
      ...longResultRows,
    ]), {
      goal: "请完成车票查询：选择出发日期后选择具体日期 15，勾选记住选项并点击查询按钮",
    });

    const rankOf = (ref: string) => clusterFor(result, ref)!.rank;
    expect(rankOf("query-button")).toBeLessThan(32);
    expect(rankOf("remember-checkbox")).toBeLessThan(32);
    expect(rankOf("departure-combobox")).toBeLessThan(32);
    expect(rankOf("calendar-cell")).toBeLessThan(32);
    expect(longResultRows.some((row) => rankOf(row.elementRef) <= 4)).toBe(false);
  });

  it("keeps T01-shaped date/filter controls in the shared K32 prefix", () => {
    const goal = "在铁路12306查询2026-09-23上海到杭州的高铁动车，要求08:00至12:00出发，优先最早到达，选择出发日期和发车时间后点击查询";
    const noise = Array.from({ length: 149 }, (_, index) => element(
      `result-row-${index}`,
      "MenuItem",
      `车次 G${1200 + index} 上海南 杭州东 ${String(index % 24).padStart(2, "0")}:00 高铁动车`,
      {
        source: "dom",
        browserRegion: "content",
        description: "列车结果行 车次、出发站、到达站、出发时间、到达时间、二等座显示票价和余票状态",
        bbox: box(420, 300 + index * 22, 520, 20),
        state: { enabled: true },
      },
    ));
    const result = retrieveGroundingClusters(catalog([
      element("date-input", "ComboBox", "出发日期", { source: "dom", browserRegion: "content", bbox: box(20, 80), state: { enabled: true } }),
      element("calendar-day", "CalendarCell", "23", { source: "dom", browserRegion: "content", bbox: box(20, 120), state: { enabled: true } }),
      element("train-filter", "CheckBox", "高铁动车", { source: "dom", browserRegion: "content", bbox: box(20, 160), state: { enabled: true } }),
      element("query-button", "Button", "查询", { source: "dom", browserRegion: "content", bbox: box(20, 200), state: { enabled: true } }),
      element("departure-time", "ComboBox", "发车时间", { source: "dom", browserRegion: "content", bbox: box(20, 240), state: { enabled: true } }),
      ...noise,
    ]), { goal });
    const targetRanks = ["date-input", "calendar-day", "train-filter", "query-button", "departure-time"]
      .map((ref) => clusterFor(result, ref)!.rank);
    expect(result.rawElementCount).toBe(154);
    expect(targetRanks.every((rank) => rank <= 32)).toBe(true);
  });

  it("merges a real-style nested actionable DOM/UIA wrapper and inner control", () => {
    const result = retrieveGroundingClusters(catalog([
      element("dom-search-wrapper", "button", "搜索", { source: "dom", browserRegion: "content", bbox: box(100, 100, 160, 48), state: { enabled: true } }),
      element("uia-search-inner", "PushButton", "搜索", { source: "uia", browserRegion: "content", bbox: box(120, 108, 120, 32), state: { enabled: true } }),
    ]), { goal: "搜索" });
    expect(result.clusters).toHaveLength(1);
    const cluster = result.clusters[0]!;
    expect(cluster.memberRefs).toEqual(["dom-search-wrapper", "uia-search-inner"]);
    expect(cluster.representativeRef).toBe("dom-search-wrapper");
    expect(cluster.aliases[0]).toMatchObject({ elementRef: "uia-search-inner", relation: "actionable_containment_alias" });
    expect(cluster.evidence[0]).toMatchObject({
      relation: "actionable_containment_alias",
      labelStrength: "exact",
      containment: 1,
      areaRatio: expect.closeTo(2, 5),
      centerDistance: 0,
    });
    expect(cluster.evidence[0]!.reasons).toEqual(expect.arrayContaining([
      "cross_source",
      "same_browser_region",
      "actionable_outer",
      "actionable_inner",
      "area_ratio_bounded",
    ]));
    expect(cluster.reasonCodes).toContain("actionable_containment_alias");
  });

  it("allows only tightly constrained same-source actionable containment", () => {
    const result = retrieveGroundingClusters(catalog([
      element("dom-wrapper", "Button", "搜索", { source: "dom", browserRegion: "content", bbox: box(100, 100, 140, 40), state: { enabled: true } }),
      element("dom-inner", "button", "搜索", { source: "dom", browserRegion: "content", bbox: box(110, 105, 120, 30), state: { enabled: true } }),
    ]), { goal: "搜索" });
    expect(result.clusters).toHaveLength(1);
    expect(result.clusters[0]!.aliases[0]!.relation).toBe("actionable_containment_alias");
    expect(result.clusters[0]!.evidence[0]!.reasons).toContain("same_source_strict");
  });

  it("does not merge distant or repeated same-name actionable controls", () => {
    const result = retrieveGroundingClusters(catalog([
      element("dom-search-one", "button", "搜索", { source: "dom", browserRegion: "content", bbox: box(100, 100), state: { enabled: true } }),
      element("uia-search-two", "PushButton", "搜索", { source: "uia", browserRegion: "content", bbox: box(100, 180), state: { enabled: true } }),
      element("dom-search-three", "button", "搜索", { source: "dom", browserRegion: "content", bbox: box(500, 100), state: { enabled: true } }),
    ]), { goal: "搜索" });
    expect(result.clusters).toHaveLength(3);
    expect(result.clusters.every((cluster) => cluster.aliases.length === 0)).toBe(true);
  });

  it("does not merge actionable containment across regions or enabled-state conflicts", () => {
    const result = retrieveGroundingClusters(catalog([
      element("dom-content", "button", "搜索", { source: "dom", browserRegion: "content", bbox: box(100, 100, 160, 48), state: { enabled: true } }),
      element("uia-chrome", "PushButton", "搜索", { source: "uia", browserRegion: "chrome", bbox: box(120, 108, 120, 32), state: { enabled: true } }),
      element("dom-enabled", "button", "提交", { source: "dom", browserRegion: "content", bbox: box(400, 100, 160, 48), state: { enabled: true } }),
      element("uia-disabled", "PushButton", "提交", { source: "uia", browserRegion: "content", bbox: box(420, 108, 120, 32), state: { enabled: false } }),
    ]), { goal: "搜索 提交" });
    expect(result.clusters).toHaveLength(4);
    expect(result.clusters.every((cluster) => cluster.aliases.length === 0)).toBe(true);
  });

  it("fails closed when browser-region evidence is missing", () => {
    const result = retrieveGroundingClusters(catalog([
      element("dom-unknown-region", "button", "搜索", { source: "dom", bbox: box(100, 100, 160, 48), state: { enabled: true } }),
      element("uia-unknown-region", "PushButton", "搜索", { source: "uia", bbox: box(120, 108, 120, 32), state: { enabled: true } }),
    ]), { goal: "搜索" });
    expect(result.clusters).toHaveLength(2);
    expect(result.clusters.every((cluster) => cluster.aliases.length === 0)).toBe(true);
  });

  it("supports nested actionable parent + static child only when the leaf is unique", () => {
    const result = retrieveGroundingClusters(catalog([
      element("button-parent", "PushButton", "Search button", { source: "dom", browserRegion: "content", bbox: box(200, 100, 120, 40), state: { enabled: true } }),
      element("button-text", "StaticText", "Search", { source: "dom", browserRegion: "content", bbox: box(220, 110, 80, 20) }),
    ]), query);
    expect(result.clusters).toHaveLength(1);
    const cluster = result.clusters[0]!;
    expect(cluster.representativeRef).toBe("button-parent");
    expect(cluster.aliases[0]!.relation).toBe("nested_alias");
    expect(cluster.evidence[0]).toMatchObject({ relation: "nested_alias", containment: 1, centerDistance: expect.any(Number), labelStrength: "strong" });
    expect(cluster.evidence[0]!.reasons).toEqual(expect.arrayContaining(["actionable_parent", "static_child", "unique_actionable_leaf"]));
  });

  it("rejects broad ancestors, adjacent/repeated controls, URL cells and checkbox labels", () => {
    const result = retrieveGroundingClusters(catalog([
      element("document", "Document", "Search", { source: "dom", browserRegion: "content", bbox: box(0, 0, 1000, 700) }),
      element("row-one", "Button", "二等座", { source: "dom", browserRegion: "content", bbox: box(100, 100) }),
      element("row-two", "Button", "二等座", { source: "dom", browserRegion: "content", bbox: box(100, 150) }),
      element("adjacent-a", "Button", "Same", { source: "dom", browserRegion: "content", bbox: box(300, 100) }),
      element("adjacent-b", "Button", "Same", { source: "dom", browserRegion: "content", bbox: box(390, 100) }),
      element("url-a", "Link", "https://example.com/ticket", { source: "dom", browserRegion: "content", bbox: box(500, 100) }),
      element("url-b", "Link", "https://example.com/ticket", { source: "dom", browserRegion: "content", bbox: box(620, 100) }),
      element("checkbox", "CheckBox", "Remember", { source: "dom", browserRegion: "content", bbox: box(740, 100) }),
      element("checkbox-label", "Label", "Remember", { source: "dom", browserRegion: "content", bbox: box(740, 100, 80, 20) }),
    ]), { goal: "choose 二等座" });
    expect(result.clusters).toHaveLength(9);
    expect(clusterFor(result, "document")!.aliases).toHaveLength(0);
    expect(clusterFor(result, "row-one")!.memberRefs).toEqual(["row-one"]);
    expect(clusterFor(result, "row-two")!.memberRefs).toEqual(["row-two"]);
    expect(clusterFor(result, "adjacent-a")!.memberRefs).toEqual(["adjacent-a"]);
    expect(clusterFor(result, "url-a")!.memberRefs).toEqual(["url-a"]);
    expect(clusterFor(result, "checkbox")!.memberRefs).toEqual(["checkbox"]);
    expect(clusterFor(result, "checkbox-label")!.memberRefs).toEqual(["checkbox-label"]);
  });

  it("keeps role/state/region/missing-data conflicts fail-closed", () => {
    const result = retrieveGroundingClusters(catalog([
      element("region-content", "Button", "Go", { source: "dom", browserRegion: "content", bbox: box(0, 0), state: { enabled: true } }),
      element("region-chrome", "PushButton", "Go", { source: "uia", browserRegion: "chrome", bbox: box(0, 0), state: { enabled: true } }),
      element("enabled", "Button", "State", { source: "dom", browserRegion: "content", bbox: box(120, 0), state: { enabled: true } }),
      element("disabled", "Button", "State", { source: "uia", browserRegion: "content", bbox: box(120, 0), state: { enabled: false } }),
      element("missing-name-a", "Button", undefined, { source: "dom", browserRegion: "content", bbox: box(240, 0) }),
      element("missing-name-b", "PushButton", undefined, { source: "uia", browserRegion: "content", bbox: box(240, 0) }),
      element("missing-box-a", "Button", "Missing box", { source: "dom", browserRegion: "content" }),
      element("missing-box-b", "PushButton", "Missing box", { source: "uia", browserRegion: "content" }),
    ]), { goal: "" });
    expect(result.clusters).toHaveLength(8);
    for (const ref of ["region-content", "region-chrome", "enabled", "disabled", "missing-name-a", "missing-name-b", "missing-box-a", "missing-box-b"]) {
      expect(clusterFor(result, ref)!.memberRefs).toEqual([ref]);
    }
  });

  it("is input-order stable and exposes a full order suitable for prefix slicing", () => {
    const elements = [
      element("alpha", "Button", "Alpha", { source: "dom", browserRegion: "content", bbox: box(0, 0) }),
      element("beta", "Link", "Beta", { source: "dom", browserRegion: "content", bbox: box(200, 0) }),
      element("gamma", "TextBox", "Gamma", { source: "uia", browserRegion: "chrome", bbox: box(400, 0), state: { editable: true, focused: true } }),
      element("alpha-alias", "PushButton", "Alpha", { source: "uia", browserRegion: "chrome", bbox: box(1, 1) }),
    ];
    const first = retrieveGroundingClusters(catalog(elements), { goal: "Gamma Alpha" });
    const second = retrieveGroundingClusters(catalog([...elements].reverse()), { goal: "Gamma Alpha" });
    expect(first.clusters.map((cluster) => [cluster.semanticClusterId, cluster.rank, cluster.memberRefs])).toEqual(
      second.clusters.map((cluster) => [cluster.semanticClusterId, cluster.rank, cluster.memberRefs]),
    );
    expect(first.clusters.length).toBeGreaterThan(0);
    expect(first.clusters.slice(0, 2)).toEqual(first.clusters.slice(0, 2));
    expect(first.clusters[0]!.rank).toBe(1);
    expect(first.clusters.at(-1)!.rank).toBe(first.clusters.length);
    const retrieval = new DeterministicGroundingRetrieval();
    expect(retrieval.retrieve(catalog(elements), { goal: "Gamma Alpha" }).clusters.map((cluster) => cluster.semanticClusterId)).toEqual(
      first.clusters.map((cluster) => cluster.semanticClusterId),
    );
  });

  it("does not let stripped boilerplate alone create an alias", () => {
    const result = retrieveGroundingClusters(catalog([
      element("button-only", "Button", "button", { source: "dom", browserRegion: "content", bbox: box(0, 0) }),
      element("pushbutton-only", "PushButton", "push button", { source: "uia", browserRegion: "chrome", bbox: box(0, 0) }),
    ]), { goal: "" });
    expect(result.clusters).toHaveLength(2);
    expect(result.clusters.every((cluster) => cluster.aliases.length === 0)).toBe(true);
  });
});
