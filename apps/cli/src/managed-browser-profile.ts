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
