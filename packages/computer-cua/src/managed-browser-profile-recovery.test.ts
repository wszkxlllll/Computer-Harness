import { describe, expect, it } from "vitest";
import { lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { argvReferencesManagedBrowserProfile, commandLineReferencesManagedBrowserProfile, inspectManagedBrowserProfile, matchingPidsFromInventory, recoverStaleManagedBrowserProfile, sameManagedBrowserProfilePath } from "./managed-browser-profile-recovery.js";

// GitHub's Windows runner temp directory may be a reparse point. Production
// must reject such a profile root, so these tests create their fixtures under
// a repository-controlled directory whose real path is checked before use.
const testRootBase = resolve(fileURLToPath(new URL("../../../.test-tmp/managed-browser-profile-recovery/", import.meta.url)));

async function mkdtempFixture(prefix: string): Promise<string> {
  await mkdir(testRootBase, { recursive: true });
  const metadata = await lstat(testRootBase);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("managed-browser recovery test root is not a regular directory");
  const resolvedBase = await realpath(testRootBase);
  if (!sameManagedBrowserProfilePath(resolvedBase, testRootBase, process.platform)) {
    throw new Error("managed-browser recovery test root resolves through a reparse point");
  }
  return mkdtemp(join(testRootBase, prefix));
}

describe("managed browser stale profile recovery", () => {
  it("refuses recovery while a process uses the exact profile and leaves markers untouched", async () => {
    const root = await mkdtempFixture("harness-profile-active-");
    const profile = join(root, "travel");
    await mkdir(profile);
    await writeFile(join(profile, ".computer-harness-profile.lock"), "", "utf8");
    try {
      await expect(recoverStaleManagedBrowserProfile(root, "travel", {
        findProcessesUsingProfile: async () => [1234],
      })).rejects.toThrow(/still using/iu);
      await expect(lstat(join(profile, ".computer-harness-profile.lock"))).resolves.toBeDefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("archives only stale runtime markers and leaves browser login data untouched", async () => {
    const root = await mkdtempFixture("harness-profile-recover-");
    const profile = join(root, "travel");
    await mkdir(profile);
    await writeFile(join(profile, ".computer-harness-profile.lock"), "stale-lock-marker", "utf8");
    await writeFile(join(profile, "DevToolsActivePort"), "9222\n/devtools/browser/private", "utf8");
    await writeFile(join(profile, "Cookies"), "user-login-state", "utf8");
    try {
      const result = await recoverStaleManagedBrowserProfile(root, "travel", {
        findProcessesUsingProfile: async () => [],
        now: () => 123,
      });
      expect(result.archiveId).toMatch(/^recovery-123-/u);
      expect(result.archivedMarkers).toEqual(["devtools_port", "profile_lock"]);
      await expect(readFile(join(profile, "Cookies"), "utf8")).resolves.toBe("user-login-state");
      await expect(readFile(join(profile, result.archiveId, ".computer-harness-profile.lock"), "utf8")).resolves.toBe("stale-lock-marker");
      await expect(readFile(join(profile, result.archiveId, "DevToolsActivePort"), "utf8")).resolves.toBe("9222\n/devtools/browser/private");
      await expect(lstat(join(profile, ".computer-harness-profile.lock"))).rejects.toThrow();
      await expect(lstat(join(profile, "DevToolsActivePort"))).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("leaves the profile lock in place after a partial archive so recovery can retry", async () => {
    const root = await mkdtempFixture("harness-profile-partial-recovery-");
    const profile = join(root, "travel");
    await mkdir(profile);
    await writeFile(join(profile, ".computer-harness-profile.lock"), "stale-lock", "utf8");
    await writeFile(join(profile, "DevToolsActivePort"), "9222\n", "utf8");
    let archivedPort = "";
    try {
      await expect(recoverStaleManagedBrowserProfile(root, "travel", {
        findProcessesUsingProfile: async () => [],
        renameMarker: async (source, destination) => {
          if (source.endsWith(".computer-harness-profile.lock")) throw new Error("fixture lock archive failure");
          archivedPort = destination;
          await rename(source, destination);
        },
      })).rejects.toThrow(/fixture lock archive failure/iu);
      await expect(lstat(join(profile, ".computer-harness-profile.lock"))).resolves.toBeDefined();
      await expect(lstat(join(profile, "DevToolsActivePort"))).rejects.toThrow();
      await expect(readFile(archivedPort, "utf8")).resolves.toBe("9222\n");

      const retry = await recoverStaleManagedBrowserProfile(root, "travel", {
        findProcessesUsingProfile: async () => [],
      });
      expect(retry.archivedMarkers).toEqual(["profile_lock"]);
      await expect(readFile(join(profile, retry.archiveId, ".computer-harness-profile.lock"), "utf8")).resolves.toBe("stale-lock");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses recovery when process inventory is unavailable", async () => {
    const root = await mkdtempFixture("harness-profile-unknown-");
    const profile = join(root, "travel");
    await mkdir(profile);
    await writeFile(join(profile, ".computer-harness-profile.lock"), "", "utf8");
    try {
      await expect(recoverStaleManagedBrowserProfile(root, "travel", {
        findProcessesUsingProfile: async () => undefined,
      })).rejects.toThrow(/Could not verify/iu);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("allows a leftover DevToolsActivePort when no profile lock or owner remains", async () => {
    const root = await mkdtempFixture("harness-profile-port-only-");
    const profile = join(root, "travel");
    await mkdir(profile);
    await writeFile(join(profile, "DevToolsActivePort"), "9222\n", "utf8");
    try {
      await expect(inspectManagedBrowserProfile(root, "travel", {
        findProcessesUsingProfile: async () => [],
      })).resolves.toEqual({ state: "ready", markers: ["devtools_port"] });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("matches only an exact user-data-dir argument across quoting and separator/case variants", () => {
    const windowsRoot = "C:\\Users\\Lenovo\\AppData\\Local\\ComputerHarness\\managed-browser-profiles\\travel";
    expect(commandLineReferencesManagedBrowserProfile(
      'msedge.exe --user-data-dir="c:/users/lenovo/AppData/Local/ComputerHarness/managed-browser-profiles/travel" --no-first-run',
      windowsRoot,
      "win32",
    )).toBe(true);
    expect(commandLineReferencesManagedBrowserProfile(
      'msedge.exe "--user-data-dir=C:\\Users\\Lenovo\\AppData\\Local\\ComputerHarness\\managed-browser-profiles\\travel"',
      windowsRoot,
      "win32",
    )).toBe(true);
    expect(commandLineReferencesManagedBrowserProfile(
      'msedge.exe --user-data-dir="C:\\Users\\Lenovo\\AppData\\Local\\ComputerHarness\\managed-browser-profiles\\old\\..\\travel"',
      windowsRoot,
      "win32",
    )).toBe(true);
    expect(commandLineReferencesManagedBrowserProfile(
      'msedge.exe --user-data-dir="C:\\Users\\Lenovo\\AppData\\Local\\ComputerHarness\\managed-browser-profiles\\travel other"',
      windowsRoot,
      "win32",
    )).toBe(false);
    expect(commandLineReferencesManagedBrowserProfile(
      'msedge.exe --user-data-dir=C:\\Users\\Lenovo\\AppData\\Local\\ComputerHarness\\managed-browser-profiles\\travel-old',
      windowsRoot,
      "win32",
    )).toBe(false);
    expect(commandLineReferencesManagedBrowserProfile(
      'msedge.exe --other-option=C:\\Users\\Lenovo\\AppData\\Local\\ComputerHarness\\managed-browser-profiles\\travel',
      windowsRoot,
      "win32",
    )).toBe(false);

    const posixRoot = "/home/test/App Data/ComputerHarness/managed-browser-profiles/travel";
    expect(commandLineReferencesManagedBrowserProfile(
      `chromium --user-data-dir="${posixRoot}" --no-first-run`,
      posixRoot,
      "linux",
    )).toBe(true);
    expect(commandLineReferencesManagedBrowserProfile(
      `chromium --user-data-dir=${posixRoot}-old`,
      posixRoot,
      "linux",
    )).toBe(false);
  });

  it("matches Unicode profile arguments from a PID inventory without logging the command line", async () => {
    const root = "C:\\Users\\测试\\AppData\\Local\\ComputerHarness\\managed-browser-profiles\\旅行";
    const inventory = `1234\tmsedge.exe --user-data-dir="${root}" --no-first-run`;
    expect(matchingPidsFromInventory(inventory, root, "win32")).toEqual([1234]);
    expect(argvReferencesManagedBrowserProfile([
      "msedge.exe", `--user-data-dir=${root}`, "--no-first-run",
    ], root, "win32")).toBe(true);
  });

  it("fails closed for Darwin ps-style inventories while allowing injected verified inventory in state tests", async () => {
    const root = "/Users/test/App Data/ComputerHarness/managed-browser-profiles/travel";
    const inventory = `1234\tChromium --user-data-dir="${root}" --no-first-run`;
    expect(matchingPidsFromInventory(inventory, root, "darwin")).toBeUndefined();

    const fixtureRoot = await mkdtempFixture("harness-profile-darwin-injected-");
    const profile = join(fixtureRoot, "travel");
    await mkdir(profile);
    await writeFile(join(profile, ".computer-harness-profile.lock"), "stale-lock", "utf8");
    try {
      await expect(inspectManagedBrowserProfile(fixtureRoot, "travel", {
        // Injected ownership is the seam for a future boundary-preserving
        // macOS process API; it keeps this state-machine test platform-neutral.
        findProcessesUsingProfile: async () => [],
      })).resolves.toEqual({ state: "stale", markers: ["profile_lock"] });
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("compares Windows paths without casing or separator sensitivity and rejects outside paths", () => {
    expect(sameManagedBrowserProfilePath(
      "C:\\Users\\Lenovo\\AppData\\Local\\ComputerHarness\\managed-browser-profiles\\travel",
      "c:/users/lenovo/AppData/Local/ComputerHarness/managed-browser-profiles/travel",
      "win32",
    )).toBe(true);
    expect(sameManagedBrowserProfilePath(
      "C:\\Users\\Lenovo\\AppData\\Local\\ComputerHarness\\managed-browser-profiles\\travel-old",
      "C:\\Users\\Lenovo\\AppData\\Local\\ComputerHarness\\managed-browser-profiles\\travel",
      "win32",
    )).toBe(false);
  });

  it("accepts Windows realpath casing changes but still rejects an outside reparse target", async () => {
    if (process.platform !== "win32") return;
    const root = await mkdtempFixture("Harness-Profile-Case-");
    const profile = join(root, "travel");
    await mkdir(profile);
    const outsideRoot = await mkdtempFixture("Harness-Profile-Outside-");
    const outsideProfile = join(outsideRoot, "travel");
    await mkdir(outsideProfile);
    try {
      await expect(inspectManagedBrowserProfile(root.toUpperCase(), "travel", {
        findProcessesUsingProfile: async () => [],
      })).resolves.toMatchObject({ state: "ready" });
      await rm(profile, { recursive: true, force: true });
      try {
        await symlink(outsideProfile, profile, "junction");
      } catch (error) {
        if (process.platform !== "win32") throw error;
        return;
      }
      await expect(inspectManagedBrowserProfile(root, "travel", {
        findProcessesUsingProfile: async () => [],
      })).rejects.toThrow(/regular directory|reparse point|outside/iu);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outsideRoot, { recursive: true, force: true });
    }
  });

  it("rejects traversal labels and reparse markers", async () => {
    const root = await mkdtempFixture("harness-profile-path-");
    const profile = join(root, "travel");
    await mkdir(profile);
    const outside = join(root, "outside-marker");
    await writeFile(outside, "outside", "utf8");
    try {
      await expect(inspectManagedBrowserProfile(root, "../outside")).rejects.toThrow(/label is invalid/iu);
      try {
        await symlink(outside, join(profile, ".computer-harness-profile.lock"), "file");
      } catch (error) {
        if (process.platform !== "win32") throw error;
        // Local Windows policy may deny creating test symlinks; the path label
        // containment assertion above remains active on every platform.
        return;
      }
      await expect(inspectManagedBrowserProfile(root, "travel", {
        findProcessesUsingProfile: async () => [],
      })).resolves.toMatchObject({ state: "unsafe" });
      await expect(recoverStaleManagedBrowserProfile(root, "travel", {
        findProcessesUsingProfile: async () => [],
      })).rejects.toThrow(/unsafe path or marker/iu);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
