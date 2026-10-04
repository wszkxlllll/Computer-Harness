import type { ActionId, AssetId, ComputerSessionId, ObservationId, RunId, SurfaceId, ToolCallId } from "@computer-harness/protocol";
import { describe, expect, it } from "vitest";
import type { ActionPolicyContext, ProviderAdapter } from "@computer-harness/runtime";
import { initialRunSnapshot } from "@computer-harness/trajectory";
import { LayeredRiskGuard, ProviderRiskAssessor, ScriptedRiskAssessor } from "./index.js";

const runId = "risk-run" as RunId;
const surfaceRef = { surfaceId: "risk-guard-index-desktop" as SurfaceId, generation: 1, kind: "desktop" as const };
const observation = {
  id: "observation-1" as ObservationId,
  runId,
  computerSessionId: "computer-1" as ComputerSessionId,
  surfaceRef,
  capturedAt: "2026-09-16T00:00:00.000Z",
  viewport: { width: 800, height: 600, coordinateSpace: "physical" as const },
  screenshot: { assetId: "asset-1" as AssetId, relativePath: "screenshots/one.png", mediaType: "image/png", byteLength: 1 },
};
const session = { id: observation.computerSessionId, backend: "fake", viewport: observation.viewport, capabilities: { screenshot: true, pointer: true, keyboard: true, accessibility: false }, openedAt: observation.capturedAt };

function context(effect: "navigate" | "financial" | "local_edit" | "unknown", target = "Details", summary = "Open details", kind: "click" | "type" = "click", groundingRef?: string): ActionPolicyContext {
  const call = { id: "call-1" as ToolCallId, name: groundingRef === undefined ? kind : kind === "click" ? "click_element" : "type", arguments: groundingRef === undefined ? kind === "click" ? { x: 10, y: 20 } : { text: "hello" } : kind === "click" ? { elementRef: groundingRef } : { elementRef: groundingRef, text: "hello" }, declaredEffect: { effects: [effect], target, summary } };
  const action = kind === "click"
    ? { actionId: "action-1" as ActionId, basedOn: observation.id, kind: "click" as const, point: { x: 10, y: 20 }, ...(groundingRef === undefined ? {} : { groundingRef }) }
    : { actionId: "action-1" as ActionId, basedOn: observation.id, kind: "type" as const, text: "hello", ...(groundingRef === undefined ? {} : { groundingRef }) };
  const snapshot = initialRunSnapshot(runId);
  return { runId, goal: "Inspect a product and buy it only after confirmation", recentUserInputs: [], evaluatedSurfaceRef: observation.surfaceRef, candidate: { calls: [call], actions: [action], decisionObservation: observation, session }, snapshot };
}

function protectedContext(
  effect: "observe" | "local_edit" | "unknown",
  target: string,
  summary: string,
): ActionPolicyContext {
  const call = {
    id: "protected-call" as ToolCallId,
    name: "type",
    arguments: { text: "password=SYNTHETIC_ONLY" },
    declaredEffect: { effects: [effect], target, summary },
  };
  const snapshot = initialRunSnapshot(runId);
  return {
    runId,
    goal: "Fill the requested field",
    recentUserInputs: [],
    candidate: {
      calls: [call],
      actions: [{ actionId: "protected-action" as ActionId, basedOn: observation.id, kind: "type", text: "password=SYNTHETIC_ONLY" }],
      decisionObservation: observation,
      session,
    },
    snapshot,
  };
}

function keypressContext(effect: "unknown" | "navigate" = "unknown"): ActionPolicyContext {
  const snapshot = initialRunSnapshot(runId);
  return {
    runId,
    goal: "Use the configured shortcut",
    recentUserInputs: [],
    candidate: {
      calls: [{
        id: "shortcut-call" as ToolCallId,
        name: "hotkey",
        arguments: { keys: ["CTRL", "ALT", "DELETE"] },
        declaredEffect: { effects: [effect], target: "System shortcut", summary: "Use the shortcut" },
      }],
      actions: [{ actionId: "shortcut-action" as ActionId, basedOn: observation.id, kind: "keypress", keys: ["CTRL", "ALT", "DELETE"] }],
      decisionObservation: observation,
      session,
    },
    snapshot,
  };
}

function addressBarEnterContext(target = "Chrome 地址栏", summary = "回车提交地址栏 URL，导航到 Apple 中国官网首页"): ActionPolicyContext {
  const snapshot = initialRunSnapshot(runId);
  return withNavigationGrounding({
    runId,
    goal: "打开 https://www.apple.com.cn/",
    recentUserInputs: [],
    candidate: {
      calls: [{
        id: "address-bar-enter-call" as ToolCallId,
        name: "keypress",
        arguments: { keys: ["ENTER"] },
        declaredEffect: { effects: ["navigate"], target, summary },
      }],
      actions: [{ actionId: "address-bar-enter-action" as ActionId, basedOn: observation.id, kind: "keypress", keys: ["ENTER"] }],
      decisionObservation: observation,
      session,
    },
    snapshot,
  }, "address");
}

function withNavigationGrounding(candidate: ActionPolicyContext, kind: "search" | "address"): ActionPolicyContext {
  const action = candidate.candidate.actions[0];
  const click = action?.kind === "click";
  if (action?.kind === "click") candidate.candidate.actions[0] = { ...action, groundingRef: "navigation-control" };
  candidate.candidate.decisionObservation = { ...observation, grounding: {
    version: "grounding-catalog-v2", source: "hybrid", observationId: observation.id,
    computerSessionId: session.id, surfaceRef, completeness: "complete", degraded: false, maxElements: 256,
    elements: [{ elementRef: "navigation-control", source: kind === "search" ? "dom" : "uia",
      browserRegion: kind === "search" ? "content" : "chrome", role: click ? "button" : "textbox",
      name: kind === "search" ? "Search" : "Address and search bar",
      bbox: { x: 0, y: 0, width: 40, height: 40, coordinateSpace: "physical" },
      state: { focused: true, enabled: true, editable: !click } }],
  } };
  return candidate;
}

function switchWindowContext(
  effect?: "navigate" | "financial" | "external_commitment" | "observe" | "unknown",
  target = "Listed Browser window",
  summary = "Switch the active window binding",
): ActionPolicyContext {
  const snapshot = initialRunSnapshot(runId);
  return {
    runId,
    goal: "Review two already-open applications",
    recentUserInputs: [],
    candidate: {
      calls: [{
        id: "switch-call" as ToolCallId,
        name: "switch_window",
        arguments: { windowRef: "opaque-window-ref" },
        ...(effect === undefined ? {} : { declaredEffect: { effects: [effect], target, summary } }),
      }],
      actions: [{ actionId: "switch-action" as ActionId, basedOn: observation.id, kind: "switch_window", windowRef: "opaque-window-ref" }],
      decisionObservation: observation,
      session,
    },
    snapshot,
  };
}

describe("LayeredRiskGuard", () => {
  function focusedTyping(summary = "向当前聚焦的 Search 输入框逐字输入指定文本，不涉及提交或导航"): ActionPolicyContext {
    const candidate = context("local_edit", "Search 输入框", summary, "type");
    candidate.candidate.decisionObservation = {
      ...observation,
      grounding: {
        version: "grounding-catalog-v2", source: "hybrid", observationId: observation.id,
        computerSessionId: session.id, surfaceRef, completeness: "partial", degraded: false, maxElements: 256,
        elements: [{ elementRef: "search-1", source: "dom", browserRegion: "content", role: "textbox", name: "Search", state: { focused: true, enabled: true, editable: true } }],
      },
    };
    return candidate;
  }

  it("allows the observed single local-edit terminal disclaimer without invoking the assessor", async () => {
    let reviews = 0;
    const guard = new LayeredRiskGuard({ assessor: { id: "must-not-run", async classify() { reviews += 1; throw new Error("unexpected review"); } } });
    await expect(guard.evaluate(focusedTyping(), new AbortController().signal)).resolves.toMatchObject({ decision: "allow", path: "local", reasonCode: "declared_low_impact", policyVersion: "layered-effects-v2", modelRequestCount: 0 });
    expect(reviews).toBe(0);
  });

  it.each([
    "向Search输入文本，不涉及提交或导航。",
    "向Search输入文本, 不涉及提交或导航.",
  ])("accepts only the exact terminal disclaimer boundary: %s", async (summary) => {
    await expect(new LayeredRiskGuard({ maxModelRequests: 0 }).evaluate(focusedTyping(summary), new AbortController().signal)).resolves.toMatchObject({ decision: "allow", path: "local" });
  });

  it("accepts the actual partial nondegraded Runtime hot-subset shape without calling review", async () => {
    const candidate = focusedTyping();
    const current = candidate.candidate.decisionObservation;
    const catalog = current.grounding!;
    const elements = [...catalog.elements, ...Array.from({ length: 15 }, (_, index) => ({ elementRef: `other-${index}`, source: index < 7 ? "dom" as const : "uia" as const, role: "button", state: { focused: false, enabled: true } }))];
    candidate.candidate.decisionObservation = { ...current, grounding: { ...catalog, elements, selection: { strategy: "bounded-fusion-v1", candidateElementCount: 34, selectedElementRefs: elements.map((element) => element.elementRef), sourceCounts: { dom: 8, uia: 26 }, truncated: true, reasons: [] } } };
    await expect(new LayeredRiskGuard({ maxModelRequests: 0 }).evaluate(candidate, new AbortController().signal)).resolves.toMatchObject({ decision: "allow", path: "local", modelRequestCount: 0 });
  });

  it.each(["missing-counts", "omitted-dom", "wrong-total", "wrong-strategy", "wrong-refs"])("rejects inconsistent hot-subset provenance: %s", async (scenario) => {
    const candidate = focusedTyping();
    const current = candidate.candidate.decisionObservation;
    const catalog = current.grounding!;
    const selection = {
      strategy: scenario === "wrong-strategy" ? "deterministic-lexical-v1" as const : "bounded-fusion-v1" as const,
      candidateElementCount: scenario === "wrong-total" ? 4 : 3,
      selectedElementRefs: [scenario === "wrong-refs" ? "other-ref" : "search-1"],
      ...(scenario === "missing-counts" ? {} : { sourceCounts: { dom: scenario === "omitted-dom" ? 2 : 1, uia: 2 } }),
      truncated: true, reasons: [],
    };
    candidate.candidate.decisionObservation = { ...current, grounding: { ...catalog, selection } };
    await expect(new LayeredRiskGuard().evaluate(candidate, new AbortController().signal)).resolves.toMatchObject({ decision: "require_approval", path: "fallback", reasonCode: "semantic_review_unavailable" });
  });

  it.each([
    "不涉及提交或导航",
    "向Search输入文本，不涉及提交或导航，随后提交订单",
    "向Search输入文本，不涉及提交或导航但发送消息",
    "输入提交订单文本，不涉及提交或导航",
    "发送消息，不涉及提交或导航",
    "购买商品，不涉及提交或导航",
    "Buy the item, 不涉及提交或导航",
    "下单，不涉及提交或导航",
    "买入股票，不涉及提交或导航",
    "永久删除数据，不涉及提交或导航",
    "修改密码，不涉及提交或导航",
    "输入文本，不是不涉及提交或导航",
    "输入短语‘不涉及提交或导航’",
    "引用‘输入文本，不涉及提交或导航",
    "Write text, do not submit or navigate",
  ])("keeps other or nonterminal risk wording fail-closed: %s", async (summary) => {
    await expect(new LayeredRiskGuard().evaluate(focusedTyping(summary), new AbortController().signal)).resolves.toMatchObject({ decision: "require_approval", path: "fallback", reasonCode: "semantic_review_unavailable" });
  });

  it.each([
    "missing", "degraded", "unknown", "stale-catalog", "stale-action", "wrong-session", "unfocused", "disabled", "readonly", "multiple", "uia", "chrome", "button", "truncated", "newline", "control", "click", "enter", "batch", "risky-target", "old-version", "uia-catalog",
  ])("does not exempt typing without bounded current evidence: %s", async (scenario) => {
    const candidate = focusedTyping();
    const current = candidate.candidate.decisionObservation;
    const catalog = current.grounding!;
    const element = catalog.elements[0]!;
    const changedElement = { ...element, state: { ...element.state } };
    if (scenario === "missing") candidate.candidate.decisionObservation = { ...current, grounding: undefined };
    else if (scenario === "degraded") candidate.candidate.decisionObservation = { ...current, grounding: { ...catalog, degraded: true } };
    else if (scenario === "unknown") candidate.candidate.decisionObservation = { ...current, grounding: { ...catalog, completeness: "unknown" } };
    else if (scenario === "old-version") candidate.candidate.decisionObservation = { ...current, grounding: { ...catalog, version: "uia-catalog-v1" } };
    else if (scenario === "uia-catalog") candidate.candidate.decisionObservation = { ...current, grounding: { ...catalog, source: "uia" } };
    else if (scenario === "stale-catalog") candidate.candidate.decisionObservation = { ...current, grounding: { ...catalog, observationId: "old" as ObservationId } };
    else if (scenario === "wrong-session") candidate.candidate.decisionObservation = { ...current, computerSessionId: "other" as ComputerSessionId };
    else if (scenario === "truncated") candidate.candidate.decisionObservation = { ...current, grounding: { ...catalog, selection: { strategy: "deterministic-lexical-v1", candidateElementCount: 2, selectedElementRefs: ["wrong-ref"], truncated: true, reasons: [] } } };
    else if (scenario === "multiple") candidate.candidate.decisionObservation = { ...current, grounding: { ...catalog, elements: [element, { ...element, elementRef: "other" }] } };
    else if (["unfocused", "disabled", "readonly", "uia", "chrome", "button"].includes(scenario)) {
      if (scenario === "unfocused") changedElement.state.focused = false;
      if (scenario === "disabled") changedElement.state.enabled = false;
      if (scenario === "readonly") changedElement.state.editable = false;
      candidate.candidate.decisionObservation = { ...current, grounding: { ...catalog, elements: [{ ...changedElement, ...(scenario === "uia" ? { source: "uia" as const } : {}), ...(scenario === "chrome" ? { browserRegion: "chrome" as const } : {}), ...(scenario === "button" ? { role: "button" } : {}) }] } };
    } else if (scenario === "stale-action") candidate.candidate.actions[0] = { actionId: "old" as ActionId, basedOn: "old" as ObservationId, kind: "type", text: "hello" };
    else if (scenario === "newline") candidate.candidate.actions[0] = { actionId: "newline" as ActionId, basedOn: current.id, kind: "type", text: "hello\n" };
    else if (scenario === "control") candidate.candidate.actions[0] = { actionId: "control" as ActionId, basedOn: current.id, kind: "type", text: "hello\t" };
    else if (scenario === "click") candidate.candidate.actions[0] = { actionId: "click" as ActionId, basedOn: current.id, kind: "click", point: { x: 10, y: 20 } };
    else if (scenario === "enter") candidate.candidate.actions[0] = { actionId: "enter" as ActionId, basedOn: current.id, kind: "keypress", keys: ["ENTER"] };
    else if (scenario === "batch") candidate.candidate.actions = [...candidate.candidate.actions, { actionId: "enter" as ActionId, basedOn: current.id, kind: "keypress", keys: ["ENTER"] }];
    else if (scenario === "risky-target") candidate.candidate.calls[0]!.declaredEffect!.target = "Submit order";
    await expect(new LayeredRiskGuard().evaluate(candidate, new AbortController().signal)).resolves.toMatchObject({ decision: "require_approval", path: "fallback", reasonCode: "semantic_review_unavailable" });
  });

  it("retains mandatory declared-high and protected-input boundaries with the disclaimer", async () => {
    const high = focusedTyping();
    high.candidate.calls[0]!.declaredEffect!.effects = ["external_commitment"];
    await expect(new LayeredRiskGuard().evaluate(high, new AbortController().signal)).resolves.toMatchObject({ decision: "require_approval", path: "local", reasonCode: "declared_high_impact" });
    const protectedInput = focusedTyping();
    protectedInput.candidate.actions[0] = { actionId: "protected" as ActionId, basedOn: observation.id, kind: "type", text: "password=SYNTHETIC_ONLY" };
    await expect(new LayeredRiskGuard().evaluate(protectedInput, new AbortController().signal)).resolves.toMatchObject({ decision: "require_approval", path: "local", reasonCode: "protected_input" });
  });

  it("allows declared low-impact actions and requires approval for declared financial actions without a reviewer", async () => {
    const guard = new LayeredRiskGuard();
    await expect(guard.evaluate(context("navigate"), new AbortController().signal)).resolves.toMatchObject({ decision: "allow", path: "local", modelRequestCount: 0 });
    await expect(guard.evaluate(context("financial", "Confirm payment", "Pay for order"), new AbortController().signal)).resolves.toMatchObject({ decision: "require_approval", path: "local", modelRequestCount: 0, categories: ["financial"] });
  });

  it("uses the Run-scoped switch as the approval boundary and ignores its claimed content effects", async () => {
    const guard = new LayeredRiskGuard();
    for (const candidate of [
      switchWindowContext("navigate"),
      switchWindowContext("financial", "Submit payment; password settings", "Send private information"),
      switchWindowContext("external_commitment", "Publish this draft", "Submit the form"),
      switchWindowContext("observe"),
      switchWindowContext(),
    ]) {
      await expect(guard.evaluate(candidate, new AbortController().signal)).resolves.toMatchObject({
        decision: "allow",
        path: "local",
        reasonCode: "run_scoped_window_switch",
        categories: [],
        modelRequestCount: 0,
      });
    }
    await expect(guard.evaluate(context("financial", "Confirm payment", "Pay for order"), new AbortController().signal)).resolves.toMatchObject({
      decision: "require_approval",
      reasonCode: "declared_high_impact",
      categories: ["financial"],
    });
  });

  it("reviews a low-risk declaration whose target implies an undeclared commitment", async () => {
    const assessor = new ScriptedRiskAssessor({ effects: ["external_commitment"], alignment: "aligned", evidence: "The target submits the form." });
    const guard = new LayeredRiskGuard({ assessor });
    await expect(guard.evaluate(context("navigate", "Submit order", "Submit this order"), new AbortController().signal)).resolves.toMatchObject({ decision: "require_approval", path: "model", modelRequestCount: 1, categories: ["external_commitment"] });
  });

  it("reviews risk words quoted in typed content", async () => {
    const guard = new LayeredRiskGuard();
    await expect(guard.evaluate(context("local_edit", "Draft", "Write the phrase \"do not send\"", "type"), new AbortController().signal)).resolves.toMatchObject({ decision: "require_approval", path: "fallback", reasonCode: "semantic_review_unavailable" });
  });

  it("allows a navigation-only search submission without spending the semantic review budget", async () => {
    const search = withNavigationGrounding(context("navigate", "提交搜索 button", "Submit the site search for the typed query"), "search");
    search.goal = "Open the site and search for MacBook Air";
    await expect(new LayeredRiskGuard({ maxModelRequests: 0 }).evaluate(search, new AbortController().signal)).resolves.toMatchObject({
      decision: "allow",
      path: "local",
      reasonCode: "declared_low_impact",
      modelRequestCount: 0,
    });

    const enter = context("navigate", "搜索框 (MacBook Air)", "Press Enter in the focused search field to submit the search", "click");
    enter.goal = "Search the site for MacBook Air";
    enter.candidate.actions[0] = { actionId: "search-enter-action" as ActionId, basedOn: observation.id, kind: "keypress", keys: ["ENTER"] };
    withNavigationGrounding(enter, "search");
    await expect(new LayeredRiskGuard({ maxModelRequests: 0 }).evaluate(enter, new AbortController().signal)).resolves.toMatchObject({
      decision: "allow",
      path: "local",
      reasonCode: "declared_low_impact",
      modelRequestCount: 0,
    });
  });

  it.each(["missing", "stale", "surface", "degraded", "truncated", "message-focus", "modifier", "non-enter"])("does not trust navigation declarations without matching current evidence: %s", async (scenario) => {
    for (const kind of ["search", "address"] as const) {
      const candidate = addressBarEnterContext();
      if (kind === "search") {
        candidate.goal = "Search for a product";
        candidate.candidate.calls[0]!.declaredEffect = { effects: ["navigate"], target: "Search", summary: "Submit the search query" };
        withNavigationGrounding(candidate, "search");
      }
      const current = candidate.candidate.decisionObservation;
      const catalog = current.grounding!;
      if (scenario === "missing") { const { grounding: _grounding, ...without } = current; candidate.candidate.decisionObservation = without; }
      if (scenario === "stale") candidate.candidate.decisionObservation = { ...current, grounding: { ...catalog, observationId: "old" as ObservationId } };
      if (scenario === "surface") candidate.candidate.decisionObservation = { ...current, grounding: { ...catalog, surfaceRef: { ...surfaceRef, generation: 2 } } };
      if (scenario === "degraded") candidate.candidate.decisionObservation = { ...current, grounding: { ...catalog, degraded: true } };
      if (scenario === "truncated") candidate.candidate.decisionObservation = { ...current, grounding: { ...catalog, selection: { strategy: "bounded-fusion-v1", candidateElementCount: 2, selectedElementRefs: ["navigation-control"], truncated: true, reasons: [] } } };
      if (scenario === "message-focus") candidate.candidate.decisionObservation = { ...current, grounding: { ...catalog, elements: [{ ...catalog.elements[0]!, name: "Message", source: "dom", browserRegion: "content" }] } };
      if (scenario === "modifier" || scenario === "non-enter") candidate.candidate.actions[0] = { actionId: "shortcut" as ActionId, basedOn: observation.id, kind: "keypress", keys: scenario === "modifier" ? ["CTRL", "ENTER"] : ["CTRL", "W"] };
      await expect(new LayeredRiskGuard().evaluate(candidate, new AbortController().signal)).resolves.toMatchObject({ decision: "require_approval", reasonCode: "semantic_review_unavailable" });
    }
  });

  it.each(["search", "address"] as const)("reviews partial %s evidence even without a selection trace", async (kind) => {
    const candidate = addressBarEnterContext();
    if (kind === "search") {
      candidate.goal = "Search for a product";
      candidate.candidate.calls[0]!.declaredEffect = { effects: ["navigate"], target: "Search", summary: "Submit the search query" };
      withNavigationGrounding(candidate, "search");
    }
    const current = candidate.candidate.decisionObservation;
    const catalog = current.grounding!;
    expect(catalog.selection).toBeUndefined();
    candidate.candidate.decisionObservation = { ...current, grounding: { ...catalog, completeness: "partial" } };
    await expect(new LayeredRiskGuard().evaluate(candidate, new AbortController().signal)).resolves.toMatchObject({ decision: "require_approval", reasonCode: "semantic_review_unavailable" });
  });

  it("does not exempt a search phrase that also names an external commitment", async () => {
    const candidate = context("navigate", "Submit order search", "Submit the order search");
    candidate.goal = "Search the order system";
    await expect(new LayeredRiskGuard({
      assessor: new ScriptedRiskAssessor({ effects: ["local_edit"], alignment: "aligned", evidence: "Synthetic low-risk review" }),
      maxModelRequests: 0,
    }).evaluate(candidate, new AbortController().signal)).resolves.toMatchObject({
      decision: "require_approval",
      path: "fallback",
      reasonCode: "risk_model_budget_exhausted",
    });
  });

  it("allows Enter navigation from an explicitly identified URL address bar", async () => {
    await expect(new LayeredRiskGuard({ maxModelRequests: 0 }).evaluate(addressBarEnterContext(), new AbortController().signal)).resolves.toMatchObject({
      decision: "allow",
      path: "local",
      reasonCode: "declared_low_impact",
      modelRequestCount: 0,
    });
  });

  it("keeps ordinary form submission and high-risk URL navigation protected", async () => {
    const exhausted = { assessor: new ScriptedRiskAssessor({ effects: ["local_edit"], alignment: "aligned", evidence: "Synthetic low-risk review" }), maxModelRequests: 0 };
    await expect(new LayeredRiskGuard(exhausted).evaluate(
      addressBarEnterContext("Checkout form", "按回车提交订单表单"),
      new AbortController().signal,
    )).resolves.toMatchObject({ decision: "require_approval", reasonCode: "risk_model_budget_exhausted" });

    await expect(new LayeredRiskGuard(exhausted).evaluate(
      addressBarEnterContext("Chrome 地址栏", "回车提交地址栏 https://example.test/delete-account，导航到页面"),
      new AbortController().signal,
    )).resolves.toMatchObject({ decision: "require_approval", reasonCode: "risk_model_budget_exhausted" });
  });

  it.each([
    ["unknown", protectedContext("unknown", "Input", "Fill the field")],
    ["contradiction", protectedContext("observe", "Input", "Observe the field")],
    ["text ambiguity", protectedContext("local_edit", "Confirm payment", "Click Confirm payment")],
  ] as const)("keeps protected input mandatory when %s would otherwise enter semantic review", async (_label, candidate) => {
    let reviewerCalls = 0;
    const assessor = {
      id: "low-risk-reviewer",
      async classify() {
        reviewerCalls += 1;
        return { effects: ["local_edit"] as const, alignment: "aligned" as const, evidence: "Synthetic low-risk review" };
      },
    };
    await expect(new LayeredRiskGuard({ assessor }).evaluate(candidate, new AbortController().signal)).resolves.toMatchObject({
      decision: "require_approval",
      path: "local",
      reasonCode: "protected_input",
      modelRequestCount: 0,
    });
    expect(reviewerCalls).toBe(0);
  });

  it("keeps host deny above reviewer allow", async () => {
    let reviewerCalls = 0;
    const assessor = {
      id: "low-risk-reviewer",
      async classify() {
        reviewerCalls += 1;
        return { effects: ["local_edit"] as const, alignment: "aligned" as const, evidence: "Synthetic low-risk review" };
      },
    };
    await expect(new LayeredRiskGuard({ assessor, forbiddenShortcuts: ["CTRL+ALT+DELETE"] }).evaluate(keypressContext(), new AbortController().signal)).resolves.toMatchObject({
      decision: "deny",
      path: "local",
      reasonCode: "forbidden_shortcut",
      modelRequestCount: 0,
    });
    expect(reviewerCalls).toBe(0);
  });

  it("keeps semantic review available for non-mandatory uncertainty", async () => {
    const assessor = new ScriptedRiskAssessor({ effects: ["local_edit"], alignment: "aligned", evidence: "Synthetic low-risk review" });
    await expect(new LayeredRiskGuard({ assessor }).evaluate(context("unknown"), new AbortController().signal)).resolves.toMatchObject({ decision: "allow", path: "model", modelRequestCount: 1 });
    await expect(new LayeredRiskGuard({ assessor }).evaluate(context("navigate", "Confirm payment", "Click Confirm payment"), new AbortController().signal)).resolves.toMatchObject({ decision: "allow", path: "model", modelRequestCount: 1 });
  });

  it("fails closed when a grounded unknown-effect click loses its raw evidence", async () => {
    let reviewerCalls = 0;
    const assessor = {
      id: "low-risk-reviewer",
      async classify() {
        reviewerCalls += 1;
        return { effects: ["navigate"] as const, alignment: "aligned" as const, evidence: "Synthetic low-risk review" };
      },
    };
    await expect(new LayeredRiskGuard({ assessor }).evaluate(context("unknown", "Details", "Open details", "click", "element-ref"), new AbortController().signal)).resolves.toMatchObject({
      decision: "require_approval",
      path: "local",
      reasonCode: "unknown_grounding_evidence_unavailable",
      modelRequestCount: 0,
    });
    expect(reviewerCalls).toBe(0);
  });

  it("keeps grounded type target evidence visible to Guard preflight", async () => {
    let reviewerCalls = 0;
    const assessor = { id: "low-risk-reviewer", async classify() { reviewerCalls += 1; return { effects: ["local_edit"] as const, alignment: "aligned" as const, evidence: "Synthetic low-risk review" }; } };
    await expect(new LayeredRiskGuard({ assessor }).evaluate(context("unknown", "Document", "Replace multiline text", "type", "uia-current-ref"), new AbortController().signal)).resolves.toMatchObject({
      decision: "require_approval",
      path: "local",
      reasonCode: "unknown_grounding_evidence_unavailable",
      modelRequestCount: 0,
    });
    expect(reviewerCalls).toBe(0);
  });

  it("fails closed when semantic review errors, times out, or exhausts its budget", async () => {
    await expect(new LayeredRiskGuard({ assessor: new ScriptedRiskAssessor(new Error("synthetic reviewer failure")) }).evaluate(context("unknown"), new AbortController().signal)).resolves.toMatchObject({
      decision: "require_approval",
      path: "fallback",
      reasonCode: "risk_model_failed",
      modelRequestCount: 1,
    });

    const timeoutAssessor = {
      id: "timeout-reviewer",
      async classify(_input: ActionPolicyContext, signal: AbortSignal) {
        return await new Promise<never>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason ?? new Error("synthetic review timeout")), { once: true });
        });
      },
    };
    await expect(new LayeredRiskGuard({ assessor: timeoutAssessor, timeoutMs: 5 }).evaluate(context("unknown"), new AbortController().signal)).resolves.toMatchObject({
      decision: "require_approval",
      path: "fallback",
      reasonCode: "risk_model_failed",
      modelRequestCount: 1,
    });

    await expect(new LayeredRiskGuard({ assessor: new ScriptedRiskAssessor({ effects: ["local_edit"], alignment: "aligned", evidence: "low" }), maxModelRequests: 0 }).evaluate(context("unknown"), new AbortController().signal)).resolves.toMatchObject({
      decision: "require_approval",
      path: "fallback",
      reasonCode: "risk_model_budget_exhausted",
      modelRequestCount: 0,
    });
  });

  it("does not let view/draft words suppress a mixed payment signal", async () => {
    await expect(new LayeredRiskGuard().evaluate(context("navigate", "Confirm payment", "View the bill then click Confirm payment"), new AbortController().signal)).resolves.toMatchObject({
      decision: "require_approval",
      path: "fallback",
      reasonCode: "semantic_review_unavailable",
    });
    await expect(new LayeredRiskGuard().evaluate(context("navigate", "Payment history", "View payment history"), new AbortController().signal)).resolves.toMatchObject({
      decision: "allow",
      path: "local",
      reasonCode: "declared_low_impact",
      modelRequestCount: 0,
    });
    await expect(new LayeredRiskGuard().evaluate(context("local_edit", "Payment history", "View payment history"), new AbortController().signal)).resolves.toMatchObject({
      decision: "require_approval",
      path: "fallback",
      reasonCode: "semantic_review_unavailable",
    });
    await expect(new LayeredRiskGuard().evaluate(context("local_edit", "Draft", "Draft an email to send"), new AbortController().signal)).resolves.toMatchObject({
      decision: "require_approval",
      path: "fallback",
      reasonCode: "semantic_review_unavailable",
    });
  });

  it("does not treat financial-looking URL tokens as a financial Computer action", async () => {
    await expect(new LayeredRiskGuard().evaluate(
      context("navigate", "https://example.test/products?next=checkout", "Open the page", "click"),
      new AbortController().signal,
    )).resolves.toMatchObject({ decision: "allow", path: "local", reasonCode: "declared_low_impact" });
  });

  it("keeps high-impact URL paths visible to the risk scan", async () => {
    await expect(new LayeredRiskGuard().evaluate(
      context("navigate", "https://example.test/delete-account", "Open the page", "click"),
      new AbortController().signal,
    )).resolves.toMatchObject({ decision: "require_approval", reasonCode: "semantic_review_unavailable" });
  });

  it("keeps high-impact URL query actions visible", async () => {
    await expect(new LayeredRiskGuard().evaluate(
      context("navigate", "https://example.test/settings?action=delete-account&next=/home", "Open the page", "click"),
      new AbortController().signal,
    )).resolves.toMatchObject({ decision: "require_approval", reasonCode: "semantic_review_unavailable" });
  });

  it("allows only passive waits on an explicitly described product page", async () => {
    const passive = context("navigate", "MacBook Air 购买页", "等待页面加载", "click");
    passive.candidate.actions[0] = { actionId: "wait-action" as ActionId, kind: "wait", durationMs: 100 };
    await expect(new LayeredRiskGuard().evaluate(passive, new AbortController().signal)).resolves.toMatchObject({ decision: "allow", reasonCode: "declared_low_impact" });

    const commitment = context("navigate", "MacBook Air 购买页", "点击购买并付款", "click");
    commitment.candidate.actions[0] = { actionId: "wait-action-2" as ActionId, kind: "wait", durationMs: 100 };
    await expect(new LayeredRiskGuard().evaluate(commitment, new AbortController().signal)).resolves.toMatchObject({ decision: "require_approval", reasonCode: "semantic_review_unavailable" });
  });

  it.each([
    ["view payment history followed by purchase", context("navigate", "Payment history", "View payment history, then purchase item")],
    ["do not send draft followed by submit", context("local_edit", "Draft", "Do not send the draft; submit the order")],
    ["查看支付历史后购买商品", context("navigate", "支付历史", "查看支付历史后购买商品")],
    ["不要发送草稿随后提交订单", context("local_edit", "草稿", "不要发送草稿，随后提交订单")],
  ] as const)("does not exempt a later high-impact action after %s", async (_label, candidate) => {
    await expect(new LayeredRiskGuard().evaluate(candidate, new AbortController().signal)).resolves.toMatchObject({
      decision: "require_approval",
      path: "fallback",
      reasonCode: "semantic_review_unavailable",
    });
  });

  it.each([
    ["do not send draft but submit order", context("local_edit", "Draft", "Do not send the draft but submit the order")],
    ["do not pay old invoice but transfer funds", context("navigate", "Old invoice", "Do not pay the old invoice but transfer the funds")],
    ["不要发送草稿但提交订单", context("local_edit", "草稿", "不要发送草稿但提交订单")],
  ] as const)("does not let an unpunctuated conjunction extend a negation exemption: %s", async (_label, candidate) => {
    await expect(new LayeredRiskGuard().evaluate(candidate, new AbortController().signal)).resolves.toMatchObject({
      decision: "require_approval",
      path: "fallback",
      reasonCode: "semantic_review_unavailable",
    });
  });

  it("reviews ordinary unquoted negated risk wording", async () => {
    await expect(new LayeredRiskGuard().evaluate(context("local_edit", "Draft", "Write the phrase do not send", "type"), new AbortController().signal)).resolves.toMatchObject({
      decision: "require_approval",
      path: "fallback",
      reasonCode: "semantic_review_unavailable",
    });
  });

  it.each([
    ["quoted submit", context("navigate", "Button", "Click \"submit\"")],
    ["apostrophe before submit", context("navigate", "Order", "Don't wait, submit user's order")],
  ] as const)("does not treat quoted punctuation as a risk exemption: %s", async (_label, candidate) => {
    await expect(new LayeredRiskGuard().evaluate(candidate, new AbortController().signal)).resolves.toMatchObject({
      decision: "require_approval",
      path: "fallback",
      reasonCode: "semantic_review_unavailable",
    });
  });

  it("fails closed for missing declarations and unavailable ambiguous review", async () => {
    const missing = context("navigate");
    missing.candidate.calls[0]!.declaredEffect = undefined;
    const guard = new LayeredRiskGuard();
    await expect(guard.evaluate(missing, new AbortController().signal)).resolves.toMatchObject({ decision: "deny", reasonCode: "missing_effect_declaration" });
    await expect(guard.evaluate(context("unknown"), new AbortController().signal)).resolves.toMatchObject({ decision: "require_approval", path: "fallback", modelRequestCount: 0 });
  });

  it("redacts likely secrets from provider review evidence", async () => {
    const provider: ProviderAdapter = { id: "fake-reviewer", async generate() { return { type: "tool_calls", calls: [{ id: "risk-1" as ToolCallId, name: "risk_classification", arguments: { effects: ["unknown"], alignment: "unclear", evidence: "password=top-secret-value card 1234567890123456" } }] }; } };
    await expect(new ProviderRiskAssessor(provider).classify(context("unknown"), new AbortController().signal)).resolves.toMatchObject({ evidence: "password=[redacted] card [redacted-number]" });
  });
});
