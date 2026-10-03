import type {
  CuaDriverLike,
  BoundsExpectation,
  EndSessionInput,
  GetSessionInput,
  GetSessionStateInput,
  StartSessionInput,
  StatePredicate,
  VerifyStateInput,
  WindowPredicate,
} from "./cua-sdk-contract.js";

export type { CuaDriverLike } from "./cua-sdk-contract.js";

export const CUA_SDK_VERSION_WINDOWS = "0.22.2";
export const CUA_SDK_VERSION_MACOS = "0.22.2";
export const CUA_SDK_VERSION_LINUX = "0.32.0";

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

export interface CuaSdkModule {
  readonly CuaDriver: { readonly connect: (socketPath: string) => CuaDriverLike };
  readonly StartSessionInput: InputFactory<StartSessionInput>;
  readonly EndSessionInput: InputFactory<EndSessionInput>;
  readonly GetSessionInput: InputFactory<GetSessionInput>;
  readonly GetSessionStateInput: InputFactory<GetSessionStateInput>;
  readonly VerifyStateInput: InputFactory<VerifyStateInput>;
  readonly StatePredicate: InputFactory<StatePredicate>;
  readonly WindowPredicate: InputFactory<WindowPredicate>;
  readonly BoundsExpectation: InputFactory<BoundsExpectation>;
}

export interface InputFactory<T> {
  new(partial: Record<string, unknown>): T;
  readonly new: (partial: Record<string, unknown>) => T;
  create(partial: Record<string, unknown>): T;
}

type CuaSdkModuleLoader = (alias: string) => Promise<CuaSdkModule>;

const cachedModules = new Map<string, Promise<CuaSdkModule>>();
let testModuleLoader: CuaSdkModuleLoader | undefined;

async function importCuaSdkModule(alias: string): Promise<CuaSdkModule> {
  return await import(/* @vite-ignore */ alias) as unknown as CuaSdkModule;
}

/** Load the platform-specific SDK only when an operation actually needs CUA. */
export function loadCuaSdkModule(platform: NodeJS.Platform = process.platform): Promise<CuaSdkModule> {
  const alias = cuaSdkAliasForPlatform(platform);
  const existing = cachedModules.get(alias);
  if (existing !== undefined) return existing;

  const pending = (testModuleLoader ?? importCuaSdkModule)(alias);
  cachedModules.set(alias, pending);
  void pending.catch(() => {
    if (cachedModules.get(alias) === pending) cachedModules.delete(alias);
  });
  return pending;
}

/** Internal test seam. It is intentionally not re-exported from the package entrypoint. */
export function setCuaSdkModuleLoaderForTests(loader: CuaSdkModuleLoader | undefined): void {
  testModuleLoader = loader;
  cachedModules.clear();
}

export function resetCuaSdkModuleCacheForTests(): void {
  cachedModules.clear();
}
