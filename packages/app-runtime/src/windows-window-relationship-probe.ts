import { spawn } from "node:child_process";
import { Buffer } from "node:buffer";
import type {
  WindowRelationshipProbe,
  WindowRelationshipProbeSnapshot,
  WindowRelationshipProbeWindow,
} from "@computer-harness/computer-cua";

export interface PowerShellProbeExecutionOptions {
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
}

export interface PowerShellProbeExecutionResult {
  readonly exitCode: number;
  readonly stdout: Uint8Array;
}

export type PowerShellProbeExecutor = (
  executablePath: string,
  args: readonly string[],
  options: PowerShellProbeExecutionOptions,
) => Promise<PowerShellProbeExecutionResult>;

export interface WindowsWindowRelationshipProbeOptions {
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  /** Test seam; production always spawns the fixed system Windows PowerShell executable. */
  readonly execute?: PowerShellProbeExecutor;
}

const POWERSHELL_PATH = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_OUTPUT_BYTES = 512 * 1024;
const MAX_WINDOW_ROWS = 2_048;

/**
 * Win32-only fallback for relationship metadata missing from CUA inventory.
 * Its embedded C# uses read-only EnumWindows/GetWindow/GetWindowThreadProcessId,
 * GetWindowRect/DwmGetWindowAttribute/IsWindowVisible/IsIconic/GetClassName
 * and GetForegroundWindow. Output bounds are DWM visible frame bounds only.
 * It never calls SetForegroundWindow, SendInput, GetWindowText, or any input API;
 * it does not collect title or UI text and emits only numeric fields and an
 * ASCII window class for the adapter's transient-child evidence policy.
 * Rectangle reads use a temporary per-thread PMv2 DPI context, restored even
 * on failure; unavailable/failed DPI APIs leave the snapshot incomplete.
 */
export function createWindowsWindowRelationshipProbe(
  options: WindowsWindowRelationshipProbeOptions = {},
): WindowRelationshipProbe {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30_000) {
    throw new Error("Window relationship probe timeout must be between 100 and 30000 ms");
  }
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1_024 || maxOutputBytes > 4 * 1024 * 1024) {
    throw new Error("Window relationship probe output limit must be between 1024 bytes and 4 MiB");
  }
  return {
    async read(signal) {
      signal.throwIfAborted();
      if (process.platform !== "win32" && options.execute === undefined) {
        throw new Error("Win32 window relationship probing is unavailable on this platform");
      }
      const execute = options.execute ?? executePowerShellProbe;
      const encodedScript = Buffer.from(POWERSHELL_PROBE_SCRIPT, "utf16le").toString("base64");
      const result = await execute(POWERSHELL_PATH, [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        encodedScript,
      ], { signal, timeoutMs, maxOutputBytes });
      signal.throwIfAborted();
      if (result.exitCode !== 0) throw new Error("Win32 window relationship probe exited unsuccessfully");
      if (result.stdout.byteLength > maxOutputBytes) throw new Error("Win32 window relationship probe output exceeded its limit");
      const bytes = Buffer.from(result.stdout);
      if (bytes.some((byte) => byte > 0x7f)) throw new Error("Win32 window relationship probe output was not ASCII-safe JSON");
      return parseWindowRelationshipProbeOutput(bytes.toString("utf8"), MAX_WINDOW_ROWS);
    },
  };
}

export function parseWindowRelationshipProbeOutput(
  output: string,
  maxWindowRows = MAX_WINDOW_ROWS,
): WindowRelationshipProbeSnapshot {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new Error("Win32 window relationship probe returned invalid JSON");
  }
  if (!isRecord(parsed) || !hasOnlyKeys(parsed, [
    "complete", "truncated", "source", "foregroundPid", "foregroundWindowId", "windows", "zOrderWindowIds",
  ]) || parsed.source !== "win32_relationship_probe" || typeof parsed.complete !== "boolean" ||
      (parsed.truncated !== undefined && typeof parsed.truncated !== "boolean") || !Array.isArray(parsed.windows) ||
      !Array.isArray(parsed.zOrderWindowIds)) {
    throw new Error("Win32 window relationship probe returned an invalid schema");
  }
  if (parsed.windows.length > maxWindowRows) throw new Error("Win32 window relationship probe returned too many windows");
  if (parsed.zOrderWindowIds.length > maxWindowRows) throw new Error("Win32 window relationship probe returned too many z-order handles");
  const foregroundPid = optionalPositiveInteger(parsed.foregroundPid);
  const foregroundWindowId = optionalPositiveInteger(parsed.foregroundWindowId);
  if ((foregroundPid === undefined) !== (foregroundWindowId === undefined) ||
      (parsed.foregroundPid !== undefined && parsed.foregroundPid !== null && foregroundPid === undefined) ||
      (parsed.foregroundWindowId !== undefined && parsed.foregroundWindowId !== null && foregroundWindowId === undefined)) {
    throw new Error("Win32 window relationship probe returned an invalid foreground identity");
  }
  const windows = parsed.windows.flatMap((value) => {
    const row = parseProbeWindow(value);
    return row === undefined ? [] : [row];
  });
  const zOrderWindowIds: number[] = [];
  const zOrderIds = new Set<number>();
  for (const value of parsed.zOrderWindowIds) {
    const windowId = positiveInteger(value);
    if (windowId === undefined || zOrderIds.has(windowId)) {
      throw new Error("Win32 window relationship probe returned an invalid z-order chain");
    }
    zOrderIds.add(windowId);
    zOrderWindowIds.push(windowId);
  }
  const zIndexByWindowId = new Map(zOrderWindowIds.map((windowId, index) => [windowId, zOrderWindowIds.length - index]));
  const windowsWithZOrder = windows.map((window) => {
    const zIndex = zIndexByWindowId.get(window.windowId);
    return zIndex === undefined ? window : { ...window, zIndex };
  });
  const seen = new Set<string>();
  for (const window of windowsWithZOrder) {
    const key = `${window.pid}:${window.windowId}`;
    if (seen.has(key)) throw new Error("Win32 window relationship probe returned duplicate HWND identities");
    seen.add(key);
  }
  const truncated = parsed.truncated === true;
  return {
    complete: parsed.complete === true && !truncated && windowsWithZOrder.every((window) => window.zIndex !== undefined),
    ...(parsed.truncated === undefined ? {} : { truncated }),
    source: "win32_relationship_probe",
    windows: windowsWithZOrder,
    ...(foregroundPid === undefined ? {} : { foregroundPid }),
    ...(foregroundWindowId === undefined ? {} : { foregroundWindowId }),
  };
}

function parseProbeWindow(value: unknown): WindowRelationshipProbeWindow | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    "pid", "windowId", "ownerPid", "ownerWindowId", "isOnScreen", "minimized", "bounds", "windowClass",
  ])) {
    throw new Error("Win32 window relationship probe returned an invalid window row");
  }
  const pid = positiveInteger(value.pid);
  const windowId = positiveInteger(value.windowId);
  const ownerPid = optionalOwnerId(value.ownerPid);
  const ownerWindowId = optionalOwnerId(value.ownerWindowId);
  const bounds = parseBounds(value.bounds);
  if (pid === undefined || windowId === undefined || typeof value.isOnScreen !== "boolean" ||
      typeof value.minimized !== "boolean" || bounds === undefined ||
      (value.ownerPid !== null && value.ownerPid !== undefined && ownerPid === undefined) ||
      (value.ownerWindowId !== null && value.ownerWindowId !== undefined && ownerWindowId === undefined) ||
      ((ownerPid === undefined) !== (ownerWindowId === undefined)) ||
      (ownerPid !== undefined && ownerWindowId !== undefined && ((ownerPid === 0) !== (ownerWindowId === 0))) ||
      (value.windowClass !== null && value.windowClass !== undefined && !isAsciiClass(value.windowClass))) {
    throw new Error("Win32 window relationship probe returned an invalid window row");
  }
  if (bounds === "zero_size") return undefined;
  return {
    pid,
    windowId,
    ...(ownerPid === undefined ? {} : { ownerPid }),
    ...(ownerWindowId === undefined ? {} : { ownerWindowId }),
    isOnScreen: value.isOnScreen,
    minimized: value.minimized,
    bounds,
    ...(typeof value.windowClass === "string" ? { windowClass: value.windowClass } : {}),
  };
}

function parseBounds(value: unknown): { x: number; y: number; width: number; height: number } | "zero_size" | undefined {
  if (!isRecord(value) || !Number.isSafeInteger(value.x) || !Number.isSafeInteger(value.y) ||
      !Number.isSafeInteger(value.width) || !Number.isSafeInteger(value.height) ||
      Number(value.width) < 0 || Number(value.height) < 0) return undefined;
  const width = isRecord(value) ? positiveInteger(value.width) : undefined;
  const height = isRecord(value) ? positiveInteger(value.height) : undefined;
  if (Number(value.width) === 0 || Number(value.height) === 0) return "zero_size";
  if (width === undefined || height === undefined) return undefined;
  return { x: value.x as number, y: value.y as number, width, height };
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function optionalPositiveInteger(value: unknown): number | undefined {
  return value === null || value === undefined ? undefined : positiveInteger(value);
}

function optionalOwnerId(value: unknown): number | undefined {
  return value === null || value === undefined ? undefined :
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function optionalInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
}

function isAsciiClass(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128 && /^[\x20-\x7e]+$/u.test(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedSet = new Set(allowed);
  return Object.keys(value).every((key) => allowedSet.has(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const POWERSHELL_PROBE_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$source = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class HarnessReadOnlyWindowProbe {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  public sealed class Row {
    public int pid { get; set; }
    public long windowId { get; set; }
    public int ownerPid { get; set; }
    public long ownerWindowId { get; set; }
    public bool isOnScreen { get; set; }
    public bool minimized { get; set; }
    public object bounds { get; set; }
    public string windowClass { get; set; }
  }
  [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr extra);
  [DllImport("user32.dll")] private static extern IntPtr GetWindow(IntPtr hwnd, uint command);
  [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);
  [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
  [DllImport("dwmapi.dll")] private static extern int DwmGetWindowAttribute(IntPtr hwnd, uint attribute, out RECT rect, int size);
  [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] private static extern bool IsIconic(IntPtr hwnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetClassName(IntPtr hwnd, StringBuilder name, int maxCount);
  [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] private static extern int GetSystemMetrics(int index);
  [DllImport("user32.dll")] private static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  private const uint GW_OWNER = 4;
  private const uint GW_HWNDFIRST = 0;
  private const uint GW_HWNDNEXT = 2;
  private const uint DWMWA_EXTENDED_FRAME_BOUNDS = 9;
  private const int MAX_ENUMERATED_WINDOWS = 2048;
  private static bool complete;
  private static List<Row> rows;
  private static List<IntPtr> enumeratedHandles;
  private static HashSet<IntPtr> enumeratedHandleSet;
  private static List<long> zOrderWindowIds;
  private delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr extra);
  public static bool Complete { get { return complete; } }
  public static long[] ZOrderWindowIds { get { return zOrderWindowIds.ToArray(); } }
  public static object[] ReadWindows() {
    complete = true;
    rows = new List<Row>();
    enumeratedHandles = new List<IntPtr>();
    enumeratedHandleSet = new HashSet<IntPtr>();
    zOrderWindowIds = new List<long>();
    IntPtr previousDpiContext = IntPtr.Zero;
    try {
      previousDpiContext = SetThreadDpiAwarenessContext(new IntPtr(-4));
      if (previousDpiContext == IntPtr.Zero) { complete = false; return rows.ToArray(); }
      ReadWindowsInPhysicalCoordinates();
    } catch { complete = false; }
    finally {
      if (previousDpiContext != IntPtr.Zero) {
        try {
          if (SetThreadDpiAwarenessContext(previousDpiContext) == IntPtr.Zero) complete = false;
        } catch { complete = false; }
      }
    }
    return rows.ToArray();
  }
  private static void ReadWindowsInPhysicalCoordinates() {
    bool enumerated = EnumWindows(delegate(IntPtr hwnd, IntPtr extra) {
      try {
        if (!enumeratedHandleSet.Add(hwnd)) { complete = false; return true; }
        if (enumeratedHandles.Count >= MAX_ENUMERATED_WINDOWS) { complete = false; return false; }
        enumeratedHandles.Add(hwnd);
        uint pid;
        if (GetWindowThreadProcessId(hwnd, out pid) == 0 || pid == 0) { complete = false; return true; }
        RECT outerRect;
        if (!GetWindowRect(hwnd, out outerRect)) { complete = false; return true; }
        long outerWidth = (long)outerRect.Right - outerRect.Left;
        long outerHeight = (long)outerRect.Bottom - outerRect.Top;
        if (outerWidth < 0 || outerHeight < 0) { complete = false; return true; }
        // A successfully measured zero-area HWND cannot receive interaction
        // or occlude another window; omit it from relationship rows without
        // treating it as a failed enumeration.
        if (outerWidth == 0 || outerHeight == 0) return true;
        // GetWindowRect may include invisible resize borders. Only the DWM
        // visible frame can match CUA capture geometry for admission evidence.
        RECT rect;
        if (DwmGetWindowAttribute(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, out rect, Marshal.SizeOf(typeof(RECT))) != 0) { complete = false; return true; }
        long frameWidth = (long)rect.Right - rect.Left;
        long frameHeight = (long)rect.Bottom - rect.Top;
        if (frameWidth <= 0 || frameHeight <= 0 || frameWidth > Int32.MaxValue || frameHeight > Int32.MaxValue) { complete = false; return true; }
        int width = (int)frameWidth;
        int height = (int)frameHeight;
        bool minimized = IsIconic(hwnd);
        IntPtr ownerHwnd = GetWindow(hwnd, GW_OWNER);
        int ownerPid = 0;
        long ownerWindowId = 0;
        if (ownerHwnd != IntPtr.Zero) {
          uint ownerProcessId;
          if (GetWindowThreadProcessId(ownerHwnd, out ownerProcessId) == 0 || ownerProcessId == 0) { complete = false; return true; }
          ownerPid = unchecked((int)ownerProcessId);
          ownerWindowId = ownerHwnd.ToInt64();
        }
        StringBuilder className = new StringBuilder(256);
        int classLength = GetClassName(hwnd, className, className.Capacity);
        if (classLength <= 0) { complete = false; return true; }
        string windowClass = classLength > 0 ? className.ToString() : null;
        if (windowClass != null) {
          foreach (char character in windowClass) {
            if (character < 0x20 || character > 0x7e) { windowClass = null; break; }
          }
        }
        int virtualLeft = GetSystemMetrics(76);
        int virtualTop = GetSystemMetrics(77);
        int virtualWidth = GetSystemMetrics(78);
        int virtualHeight = GetSystemMetrics(79);
        if (virtualWidth <= 0 || virtualHeight <= 0) { complete = false; return true; }
        bool intersectsDesktop = rect.Right > virtualLeft && rect.Left < virtualLeft + virtualWidth &&
          rect.Bottom > virtualTop && rect.Top < virtualTop + virtualHeight;
        rows.Add(new Row {
          pid = unchecked((int)pid),
          windowId = hwnd.ToInt64(),
          ownerPid = ownerPid,
          ownerWindowId = ownerWindowId,
          isOnScreen = IsWindowVisible(hwnd) && !minimized && intersectsDesktop,
          minimized = minimized,
          bounds = new { x = rect.Left, y = rect.Top, width = width, height = height },
          windowClass = windowClass
        });
        return true;
      } catch { complete = false; return true; }
    }, IntPtr.Zero);
    if (!enumerated) complete = false;
    ReadZOrder();
  }
  private static void ReadZOrder() {
    zOrderWindowIds = new List<long>();
    if (enumeratedHandles.Count == 0) return;
    IntPtr current = GetWindow(enumeratedHandles[0], GW_HWNDFIRST);
    HashSet<IntPtr> visited = new HashSet<IntPtr>();
    while (current != IntPtr.Zero && zOrderWindowIds.Count < MAX_ENUMERATED_WINDOWS) {
      if (!visited.Add(current)) { complete = false; return; }
      if (!enumeratedHandleSet.Contains(current)) complete = false;
      zOrderWindowIds.Add(current.ToInt64());
      current = GetWindow(current, GW_HWNDNEXT);
    }
    if (current != IntPtr.Zero || visited.Count != enumeratedHandles.Count) complete = false;
  }
  public static object ReadForeground() {
    IntPtr hwnd = GetForegroundWindow();
    if (hwnd == IntPtr.Zero) return null;
    uint pid;
    if (GetWindowThreadProcessId(hwnd, out pid) == 0 || pid == 0) { complete = false; return null; }
    return new { foregroundPid = unchecked((int)pid), foregroundWindowId = hwnd.ToInt64() };
  }
}
'@
Add-Type -TypeDefinition $source -Language CSharp
$windows = [HarnessReadOnlyWindowProbe]::ReadWindows()
$zOrderWindowIds = [HarnessReadOnlyWindowProbe]::ZOrderWindowIds
$foreground = [HarnessReadOnlyWindowProbe]::ReadForeground()
$foregroundPid = $null
$foregroundWindowId = $null
if ($null -ne $foreground) { $foregroundPid = $foreground.foregroundPid; $foregroundWindowId = $foreground.foregroundWindowId }
$payload = [ordered]@{
  complete = [HarnessReadOnlyWindowProbe]::Complete
  truncated = $false
  source = 'win32_relationship_probe'
  foregroundPid = $foregroundPid
  foregroundWindowId = $foregroundWindowId
  zOrderWindowIds = $zOrderWindowIds
  windows = $windows
}
ConvertTo-Json -InputObject $payload -Depth 5 -Compress
`;

async function executePowerShellProbe(
  executablePath: string,
  args: readonly string[],
  options: PowerShellProbeExecutionOptions,
): Promise<PowerShellProbeExecutionResult> {
  options.signal.throwIfAborted();
  return await new Promise<PowerShellProbeExecutionResult>((resolve, reject) => {
    const child = spawn(executablePath, [...args], { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    const chunks: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;
    let timedOut = false;
    let exceededLimit = false;
    const finish = (error?: Error, result?: PowerShellProbeExecutionResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal.removeEventListener("abort", onAbort);
      if (error !== undefined) reject(error);
      else resolve(result!);
    };
    const onAbort = () => {
      child.kill();
      finish(options.signal.reason instanceof Error ? options.signal.reason : new Error("Window relationship probe aborted"));
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
      finish(new Error("Win32 window relationship probe timed out"));
    }, options.timeoutMs);
    options.signal.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      outputBytes += chunk.byteLength;
      if (outputBytes > options.maxOutputBytes) {
        exceededLimit = true;
        child.kill();
        finish(new Error("Win32 window relationship probe output exceeded its limit"));
        return;
      }
      chunks.push(Buffer.from(chunk));
    });
    child.on("error", () => finish(new Error("Failed to start the read-only Win32 window relationship probe")));
    child.on("close", (exitCode) => {
      if (timedOut) return finish(new Error("Win32 window relationship probe timed out"));
      if (exceededLimit) return finish(new Error("Win32 window relationship probe output exceeded its limit"));
      finish(undefined, { exitCode: exitCode ?? -1, stdout: Buffer.concat(chunks) });
    });
    if (options.signal.aborted) onAbort();
  });
}
