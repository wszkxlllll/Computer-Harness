import { execFile as execFileCallback } from "node:child_process";
import { lstat, mkdir, readFile, readdir, realpath, rename } from "node:fs/promises";
import { isAbsolute, posix, relative, resolve, sep, win32 } from "node:path";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";

const execFile = promisify(execFileCallback);
const PROFILE_LOCK = ".computer-harness-profile.lock";
const DEVTOOLS_PORT = "DevToolsActivePort";

export type ManagedBrowserProfileState = "ready" | "active" | "stale" | "unknown" | "unsafe";
export type ManagedBrowserProfileMarker = "profile_lock" | "devtools_port";

export interface ManagedBrowserProfileInspection {
  readonly state: ManagedBrowserProfileState;
  readonly markers: readonly ManagedBrowserProfileMarker[];
}

export interface ManagedBrowserProfileRecoveryResult {
  readonly archivedMarkers: readonly ManagedBrowserProfileMarker[];
  /** Opaque local archive identifier; no filesystem path or file content. */
  readonly archiveId: string;
}

export interface ManagedBrowserProfileRecoveryDependencies {
  /** Undefined means process inventory failed and recovery must fail closed. */
  readonly findProcessesUsingProfile?: (profileRoot: string) => Promise<readonly number[] | undefined>;
  readonly now?: () => number;
  readonly renameMarker?: (source: string, destination: string) => Promise<void>;
}

/**
 * Read only the two Harness/Chromium runtime marker names. Never inspect
 * cookies, browser databases, preferences, or other user profile contents.
 */
export async function inspectManagedBrowserProfile(
  profilesRoot: string,
  profileLabel: string,
  dependencies: ManagedBrowserProfileRecoveryDependencies = {},
): Promise<ManagedBrowserProfileInspection> {
  const locations = await resolveProfileLocations(profilesRoot, profileLabel);
  if (locations === undefined) return { state: "ready", markers: [] };

  const markers: ManagedBrowserProfileMarker[] = [];
  for (const [name, kind] of [[PROFILE_LOCK, "profile_lock"], [DEVTOOLS_PORT, "devtools_port"]] as const) {
    const entry = await inspectRegularMarker(locations.profileRoot, name);
    if (entry === "unsafe") return { state: "unsafe", markers };
    if (entry === "present") markers.push(kind);
  }

  const findProcesses = dependencies.findProcessesUsingProfile ?? findProcessesUsingProfile;
  const processes = await findProcesses(locations.profileRoot);
  if (processes === undefined) return { state: "unknown", markers };
  if (processes.some((pid) => Number.isSafeInteger(pid) && pid > 0)) return { state: "active", markers };
  return markers.includes("profile_lock") ? { state: "stale", markers } : { state: "ready", markers };
}

/**
 * Archive stale lock/DevTools markers only after process inventory proves no
 * process references the exact Harness-owned profile. Profile data remains
 * untouched, and unknown/active/unsafe states fail closed.
 */
export async function recoverStaleManagedBrowserProfile(
  profilesRoot: string,
  profileLabel: string,
  dependencies: ManagedBrowserProfileRecoveryDependencies = {},
): Promise<ManagedBrowserProfileRecoveryResult> {
  const inspection = await inspectManagedBrowserProfile(profilesRoot, profileLabel, dependencies);
  if (inspection.state !== "stale") {
    throw new Error(recoveryError(inspection.state));
  }
  const locations = await resolveProfileLocations(profilesRoot, profileLabel);
  if (locations === undefined) throw new Error("managed browser profile disappeared before recovery");

  const archiveId = `recovery-${(dependencies.now ?? Date.now)()}-${randomUUID().slice(0, 8)}`;
  const archiveRoot = resolve(locations.profileRoot, archiveId);
  if (!isContained(locations.profileRoot, archiveRoot)) throw new Error("managed browser recovery archive escaped its profile");
  await mkdir(archiveRoot, { mode: 0o700 });

  const archivedMarkers: ManagedBrowserProfileMarker[] = [];
  // Move the non-authoritative port marker first and the profile lock last.
  // A partial failure therefore leaves the lock in place, so retry remains
  // available instead of making an incomplete archive look clean.
  for (const [name, kind] of [[DEVTOOLS_PORT, "devtools_port"], [PROFILE_LOCK, "profile_lock"]] as const) {
    const source = resolve(locations.profileRoot, name);
    const destination = resolve(archiveRoot, name);
    if (!isContained(locations.profileRoot, source) || !isContained(archiveRoot, destination)) {
      throw new Error("managed browser recovery path escaped its profile");
    }
    const entry = await inspectRegularMarker(locations.profileRoot, name);
    if (entry === "unsafe") throw new Error("managed browser runtime marker is not a regular file");
    if (entry === "missing") continue;
    await (dependencies.renameMarker ?? rename)(source, destination);
    archivedMarkers.push(kind);
  }
  if (archivedMarkers.length === 0) throw new Error("managed browser runtime markers changed before recovery");
  return { archivedMarkers, archiveId };
}

async function resolveProfileLocations(profilesRoot: string, profileLabel: string): Promise<{ profilesRoot: string; profileRoot: string } | undefined> {
  if (!/^[A-Za-z0-9._-]{1,64}$/u.test(profileLabel)) throw new Error("managed browser profile label is invalid");
  if (!isAbsolute(profilesRoot)) throw new Error("managed browser profile root must be absolute");
  const root = resolve(profilesRoot);
  const profileRoot = resolve(root, profileLabel);
  if (!isContained(root, profileRoot) || profileRoot === root) throw new Error("managed browser profile escaped its Harness-owned root");

  const rootInfo = await lstatOrMissing(root);
  if (rootInfo === undefined) return undefined;
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) throw new Error("managed browser profile root is not a regular directory");
  const realRoot = resolve(await realpath(root));
  if (!sameManagedBrowserProfilePath(realRoot, root)) throw new Error("managed browser profile root resolves through a reparse point");

  const profileInfo = await lstatOrMissing(profileRoot);
  if (profileInfo === undefined) return undefined;
  if (profileInfo.isSymbolicLink() || !profileInfo.isDirectory()) throw new Error("managed browser profile is not a regular directory");
  const realProfile = resolve(await realpath(profileRoot));
  if (!isContained(realRoot, realProfile) || !sameManagedBrowserProfilePath(realProfile, profileRoot)) throw new Error("managed browser profile resolves outside its Harness-owned root");
  return { profilesRoot: root, profileRoot };
}

async function inspectRegularMarker(profileRoot: string, name: string): Promise<"missing" | "present" | "unsafe"> {
  const marker = resolve(profileRoot, name);
  if (!isContained(profileRoot, marker)) return "unsafe";
  const metadata = await lstatOrMissing(marker);
  if (metadata === undefined) return "missing";
  return metadata.isFile() && !metadata.isSymbolicLink() ? "present" : "unsafe";
}

async function lstatOrMissing(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return undefined;
    throw error;
  }
}

function isContained(parent: string, candidate: string): boolean {
  const child = relative(parent, candidate);
  return child === "" || child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

/** Match a complete Chromium --user-data-dir argument, never a substring. */
export function commandLineReferencesManagedBrowserProfile(
  commandLine: string,
  profileRoot: string,
  osPlatform: NodeJS.Platform = process.platform,
): boolean {
  if (canonicalProfilePath(profileRoot, osPlatform) === undefined) return false;
  const option = "--user-data-dir";
  let searchFrom = 0;
  while (searchFrom < commandLine.length) {
    const optionAt = commandLine.toLocaleLowerCase().indexOf(option, searchFrom);
    if (optionAt < 0) return false;
    searchFrom = optionAt + option.length;
    const before = commandLine[optionAt - 1];
    if (before !== undefined && !/\s/u.test(before) && before !== '"' && before !== "'") continue;
    let valueAt = searchFrom;
    const separator = commandLine[valueAt];
    if (separator === "=") valueAt += 1;
    else if (separator !== undefined && /\s/u.test(separator)) {
      while (valueAt < commandLine.length && /\s/u.test(commandLine[valueAt]!)) valueAt += 1;
    } else {
      continue;
    }
    const valueQuote = commandLine[valueAt] === '"' || commandLine[valueAt] === "'" ? commandLine[valueAt]! : undefined;
    let candidateText: string;
    if (valueQuote !== undefined) {
      const end = commandLine.indexOf(valueQuote, valueAt + 1);
      if (end < 0) continue;
      candidateText = commandLine.slice(valueAt + 1, end);
    } else {
      let end = commandLine.length;
      if (before === '"' || before === "'") {
        const outerQuoteEnd = commandLine.indexOf(before, valueAt);
        if (outerQuoteEnd >= 0) end = outerQuoteEnd;
      } else {
        const nextSpace = commandLine.slice(valueAt).search(/\s/u);
        if (nextSpace >= 0) end = valueAt + nextSpace;
      }
      candidateText = commandLine.slice(valueAt, end);
    }
    if (sameManagedBrowserProfilePath(candidateText, profileRoot, osPlatform)) {
      return true;
    }
  }
  return false;
}

/** Exact argv matching for Linux /proc (NUL-delimited arguments preserve paths with spaces). */
export function argvReferencesManagedBrowserProfile(
  argv: readonly string[],
  profileRoot: string,
  osPlatform: NodeJS.Platform = process.platform,
): boolean {
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument.startsWith("--user-data-dir=")) {
      if (sameManagedBrowserProfilePath(argument.slice("--user-data-dir=".length), profileRoot, osPlatform)) return true;
    } else if (argument === "--user-data-dir" && argv[index + 1] !== undefined &&
        sameManagedBrowserProfilePath(argv[index + 1]!, profileRoot, osPlatform)) {
      return true;
    }
  }
  return false;
}

function normalizedPathText(value: string, osPlatform: NodeJS.Platform): string {
  const pathApi = osPlatform === "win32" ? win32 : posix;
  if (!pathApi.isAbsolute(value)) return "";
  let normalized = pathApi.normalize(value);
  const root = pathApi.parse(normalized).root;
  while (normalized.length > root.length && (normalized.endsWith("/") || normalized.endsWith("\\"))) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
}

function canonicalProfilePath(value: string, osPlatform: NodeJS.Platform): string | undefined {
  const normalized = normalizedPathText(value, osPlatform);
  if (normalized.length === 0) return undefined;
  return osPlatform === "win32" ? normalized.toLocaleLowerCase("en-US") : normalized;
}

export function sameManagedBrowserProfilePath(left: string, right: string, osPlatform: NodeJS.Platform = process.platform): boolean {
  const canonicalLeft = canonicalProfilePath(left, osPlatform);
  const canonicalRight = canonicalProfilePath(right, osPlatform);
  return canonicalLeft !== undefined && canonicalLeft === canonicalRight;
}

async function findProcessesUsingProfile(profileRoot: string): Promise<readonly number[] | undefined> {
  try {
    if (process.platform === "win32") {
      // Return command lines only to this process for exact argument parsing;
      // neither command lines nor URLs are logged or persisted.
      const script = "[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); $OutputEncoding=[System.Text.UTF8Encoding]::new($false); Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine -match '--user-data-dir(?:=|\\s)' } | ForEach-Object { '{0}{1}{2}' -f $_.ProcessId, [char]9, $_.CommandLine }";
      const result = await execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
        windowsHide: true,
        timeout: 2_500,
      });
      return matchingPidsFromInventory(String(result.stdout), profileRoot, "win32");
    }
    if (process.platform === "linux") return await findLinuxProcessesUsingProfile(profileRoot);
    // macOS `ps` exposes a flattened command-line string rather than the
    // original argv boundaries. A profile path containing spaces can therefore
    // be split or joined ambiguously, so never infer ownership from this
    // inventory. Callers may still inject a verified inventory dependency when
    // the host has a boundary-preserving process API.
    if (process.platform === "darwin") return undefined;
    return undefined;
  } catch {
    return undefined;
  }
}

async function findLinuxProcessesUsingProfile(profileRoot: string): Promise<readonly number[] | undefined> {
  if (typeof process.getuid !== "function") return undefined;
  const currentUid = String(process.getuid());
  const entries = await readdir("/proc");
  const owners: number[] = [];
  for (const entry of entries) {
    if (!/^\d+$/u.test(entry)) continue;
    const processRoot = `/proc/${entry}`;
    let status: string;
    try {
      status = await readFile(`${processRoot}/status`, "utf8");
    } catch (error) {
      if (isRecord(error) && (error.code === "ENOENT" || error.code === "ESRCH")) continue;
      if (isRecord(error) && error.code === "EACCES") return undefined;
      return undefined;
    }
    const uidLine = status.split(/\r?\n/u).find((line) => line.startsWith("Uid:"));
    const realUid = uidLine?.trim().split(/\s+/u)[1];
    if (realUid !== currentUid) continue;

    let rawArguments: Buffer;
    try {
      rawArguments = await readFile(`${processRoot}/cmdline`);
    } catch (error) {
      if (isRecord(error) && (error.code === "ENOENT" || error.code === "ESRCH")) continue;
      return undefined;
    }
    const argv = rawArguments.toString("utf8").split("\u0000").filter((argument) => argument.length > 0);
    if (argvReferencesManagedBrowserProfile(argv, profileRoot, "linux")) owners.push(Number(entry));
  }
  return owners;
}

export function matchingPidsFromInventory(
  inventory: string,
  profileRoot: string,
  osPlatform: NodeJS.Platform,
): number[] | undefined {
  // This parser consumes a tab-delimited PID + flattened command line. It is
  // safe for the Windows CIM producer used above, but not for Darwin `ps`:
  // `ps` does not preserve argv boundaries, so a path with spaces cannot be
  // matched safely. Keep this helper fail-closed even if a future caller tries
  // to reuse it for Darwin output.
  if (osPlatform === "darwin") return undefined;
  const pids: number[] = [];
  for (const line of inventory.split(/\r?\n/u)) {
    if (line.trim().length === 0) continue;
    const match = line.match(/^\s*(\d+)(?:(?:\t|\s+)(.*))?$/u);
    if (match === null) return undefined;
    const pid = Number(match[1]);
    if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
    if (match[2] !== undefined && commandLineReferencesManagedBrowserProfile(match[2], profileRoot, osPlatform)) pids.push(pid);
  }
  return pids;
}

function recoveryError(state: ManagedBrowserProfileState): string {
  if (state === "active") return "A process is still using the managed browser profile; close that browser and stop its Host before recovery.";
  if (state === "unknown") return "Could not verify managed browser processes; recovery was refused.";
  if (state === "unsafe") return "Managed browser profile contains an unsafe path or marker; recovery was refused.";
  return "Managed browser profile has no stale runtime markers to recover.";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
