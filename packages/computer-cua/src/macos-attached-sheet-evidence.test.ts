import { describe, expect, it } from "vitest";
import { verifyMacAttachedSheetEvidence, type MacAttachedSheetEvidenceInput } from "./macos-attached-sheet-evidence.js";

const parent = {
  target: { pid: 100, windowId: 200 },
  bounds: { x: 10, y: 20, width: 800, height: 600 },
} as const;
const candidate = {
  target: { pid: 100, windowId: 201 },
  bounds: { x: 100, y: 120, width: 500, height: 400 },
  isOnScreen: true,
  minimized: false,
} as const;

function sheetProof(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: "macos-attached-sheet-v1",
    status: "sheet",
    snapshot_id: "sheet-snapshot-1",
    pid: parent.target.pid,
    parent_window_id: parent.target.windowId,
    parent_owner_pid: parent.target.pid,
    frontmost_pid: parent.target.pid,
    direct_children_status: "success",
    direct_child_count: 1,
    parent_role: "AXWindow",
    parent_bounds: parent.bounds,
    focused_window_id: candidate.target.windowId,
    sheet: {
      role: "AXSheet",
      ax_parent_verified: true,
      pid: candidate.target.pid,
      owner_pid: parent.target.pid,
      ax_parent_pid: parent.target.pid,
      ax_parent_window_id: parent.target.windowId,
      window_id: candidate.target.windowId,
      bounds: candidate.bounds,
    },
    ...overrides,
  };
}

function input(overrides: Partial<MacAttachedSheetEvidenceInput> = {}): MacAttachedSheetEvidenceInput {
  const state = {
    snapshot_id: "sheet-snapshot-1",
    attached_sheet_proof: sheetProof(),
  };
  return {
    result: { isError: false, degraded: false },
    parent,
    candidate,
    state,
    parentIdentityMismatch: false,
    ...overrides,
  };
}

describe("macOS attached-sheet private evidence", () => {
  it("admits only the exact focused AXSheet candidate with fresh parent and child geometry", () => {
    expect(verifyMacAttachedSheetEvidence(input())).toMatchObject({
      status: "sheet",
      evidence: {
        kind: "native_window",
        nativeWindow: { pid: candidate.target.pid, hwnd: candidate.target.windowId },
        owner: { pid: parent.target.pid, hwnd: parent.target.windowId },
        rootRole: "dialog",
        frontmostEvidence: "exact_foreground",
        admissionSource: "macos_attached_sheet_proof",
      },
    });
  });

  it("accepts an exact relation-only proof from a degraded catalog", () => {
    const state = {
      degraded: true,
      elements_complete: false,
      attached_sheet_snapshot_id: "sheet-snapshot-1",
      attached_sheet_proof: sheetProof(),
    };
    expect(verifyMacAttachedSheetEvidence(input({
      result: { isError: false, degraded: true },
      state,
    })).status).toBe("sheet");
  });

  it("reports geometry instability separately and refuses a different candidate identity", () => {
    expect(verifyMacAttachedSheetEvidence(input({
      candidate: { ...candidate, bounds: { ...candidate.bounds, x: candidate.bounds.x + 1 } },
    })).status).toBe("geometry_unstable");
    expect(verifyMacAttachedSheetEvidence(input({
      candidate: { ...candidate, target: { ...candidate.target, windowId: candidate.target.windowId + 1 } },
    })).status).toBe("unknown");
  });

  it("keeps missing, contradictory, and unrelated degraded proofs unknown", () => {
    expect(verifyMacAttachedSheetEvidence(input({ state: undefined })).status).toBe("unknown");
    expect(verifyMacAttachedSheetEvidence(input({ parentIdentityMismatch: true })).status).toBe("unknown");
    expect(verifyMacAttachedSheetEvidence(input({ result: { isError: true, degraded: false } })).status).toBe("unknown");
    expect(verifyMacAttachedSheetEvidence(input({
      result: { isError: false, degraded: true },
      state: { degraded: true, elements_complete: false, attached_sheet_proof: sheetProof() },
    })).status).toBe("unknown");
  });
});
