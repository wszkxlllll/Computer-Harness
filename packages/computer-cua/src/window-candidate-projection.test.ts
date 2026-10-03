import { describe, expect, it } from "vitest";
import type { CuaWindowInfo } from "./window-contract.js";
import { isRelevantManualWindowCandidate, projectSelectableWindowCandidates } from "./window-candidate-projection.js";

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

  it.each(["darwin", "linux"] as const)("does not apply Win32 helper rules on %s", (platform) => {
    const hiddenOnWindows = windowInfo(77, 770, { isOnScreen: false, minimized: false, windowClass: "#32768" });
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
