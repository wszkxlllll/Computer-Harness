import { describe, expect, it } from "vitest";
import { projectExactWindowRoot } from "./window-root-projection.js";

const target = { pid: 27_384, windowId: 10_031_894 };

function countedState(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const elements = [
    { depth: 3, role: "Menu" },
    ...Array.from({ length: 26 }, (_, index) => ({ depth: index % 2 === 0 ? 4 : 5, role: "MenuItem" })),
  ];
  return {
    pid: target.pid,
    window_id: target.windowId,
    element_count: elements.length,
    returned_element_count: elements.length,
    total_element_count: elements.length,
    elements_complete: false,
    elements,
    ...overrides,
  };
}

describe("exact HWND root projection", () => {
  it("preserves the established complete depth-zero root contract", () => {
    expect(projectExactWindowRoot({
      complete: true,
      elements_complete: true,
      elements: [{ depth: 0, role: "Popup" }],
    }, target)).toEqual({ role: "popup", complete: true });
  });

  it("projects a unique minimum-depth Menu from exact, fully counted state even when elements_complete is false", () => {
    const state = countedState();
    delete state.complete;
    delete state.root_surface;

    expect(state.elements).toHaveLength(27);
    expect(projectExactWindowRoot(state, target)).toEqual({ role: "menu", complete: true });
  });

  it.each([
    ["element_count", 26],
    ["returned_element_count", 26],
    ["total_element_count", 26],
    ["total_element_count", Number.MAX_SAFE_INTEGER + 1],
  ])("rejects an unsafe or unequal %s", (key, value) => {
    expect(projectExactWindowRoot(countedState({ [key]: value }), target)).toBeUndefined();
  });

  it("rejects multiple minimum-depth elements rather than selecting one by order", () => {
    const state = countedState();
    state.elements = [
      { depth: 3, role: "Menu" },
      { depth: 3, role: "Dialog" },
      ...Array.from({ length: 25 }, (_, index) => ({ depth: index + 4, role: "MenuItem" })),
    ];
    state.element_count = 27;
    state.returned_element_count = 27;
    state.total_element_count = 27;

    expect(projectExactWindowRoot(state, target)).toBeUndefined();
  });

  it.each([
    ["missing pid", { window_id: target.windowId }],
    ["missing HWND", { pid: target.pid }],
    ["wrong pid", { pid: target.pid + 1, window_id: target.windowId }],
    ["wrong HWND", { pid: target.pid, window_id: target.windowId + 1 }],
  ])("rejects %s in the exact top-level identity", (_label, identity) => {
    const state = countedState();
    delete state.pid;
    delete state.window_id;
    Object.assign(state, identity);

    expect(projectExactWindowRoot(state, target)).toBeUndefined();
  });

  it.each([
    ["degraded", { degraded: true }],
    ["truncated", { truncated: true }],
  ])("rejects %s state", (_label, flags) => {
    expect(projectExactWindowRoot(countedState(flags), target)).toBeUndefined();
  });

  it.each(["Window", "MenuItem"]) ("rejects non-transient minimum role %s even if a deeper Menu exists", (role) => {
    expect(projectExactWindowRoot(countedState({
      elements: [
        { depth: 3, role },
        ...Array.from({ length: 26 }, (_, index) => ({ depth: index + 4, role: "Menu" })),
      ],
    }), target)).toBeUndefined();
  });

  it.each([
    ["identity", { pid: target.pid, window_id: target.windowId + 1, complete: true, role: "Menu" }],
    ["role", { pid: target.pid, window_id: target.windowId, complete: true, role: "Dialog" }],
    ["incomplete assertion", { pid: target.pid, window_id: target.windowId, complete: false, role: "Menu" }],
  ])("rejects a conflicting root_surface %s", (_label, root) => {
    expect(projectExactWindowRoot(countedState({ root_surface: root }), target)).toBeUndefined();
  });

  it("rejects conflicting identity aliases on state and count aliases", () => {
    expect(projectExactWindowRoot(countedState({ windowId: target.windowId + 1 }), target)).toBeUndefined();
    expect(projectExactWindowRoot(countedState({ elementCount: 26 }), target)).toBeUndefined();
  });

  it("does not replace explicit incomplete state with counted fallback proof", () => {
    expect(projectExactWindowRoot(countedState({ complete: false }), target)).toBeUndefined();
    expect(projectExactWindowRoot(countedState({ complete: "true" }), target)).toBeUndefined();
  });

  it("rejects malformed or conflicting root assertions on the established depth-zero path", () => {
    const state = { complete: true, elements_complete: true, elements: [{ depth: 0, role: "Menu" }] };
    const root = { pid: target.pid, window_id: target.windowId, complete: true, role: "Menu" };
    expect(projectExactWindowRoot({ ...state, root_surface: "invalid" }, target)).toBeUndefined();
    expect(projectExactWindowRoot({ ...state, root_surface: { ...root, role: "Dialog" } }, target)).toBeUndefined();
    expect(projectExactWindowRoot({ ...state, root_surface: root, rootSurface: { ...root, window_id: target.windowId + 1 } }, target)).toBeUndefined();
  });
});
