import { describe, expect, it } from "vitest";
import type { CuaWindowInfo, CuaWindowInventory } from "@computer-harness/computer-cua";
import { projectWindowTargetInventory } from "./window-target-discovery.js";
import { filterInitialTargetWindowCandidates } from "./window-target-matcher.js";

function row(
  pid: number,
  windowId: number,
  ownerPid: number,
  ownerWindowId: number,
  title: string,
): CuaWindowInfo {
  return {
    target: { pid, windowId },
    bounds: { x: 0, y: 0, width: 800, height: 600 },
    ownerPid,
    ownerWindowId,
    appName: "Notepad.exe",
    title,
  };
}

function inventory(windows: readonly CuaWindowInfo[], overrides: Partial<CuaWindowInventory> = {}): CuaWindowInventory {
  return {
    windows,
    complete: true,
    completeAttestation: "explicit",
    source: "win32_relationship_probe",
    ...overrides,
  };
}

describe("projectWindowTargetInventory", () => {
  it("attaches a direct owned-child relation only for an exact parent HWND in the same complete snapshot", () => {
    const parent = row(27384, 0x98e1b34, 0, 0, "*CH-NOTEPAD - Notepad");
    const child = row(27384, 0x991316, 27384, 0x98e1b34, "Host popup");
    const projected = projectWindowTargetInventory(inventory([parent, child]));
    expect(projected).toMatchObject([
      { pid: parent.target.pid, windowId: parent.target.windowId, title: parent.title },
      { pid: child.target.pid, windowId: child.target.windowId, relationship: { kind: "owned_child", owner: { pid: parent.target.pid, windowId: parent.target.windowId } } },
    ]);
  });

  it("accepts CUA-owned relations only from explicit complete inventory rows with the relationship fields present", () => {
    const parent = { ...row(27384, 0x98e1b34, 0, 0, "Notepad"), zIndex: 1, isOnScreen: true, minimized: false, windowClass: "Notepad" };
    const child = { ...row(27384, 0x991316, 27384, 0x98e1b34, "Dialog"), zIndex: 2, isOnScreen: true, minimized: false, windowClass: "Dialog" };
    const explicit = inventory([parent, child], {
      source: "cua_inventory",
      completeAttestation: "explicit",
      foregroundPid: parent.target.pid,
      foregroundWindowId: parent.target.windowId,
    });
    const relation = projectWindowTargetInventory(explicit).find((target) => target.windowId === child.target.windowId)?.relationship;
    expect(relation).toEqual({ kind: "owned_child", owner: { pid: parent.target.pid, windowId: parent.target.windowId } });

    expect(projectWindowTargetInventory({ ...explicit, completeAttestation: "missing" })[1])
      .not.toHaveProperty("relationship");
    expect(projectWindowTargetInventory({ ...explicit, windows: [parent, { ...child, ownerWindowId: undefined }] })[1])
      .not.toHaveProperty("relationship");
  });

  it.each([
    ["partial snapshot", { complete: false }],
    ["truncated snapshot", { truncated: true }],
    ["negative completeness", { completeAttestation: "negative" as const }],
    ["untrusted source", { source: "untrusted" as unknown as CuaWindowInventory["source"] }],
  ])("does not attach an owner relation from a %s", (_label, overrides) => {
    const parent = row(10, 100, 0, 0, "Main window");
    const child = row(10, 101, 10, 100, "Owned dialog");
    expect(projectWindowTargetInventory(inventory([parent, child], overrides)).find((target) => target.windowId === child.target.windowId))
      .not.toHaveProperty("relationship");
  });

  it("does not infer a relation from PID alone, absent parent rows, duplicate identities, or a non-root parent", () => {
    const root = row(20, 200, 0, 0, "Root");
    const childWrongHwnd = row(20, 201, 20, 299, "Wrong HWND");
    const missingParent = row(21, 210, 30, 300, "Missing owner");
    const duplicate = row(20, 200, 0, 0, "Root duplicate");
    const intermediate = row(20, 220, 20, 200, "Intermediate");
    const nested = row(20, 221, 20, 220, "Nested child");
    const projected = projectWindowTargetInventory(inventory([root, childWrongHwnd, missingParent, duplicate, intermediate, nested]));
    expect(projected.every((target) => target.relationship === undefined)).toBe(true);
  });

  it("keeps only visible or minimized rows from a trusted complete inventory for initial matching", () => {
    const hiddenHelpers = Array.from({ length: 318 }, (_, index) => ({
      ...row(30_000 + index, 40_000 + index, 0, 0, `Background helper ${index}`),
      isOnScreen: false,
      minimized: false,
    }));
    const notepad = {
      ...row(60_000, 70_000, 0, 0, "Untitled - Notepad"),
      isOnScreen: true,
      minimized: false,
    };
    const visibleBackground = {
      ...row(60_001, 70_001, 0, 0, "Background document"),
      appName: "WPS Office",
      isOnScreen: true,
      minimized: false,
    };
    const minimizedWps = {
      ...row(60_002, 70_002, 0, 0, "Quarterly report"),
      appName: "WPS Office",
      isOnScreen: false,
      minimized: true,
    };

    const projected = projectWindowTargetInventory(inventory([
      ...hiddenHelpers,
      notepad,
      visibleBackground,
      minimizedWps,
    ]));

    expect(projected).toMatchObject([
      { pid: notepad.target.pid, windowId: notepad.target.windowId },
      { pid: visibleBackground.target.pid, windowId: visibleBackground.target.windowId },
      { pid: minimizedWps.target.pid, windowId: minimizedWps.target.windowId },
    ]);
    expect(filterInitialTargetWindowCandidates(projected)).toHaveLength(3);
  });

  it("keeps full-snapshot owner proof when a hidden owner is omitted from the target projection", () => {
    const hiddenRoot = {
      ...row(61_000, 71_000, 0, 0, "Hidden root"),
      isOnScreen: false,
      minimized: false,
    };
    const visibleOwnedChild = {
      ...row(61_000, 71_001, 61_000, 71_000, "Owned child"),
      isOnScreen: true,
      minimized: false,
    };

    const projected = projectWindowTargetInventory(inventory([hiddenRoot, visibleOwnedChild]));
    expect(projected).toEqual([{
      pid: visibleOwnedChild.target.pid,
      windowId: visibleOwnedChild.target.windowId,
      appName: visibleOwnedChild.appName,
      title: visibleOwnedChild.title,
      relationship: { kind: "owned_child", owner: { pid: hiddenRoot.target.pid, windowId: hiddenRoot.target.windowId } },
    }]);
    expect(filterInitialTargetWindowCandidates(projected)).toEqual(projected);
  });

  it.each([
    ["partial inventory", { complete: false }],
    ["truncated inventory", { truncated: true }],
    ["untrusted source", { source: undefined }],
  ])("does not hide unknown visibility from a %s", (_label, overrides) => {
    const unknownVisibility = row(62_000, 72_000, 0, 0, "Unknown visibility");
    expect(projectWindowTargetInventory(inventory([unknownVisibility], overrides))).toMatchObject([
      { pid: unknownVisibility.target.pid, windowId: unknownVisibility.target.windowId },
    ]);
  });

  it("does not hide a row with missing visibility fields even when other inventory fields are complete", () => {
    const unknownVisibility = row(63_000, 73_000, 0, 0, "Unknown visibility");
    expect(projectWindowTargetInventory(inventory([unknownVisibility]))).toMatchObject([
      { pid: unknownVisibility.target.pid, windowId: unknownVisibility.target.windowId },
    ]);
  });
});
