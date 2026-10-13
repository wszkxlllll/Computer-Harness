import { describe, expect, it } from "vitest";
import {
  canVerifyExactTransientRoot,
  hasExactOwnedAuxiliaryStackEvidence,
  trustedWindowClassRootRole,
  win32OwnedChildEvidence,
  win32RelationshipChildEvidence,
  windowCandidateRelationship,
} from "./windows-transient-evidence.js";
import type { CuaWindowInfo, CuaWindowInventory, CuaWindowTarget } from "./window-contract.js";

const parent: CuaWindowTarget = { pid: 100, windowId: 10 };
const child: CuaWindowInfo = {
  target: { pid: 100, windowId: 11 },
  bounds: { x: 100, y: 100, width: 400, height: 300 },
  isOnScreen: true,
  minimized: false,
  ownerPid: parent.pid,
  ownerWindowId: parent.windowId,
  zIndex: 2,
  windowClass: "#32768",
};
const parentInfo: CuaWindowInfo = {
  target: parent,
  bounds: { x: 50, y: 50, width: 900, height: 700 },
  isOnScreen: true,
  minimized: false,
  zIndex: 1,
};

function inventory(overrides: Partial<CuaWindowInventory> = {}): CuaWindowInventory {
  return {
    windows: [parentInfo, child],
    complete: true,
    truncated: false,
    source: "win32_relationship_probe",
    foregroundPid: child.target.pid,
    foregroundWindowId: child.target.windowId,
    ...overrides,
  };
}

describe("Windows transient owner evidence", () => {
  it("requires a complete, untruncated Win32 relationship snapshot before exact-root UIA reads", () => {
    expect(canVerifyExactTransientRoot(inventory())).toBe(true);
    expect(canVerifyExactTransientRoot(inventory({ complete: false }))).toBe(false);
    expect(canVerifyExactTransientRoot(inventory({ truncated: true }))).toBe(false);
    expect(canVerifyExactTransientRoot(inventory({ source: "cua_inventory" }))).toBe(false);
  });

  it("accepts the exact visible owned child only when that HWND is foreground", () => {
    expect(win32RelationshipChildEvidence(parent, child, inventory())).toMatchObject({
      kind: "native_window",
      nativeWindow: { pid: child.target.pid, hwnd: child.target.windowId },
      owner: { pid: parent.pid, hwnd: parent.windowId },
      relationshipProof: "exact_foreground",
    });
    expect(win32RelationshipChildEvidence(parent, child, inventory({ foregroundPid: parent.pid, foregroundWindowId: parent.windowId })))
      .toBeUndefined();
    expect(win32RelationshipChildEvidence(parent, { ...child, ownerWindowId: 99 }, inventory())).toBeUndefined();
  });

  it("requires the exact parent to own foreground and the candidate to be above it", () => {
    expect(hasExactOwnedAuxiliaryStackEvidence(parent, child, inventory({ foregroundPid: parent.pid, foregroundWindowId: parent.windowId })))
      .toBe(true);
    expect(hasExactOwnedAuxiliaryStackEvidence(parent, child, inventory({ foregroundPid: child.target.pid, foregroundWindowId: child.target.windowId })))
      .toBe(false);
    expect(hasExactOwnedAuxiliaryStackEvidence(parent, { ...child, zIndex: 1 }, inventory({ foregroundPid: parent.pid, foregroundWindowId: parent.windowId })))
      .toBe(false);
    expect(hasExactOwnedAuxiliaryStackEvidence(parent, child, inventory({ complete: false, foregroundPid: parent.pid, foregroundWindowId: parent.windowId })))
      .toBe(false);
  });

  it("uses admission plus exact foreground evidence for a native owned child", () => {
    expect(win32OwnedChildEvidence(parent, child, inventory(), true)).toMatchObject({
      kind: "native_window",
      nativeWindow: { pid: child.target.pid, hwnd: child.target.windowId },
      relationshipProof: "exact_foreground",
    });
    expect(win32OwnedChildEvidence(parent, child, inventory({ foregroundPid: parent.pid, foregroundWindowId: parent.windowId }), true))
      .toBeUndefined();
    expect(win32OwnedChildEvidence(parent, child, inventory(), false)).toBeUndefined();
  });

  it("classifies exact owner relationships without trusting incomplete cross-process rows", () => {
    expect(trustedWindowClassRootRole("#32768")).toBe("menu");
    expect(trustedWindowClassRootRole("#32770")).toBe("dialog");
    expect(trustedWindowClassRootRole("CustomClass")).toBeUndefined();
    expect(windowCandidateRelationship(child, parent, inventory(), false)).toMatchObject({
      kind: "owned_child", owner: parent, rootRole: "menu",
    });
    expect(windowCandidateRelationship(child, parent, inventory({ source: "cua_inventory" }), true)).toMatchObject({ kind: "owned_child" });

    const crossProcess = { ...child, target: { pid: 200, windowId: 21 } };
    expect(windowCandidateRelationship(crossProcess, parent, inventory(), false)).toMatchObject({ kind: "owned_child" });
    expect(windowCandidateRelationship(crossProcess, parent, inventory({ source: "cua_inventory" }), false)).toBeUndefined();
    expect(windowCandidateRelationship({ ...child, ownerWindowId: 99 }, parent, inventory(), true)).toMatchObject({ kind: "scoped_peer" });
  });
});
