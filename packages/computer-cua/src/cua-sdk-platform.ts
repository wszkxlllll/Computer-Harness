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
import { createRequire } from "node:module";
import { realpath } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { types as utilTypes } from "node:util";

export type { CuaDriverLike } from "./cua-sdk-contract.js";

export const CUA_SDK_VERSION_WINDOWS = "0.22.2";
export const CUA_SDK_VERSION_MACOS = "0.22.2";
export const CUA_SDK_VERSION_LINUX = "0.32.0";

const CUA_SDK_ALIAS_LINUX = "@trycua/cua-driver-0.32.0";
const CUA_SDK_ALIAS_WINDOWS_MACOS = "@trycua/cua-driver-0.22.2";
const CUA_SDK_ALIAS_MAC_RESOLVER_COMPATIBILITY = "@trycua/cua-driver-0.22.2";
const CUA_NODE_RESOLVER_SPECIFIER = "@ubjs/node/typescript/dist/resolve-lib.js";

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
type CuaSdkModuleImportDependencies = {
  readonly resolve: (specifier: string) => string;
  readonly realpath: (path: string) => Promise<string>;
  readonly createRequire: (url: string) => NodeJS.Require;
  readonly runtimePlatform: () => NodeJS.Platform;
  readonly importModule: (url: string) => Promise<CuaSdkModule>;
};

const cachedModules = new Map<string, Promise<CuaSdkModule>>();
let testModuleLoader: CuaSdkModuleLoader | undefined;
let testImportDependencies: CuaSdkModuleImportDependencies | undefined;

const defaultImportDependencies: CuaSdkModuleImportDependencies = {
  resolve: (specifier) => import.meta.resolve(specifier),
  realpath,
  createRequire,
  runtimePlatform: () => process.platform,
  importModule: (url) => import(/* @vite-ignore */ url) as Promise<CuaSdkModule>,
};

function validateResolverModule(moduleValue: unknown): void {
  if (typeof moduleValue !== "object" || moduleValue === null || utilTypes.isProxy(moduleValue)) {
    throw new TypeError("CUA SDK resolver module is invalid");
  }

  const descriptor = Object.getOwnPropertyDescriptor(moduleValue, "resolveLibPath");
  if (descriptor === undefined || !("value" in descriptor)) {
    throw new TypeError("CUA SDK resolver export is invalid");
  }

  const resolver = descriptor.value;
  if (typeof resolver !== "function" || utilTypes.isProxy(resolver)) {
    throw new TypeError("CUA SDK resolver export is invalid");
  }
}

async function preloadMacResolver(canonicalSdkUrl: string, dependencies: CuaSdkModuleImportDependencies): Promise<void> {
  try {
    const sdkRequire = dependencies.createRequire(canonicalSdkUrl);
    const resolverPath = sdkRequire.resolve(CUA_NODE_RESOLVER_SPECIFIER);
    // Use the same canonical file for both resolution and loading. Node may
    // create or reuse its ordinary require.cache entry; we never edit it.
    const canonicalResolverPath = await dependencies.realpath(resolverPath);
    validateResolverModule(sdkRequire(canonicalResolverPath));
  } catch {
    throw new Error("CUA SDK resolver preload failed");
  }
}

async function importCuaSdkModule(alias: string): Promise<CuaSdkModule> {
  const dependencies = testImportDependencies ?? defaultImportDependencies;
  const resolved = new URL(dependencies.resolve(alias));
  if (resolved.protocol !== "file:") throw new TypeError("CUA SDK entry must resolve to a file URL");
  const canonicalPath = await dependencies.realpath(fileURLToPath(resolved));
  const canonicalSdkUrl = pathToFileURL(canonicalPath).href;
  if (dependencies.runtimePlatform() === "darwin" && alias === CUA_SDK_ALIAS_MAC_RESOLVER_COMPATIBILITY) {
    await preloadMacResolver(canonicalSdkUrl, dependencies);
  }
  return await dependencies.importModule(canonicalSdkUrl);
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

/** Internal test seam for the default ESM resolution and canonical import route. */
export function setCuaSdkModuleImportDependenciesForTests(dependencies: CuaSdkModuleImportDependencies | undefined): void {
  testImportDependencies = dependencies;
  cachedModules.clear();
}

export function resetCuaSdkModuleCacheForTests(): void {
  cachedModules.clear();
}
