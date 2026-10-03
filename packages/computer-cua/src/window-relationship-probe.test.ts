import { describe, expect, it } from "vitest";
import type { CuaWindowInfo, CuaWindowInventory } from "./window-contract.js";
import { mergeWindowRelationshipInventory, type WindowRelationshipProbeSnapshot } from "./window-relationship-probe.js";

const parent: CuaWindowInfo = {
  target: { pid: 41, windowId: 101 },
  title: "local-only parent label",
  appName: "Fixture",
  bounds: { x: 0, y: 0, width: 800, height: 600 },
  zIndex: 2,
  isOnScreen: true,
};

const child = {
  pid: 41,
  windowId: 202,
  ownerPid: 41,
  ownerWindowId: 101,
  zIndex: 3,
  isOnScreen: true,
  minimized: false,
  bounds: { x: 100, y: 90, width: 300, height: 200 },
  windowClass: "#32770",
} as const;

function probe(overrides: Partial<WindowRelationshipProbeSnapshot> = {}): WindowRelationshipProbeSnapshot {
  return {
    source: "win32_relationship_probe",
    complete: true,
    windows: [
      {
        pid: parent.target.pid,
        windowId: parent.target.windowId,
        ownerPid: 0,
        ownerWindowId: 0,
        zIndex: 2,
        isOnScreen: true,
        minimized: false,
        bounds: parent.bounds,
        windowClass: "Notepad",
      },
      child,
    ],
    foregroundPid: child.pid,
    foregroundWindowId: child.windowId,
    ...overrides,
  };
}

function cua(windows: readonly CuaWindowInfo[] = [parent]): CuaWindowInventory {
  return { windows, complete: false, completeAttestation: "missing", source: "cua_inventory" };
}

describe("cross-platform window relationship inventory merge", () => {
  it("uses a complete probe's exact rows and bounds despite non-atomic CUA geometry", () => {
    const staleParent = { ...parent, bounds: { x: 1190, y: 211, width: 687, height: 685 } };
    const staleChild: CuaWindowInfo = {
      target: { pid: child.pid, windowId: child.windowId },
      title: "local-only child label",
      bounds: { x: 1183, y: 318, width: 447, height: 697 },
      ownerPid: child.ownerPid,
      ownerWindowId: child.ownerWindowId,
      zIndex: child.zIndex,
      isOnScreen: child.isOnScreen,
      minimized: child.minimized,
      windowClass: child.windowClass,
    };
    const freshParentBounds = { x: 67, y: 80, width: 467, height: 461 };
    const freshChildBounds = { x: 133, y: 100, width: 298, height: 465 };
    const rows = [
      { ...probe().windows[0]!, bounds: freshParentBounds },
      { ...child, bounds: freshChildBounds },
    ];
    const merged = mergeWindowRelationshipInventory(cua([staleParent, staleChild]), probe({ windows: rows }), true);

    expect(merged.complete).toBe(true);
    expect(merged.windows.map((window) => window.target.windowId)).toEqual([101, 202]);
    expect(merged.windows[0]).toMatchObject({ bounds: freshParentBounds, title: parent.title, appName: parent.appName });
    expect(merged.windows[1]).toMatchObject({
      bounds: freshChildBounds,
      title: staleChild.title,
      ownerPid: child.ownerPid,
      ownerWindowId: child.ownerWindowId,
      zIndex: child.zIndex,
    });
  });

  it("tolerates non-atomic row churn: a CUA row disappears and fresh probe rows appear", () => {
    const staleCuaRow: CuaWindowInfo = {
      target: { pid: 41, windowId: 303 },
      title: "stale local label",
      bounds: { x: 500, y: 20, width: 400, height: 200 },
      zIndex: 1,
      isOnScreen: true,
    };
    const newProbeRow = {
      pid: 41,
      windowId: 404,
      ownerPid: 0,
      ownerWindowId: 0,
      zIndex: 4,
      isOnScreen: true,
      minimized: false,
      bounds: { x: 600, y: 30, width: 500, height: 300 },
      windowClass: "OtherWindow",
    } as const;
    const freshParentBounds = { x: 12, y: 14, width: 801, height: 601 };
    const merged = mergeWindowRelationshipInventory(cua([
      { ...parent, bounds: { x: 0, y: 0, width: 799, height: 599 } },
      staleCuaRow,
    ]), probe({ windows: [
      { ...probe().windows[0]!, bounds: freshParentBounds },
      child,
      newProbeRow,
    ] }), true);

    expect(merged.complete).toBe(true);
    expect(merged.windows.map((window) => window.target.windowId)).toEqual([101, 202, 404]);
    expect(merged.windows[0]).toMatchObject({ bounds: freshParentBounds, title: parent.title, appName: parent.appName });
    expect(merged.windows[1]).toMatchObject({ ownerPid: 41, ownerWindowId: 101 });
    expect(merged.windows[2]?.title).toBeUndefined();
    expect(merged.windows[2]?.appName).toBeUndefined();
  });

  it("attaches CUA labels only to exact PID/HWND identities", () => {
    const merged = mergeWindowRelationshipInventory(cua(), probe(), true);

    expect(merged.complete).toBe(true);
    expect(merged.source).toBe("win32_relationship_probe");
    expect(merged.foregroundPid).toBe(child.pid);
    expect(merged.foregroundWindowId).toBe(child.windowId);
    expect(merged.windows.map((window) => window.target)).toEqual([
      parent.target,
      { pid: child.pid, windowId: child.windowId },
    ]);
    expect(merged.windows[0]).toMatchObject({ title: parent.title, appName: parent.appName });
    expect(merged.windows[1]).toMatchObject({ ownerPid: parent.target.pid, ownerWindowId: parent.target.windowId, windowClass: "#32770" });
    expect(merged.windows.flatMap((window) => Object.keys(window))).not.toContain("text");
  });

  it("permits narrow partial augmentation for an exact existing foreground child only", () => {
    const childCua: CuaWindowInfo = {
      target: { pid: child.pid, windowId: child.windowId },
      title: "local-only dialog label",
      bounds: { x: 10, y: 10, width: 100, height: 80 },
    };
    const probeOnlyRow = {
      pid: 41,
      windowId: 505,
      ownerPid: 0,
      ownerWindowId: 0,
      zIndex: 4,
      isOnScreen: true,
      minimized: false,
      bounds: { x: 700, y: 50, width: 200, height: 100 },
      windowClass: "Unrelated",
    } as const;
    const partial = mergeWindowRelationshipInventory(cua([parent, childCua]), probe({
      complete: false,
      windows: [probe().windows[0]!, child, probeOnlyRow],
    }), true);

    expect(partial.complete).toBe(false);
    expect(partial.completeAttestation).toBe("negative");
    expect(partial.windows.map((window) => window.target.windowId)).toEqual([101, 202]);
    expect(partial.windows[1]).toMatchObject({
      title: childCua.title,
      bounds: childCua.bounds,
      ownerPid: child.ownerPid,
      ownerWindowId: child.ownerWindowId,
      isOnScreen: true,
      minimized: false,
      windowClass: "#32770",
    });
    expect(partial.windows[1]!.zIndex).toBeUndefined();
    expect(partial.foregroundPid).toBe(child.pid);
    expect(partial.foregroundWindowId).toBe(child.windowId);
  });

  it("does not add a probe-only foreground identity to a partial picker", () => {
    const partial = mergeWindowRelationshipInventory(cua(), probe({ complete: false }), true);

    expect(partial.complete).toBe(false);
    expect(partial.windows.map((window) => window.target)).toEqual([parent.target]);
    expect(partial.foregroundPid).toBeUndefined();
    expect(partial.foregroundWindowId).toBeUndefined();
  });

  it("requires positive untruncated probe evidence and no CUA negative attestation", () => {
    const bothComplete = mergeWindowRelationshipInventory({ ...cua(), complete: true, completeAttestation: "explicit" }, probe(), true);
    const probeIncomplete = mergeWindowRelationshipInventory({ ...cua(), complete: true, completeAttestation: "explicit" }, probe({ complete: false }), true);
    const explicitCuaIncomplete = mergeWindowRelationshipInventory({ ...cua(), complete: false, completeAttestation: "explicit" }, probe(), true);
    const negativeCua = mergeWindowRelationshipInventory({ ...cua(), complete: true, completeAttestation: "negative" }, probe(), true);
    const cuaTruncated = mergeWindowRelationshipInventory({ ...cua(), complete: false, truncated: true }, probe(), true);
    const probeTruncated = mergeWindowRelationshipInventory(cua(), probe({ truncated: true }), true);

    expect(bothComplete.complete).toBe(true);
    for (const rejected of [probeIncomplete, explicitCuaIncomplete, negativeCua, cuaTruncated, probeTruncated]) {
      expect(rejected.complete).toBe(false);
      expect(rejected.completeAttestation).toBe("negative");
      expect(rejected.foregroundWindowId).toBeUndefined();
    }
    expect(cuaTruncated.truncated).toBe(true);
    expect(probeTruncated.truncated).toBe(true);
  });

  it("filters offscreen rows only for the visible-window projection", () => {
    const offscreen = { ...child, windowId: 303, isOnScreen: false, minimized: true };
    const windows = [probe().windows[0]!, child, offscreen];
    const visible = mergeWindowRelationshipInventory(cua(), probe({ windows }), true);
    const all = mergeWindowRelationshipInventory(cua(), probe({ windows }), false);

    expect(visible.complete).toBe(true);
    expect(visible.windows.map((window) => window.target.windowId)).toEqual([101, 202]);
    expect(all.windows.map((window) => window.target.windowId)).toEqual([101, 202, 303]);
  });

  it.each([
    ["owner PID/HWND", { ...parent, ownerPid: 900, ownerWindowId: 901 }],
    ["visibility", { ...parent, isOnScreen: false }],
    ["minimized", { ...parent, minimized: true }],
    ["window class", { ...parent, windowClass: "ContradictoryClass" }],
  ])("fails closed when explicitly supplied CUA %s contradicts the probe", (_field, contradictory) => {
    const merged = mergeWindowRelationshipInventory(cua([contradictory]), probe(), true);

    expect(merged.complete).toBe(false);
    expect(merged.completeAttestation).toBe("negative");
    expect(merged.windows).toEqual([contradictory]);
    expect(merged.foregroundPid).toBeUndefined();
    expect(merged.foregroundWindowId).toBeUndefined();
  });

  it("accepts Notepad visible-list 6 > 5 versus global-chain 699 > 639 ranks", () => {
    const cuaChild = { target: { pid: child.pid, windowId: child.windowId }, bounds: child.bounds, zIndex: 6 };
    const input = cua([{ ...parent, zIndex: 5 }, cuaChild]);
    const merged = mergeWindowRelationshipInventory(input, probe({ windows: [
      { ...probe().windows[0]!, zIndex: 639 }, { ...child, zIndex: 699 },
    ] }), true);
    expect(merged.complete).toBe(true);
    expect(merged.windows.map((row) => row.zIndex)).toEqual([639, 699]);
  });

  it.each([[6, 5, 639, 699], [5, 5, 639, 699], [5, 6, 699, 699]])(
    "rejects reversed or duplicate common ranks (%s, %s, %s, %s)", (parentZ, childZ, probeParentZ, probeChildZ) => {
      const input = cua([{ ...parent, zIndex: parentZ }, {
        target: { pid: child.pid, windowId: child.windowId }, bounds: child.bounds, zIndex: childZ,
      }]);
      const merged = mergeWindowRelationshipInventory(input, probe({ windows: [
        { ...probe().windows[0]!, zIndex: probeParentZ }, { ...child, zIndex: probeChildZ },
      ] }), true);
      expect(merged.complete).toBe(false);
      expect(merged.foregroundWindowId).toBeUndefined();
    },
  );

  it("does not compare rank scales for one common row or missing CUA z", () => {
    expect(mergeWindowRelationshipInventory(cua([{ ...parent, zIndex: 99 }]), probe(), true).complete).toBe(true);
    expect(mergeWindowRelationshipInventory(cua([parent, {
      target: { pid: child.pid, windowId: child.windowId }, bounds: child.bounds,
    }]), probe(), true).complete).toBe(true);
  });

  it("fails closed when CUA and Win32 foreground identities disagree", () => {
    const cuaInventory: CuaWindowInventory = {
      ...cua(),
      foregroundPid: parent.target.pid,
      foregroundWindowId: parent.target.windowId,
    };
    const merged = mergeWindowRelationshipInventory(cuaInventory, probe(), true);

    expect(merged.complete).toBe(false);
    expect(merged.completeAttestation).toBe("negative");
    expect(merged.foregroundPid).toBeUndefined();
    expect(merged.foregroundWindowId).toBeUndefined();
  });

  it("fails closed on invalid or duplicate probe rows and duplicate CUA identities", () => {
    const invalidProbeRow = { ...child, zIndex: 3.5 } as unknown as WindowRelationshipProbeSnapshot["windows"][number];
    const invalid = mergeWindowRelationshipInventory(cua(), probe({ windows: [invalidProbeRow] }), true);
    const duplicateProbe = mergeWindowRelationshipInventory(cua(), probe({ windows: [child, child] }), true);
    const duplicateCua = mergeWindowRelationshipInventory(cua([parent, parent]), probe(), true);

    for (const rejected of [invalid, duplicateProbe, duplicateCua]) {
      expect(rejected.complete).toBe(false);
      expect(rejected.completeAttestation).toBe("negative");
      expect(rejected.foregroundWindowId).toBeUndefined();
    }
  });
});
