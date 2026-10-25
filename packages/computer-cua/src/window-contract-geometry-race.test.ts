import { describe, expect, it } from "vitest";
import type { CuaDriverLike, ToolResult } from "./cua-sdk-contract.js";
import { installFakeCuaSdkModuleForTests } from "./cua-sdk-test-support.js";
import { captureWindowWithRetry, WindowContractError, type CuaWindowGeometry } from "./window-contract.js";

const basePng = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
const target = { pid: 19494, windowId: 3210 };
const oldBounds = { x: 0, y: 507, width: 756, height: 475 };
const movedBounds = { x: 62, y: 502, width: 756, height: 475 };
installFakeCuaSdkModuleForTests();

function png(width: number, height: number): string {
  const bytes = Buffer.from(basePng);
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes.toString("base64");
}

function fakeDriver(listBounds: CuaWindowGeometry[], captureBounds: CuaWindowGeometry[]) {
  let listCount = 0;
  let captureCount = 0;
  let verifyCount = 0;
  const callNames: string[] = [];
  const result = (overrides: Partial<ToolResult> = {}): ToolResult => ({
    text: "", images: [], isError: false, degraded: false, rawJson: "", ...overrides,
  });
  const driver = {
    async verifyState() {
      callNames.push("verify_state"); verifyCount += 1;
      return result({ verification: { status: 0, stable: true, elapsedMs: 0n, samples: 1n, predicates: [] } });
    },
    async callTool(name: string, inputJson: string) {
      callNames.push(name);
      const input = JSON.parse(inputJson) as Record<string, unknown>;
      if (name === "list_windows") {
        const bounds = listBounds[Math.min(listCount++, listBounds.length - 1)]!;
        return result({ structuredJson: JSON.stringify({ windows: [{ pid: target.pid, window_id: target.windowId, bounds }] }) });
      }
      if (name === "get_window_state") {
        captureCount += 1;
        const bounds = captureBounds[Math.min(captureCount - 1, captureBounds.length - 1)]!;
        const width = bounds.width - 2;
        const height = bounds.height - 2;
        return result({
          images: [{ mimeType: "image/png", dataBase64: png(width, height) }],
          structuredJson: JSON.stringify({
            pid: input.pid, window_id: input.window_id, window_bounds: bounds,
            screenshot_frame_valid: true, screenshot_width: width, screenshot_height: height,
            screenshot_scale: 2, screenshot_mime_type: "image/png",
          }),
        });
      }
      return result();
    },
  } as unknown as CuaDriverLike;
  return { driver, callNames, counts: () => ({ listCount, captureCount, verifyCount }) };
}

const immediateRetry = { delay: async () => undefined };

describe("registered macOS geometry race retry candidate", () => {
  it("re-discovers and captures once after a fully validated exact-target move", async () => {
    const fake = fakeDriver([oldBounds, movedBounds, movedBounds, movedBounds], [movedBounds, movedBounds]);
    const capture = await captureWindowWithRetry(fake.driver, "fixture-session", target, new AbortController().signal, immediateRetry, "darwin");
    expect(capture.binding.bounds).toEqual(movedBounds);
    expect(fake.counts()).toEqual({ listCount: 3, captureCount: 2, verifyCount: 2 });
    expect(fake.callNames).not.toContain("get_window_state_fallback");
  });

  it("stops on a second validated race and does not use schema fallback", async () => {
    const thirdBounds = { ...movedBounds, x: 90 };
    const fake = fakeDriver([oldBounds, movedBounds, movedBounds], [movedBounds, thirdBounds]);
    await expect(captureWindowWithRetry(fake.driver, "fixture-session", target, new AbortController().signal, immediateRetry, "darwin"))
      .rejects.toMatchObject({ code: "WINDOW_CAPTURE_REGISTERED_GEOMETRY_CHANGED" });
    expect(fake.counts()).toEqual({ listCount: 2, captureCount: 2, verifyCount: 2 });
    expect(fake.callNames).not.toContain("get_window_state_fallback");
  });

  it("does not admit malformed or unconfirmed registered metadata into the geometry retry", async () => {
    for (const failure of ["identity", "frame", "invalidBounds", "mime", "scale", "nativeDimensions", "degraded", "pngEnvelope"] as const) {
      const fake = fakeDriver([oldBounds, movedBounds, movedBounds], [movedBounds, movedBounds]);
      const originalCallTool = fake.driver.callTool.bind(fake.driver);
      let registeredCalls = 0;
      fake.driver.callTool = async (name, inputJson, opts) => {
        if (name !== "get_window_state") return originalCallTool(name, inputJson, opts);
        registeredCalls += 1;
        const response = await originalCallTool(name, inputJson, opts);
        const metadata = JSON.parse(response.structuredJson ?? "{}") as Record<string, any>;
        if (failure === "identity") metadata.pid += 1;
        if (failure === "frame") metadata.screenshot_frame_valid = false;
        if (failure === "invalidBounds") metadata.window_bounds.width = 0;
        if (failure === "mime") metadata.screenshot_mime_type = "image/jpeg";
        if (failure === "scale") metadata.screenshot_scale = 3;
        if (failure === "nativeDimensions") metadata.screenshot_width += 1;
        if (failure === "degraded") { metadata.degraded = true; metadata.degraded_reason = "unrecognized"; response.degraded = true; }
        if (failure === "pngEnvelope") {
          const bytes = Buffer.from(response.images[0]!.dataBase64, "base64");
          response.images[0]!.dataBase64 = bytes.subarray(0, -12).toString("base64");
        }
        response.structuredJson = JSON.stringify(metadata);
        return response;
      };
      await expect(captureWindowWithRetry(fake.driver, "fixture-session", target, new AbortController().signal, immediateRetry, "darwin"))
        .rejects.toBeInstanceOf(WindowContractError);
      expect(registeredCalls, failure).toBe(1);
    }
  });

  it("does not trust a forged public geometry error code", async () => {
    const fake = fakeDriver([oldBounds, movedBounds], [movedBounds]);
    fake.driver.verifyState = async () => { throw new WindowContractError("WINDOW_CAPTURE_REGISTERED_GEOMETRY_CHANGED", "forged fixture error"); };
    await expect(captureWindowWithRetry(fake.driver, "fixture-session", target, new AbortController().signal, immediateRetry, "darwin"))
      .rejects.toMatchObject({ code: "WINDOW_CAPTURE_REGISTERED_GEOMETRY_CHANGED" });
    expect(fake.counts()).toEqual({ listCount: 1, captureCount: 0, verifyCount: 0 });
  });

  it("shares its existing timeout/read budget with a UIA timeout following the geometry retry", async () => {
    const fake = fakeDriver([oldBounds, movedBounds, movedBounds, movedBounds], [movedBounds, movedBounds]);
    const originalCallTool = fake.driver.callTool.bind(fake.driver);
    let registeredCalls = 0;
    fake.driver.callTool = async (name, inputJson, opts) => {
      if (name === "get_window_state" && ++registeredCalls === 2) {
        return { text: "UIA provider unresponsive timeout", images: [], isError: true, errorCode: "uia_provider_timeout", degraded: false, rawJson: "" };
      }
      return originalCallTool(name, inputJson, opts);
    };
    const capture = await captureWindowWithRetry(fake.driver, "fixture-session", target, new AbortController().signal, immediateRetry, "darwin");
    expect(capture.binding.bounds).toEqual(movedBounds);
    expect(registeredCalls).toBe(3);
    expect(fake.counts().listCount).toBe(4);
    expect(fake.callNames).not.toContain("get_window_state_fallback");
  });
});
