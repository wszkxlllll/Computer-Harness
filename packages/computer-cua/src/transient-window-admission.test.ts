import { describe, expect, it } from "vitest";
import type { CuaWindowInfo, CuaWindowInventory } from "./window-contract.js";
import { assessOwnedTransientWindowAdmission } from "./transient-window-admission.js";

const parent = { pid: 41, windowId: 101 } as const;
const baseWindow: CuaWindowInfo = {
  target: parent,
  bounds: { x: 0, y: 0, width: 800, height: 600 },
  appName: "Fixture",
  zIndex: 1,
  isOnScreen: true,
};
const ownedChild: CuaWindowInfo = {
  target: { pid: parent.pid, windowId: 202 },
  bounds: { x: 120, y: 100, width: 300, height: 200 },
  appName: "Fixture",
  ownerPid: parent.pid,
  ownerWindowId: parent.windowId,
  zIndex: 2,
  isOnScreen: true,
};

function inventory(...windows: CuaWindowInfo[]): CuaWindowInventory {
  return { windows, complete: true };
}

function assess(
  candidate: CuaWindowInfo = ownedChild,
  current: CuaWindowInventory = inventory(baseWindow, candidate),
  overrides: Partial<Parameters<typeof assessOwnedTransientWindowAdmission>[0]> = {},
) {
  return assessOwnedTransientWindowAdmission({
    parent,
    candidate,
    inventory: current,
    surfacedWindowCount: 1,
    baselineComplete: true,
    parentSurfaceCurrent: true,
    ...overrides,
  });
}

describe("owned transient HWND stage-one admission", () => {
  it("admits only one same-process, exactly-owned, uniquely highest owned candidate", () => {
    expect(assess()).toEqual({ decision: "admitted" });
  });

  it("does not treat a same-PID window with missing owner evidence as authorized", () => {
    const candidate: CuaWindowInfo = {
      target: ownedChild.target,
      bounds: ownedChild.bounds,
      appName: "Fixture",
      ownerPid: parent.pid,
      zIndex: 2,
      isOnScreen: true,
    };
    expect(assess(candidate, inventory(baseWindow, candidate))).toMatchObject({
      decision: "manual",
      code: "TRANSIENT_SURFACE_UNKNOWN",
    });
  });

  it("rejects a forged owner HWND even when the PID matches", () => {
    const candidate = { ...ownedChild, ownerWindowId: 999 };
    expect(assess(candidate, inventory(baseWindow, candidate))).toMatchObject({
      decision: "rejected",
      code: "WINDOW_SCOPE_REQUIRED",
    });
  });

  it("rejects a child in another PID rather than expanding the host scope", () => {
    const candidate: CuaWindowInfo = {
      ...ownedChild,
      target: { pid: 42, windowId: 202 },
      ownerPid: parent.pid,
    };
    expect(assess(candidate, inventory(baseWindow, candidate))).toMatchObject({
      decision: "rejected",
      code: "WINDOW_SCOPE_REQUIRED",
    });
  });

  it("admits a cross-process child only from a complete Win32 exact-owner snapshot", () => {
    const candidate: CuaWindowInfo = {
      ...ownedChild,
      target: { pid: 42, windowId: 202 },
      ownerPid: parent.pid,
      ownerWindowId: parent.windowId,
    };
    const completeWin32: CuaWindowInventory = {
      ...inventory(baseWindow, candidate),
      source: "win32_relationship_probe",
      foregroundPid: parent.pid,
      foregroundWindowId: parent.windowId,
    };
    expect(assess(candidate, completeWin32)).toEqual({ decision: "admitted" });
    expect(assess(candidate, { ...completeWin32, complete: false })).toMatchObject({
      decision: "rejected",
      code: "WINDOW_SCOPE_REQUIRED",
    });
    expect(assess(candidate, { ...completeWin32, source: "cua_inventory" })).toMatchObject({
      decision: "rejected",
      code: "WINDOW_SCOPE_REQUIRED",
    });
  });

  it("rejects a cross-process candidate without the parent's exact Win32 owner pair", () => {
    const candidate: CuaWindowInfo = {
      ...ownedChild,
      target: { pid: 42, windowId: 202 },
      ownerPid: 0,
      ownerWindowId: 0,
    };
    const completeWin32: CuaWindowInventory = {
      ...inventory(baseWindow, candidate),
      source: "win32_relationship_probe",
      foregroundPid: parent.pid,
      foregroundWindowId: parent.windowId,
    };
    expect(assess(candidate, completeWin32)).toMatchObject({ decision: "rejected", code: "WINDOW_SCOPE_REQUIRED" });
  });

  it("requires a complete inventory and complete pre-action baseline", () => {
    const partial = { ...inventory(baseWindow, ownedChild), complete: false };
    expect(assess(ownedChild, partial)).toMatchObject({ decision: "manual", code: "WINDOW_INVENTORY_UNKNOWN" });
    expect(assess(ownedChild, inventory(baseWindow, ownedChild), { baselineComplete: false }))
      .toMatchObject({ decision: "manual", code: "WINDOW_INVENTORY_UNKNOWN" });
  });

  it("permits a partial dialog inventory only with exact foreground, owner, PID/HWND, and visibility evidence", () => {
    const { zIndex: _zIndex, ...candidateWithoutZOrder } = ownedChild;
    const candidate = { ...candidateWithoutZOrder, minimized: false };
    const partial: CuaWindowInventory = {
      ...inventory(baseWindow, candidate),
      complete: false,
      source: "win32_relationship_probe",
      foregroundPid: candidate.target.pid,
      foregroundWindowId: candidate.target.windowId,
    };
    expect(assess(candidate, partial, { baselineComplete: false })).toEqual({ decision: "admitted" });
    const withoutForeground: CuaWindowInventory = {
      windows: partial.windows,
      complete: false,
      source: "win32_relationship_probe",
    };
    expect(assess(candidate, withoutForeground, { baselineComplete: false }))
      .toMatchObject({ decision: "manual", code: "WINDOW_INVENTORY_UNKNOWN" });
    expect(assess({ ...candidate, ownerWindowId: 999 }, partial, { baselineComplete: false }))
      .toMatchObject({ decision: "rejected", code: "WINDOW_SCOPE_REQUIRED" });
    expect(assess({ ...candidate, isOnScreen: false }, partial, { baselineComplete: false }))
      .toMatchObject({ decision: "rejected", code: "WINDOW_SCOPE_REQUIRED" });
    expect(assess(candidate, { ...partial, truncated: true }, { baselineComplete: false }))
      .toMatchObject({ decision: "manual", code: "WINDOW_INVENTORY_UNKNOWN" });
    expect(assess(candidate, partial, { baselineComplete: false, baselineTruncated: true }))
      .toMatchObject({ decision: "manual", code: "WINDOW_INVENTORY_UNKNOWN" });
  });

  it("never admits a minimized owned window as a visible child", () => {
    const candidate = { ...ownedChild, minimized: true };
    expect(assess(candidate, inventory(baseWindow, candidate))).toMatchObject({
      decision: "rejected",
      code: "WINDOW_SCOPE_REQUIRED",
    });
  });

  it("requires current parent Surface authorization from the same generation", () => {
    expect(assess(ownedChild, inventory(baseWindow, ownedChild), { parentSurfaceCurrent: false }))
      .toMatchObject({ decision: "manual", code: "TRANSIENT_SURFACE_UNKNOWN" });
  });

  it("refuses ambiguous frontmost z-order and non-frontmost candidates", () => {
    const tied = { ...ownedChild, zIndex: 1 };
    expect(assess(ownedChild, inventory(baseWindow, ownedChild, { ...ownedChild, target: { pid: 41, windowId: 303 }, zIndex: 2 })))
      .toMatchObject({ decision: "manual", code: "TRANSIENT_SURFACE_UNKNOWN" });
    expect(assess(tied, inventory(baseWindow, tied))).toMatchObject({ decision: "manual", code: "TRANSIENT_SURFACE_UNKNOWN" });
  });

  it("fails closed when the exact parent or its owned stack lacks required evidence", () => {
    const noZOrder: CuaWindowInfo = { target: baseWindow.target, bounds: baseWindow.bounds, isOnScreen: true };
    expect(assess(ownedChild, inventory(noZOrder, ownedChild))).toMatchObject({ decision: "manual", code: "TRANSIENT_SURFACE_UNKNOWN" });
    const unknownVisibility: CuaWindowInfo = {
      target: { pid: parent.pid, windowId: 303 }, bounds: baseWindow.bounds, zIndex: 1,
      ownerPid: parent.pid, ownerWindowId: parent.windowId,
    };
    expect(assess(ownedChild, inventory(baseWindow, unknownVisibility, ownedChild))).toMatchObject({ decision: "manual", code: "TRANSIENT_SURFACE_UNKNOWN" });
  });

  it("ignores higher Shell helpers outside the exact owner's transient stack", () => {
    const parentRow = { ...baseWindow, zIndex: 690 };
    const menu = { ...ownedChild, zIndex: 691, windowClass: "Microsoft.UI.Content.PopupWindowSiteBridge" };
    const shell = [744, 743, 736].map((zIndex, index): CuaWindowInfo => ({
      target: { pid: 99, windowId: 900 + index }, bounds: baseWindow.bounds,
      ownerPid: 0, ownerWindowId: 0, isOnScreen: true, minimized: false, zIndex,
      windowClass: index === 2 ? "Shell_TrayWnd" : "ThumbnailDeviceHelperWnd",
    }));
    expect(assess(menu, inventory(parentRow, menu, ...shell))).toEqual({ decision: "admitted" });
    const unrelatedWithoutMetadata: CuaWindowInfo = { target: { pid: 98, windowId: 999 }, bounds: baseWindow.bounds, ownerPid: 0, ownerWindowId: 0 };
    expect(assess(menu, inventory(parentRow, menu, unrelatedWithoutMetadata))).toEqual({ decision: "admitted" });
  });

  it.each([3, 2, undefined])("rejects a higher, tied, or unknown-z owned sibling (%s)", (zIndex) => {
    const { zIndex: _knownSiblingZ, ...ownedWithoutZ } = ownedChild;
    const sibling: CuaWindowInfo = {
      ...ownedWithoutZ, target: { pid: parent.pid, windowId: 303 }, windowClass: "UnknownOwnedPopup",
      ...(zIndex === undefined ? {} : { zIndex }),
    };
    const current = { ...inventory(baseWindow, ownedChild, sibling), foregroundPid: ownedChild.target.pid, foregroundWindowId: ownedChild.target.windowId };
    expect(assess(ownedChild, current)).toMatchObject({ decision: "manual", code: "TRANSIENT_SURFACE_UNKNOWN" });
  });

  it("requires exactly one parent row and both parent/candidate z-order values", () => {
    expect(assess(ownedChild, inventory(ownedChild))).toMatchObject({ decision: "manual" });
    expect(assess(ownedChild, inventory(baseWindow, baseWindow, ownedChild))).toMatchObject({ decision: "manual" });
    const { zIndex: _parentZ, ...unknownParentZ } = baseWindow;
    expect(assess(ownedChild, inventory(unknownParentZ, ownedChild))).toMatchObject({ decision: "manual" });
    const { zIndex: _childZ, ...unknownChildZ } = ownedChild;
    expect(assess(unknownChildZ, inventory(baseWindow, unknownChildZ))).toMatchObject({ decision: "manual" });
  });

  it.each([0, 1])("rejects a candidate below or equal to its parent (%s)", (zIndex) => {
    const candidate = { ...ownedChild, zIndex, windowClass: "#32768" };
    expect(assess(candidate, inventory(baseWindow, candidate))).toMatchObject({ decision: "manual" });
  });

  it("excludes hidden/minimized owned siblings from the interacting stack", () => {
    const hidden = { ...ownedChild, target: { pid: parent.pid, windowId: 303 }, isOnScreen: false, zIndex: 4 };
    const minimized = { ...ownedChild, target: { pid: parent.pid, windowId: 404 }, minimized: true, zIndex: 5 };
    expect(assess(ownedChild, inventory(baseWindow, ownedChild, hidden, minimized))).toEqual({ decision: "admitted" });
  });

  it("does not admit several surfaced windows through the transient exception", () => {
    expect(assess(ownedChild, inventory(baseWindow, ownedChild), { surfacedWindowCount: 2 }))
      .toMatchObject({ decision: "rejected", code: "WINDOW_SCOPE_REQUIRED" });
  });
});
