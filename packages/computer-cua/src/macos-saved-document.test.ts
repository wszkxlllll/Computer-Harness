import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  authorizedOutputParentIsPinned,
  fileIdentityPin,
  hasExplicitApplicationIdentityConflict,
  parseDocumentIdentityProof,
  prepareReopenSavedDocumentGrant,
  sameApplicationProcess,
  type VerifiedApplicationIdentity,
} from "./macos-saved-document.js";

const target = { pid: 420, windowId: 88 } as const;
const bounds = { x: 100, y: 200, width: 800, height: 600 } as const;
const executableUrl = "file:///Applications/TextEdit.app/Contents/MacOS/TextEdit";
const documentUrl = "file:///tmp/authorized-output.txt";
const processStart = { seconds: 1_777_777_777, microseconds: 123_456 };

function documentProof(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: "macos-document-identity-v1",
    snapshot_id: "s12345678",
    status: "identity_verified",
    tail_revalidated: true,
    target: { pid: target.pid, window_id: target.windowId, process_start: processStart },
    application_identity: {
      status: "verified",
      target: {
        pid: target.pid,
        window_id: target.windowId,
        bundle_id: "com.apple.TextEdit",
        executable_url: executableUrl,
        process_start: processStart,
      },
      instances: [{
        pid: target.pid,
        bundle_id: "com.apple.TextEdit",
        executable_url: executableUrl,
        process_start: processStart,
      }],
    },
    frontmost_pid: target.pid,
    focused_window_id: target.windowId,
    window: {
      role: "AXWindow",
      pid: target.pid,
      window_id: target.windowId,
      owner_pid: target.pid,
      bounds,
    },
    document: { status: "ok", type: "cf_url", matches_expected: true },
    document_domain: { status: "complete_for_ax_windows", matching_window_ids: [target.windowId] },
    edited: {
      source: "ax_close_button",
      close_button: {
        status: "verified",
        role: "AXButton",
        subrole: "AXCloseButton",
        pid: target.pid,
        window_id: target.windowId,
        ax_window_id: target.windowId,
        ax_window_matches_target: true,
      },
      value: { status: "ok", type: "cf_boolean", value: false },
    },
    ...overrides,
  };
}

function proofResult(proof: Record<string, unknown>) {
  return { structuredJson: JSON.stringify({ _private_document_proof: proof }) };
}

describe("macOS saved-document private evidence", () => {
  it("requires exact TextEdit process, focused window, geometry, and clean-document evidence", () => {
    const parsed = parseDocumentIdentityProof(proofResult(documentProof()), target, bounds, executableUrl, documentUrl);

    expect(parsed).toMatchObject({
      identity: { pid: target.pid, windowId: target.windowId, processStart, bundleId: "com.apple.TextEdit", executableUrl },
      snapshotId: "s12345678",
      cleanDocument: true,
    });
  });

  it.each([
    ["wrong process", { application_identity: { status: "verified", target: {
      pid: target.pid, window_id: target.windowId, bundle_id: "com.apple.TextEdit", executable_url: executableUrl,
      process_start: { seconds: processStart.seconds + 1, microseconds: processStart.microseconds },
    }, instances: [] } }],
    ["wrong window bounds", { window: {
      role: "AXWindow", pid: target.pid, window_id: target.windowId, owner_pid: target.pid,
      bounds: { ...bounds, x: bounds.x + 1 },
    } }],
    ["document spans multiple windows", { document_domain: { status: "complete_for_ax_windows", matching_window_ids: [target.windowId, target.windowId + 1] } }],
    ["document is edited", { edited: { source: "ax_close_button", close_button: {
      status: "verified", role: "AXButton", subrole: "AXCloseButton", pid: target.pid, window_id: target.windowId,
      ax_window_id: target.windowId, ax_window_matches_target: true,
    }, value: { status: "ok", type: "cf_boolean", value: true } } }],
  ])("rejects %s proof", (_label, overrides) => {
    expect(parseDocumentIdentityProof(proofResult(documentProof(overrides)), target, bounds, executableUrl, documentUrl)).toBeUndefined();
  });

  it("detects a positively verified different application process without treating missing proof as conflict", () => {
    const identity = parseDocumentIdentityProof(proofResult(documentProof()), target, bounds, executableUrl)?.identity;
    if (identity === undefined) throw new Error("fixture identity did not parse");
    const differentProcess = documentProof({
      application_identity: {
        status: "verified",
        target: {
          pid: target.pid + 1,
          window_id: target.windowId,
          bundle_id: "com.apple.TextEdit",
          executable_url: executableUrl,
          process_start: processStart,
        },
        instances: [{
          pid: target.pid + 1,
          bundle_id: "com.apple.TextEdit",
          executable_url: executableUrl,
          process_start: processStart,
        }],
      },
    });

    expect(hasExplicitApplicationIdentityConflict(proofResult(differentProcess), target, executableUrl, identity)).toBe(true);
    expect(hasExplicitApplicationIdentityConflict({ isError: true }, target, executableUrl, identity)).toBe(false);
    expect(sameApplicationProcess(identity, identity)).toBe(true);
  });

  it("pins the canonical Host output parent and executable before accepting a new one-run file", async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "computer-harness-saved-document-module-")));
    const path = join(directory, "authorized-output.txt");
    const expectedExecutableUrl = pathToFileURL(await realpath(process.execPath)).href;
    try {
      const prepared = await prepareReopenSavedDocumentGrant({ path, expectedExecutableUrl });
      expect(prepared).toMatchObject({
        path,
        fileUrl: pathToFileURL(path).href,
        canonicalExecutableUrl: expectedExecutableUrl,
      });
      expect(await authorizedOutputParentIsPinned(path, prepared.parentIdentity)).toBe(true);

      await writeFile(path, "authorized output\n", "utf8");
      const identity = await fileIdentityPin(path);
      expect(identity.dev).toBeTruthy();
      expect(identity.ino).toBeTruthy();
      await expect(prepareReopenSavedDocumentGrant({ path, expectedExecutableUrl }))
        .rejects.toThrow("saved-document grant must name an output file that is absent at Run open");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
