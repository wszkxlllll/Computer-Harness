/**
 * Per-platform CUA SDK version routing.
 *
 * Windows and macOS remain on the 0.22.2 pairing that the main validation
 * platforms were accepted against. Linux upgrades to the 0.32.0 pairing
 * (daemon + npm SDK from the same release pipeline), which resolved the
 * 09-25 Transport error; see docs/cua-linux-0320-upgrade-verification-2026-10-02.md.
 *
 * Both SDK releases are installed under npm aliases because a single
 * dependency version cannot differ per OS. Every runtime import site resolves
 * the actual package through this module instead of importing an
 * @trycua/cua-driver entry directly, so a process only ever loads the native
 * binding that matches the platform decision.
 *
 * The loader is asynchronous because the SDK publishes ESM-only entries
 * without a "require" export condition; every adapter call site is already
 * async.
 */
import type {
  CuaDriverLike,
  DriverMetadata,
  EndSessionInput,
  EndSessionOutput,
  GetSessionInput,
  GetSessionStateInput,
  SessionOutput,
  SessionStateOutput,
  StartSessionInput,
  StartSessionOutput,
  ToolResult,
  VerifyStateInput,
  VerifyStateOutput,
} from "./cua-sdk-contract.js";

export type {
  CuaDriverLike,
  DriverMetadata,
  EndSessionInput,
  EndSessionOutput,
  GetSessionInput,
  GetSessionStateInput,
  SessionOutput,
  SessionStateOutput,
  StartSessionInput,
  StartSessionOutput,
  ToolResult,
  VerifyStateInput,
  VerifyStateOutput,
} from "./cua-sdk-contract.js";

export const CUA_SDK_VERSION_WINDOWS = "0.22.2";
export const CUA_SDK_VERSION_MACOS = "0.22.2";
export const CUA_SDK_VERSION_LINUX = "0.32.0";

/** npm alias of the SDK release routed for each platform. */
const CUA_SDK_ALIAS_LINUX = "@trycua/cua-driver-0.32.0";
const CUA_SDK_ALIAS_WINDOWS_MACOS = "@trycua/cua-driver-0.22.2";

export function cuaSdkVersionForPlatform(platform: NodeJS.Platform = process.platform): string {
  if (platform === "linux") return CUA_SDK_VERSION_LINUX;
  if (platform === "darwin") return CUA_SDK_VERSION_MACOS;
  return CUA_SDK_VERSION_WINDOWS;
}

export function cuaSdkAliasForPlatform(platform: NodeJS.Platform = process.platform): string {
  return platform === "linux" ? CUA_SDK_ALIAS_LINUX : CUA_SDK_ALIAS_WINDOWS_MACOS;
}

/**
 * Structural surface of the versioned-alias SDK module that this adapter
 * consumes. Both releases expose these members with identical shapes; the
 * exact input/output contracts live in cua-sdk-contract.ts.
 */
export interface CuaSdkModule {
  readonly CuaDriver: { readonly connect: (socketPath: string) => CuaDriverLike };
  readonly StartSessionInput: InputFactory<StartSessionInput>;
  readonly EndSessionInput: InputFactory<EndSessionInput>;
  readonly GetSessionInput: InputFactory<GetSessionInput>;
  readonly GetSessionStateInput: InputFactory<GetSessionStateInput>;
  readonly VerifyStateInput: InputFactory<VerifyStateInput>;
  readonly StatePredicate: InputFactory<unknown>;
  readonly WindowPredicate: InputFactory<unknown>;
  readonly BoundsExpectation: InputFactory<unknown>;
}

export interface InputFactory<T> {
  new(partial: Record<string, unknown>): T;
  /** Generated static factory used by all adapter call sites. */
  readonly new: (partial: Record<string, unknown>) => T;
  create(partial: Record<string, unknown>): T;
}

let cachedModule: CuaSdkModule | undefined;
let overrideModule: CuaSdkModule | undefined;

/**
 * Resolve the platform-routed SDK module. Importing it loads the native
 * binding; callers that must stay lazy (CLI --help, OSWorld, non-CUA
 * backends) only reach here on an actual CUA path.
 */
export async function loadCuaSdkModule(platform: NodeJS.Platform = process.platform): Promise<CuaSdkModule> {
  if (overrideModule !== undefined) return overrideModule;
  if (cachedModule !== undefined) return cachedModule;
  const alias = cuaSdkAliasForPlatform(platform);
  const module = await import(/* @vite-ignore */ alias) as unknown as CuaSdkModule;
  cachedModule = module;
  return module;
}

/** Test seam: force every loader call to observe this module. */
export function setCuaSdkModuleOverrideForTests(module: CuaSdkModule | undefined): void {
  overrideModule = module;
}

/** Test seam: forget the cached module resolution. */
export function resetCuaSdkModuleCacheForTests(): void {
  cachedModule = undefined;
}
