import { spawn } from "node:child_process";
import { Buffer } from "node:buffer";
import { lstat, mkdtemp, realpath, rm } from "node:fs/promises";
import { isAbsolute, join, normalize, relative, resolve, sep } from "node:path";

export interface WindowsVisibleCaptureTarget {
  readonly pid: number;
  readonly windowId: number;
}

export interface WindowsVisibleCaptureBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface WindowsVisibleWindowCapture {
  readonly target: WindowsVisibleCaptureTarget;
  readonly bounds: WindowsVisibleCaptureBounds;
  readonly data: Uint8Array;
}

export interface WindowsVisibleCaptureExecutionOptions {
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly temporaryDirectory: string;
}

export interface WindowsVisibleCaptureExecutionResult {
  readonly exitCode: number;
  readonly stdout: Uint8Array;
}

export type WindowsVisibleCaptureExecutor = (
  executablePath: string,
  args: readonly string[],
  options: WindowsVisibleCaptureExecutionOptions,
) => Promise<WindowsVisibleCaptureExecutionResult>;

export interface WindowsVisibleWindowCaptureOptions {
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  /** Test seam. Production always uses the fixed system PowerShell executable. */
  readonly execute?: WindowsVisibleCaptureExecutor;
  /** Test seam. Production uses C:\\Windows\\Temp, never a profile-derived temp directory. */
  readonly tempRoot?: string;
}

const POWERSHELL_PATH = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
const TASKKILL_PATH = "C:\\Windows\\System32\\taskkill.exe";
const WINDOWS_TEMP = "C:\\Windows\\Temp";
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_OUTPUT_BYTES = 24 * 1024 * 1024;
const MAX_ALLOWED_OUTPUT_BYTES = 32 * 1024 * 1024;
const MAX_PNG_BYTES = 16 * 1024 * 1024;
const MAX_CAPTURE_EDGE = 8_192;
const MAX_CAPTURE_PIXELS = 16_777_216;

/**
 * Read the visible DWM bounding rectangle for one exact, foreground Windows HWND.
 * The rectangle includes any visible pixels in that region (including same-process
 * self-drawn menus); it is not a pixel-level HWND mask, so rounded/transparent
 * frame corners can contain surrounding pixels. Callers must not use it as a
 * pixel-isolation proof. The helper is socket-agnostic: callers must separately
 * prove that their CUA connection is local before opting into native screen reads.
 * A refusal, stale target, unrelated occluder, timeout, or malformed response
 * returns undefined so callers can retain their existing isolated capture.
 */
export async function captureVisibleWindowRegion(
  target: WindowsVisibleCaptureTarget,
  signal: AbortSignal,
  options: WindowsVisibleWindowCaptureOptions = {},
): Promise<WindowsVisibleWindowCapture | undefined> {
  validateTarget(target);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30_000) {
    throw new Error("Visible-window capture timeout must be between 100 and 30000 ms");
  }
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1_024 || maxOutputBytes > MAX_ALLOWED_OUTPUT_BYTES) {
    throw new Error("Visible-window capture output limit must be between 1024 bytes and 32 MiB");
  }
  signal.throwIfAborted();
  if (process.platform !== "win32" && options.execute === undefined) return undefined;

  let temporaryDirectory: string | undefined;
  let result: WindowsVisibleWindowCapture | undefined;
  try {
    temporaryDirectory = await createPrivateTemporaryDirectory(options.tempRoot ?? WINDOWS_TEMP);
    signal.throwIfAborted();
    const execute = options.execute ?? executeWindowsPowerShell;
    const script = WINDOWS_VISIBLE_CAPTURE_SCRIPT
      .replace("__TARGET_PID__", String(target.pid))
      .replace("__TARGET_WINDOW_ID__", String(target.windowId));
    const encodedScript = Buffer.from(script, "utf16le").toString("base64");
    const execution = await execute(POWERSHELL_PATH, [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      encodedScript,
    ], { signal, timeoutMs, maxOutputBytes, temporaryDirectory });
    signal.throwIfAborted();
    if (execution.exitCode !== 0 || execution.stdout.byteLength > maxOutputBytes) return undefined;
    result = parseCaptureOutput(execution.stdout, target);
  } catch {
    signal.throwIfAborted();
    result = undefined;
  } finally {
    if (temporaryDirectory !== undefined) {
      const cleaned = await removePrivateTemporaryDirectory(options.tempRoot ?? WINDOWS_TEMP, temporaryDirectory).catch(() => false);
      if (!cleaned) result = undefined;
    }
  }
  signal.throwIfAborted();
  return result;
}

async function createPrivateTemporaryDirectory(rootPath: string): Promise<string> {
  if (!isAbsolute(rootPath) || !isAsciiPath(rootPath)) throw new Error("Visible-window temporary root must be an ASCII absolute path");
  const rootResolved = resolve(rootPath);
  const rootInfo = await lstat(rootResolved);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error("Visible-window temporary root is not a plain directory");
  const rootReal = await realpath(rootResolved);
  if (!samePath(rootResolved, rootReal)) throw new Error("Visible-window temporary root resolves through a link");
  const temporaryDirectory = await mkdtemp(join(rootReal, "harness-visible-capture-"));
  try {
    const tempInfo = await lstat(temporaryDirectory);
    const tempReal = await realpath(temporaryDirectory);
    const child = relative(rootReal, tempReal);
    if (!tempInfo.isDirectory() || tempInfo.isSymbolicLink() || !samePath(temporaryDirectory, tempReal) ||
        child.length === 0 || child.startsWith(`..${sep}`) || child === ".." || isAbsolute(child) || child.includes(sep)) {
      throw new Error("Visible-window temporary directory failed its containment check");
    }
    return temporaryDirectory;
  } catch (error) {
    await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

async function removePrivateTemporaryDirectory(rootPath: string, temporaryDirectory: string): Promise<boolean> {
  if (!isAbsolute(rootPath) || !isAsciiPath(rootPath) || !isAbsolute(temporaryDirectory) || !isAsciiPath(temporaryDirectory)) return false;
  const rootResolved = resolve(rootPath);
  const rootInfo = await lstat(rootResolved);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) return false;
  const rootReal = await realpath(rootResolved);
  if (!samePath(rootResolved, rootReal)) return false;
  const tempResolved = resolve(temporaryDirectory);
  const tempInfo = await lstat(tempResolved);
  if (!tempInfo.isDirectory() || tempInfo.isSymbolicLink()) return false;
  const tempReal = await realpath(tempResolved);
  const child = relative(rootReal, tempReal);
  if (!samePath(tempResolved, tempReal) || child.length === 0 || child === ".." ||
      child.startsWith(`..${sep}`) || isAbsolute(child) || child.includes(sep) ||
      !child.startsWith("harness-visible-capture-")) return false;
  await rm(tempResolved, { recursive: true, force: false });
  return true;
}

function samePath(left: string, right: string): boolean {
  return normalize(resolve(left)).replace(/[\\/]+$/u, "").toLocaleLowerCase("en-US") ===
    normalize(resolve(right)).replace(/[\\/]+$/u, "").toLocaleLowerCase("en-US");
}

function isAsciiPath(value: string): boolean {
  return /^[\x20-\x7e]+$/u.test(value);
}

function validateTarget(target: WindowsVisibleCaptureTarget): void {
  if (!Number.isSafeInteger(target.pid) || target.pid <= 0 ||
      target.pid > 2_147_483_647 || !Number.isSafeInteger(target.windowId) || target.windowId <= 0) {
    throw new Error("Visible-window capture target must contain positive safe integer pid and windowId values");
  }
}

function parseCaptureOutput(stdout: Uint8Array, expectedTarget: WindowsVisibleCaptureTarget): WindowsVisibleWindowCapture | undefined {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(stdout).trim();
  } catch {
    return undefined;
  }
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
  if (!isRecord(value) || !hasOnlyKeys(value, ["pid", "windowId", "x", "y", "width", "height", "pngBase64"])) return undefined;
  if (value.pid !== expectedTarget.pid || value.windowId !== expectedTarget.windowId ||
      !Number.isSafeInteger(value.x) || !Number.isSafeInteger(value.y) ||
      !Number.isSafeInteger(value.width) || !Number.isSafeInteger(value.height)) return undefined;
  const bounds = {
    x: value.x as number,
    y: value.y as number,
    width: value.width as number,
    height: value.height as number,
  };
  if (bounds.width <= 0 || bounds.height <= 0 || bounds.width > MAX_CAPTURE_EDGE || bounds.height > MAX_CAPTURE_EDGE ||
      bounds.width * bounds.height > MAX_CAPTURE_PIXELS || !Number.isSafeInteger(bounds.x + bounds.width) ||
      !Number.isSafeInteger(bounds.y + bounds.height) || typeof value.pngBase64 !== "string") return undefined;
  const base64 = value.pngBase64;
  if (base64.length === 0 || base64.length > Math.ceil(MAX_PNG_BYTES / 3) * 4 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(base64)) return undefined;
  const data = new Uint8Array(Buffer.from(base64, "base64"));
  if (data.byteLength === 0 || data.byteLength > MAX_PNG_BYTES || Buffer.from(data).toString("base64") !== base64) return undefined;
  const dimensions = readPngDimensions(data);
  if (dimensions === undefined || dimensions.width !== bounds.width || dimensions.height !== bounds.height || !hasPngEnd(data)) return undefined;
  return { target: { ...expectedTarget }, bounds, data };
}

function readPngDimensions(data: Uint8Array): { width: number; height: number } | undefined {
  if (data.byteLength < 24) return undefined;
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (!signature.every((value, index) => data[index] === value) ||
      data[12] !== 73 || data[13] !== 72 || data[14] !== 68 || data[15] !== 82) return undefined;
  const dimensions = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const width = dimensions.getUint32(16);
  const height = dimensions.getUint32(20);
  return width > 0 && height > 0 ? { width, height } : undefined;
}

function hasPngEnd(data: Uint8Array): boolean {
  const length = data.byteLength;
  return length >= 12 && data[length - 8] === 73 && data[length - 7] === 69 && data[length - 6] === 78 && data[length - 5] === 68;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const set = new Set(allowed);
  return Object.keys(value).every((key) => set.has(key));
}

function executeWindowsPowerShell(
  executablePath: string,
  args: readonly string[],
  options: WindowsVisibleCaptureExecutionOptions,
): Promise<WindowsVisibleCaptureExecutionResult> {
  options.signal.throwIfAborted();
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(executablePath, [...args], {
      cwd: options.temporaryDirectory,
      env: {
        SystemRoot: "C:\\Windows",
        WINDIR: "C:\\Windows",
        PATH: "C:\\Windows\\System32;C:\\Windows;C:\\Windows\\System32\\Wbem",
        TEMP: options.temporaryDirectory,
        TMP: options.temporaryDirectory,
      },
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const chunks: Buffer[] = [];
    let outputBytes = 0;
    let timedOut = false;
    let outputExceeded = false;
    let abortReason: unknown;
    let spawnError: Error | undefined;
    let processExited = false;
    let treeTermination: Promise<void> | undefined;
    let settled = false;
    const finishReject = (reason: unknown): void => {
      if (settled) return;
      settled = true;
      rejectPromise(reason);
    };
    const kill = (): void => {
      if (treeTermination !== undefined || processExited) return;
      if (child.pid === undefined) {
        try { child.kill(); } catch { /* child may not have started */ }
        return;
      }
      treeTermination = terminateWindowsProcessTree(child.pid, child);
    };
    const onAbort = (): void => {
      abortReason = options.signal.reason ?? createAbortError();
      kill();
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      kill();
    }, options.timeoutMs);
    options.signal.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      outputBytes += bytes.byteLength;
      if (outputBytes > options.maxOutputBytes) {
        outputExceeded = true;
        kill();
        return;
      }
      chunks.push(bytes);
    });
    child.once("error", (error) => { spawnError = error; });
    child.once("exit", () => { processExited = true; });
    child.once("close", (exitCode) => {
      clearTimeout(timeout);
      options.signal.removeEventListener("abort", onAbort);
      void (async () => {
        await treeTermination;
        if (abortReason !== undefined) {
          finishReject(abortReason);
        } else if (timedOut) {
          finishReject(new Error("Visible-window capture process timed out"));
        } else if (outputExceeded) {
          finishReject(new Error("Visible-window capture output exceeded its limit"));
        } else if (spawnError !== undefined) {
          finishReject(spawnError);
        } else {
          resolvePromise({ exitCode: exitCode ?? -1, stdout: Buffer.concat(chunks, outputBytes) });
        }
      })();
    });
    if (options.signal.aborted) onAbort();
  });
}

function terminateWindowsProcessTree(pid: number, child: ReturnType<typeof spawn>): Promise<void> {
  return new Promise((resolvePromise) => {
    let completed = false;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const finish = (): void => {
      if (completed) return;
      completed = true;
      if (deadline !== undefined) clearTimeout(deadline);
      resolvePromise();
    };
    const fallback = (): void => {
      try { child.kill(); } catch { /* child may have exited already */ }
      finish();
    };
    deadline = setTimeout(() => {
      try { taskkill.kill(); } catch { /* taskkill may have exited already */ }
      fallback();
    }, 1_000);
    const taskkill = spawn(TASKKILL_PATH, ["/PID", String(pid), "/T", "/F"], {
      env: {
        SystemRoot: "C:\\Windows",
        WINDIR: "C:\\Windows",
        PATH: "C:\\Windows\\System32;C:\\Windows",
      },
      windowsHide: true,
      stdio: ["ignore", "ignore", "ignore"],
    });
    taskkill.once("error", fallback);
    taskkill.once("close", (exitCode) => {
      if (exitCode !== 0) {
        try { child.kill(); } catch { /* child may have exited already */ }
      }
      finish();
    });
  });
}

function createAbortError(): Error {
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  return error;
}

const WINDOWS_VISIBLE_CAPTURE_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$source = @'
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;

public static class HarnessVisibleWindowCapture {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  public sealed class Result {
    public int pid { get; set; }
    public long windowId { get; set; }
    public int x { get; set; }
    public int y { get; set; }
    public int width { get; set; }
    public int height { get; set; }
    public string pngBase64 { get; set; }
  }
  private delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr extra);
  [DllImport("user32.dll")] private static extern bool IsWindow(IntPtr hwnd);
  [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] private static extern bool IsIconic(IntPtr hwnd);
  [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);
  [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
  [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr extra);
  [DllImport("user32.dll")] private static extern int GetSystemMetrics(int index);
  [DllImport("user32.dll")] private static extern IntPtr GetDC(IntPtr hwnd);
  [DllImport("user32.dll")] private static extern int ReleaseDC(IntPtr hwnd, IntPtr hdc);
  [DllImport("user32.dll")] private static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [DllImport("dwmapi.dll")] private static extern int DwmGetWindowAttribute(IntPtr hwnd, uint attribute, out RECT rect, int size);
  [DllImport("gdi32.dll", SetLastError=true)] private static extern bool BitBlt(IntPtr destination, int xDestination, int yDestination, int width, int height, IntPtr source, int xSource, int ySource, uint operation);
  [DllImport("user32.dll", EntryPoint="GetWindowLongW", SetLastError=true)] private static extern int GetWindowLong32(IntPtr hwnd, int index);
  [DllImport("user32.dll", EntryPoint="GetWindowLongPtrW", SetLastError=true)] private static extern IntPtr GetWindowLongPtr64(IntPtr hwnd, int index);
  [DllImport("user32.dll")] private static extern bool GetLayeredWindowAttributes(IntPtr hwnd, out uint colorKey, out byte alpha, out uint flags);
  [DllImport("kernel32.dll", EntryPoint="SetLastError")] private static extern void SetWin32LastError(uint errorCode);
  private const uint DWMWA_EXTENDED_FRAME_BOUNDS = 9;
  private const uint SRCCOPY = 0x00CC0020;
  private const uint CAPTUREBLT = 0x40000000;
  private const int SM_XVIRTUALSCREEN = 76;
  private const int SM_YVIRTUALSCREEN = 77;
  private const int SM_CXVIRTUALSCREEN = 78;
  private const int SM_CYVIRTUALSCREEN = 79;
  private const int GWL_EXSTYLE = -20;
  private const long WS_EX_LAYERED = 0x00080000L;
  private const uint LWA_ALPHA = 0x00000002;
  private const uint LWA_COLORKEY = 0x00000001;
  private const int MAX_EDGE = 8192;
  private const long MAX_PIXELS = 16777216;
  private const int MAX_PNG_BYTES = 16777216;
  public static Result Capture(int expectedPid, long expectedWindowId) {
    IntPtr hwnd = new IntPtr(expectedWindowId);
    IntPtr previousDpiContext = IntPtr.Zero;
    Result result = null;
    try {
      previousDpiContext = SetThreadDpiAwarenessContext(new IntPtr(-4));
      if (previousDpiContext == IntPtr.Zero) return null;
      RECT before;
      if (!TargetIsStable(hwnd, expectedPid, out before) || !TargetCaptureIsOpaque(hwnd) ||
          !HasNoForeignOccluder(hwnd, expectedPid, before)) return null;
      byte[] png = CaptureRect(before);
      if (png == null || png.Length == 0 || png.Length > MAX_PNG_BYTES) return null;
      RECT after;
      if (!TargetIsStable(hwnd, expectedPid, out after) || !SameRect(before, after) ||
          !TargetCaptureIsOpaque(hwnd) || !HasNoForeignOccluder(hwnd, expectedPid, after) ||
          GetForegroundWindow() != hwnd) return null;
      result = new Result {
        pid = expectedPid,
        windowId = expectedWindowId,
        x = before.Left,
        y = before.Top,
        width = before.Right - before.Left,
        height = before.Bottom - before.Top,
        pngBase64 = Convert.ToBase64String(png)
      };
    } catch { result = null; }
    finally {
      if (previousDpiContext != IntPtr.Zero) {
        try { if (SetThreadDpiAwarenessContext(previousDpiContext) == IntPtr.Zero) result = null; }
        catch { result = null; }
      }
    }
    return result;
  }

  private static bool TargetIsStable(IntPtr hwnd, int expectedPid, out RECT bounds) {
    bounds = new RECT();
    if (!IsWindow(hwnd) || !IsWindowVisible(hwnd) || IsIconic(hwnd) || GetForegroundWindow() != hwnd) return false;
    uint processId;
    if (GetWindowThreadProcessId(hwnd, out processId) == 0 || processId != unchecked((uint)expectedPid)) return false;
    if (DwmGetWindowAttribute(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, out bounds, Marshal.SizeOf(typeof(RECT))) != 0) return false;
    long width = (long)bounds.Right - bounds.Left;
    long height = (long)bounds.Bottom - bounds.Top;
    if (width <= 0 || height <= 0 || width > MAX_EDGE || height > MAX_EDGE || width * height > MAX_PIXELS) return false;
    int virtualLeft = GetSystemMetrics(SM_XVIRTUALSCREEN);
    int virtualTop = GetSystemMetrics(SM_YVIRTUALSCREEN);
    int virtualWidth = GetSystemMetrics(SM_CXVIRTUALSCREEN);
    int virtualHeight = GetSystemMetrics(SM_CYVIRTUALSCREEN);
    if (virtualWidth <= 0 || virtualHeight <= 0) return false;
    long virtualRight = (long)virtualLeft + virtualWidth;
    long virtualBottom = (long)virtualTop + virtualHeight;
    if (bounds.Left < virtualLeft || bounds.Top < virtualTop || bounds.Right > virtualRight || bounds.Bottom > virtualBottom) return false;
    return true;
  }

  private static bool HasNoForeignOccluder(IntPtr target, int expectedPid, RECT targetBounds) {
    bool foundTarget = false;
    bool blocked = false;
    bool queryFailed = false;
    try {
      EnumWindows(delegate(IntPtr hwnd, IntPtr extra) {
        if (hwnd == target) { foundTarget = true; return false; }
        try {
          if (!IsWindow(hwnd) || !IsWindowVisible(hwnd) || IsIconic(hwnd)) return true;
          uint processId;
          if (GetWindowThreadProcessId(hwnd, out processId) == 0 || processId == 0) { queryFailed = true; return false; }
          if (processId == unchecked((uint)expectedPid)) return true;
          RECT other;
          if (!GetWindowRect(hwnd, out other)) { queryFailed = true; return false; }
          if (!Intersects(targetBounds, other)) return true;
          bool transparencyQueryFailed;
          if (IsProvenFullyTransparentLayeredWindow(hwnd, out transparencyQueryFailed)) return true;
          if (transparencyQueryFailed) { queryFailed = true; return false; }
          blocked = true;
          return false;
        } catch { queryFailed = true; return false; }
      }, IntPtr.Zero);
    } catch { queryFailed = true; }
    return foundTarget && !blocked && !queryFailed;
  }

  private static IntPtr GetWindowLongPtr(IntPtr hwnd, int index) {
    if (IntPtr.Size == 8) return GetWindowLongPtr64(hwnd, index);
    return new IntPtr(GetWindowLong32(hwnd, index));
  }

  private static bool TryGetExtendedStyle(IntPtr hwnd, out IntPtr style) {
    style = IntPtr.Zero;
    try {
      SetWin32LastError(0);
      style = GetWindowLongPtr(hwnd, GWL_EXSTYLE);
      return style != IntPtr.Zero || Marshal.GetLastWin32Error() == 0;
    } catch { return false; }
  }

  private static bool TargetCaptureIsOpaque(IntPtr hwnd) {
    IntPtr style;
    if (!TryGetExtendedStyle(hwnd, out style)) return false;
    if ((style.ToInt64() & WS_EX_LAYERED) == 0) return true;
    uint colorKey;
    byte alpha;
    uint flags;
    try {
      if (!GetLayeredWindowAttributes(hwnd, out colorKey, out alpha, out flags)) return false;
    } catch { return false; }
    if ((flags & ~(LWA_ALPHA | LWA_COLORKEY)) != 0 || (flags & LWA_COLORKEY) != 0) return false;
    return (flags & LWA_ALPHA) != 0 && alpha == 255;
  }

  private static bool IsProvenFullyTransparentLayeredWindow(IntPtr hwnd, out bool queryFailed) {
    queryFailed = false;
    IntPtr style;
    if (!TryGetExtendedStyle(hwnd, out style)) { queryFailed = true; return false; }
    if ((style.ToInt64() & WS_EX_LAYERED) == 0) return false;
    uint colorKey;
    byte alpha;
    uint flags;
    try {
      if (!GetLayeredWindowAttributes(hwnd, out colorKey, out alpha, out flags)) { queryFailed = true; return false; }
    } catch { queryFailed = true; return false; }
    return (flags & LWA_ALPHA) != 0 && alpha == 0;
  }

  private static bool Intersects(RECT left, RECT right) {
    return left.Left < right.Right && right.Left < left.Right && left.Top < right.Bottom && right.Top < left.Bottom;
  }

  private static bool SameRect(RECT left, RECT right) {
    return left.Left == right.Left && left.Top == right.Top && left.Right == right.Right && left.Bottom == right.Bottom;
  }

  private static byte[] CaptureRect(RECT rect) {
    int width = rect.Right - rect.Left;
    int height = rect.Bottom - rect.Top;
    IntPtr screen = IntPtr.Zero;
    Graphics graphics = null;
    Bitmap bitmap = null;
    IntPtr destination = IntPtr.Zero;
    try {
      screen = GetDC(IntPtr.Zero);
      if (screen == IntPtr.Zero) return null;
      bitmap = new Bitmap(width, height, PixelFormat.Format24bppRgb);
      graphics = Graphics.FromImage(bitmap);
      graphics.Clear(Color.Black);
      destination = graphics.GetHdc();
      if (destination == IntPtr.Zero || !BitBlt(destination, 0, 0, width, height, screen, rect.Left, rect.Top, SRCCOPY | CAPTUREBLT)) return null;
      graphics.ReleaseHdc(destination);
      destination = IntPtr.Zero;
      using (MemoryStream stream = new MemoryStream()) {
        bitmap.Save(stream, ImageFormat.Png);
        if (stream.Length <= 0 || stream.Length > MAX_PNG_BYTES) return null;
        return stream.ToArray();
      }
    } catch { return null; }
    finally {
      if (graphics != null && destination != IntPtr.Zero) {
        try { graphics.ReleaseHdc(destination); } catch { }
      }
      if (graphics != null) graphics.Dispose();
      if (bitmap != null) bitmap.Dispose();
      if (screen != IntPtr.Zero) ReleaseDC(IntPtr.Zero, screen);
    }
  }
}
'@
$assemblyPath = Join-Path $env:TEMP 'harness-visible-window-capture.dll'
Add-Type -TypeDefinition $source -Language CSharp -ReferencedAssemblies @('System.dll', 'System.Core.dll', 'System.Drawing.dll') -OutputAssembly $assemblyPath | Out-Null
$assembly = [System.Reflection.Assembly]::LoadFrom($assemblyPath)
$captureType = $assembly.GetType('HarnessVisibleWindowCapture', $true)
$captureMethod = $captureType.GetMethod('Capture')
$captured = $captureMethod.Invoke($null, [object[]]@([int]__TARGET_PID__, [long]__TARGET_WINDOW_ID__))
if ($null -eq $captured) {
  [Console]::Out.WriteLine('null')
} else {
  [Console]::Out.WriteLine((ConvertTo-Json -InputObject $captured -Compress -Depth 3))
}
`;
