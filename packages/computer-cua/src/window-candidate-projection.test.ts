import { describe, expect, it } from "vitest";
import type { CuaWindowInfo, CuaWindowInventory } from "./window-contract.js";
import {
  isEligibleNativeOnlyDesktopCandidate,
  isRelevantManualWindowCandidate,
  projectSelectableWindowCandidates,
} from "./window-candidate-projection.js";

const parent = { pid: 10, windowId: 100 };

function windowInfo(
  pid: number,
  windowId: number,
  overrides: Partial<CuaWindowInfo> = {},
): CuaWindowInfo {
  return {
    target: { pid, windowId },
    bounds: { x: 0, y: 0, width: 640, height: 480 },
    ...overrides,
  };
}

describe("selectable application window projection", () => {
  it("filters structurally hidden Win32 helpers while retaining background/minimized apps and untitled dialogs", () => {
    const helpers = Array.from({ length: 160 }, (_, index) =>
      windowInfo(200 + index, 2_000 + index, { isOnScreen: false, minimized: false, zIndex: index }));
    const current = windowInfo(parent.pid, parent.windowId, {
      appName: "Browser", title: "Train results", isOnScreen: true, zIndex: 3,
    });
    const backgroundNotepad = windowInfo(44, 440, {
      appName: "Notepad", title: "", isOnScreen: true, minimized: false, zIndex: 1,
    });
    const untitledDialog = windowInfo(parent.pid, 101, {
      ownerPid: parent.pid, ownerWindowId: parent.windowId, windowClass: "#32770",
      isOnScreen: true, minimized: false, zIndex: 4,
    });
    const source = [backgroundNotepad, ...helpers, untitledDialog, current];

    const projection = projectSelectableWindowCandidates(source, parent, "win32");

    expect(projection).toMatchObject({ truncated: false, omittedCount: 0 });
    expect(projection.windows.map((window) => window.target)).toEqual([
      parent,
      untitledDialog.target,
      backgroundNotepad.target,
    ]);
    expect(source).toHaveLength(163);
    expect(source).toContain(helpers[0]);
  });

  it("reports explicit truncation after prioritizing the current target and stable visible candidates", () => {
    const current = windowInfo(parent.pid, parent.windowId, { appName: "Browser", title: "Current", isOnScreen: true, zIndex: -1 });
    const windows = Array.from({ length: 130 }, (_, index) => windowInfo(1_000 + index, 5_000 + index, {
      appName: index === 129 ? "Notepad" : `Application ${String(index).padStart(3, "0")}`,
      title: index === 129 ? "Draft" : `Window ${index}`,
      isOnScreen: true,
      minimized: index === 129,
      zIndex: index === 129 ? 10_000 : index,
    }));
    const source = [current, ...windows];

    const first = projectSelectableWindowCandidates(source, parent, "win32");
    const repeated = projectSelectableWindowCandidates(source, parent, "win32");

    expect(first.windows).toHaveLength(128);
    expect(first.windows[0]?.target).toEqual(parent);
    expect(first).toMatchObject({ truncated: true, omittedCount: 3 });
    expect(first.windows.some((window) => window.appName === "Notepad")).toBe(true);
    expect(first.windows.map((window) => window.target)).toEqual(repeated.windows.map((window) => window.target));
  });

  it("retains native-only rows in the source topology but never projects them as provider targets", () => {
    const nativeOnlyForeground = windowInfo(88, 880, {
      appName: "Editor", title: "", isOnScreen: true, minimized: false, cuaListed: false,
    });
    const cuaListed = windowInfo(89, 890, {
      appName: "Notepad", title: "Draft", isOnScreen: true, minimized: false, cuaListed: true,
    });
    const source = [nativeOnlyForeground, cuaListed];

    const projection = projectSelectableWindowCandidates(source, nativeOnlyForeground.target, "win32");

    expect(projection.windows.map((window) => window.target)).toEqual([cuaListed.target]);
    expect(isRelevantManualWindowCandidate(nativeOnlyForeground, parent, undefined, undefined, "win32")).toBe(false);
    expect(source).toEqual([nativeOnlyForeground, cuaListed]);
  });

  it("admits a native-only desktop target only through an explicit complete unique Win32 proof", () => {
    const nativeOnly = windowInfo(88, 880, {
      appName: "Editor", title: "", isOnScreen: true, minimized: false, cuaListed: false,
      noActivate: false, windowClass: "EditorWindow",
    });
    const inventory: CuaWindowInventory = {
      windows: [nativeOnly], complete: true, source: "win32_relationship_probe",
    };
    const isEligible = (window: CuaWindowInfo) => isEligibleNativeOnlyDesktopCandidate(inventory, window);

    expect(isEligibleNativeOnlyDesktopCandidate(inventory, nativeOnly)).toBe(true);
    expect(projectSelectableWindowCandidates([nativeOnly], undefined, "win32").windows).toEqual([]);
    expect(projectSelectableWindowCandidates(
      [nativeOnly], undefined, "win32", undefined, undefined, false, isEligible,
    ).windows).toEqual([nativeOnly]);
    // The existing Host allowlist remains authoritative even on the opt-in path.
    expect(projectSelectableWindowCandidates(
      [nativeOnly], undefined, "win32", undefined, () => false, false, isEligible,
    ).windows).toEqual([]);
    expect(projectSelectableWindowCandidates(
      [nativeOnly], undefined, "darwin", undefined, undefined, false, () => true,
    ).windows).toEqual([]);
  });

  it("rejects native-only desktop targets without complete unique activatable-window evidence", () => {
    const nativeOnly = windowInfo(88, 880, {
      appName: "Editor", isOnScreen: true, minimized: false, cuaListed: false, noActivate: false,
    });
    const inventory: CuaWindowInventory = {
      windows: [nativeOnly], complete: true, source: "win32_relationship_probe",
    };
    const rejects = (candidateInventory: CuaWindowInventory, candidate = nativeOnly) =>
      isEligibleNativeOnlyDesktopCandidate(candidateInventory, candidate);
    const rejectsNativeRow = (overrides: Partial<CuaWindowInfo>) => {
      const row = { ...nativeOnly, ...overrides };
      return rejects({ ...inventory, windows: [row] }, row);
    };

    expect(rejects({ ...inventory, complete: false })).toBe(false);
    expect(rejects({ ...inventory, truncated: true })).toBe(false);
    expect(rejects({ ...inventory, source: "cua_inventory" })).toBe(false);
    expect(rejects({ ...inventory, completeAttestation: "negative" })).toBe(false);
    expect(rejects({ ...inventory, windows: [nativeOnly, { ...nativeOnly }] })).toBe(false);
    expect(rejectsNativeRow({ isOnScreen: false, minimized: false })).toBe(false);
    expect(rejectsNativeRow({ windowClass: "#32768" })).toBe(false);
    expect(rejectsNativeRow({ noActivate: true })).toBe(false);
    expect(rejectsNativeRow({ cuaListed: true })).toBe(false);
  });

  it("allows minimized native-only targets only when the complete native proof marks them restorable", () => {
    const minimized = windowInfo(88, 880, {
      appName: "Editor", isOnScreen: false, minimized: true, cuaListed: false, noActivate: false,
    });
    const inventory: CuaWindowInventory = {
      windows: [minimized], complete: true, source: "win32_relationship_probe",
    };
    expect(isEligibleNativeOnlyDesktopCandidate(inventory, minimized)).toBe(true);
    expect(projectSelectableWindowCandidates(
      [minimized], undefined, "win32", undefined, undefined, false,
      (window) => isEligibleNativeOnlyDesktopCandidate(inventory, window),
    ).windows).toEqual([minimized]);
  });

  it("keeps a known no-activate owned menu in topology but never offers it as an independent target", () => {
    const nonActivatingMenu = windowInfo(parent.pid, 881, {
      appName: "Notepad", title: "menu", isOnScreen: true, minimized: false,
      ownerPid: parent.pid, ownerWindowId: parent.windowId, noActivate: true,
    });
    const source = [windowInfo(parent.pid, parent.windowId, { isOnScreen: true }), nonActivatingMenu];

    const projected = projectSelectableWindowCandidates(
      source,
      parent,
      "win32",
      undefined,
      (window) => window.noActivate !== true,
      true,
    );

    expect(projected.windows.map((window) => window.target)).toEqual([parent]);
    expect(isRelevantManualWindowCandidate(nonActivatingMenu, parent, undefined, undefined, "win32")).toBe(true);
    expect(source).toContain(nonActivatingMenu);
  });

  it("preserves legacy behavior when native activation metadata is absent", () => {
    const unknownActivation = windowInfo(81, 810, { isOnScreen: true, minimized: false });
    expect(projectSelectableWindowCandidates([unknownActivation], undefined, "win32").windows)
      .toEqual([unknownActivation]);
  });

  it.each(["darwin", "linux"] as const)("does not apply Win32 helper rules on %s", (platform) => {
    const hiddenOnWindows = windowInfo(77, 770, { isOnScreen: false, minimized: false, windowClass: "#32768", noActivate: true });
    const projection = projectSelectableWindowCandidates([hiddenOnWindows], undefined, platform);
    expect(projection.windows).toEqual([hiddenOnWindows]);
    expect(projection.truncated).toBe(false);
  });

  it.each(["darwin", "linux"] as const)("accepts on-screen-list candidates with omitted visibility metadata on %s", (platform) => {
    const candidate = windowInfo(parent.pid, 102, { appName: "Editor", title: "Draft" });
    expect(isRelevantManualWindowCandidate(candidate, parent, undefined, undefined, platform)).toBe(true);
    expect(isRelevantManualWindowCandidate(candidate, parent, undefined, undefined, "win32")).toBe(false);
  });
});
