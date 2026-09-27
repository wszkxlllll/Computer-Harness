import { homedir, platform } from "node:os";
import { posix, win32 } from "node:path";

/** Stable Harness-owned root; never place this path in model/report data. */
export function defaultManagedBrowserProfileRoot(
  osPlatform: NodeJS.Platform = platform(),
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
  home = homedir(),
): string {
  const pathApi = osPlatform === "win32" ? win32 : posix;
  if (osPlatform === "win32") {
    return pathApi.resolve(environment.LOCALAPPDATA ?? pathApi.join(home, "AppData", "Local"), "ComputerHarness", "managed-browser-profiles");
  }
  return pathApi.resolve(environment.XDG_STATE_HOME ?? pathApi.join(home, ".local", "state"), "computer-harness", "managed-browser-profiles");
}

export interface ManagedBrowserProfileConfig {
  readonly profileLabel: string;
  readonly profileRoot: string;
}

/** Resolve only a profile label from Host configuration; the root is always Harness-owned. */
export function resolveManagedBrowserProfileConfig(
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
  osPlatform: NodeJS.Platform = platform(),
  home = homedir(),
): ManagedBrowserProfileConfig {
  const profileLabel = environment.HARNESS_MANAGED_BROWSER_PROFILE_LABEL?.trim() || "mobile";
  if (!/^[A-Za-z0-9._-]{1,64}$/u.test(profileLabel)) {
    throw new Error("HARNESS_MANAGED_BROWSER_PROFILE_LABEL must contain 1 to 64 letters, digits, dots, underscores, or hyphens.");
  }
  return {
    profileLabel,
    profileRoot: defaultManagedBrowserProfileRoot(osPlatform, environment, home),
  };
}

export {
  inspectManagedBrowserProfile,
  recoverStaleManagedBrowserProfile,
  type ManagedBrowserProfileInspection,
  type ManagedBrowserProfileMarker,
  type ManagedBrowserProfileRecoveryDependencies,
  type ManagedBrowserProfileRecoveryResult,
  type ManagedBrowserProfileState,
} from "@computer-harness/computer-cua";
