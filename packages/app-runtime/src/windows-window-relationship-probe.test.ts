import { Buffer } from "node:buffer";
import { describe, expect, it, vi } from "vitest";
import {
  createWindowsWindowRelationshipProbe,
  parseWindowRelationshipProbeOutput,
  type PowerShellProbeExecutor,
} from "./windows-window-relationship-probe.js";

const fixture = {
  source: "win32_relationship_probe",
  complete: true,
  truncated: false,
  foregroundPid: 101,
  foregroundWindowId: 303,
  zOrderWindowIds: [303, 202],
  windows: [
    {
      pid: 101,
      windowId: 202,
      isOnScreen: true,
      minimized: false,
      bounds: { x: 10, y: 20, width: 300, height: 200 },
      windowClass: "Notepad",
    },
    {
      pid: 101,
      windowId: 303,
      ownerPid: 101,
      ownerWindowId: 202,
      isOnScreen: true,
      minimized: false,
      bounds: { x: 20, y: 30, width: 250, height: 120 },
      windowClass: "#32770",
    },
  ],
};

function encodedJson(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value), "ascii");
}

describe("Windows read-only relationship probe", () => {
  it("parses exact relationship identities and foreground evidence without labels or UI text", () => {
    const parsed = parseWindowRelationshipProbeOutput(JSON.stringify(fixture));

    expect(parsed).toMatchObject({
      complete: true,
      source: "win32_relationship_probe",
      foregroundPid: 101,
      foregroundWindowId: 303,
      windows: [{ windowClass: "Notepad" }, { ownerPid: 101, ownerWindowId: 202, windowClass: "#32770" }],
    });
    expect(parsed.windows.map((window) => [window.windowId, window.zIndex])).toEqual([[202, 1], [303, 2]]);
    expect(Object.keys(parsed.windows[0]!)).not.toContain("title");
    expect(Object.keys(parsed.windows[0]!)).not.toContain("text");
  });

  it("forces truncated snapshots incomplete and rejects extra title/content fields", () => {
    expect(parseWindowRelationshipProbeOutput(JSON.stringify({ ...fixture, complete: true, truncated: true })).complete).toBe(false);
    expect(() => parseWindowRelationshipProbeOutput(JSON.stringify({ ...fixture, windows: [{ ...fixture.windows[0], title: "not accepted" }] })))
      .toThrow(/invalid window row/iu);
    expect(() => parseWindowRelationshipProbeOutput(JSON.stringify({ ...fixture, text: "not accepted" })))
      .toThrow(/invalid schema/iu);
  });

  it("uses fixed PowerShell arguments and read-only Win32 APIs through an injected executor", async () => {
    const execute: PowerShellProbeExecutor = vi.fn(async (_path, args, options) => {
      expect(options.timeoutMs).toBe(1_000);
      expect(options.maxOutputBytes).toBe(8_192);
      const encoded = args[args.indexOf("-EncodedCommand") + 1]!;
      const script = Buffer.from(encoded, "base64").toString("utf16le");
      expect(script).toContain("EnumWindows");
      expect(script).toContain("GetWindowThreadProcessId");
      expect(script).toContain("GetForegroundWindow");
      expect(script).toContain("GW_HWNDFIRST");
      expect(script).toContain("GW_HWNDNEXT");
      expect(script).toContain("previousDpiContext = SetThreadDpiAwarenessContext(new IntPtr(-4));");
      expect(script).toContain("if (previousDpiContext == IntPtr.Zero) { complete = false; return rows.ToArray(); }");
      expect(script).toMatch(/finally\s*\{[\s\S]*if \(previousDpiContext != IntPtr.Zero\)[\s\S]*SetThreadDpiAwarenessContext\(previousDpiContext\) == IntPtr.Zero\) complete = false;[\s\S]*catch \{ complete = false; \}/u);
      expect(script.indexOf("previousDpiContext = SetThreadDpiAwarenessContext")).toBeLessThan(script.indexOf("ReadWindowsInPhysicalCoordinates();"));
      expect(script).not.toMatch(/SetProcessDpiAware|SetProcessDpiAwareness|SetDisplayConfig/u);
      expect(script).toContain("if (!GetWindowRect(hwnd, out outerRect)) { complete = false; return true; }");
      expect(script).toContain("if (outerWidth == 0 || outerHeight == 0) return true;");
      expect(script).toContain('[DllImport("dwmapi.dll")] private static extern int DwmGetWindowAttribute');
      expect(script).toContain("private const uint DWMWA_EXTENDED_FRAME_BOUNDS = 9;");
      expect(script).toContain("if (DwmGetWindowAttribute(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, out rect, Marshal.SizeOf(typeof(RECT))) != 0) { complete = false; return true; }");
      expect(script).toContain("if (frameWidth <= 0 || frameHeight <= 0 || frameWidth > Int32.MaxValue || frameHeight > Int32.MaxValue) { complete = false; return true; }");
      expect(script).toContain("bounds = new { x = rect.Left, y = rect.Top, width = width, height = height }");
      expect(script).not.toMatch(/bounds = new \{ x = outerRect/u);
      expect(script).not.toMatch(/\[DllImport\([^\]]*\)\]\s*private static extern [^;]*(?:SetForegroundWindow|SendInput|GetWindowText)/iu);
      return { exitCode: 0, stdout: encodedJson(fixture) };
    });
    const probe = createWindowsWindowRelationshipProbe({ timeoutMs: 1_000, maxOutputBytes: 8_192, execute });

    await expect(probe.read(new AbortController().signal)).resolves.toMatchObject({ complete: true, foregroundWindowId: 303 });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]?.[0]).toBe("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    expect(execute.mock.calls[0]?.[1].slice(0, 4)).toEqual(["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand"]);
  });

  it.each(["API unavailable", "entry null", "restore null", "restore throws", "rectangle read failure"])(
    "preserves an incomplete executor snapshot for DPI/read failure: %s", async () => {
      const execute = vi.fn<PowerShellProbeExecutor>(async () => ({
        exitCode: 0, stdout: encodedJson({ ...fixture, complete: false }),
      }));
      const result = await createWindowsWindowRelationshipProbe({ execute }).read(new AbortController().signal);
      expect(result.complete).toBe(false);
      expect(execute).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["DWM API unavailable", "DWM HRESULT failure", "invalid DWM rectangle"])(
    "keeps failed DWM visible-frame evidence incomplete without a retry: %s", async () => {
      const execute = vi.fn<PowerShellProbeExecutor>(async () => ({
        exitCode: 0, stdout: encodedJson({ ...fixture, complete: false, windows: [], zOrderWindowIds: [] }),
      }));
      const result = await createWindowsWindowRelationshipProbe({ execute }).read(new AbortController().signal);
      expect(result.complete).toBe(false);
      expect(result.windows).toEqual([]);
      expect(execute).toHaveBeenCalledTimes(1);
    },
  );

  it("preserves the exact 150-percent DWM visible-frame coordinates from a successful executor", async () => {
    const frames = [
      { ...fixture.windows[0]!, bounds: { x: 1190, y: 211, width: 687, height: 685 } },
      { ...fixture.windows[1]!, bounds: { x: 1183, y: 318, width: 447, height: 697 } },
    ];
    const execute = vi.fn<PowerShellProbeExecutor>(async () => ({
      exitCode: 0, stdout: encodedJson({ ...fixture, windows: frames }),
    }));
    const result = await createWindowsWindowRelationshipProbe({ execute }).read(new AbortController().signal);
    expect(result.complete).toBe(true);
    expect(result.windows.map((row) => row.bounds)).toEqual(frames.map((row) => row.bounds));
  });

  it("propagates timeout/failure and refuses oversized output without retry", async () => {
    const timeout = vi.fn<PowerShellProbeExecutor>(async () => { throw new Error("probe timed out"); });
    const timeoutProbe = createWindowsWindowRelationshipProbe({ execute: timeout });
    await expect(timeoutProbe.read(new AbortController().signal)).rejects.toThrow("probe timed out");
    expect(timeout).toHaveBeenCalledTimes(1);

    const oversized = vi.fn<PowerShellProbeExecutor>(async () => ({ exitCode: 0, stdout: Buffer.alloc(1_025, 0x20) }));
    const sizeProbe = createWindowsWindowRelationshipProbe({ maxOutputBytes: 1_024, execute: oversized });
    await expect(sizeProbe.read(new AbortController().signal)).rejects.toThrow(/exceeded its limit/iu);
    expect(oversized).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed IDs, owner pairs, class names, and duplicate HWNDs", () => {
    expect(() => parseWindowRelationshipProbeOutput(JSON.stringify({
      ...fixture,
      windows: [{ ...fixture.windows[0], windowId: -1 }],
    }))).toThrow(/invalid window row/iu);
    expect(() => parseWindowRelationshipProbeOutput(JSON.stringify({
      ...fixture,
      windows: [{ ...fixture.windows[0], ownerPid: 101 }],
    }))).toThrow(/invalid window row/iu);
    expect(() => parseWindowRelationshipProbeOutput(JSON.stringify({
      ...fixture,
      windows: [{ ...fixture.windows[0], windowClass: "#窗口" }],
    }))).toThrow(/invalid window row/iu);
    expect(() => parseWindowRelationshipProbeOutput(JSON.stringify({ ...fixture, windows: [fixture.windows[0], fixture.windows[0]] })))
      .toThrow(/duplicate HWND/iu);
  });

  it("ignores zero-size non-interactive rows and derives zIndex from the explicit HWND walk", () => {
    const zeroSize = {
      ...fixture.windows[0],
      windowId: 404,
      bounds: { x: 50, y: 50, width: 0, height: 80 },
    };
    const parsed = parseWindowRelationshipProbeOutput(JSON.stringify({
      ...fixture,
      zOrderWindowIds: [303, 404, 202],
      windows: [...fixture.windows, zeroSize],
    }));

    expect(parsed.complete).toBe(true);
    expect(parsed.windows.map((window) => [window.windowId, window.zIndex])).toEqual([[202, 1], [303, 3]]);
    expect(parsed.windows.some((window) => window.windowId === 404)).toBe(false);

    const failedRead = parseWindowRelationshipProbeOutput(JSON.stringify({
      ...fixture,
      complete: false,
      windows: [zeroSize],
    }));
    expect(failedRead.complete).toBe(false);
    expect(failedRead.windows).toEqual([]);

    const incompleteWalk = parseWindowRelationshipProbeOutput(JSON.stringify({
      ...fixture,
      zOrderWindowIds: [202],
    }));
    expect(incompleteWalk.complete).toBe(false);
  });
});
