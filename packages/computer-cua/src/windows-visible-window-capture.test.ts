import { mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import {
  captureVisibleWindowRegion,
  type WindowsVisibleCaptureExecutor,
  type WindowsVisibleCaptureExecutionResult,
} from "./windows-visible-window-capture.js";

const target = { pid: 2468, windowId: 13579 };

describe("captureVisibleWindowRegion", () => {
  it("returns an opaque PNG with exact DWM geometry and removes its private temp directory", async () => {
    await withTemporaryRoot(async (tempRoot) => {
      const png = encodePng(4, 3);
      let temporaryDirectory: string | undefined;
      let executablePath = "";
      let capturedArgs: readonly string[] = [];
      let tempExistedDuringExecution = false;
      const execute = vi.fn<WindowsVisibleCaptureExecutor>(async (path, args, options) => {
        executablePath = path;
        capturedArgs = args;
        temporaryDirectory = options.temporaryDirectory;
        tempExistedDuringExecution = await stat(options.temporaryDirectory).then(() => true, () => false);
        return {
          exitCode: 0,
          stdout: Buffer.from(JSON.stringify({
            ...target,
            x: -80,
            y: 40,
            width: 4,
            height: 3,
            pngBase64: png.toString("base64"),
          }), "utf8"),
        };
      });

      const result = await captureVisibleWindowRegion(target, new AbortController().signal, { execute, tempRoot });
      expect(execute).toHaveBeenCalledTimes(1);
      expect(executablePath).toBe("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
      expect(capturedArgs.slice(0, 4)).toEqual(["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand"]);
      expect(tempExistedDuringExecution).toBe(true);
      const script = Buffer.from(capturedArgs[4]!, "base64").toString("utf16le");
      expect(script).toContain("@([int]2468, [long]13579)");
      expect(script).toContain("DwmGetWindowAttribute");
      expect(script).toContain("GetForegroundWindow() != hwnd");
      expect(script).toContain("IsWindowVisible(hwnd) || IsIconic(hwnd)");
      expect(script).toContain("!TargetCaptureIsOpaque(hwnd)");
      expect(script).toContain("EnumWindows(delegate(IntPtr hwnd, IntPtr extra)");
      expect(script).toContain("GetLayeredWindowAttributes");
      expect(script).toContain("alpha == 0");
      const targetOpacityCheck = script.slice(script.indexOf("private static bool TargetCaptureIsOpaque"), script.indexOf("private static bool IsProvenFullyTransparentLayeredWindow"));
      expect(targetOpacityCheck).toContain("if ((style.ToInt64() & WS_EX_LAYERED) == 0) return true;");
      expect(targetOpacityCheck).toContain("if (!GetLayeredWindowAttributes(hwnd, out colorKey, out alpha, out flags)) return false;");
      expect(targetOpacityCheck).toContain("(flags & LWA_COLORKEY) != 0");
      expect(targetOpacityCheck).toContain("alpha == 255");
      expect(script).toContain("private const uint LWA_COLORKEY = 0x00000001;");
      expect(script).toContain("BitBlt(destination, 0, 0, width, height, screen, rect.Left, rect.Top");
      expect(script).toContain("PixelFormat.Format24bppRgb");
      expect(script).not.toMatch(/SetForegroundWindow|SendInput|GetDesktopState/u);
      const occlusionCheck = script.slice(script.indexOf("private static bool HasNoForeignOccluder"), script.indexOf("private static IntPtr GetWindowLongPtr"));
      expect(occlusionCheck).toContain("if (!Intersects(targetBounds, other)) return true;");
      expect(occlusionCheck.indexOf("if (!GetWindowRect(hwnd, out other))")).toBeLessThan(occlusionCheck.indexOf("IsProvenFullyTransparentLayeredWindow(hwnd"));
      expect(temporaryDirectory).toBeDefined();
      await expect(stat(temporaryDirectory!)).rejects.toThrow();
      expect(result).toMatchObject({ target, bounds: { x: -80, y: 40, width: 4, height: 3 } });
      expect(Buffer.from(result!.data).equals(png)).toBe(true);
      expect(execute).toHaveBeenCalledTimes(1);
    });
  });

  const refusalCases: readonly [string, (png: Buffer) => WindowsVisibleCaptureExecutionResult][] = [
    ["native refusal", () => ({ exitCode: 5, stdout: Buffer.from("", "utf8") })],
    ["wrong HWND", (png) => ({ exitCode: 0, stdout: jsonOutput({ ...captureRecord(png), windowId: 99 }) })],
    ["geometry does not match PNG dimensions", (png) => ({ exitCode: 0, stdout: jsonOutput({ ...captureRecord(png), width: 5 }) })],
    ["malformed PNG", () => ({ exitCode: 0, stdout: jsonOutput({ ...captureRecord(Buffer.from("not png")), width: 7, height: 1 }) })],
  ];

  it.each(refusalCases)("returns undefined and cleans up after %s", async (_label, makeExecution) => {
    await withTemporaryRoot(async (tempRoot) => {
      let temporaryDirectory: string | undefined;
      const execute = vi.fn<WindowsVisibleCaptureExecutor>(async (_path, _args, options) => {
        temporaryDirectory = options.temporaryDirectory;
        return makeExecution(encodePng(4, 3));
      });
      await expect(captureVisibleWindowRegion(target, new AbortController().signal, { execute, tempRoot })).resolves.toBeUndefined();
      expect(temporaryDirectory).toBeDefined();
      await expect(stat(temporaryDirectory!)).rejects.toThrow();
    });
  });

  it("cleans up when the executor throws and propagates cancellation", async () => {
    await withTemporaryRoot(async (tempRoot) => {
      let temporaryDirectory: string | undefined;
      const controller = new AbortController();
      const execute = vi.fn<WindowsVisibleCaptureExecutor>(async (_path, _args, options) => {
        temporaryDirectory = options.temporaryDirectory;
        controller.abort(new Error("cancelled"));
        options.signal.throwIfAborted();
        return { exitCode: 0, stdout: Buffer.alloc(0) };
      });
      await expect(captureVisibleWindowRegion(target, controller.signal, { execute, tempRoot })).rejects.toThrow("cancelled");
      expect(temporaryDirectory).toBeDefined();
      await expect(stat(temporaryDirectory!)).rejects.toThrow();
    });
  });

  it("rejects invalid target identity before creating a temp directory or invoking PowerShell", async () => {
    await withTemporaryRoot(async (tempRoot) => {
      const execute = vi.fn<WindowsVisibleCaptureExecutor>();
      await expect(captureVisibleWindowRegion({ pid: 0, windowId: 13579 }, new AbortController().signal, { execute, tempRoot })).rejects.toThrow(/positive safe integer/u);
      expect(execute).not.toHaveBeenCalled();
    });
  });
});

function captureRecord(png: Buffer): Record<string, unknown> {
  return { ...target, x: -80, y: 40, width: 4, height: 3, pngBase64: png.toString("base64") };
}

function jsonOutput(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value), "utf8");
}

async function withTemporaryRoot(action: (path: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "visible-window-capture-test-"));
  try {
    await action(await realpath(root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function encodePng(width: number, height: number): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const pixelRows = Buffer.alloc(height * (width * 3 + 1));
  const compressed = deflateSync(pixelRows);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", compressed),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function pngChunk(name: string, data: Buffer): Buffer {
  const type = Buffer.from(name, "ascii");
  const chunk = Buffer.alloc(12 + data.byteLength);
  chunk.writeUInt32BE(data.byteLength, 0);
  type.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([type, data])), 8 + data.byteLength);
  return chunk;
}

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) !== 0 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
