import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ActionIntent, ObservationId } from "@computer-harness/protocol";
import { sameWindowGeometry, type CuaWindowGeometry, type CuaWindowTarget } from "./window-contract.js";

/** One Host-selected absolute path; never sent to the model. */
export interface ReopenSavedDocumentGrant {
  readonly path: string;
  /** Canonical executable URL frozen by the Host for com.apple.TextEdit. */
  readonly expectedExecutableUrl: string;
}

export interface FileIdentityPin {
  readonly dev: string;
  readonly ino: string;
  readonly size: string;
  readonly mtimeNs: string;
  readonly ctimeNs: string;
}

export interface VerifiedApplicationIdentity {
  readonly pid: number;
  readonly windowId: number;
  readonly processStart: { readonly seconds: number; readonly microseconds: number };
  readonly bundleId: "com.apple.TextEdit";
  readonly executableUrl: string;
}

export interface VerifiedDocumentIdentity {
  readonly snapshotId: string;
  readonly observationId: ObservationId;
  readonly identity: VerifiedApplicationIdentity;
  readonly fileUrl: string;
  readonly windowGeometry: CuaWindowGeometry;
  readonly fileIdentity: FileIdentityPin;
}

export interface PreparedReopenSavedDocumentGrant {
  readonly path: string;
  readonly fileUrl: string;
  readonly canonicalExecutableUrl: string;
  readonly parentIdentity: { readonly dev: string; readonly ino: string };
}

/** Narrow state for the Host-authorized one-file recovery flow. */
export interface PrivateReopenSavedDocumentState extends PreparedReopenSavedDocumentGrant {
  readonly primaryIdentity: VerifiedApplicationIdentity;
  savedDocument?: VerifiedDocumentIdentity;
  closedSourceActionId?: ActionIntent["actionId"];
  recoveryReady: boolean;
  attempted: boolean;
}

export type AuthorizedOutputFileIdentityRead =
  | { readonly status: "present"; readonly identity: FileIdentityPin }
  | { readonly status: "absent" }
  | { readonly status: "unverified" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return isRecord(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  }
  return isRecord(value) ? value : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parseWindowBounds(value: unknown): CuaWindowGeometry | undefined {
  const record = parseRecord(value);
  if (record === undefined) return undefined;
  const x = finiteNumber(record.x);
  const y = finiteNumber(record.y);
  const width = finiteNumber(record.width ?? record.w);
  const height = finiteNumber(record.height ?? record.h);
  return x === undefined || y === undefined || width === undefined || height === undefined || width <= 0 || height <= 0
    ? undefined
    : { x, y, width, height };
}

function processStart(value: unknown): { seconds: number; microseconds: number } | undefined {
  const record = parseRecord(value);
  return record !== undefined && Number.isSafeInteger(record.seconds) && Number.isSafeInteger(record.microseconds) &&
    (record.seconds as number) >= 0 && (record.microseconds as number) >= 0
    ? { seconds: record.seconds as number, microseconds: record.microseconds as number }
    : undefined;
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && "code" in value && typeof (value as NodeJS.ErrnoException).code === "string";
}

export async function fileIdentityPin(path: string): Promise<FileIdentityPin> {
  const info = await lstat(path, { bigint: true });
  if (info.isSymbolicLink() || !info.isFile()) throw new Error("the Host-granted output must be a regular non-symlink file");
  return {
    dev: info.dev.toString(), ino: info.ino.toString(), size: info.size.toString(),
    mtimeNs: info.mtimeNs.toString(), ctimeNs: info.ctimeNs.toString(),
  };
}

/** @internal The reader parameter keeps ENOENT distinct from every other IO failure. */
export async function inspectAuthorizedOutputFileIdentity(
  path: string,
  readIdentity: (path: string) => Promise<FileIdentityPin> = fileIdentityPin,
): Promise<AuthorizedOutputFileIdentityRead> {
  try {
    return { status: "present", identity: await readIdentity(path) };
  } catch (error) {
    return isNodeError(error) && error.code === "ENOENT" ? { status: "absent" } : { status: "unverified" };
  }
}

export function sameFileIdentity(left: FileIdentityPin, right: FileIdentityPin): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
    left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

export function samePostLaunchFileIdentity(left: FileIdentityPin, right: FileIdentityPin): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeNs === right.mtimeNs;
}

export function parseDocumentIdentityProof(
  result: { readonly isError?: boolean; readonly structuredJson?: string },
  target: CuaWindowTarget,
  bounds: CuaWindowGeometry,
  expectedExecutableUrl: string,
  expectedDocumentUrl?: string,
): { readonly identity: VerifiedApplicationIdentity; readonly snapshotId: string; readonly cleanDocument: boolean } | undefined {
  if (result.isError === true) return undefined;
  const state = parseRecord(result.structuredJson);
  const proof = parseRecord(state?._private_document_proof);
  const app = parseRecord(proof?.application_identity);
  const topTarget = parseRecord(proof?.target);
  const appTarget = parseRecord(app?.target);
  const window = parseRecord(proof?.window);
  const windowBounds = parseWindowBounds(window?.bounds);
  const appStart = processStart(appTarget?.process_start);
  const topStart = processStart(topTarget?.process_start);
  if (proof?.version !== "macos-document-identity-v1" || typeof proof.snapshot_id !== "string" || proof.snapshot_id.length === 0 ||
      app?.status !== "verified" || topTarget?.pid !== target.pid || topTarget.window_id !== target.windowId ||
      appTarget?.pid !== target.pid || appTarget.window_id !== target.windowId ||
      appTarget.bundle_id !== "com.apple.TextEdit" || appTarget.executable_url !== expectedExecutableUrl ||
      appStart === undefined || topStart === undefined || appStart.seconds !== topStart.seconds || appStart.microseconds !== topStart.microseconds ||
      !Array.isArray(app.instances) || app.instances.length !== 1 || !isRecord(app.instances[0])) return undefined;
  const instance = app.instances[0];
  const instanceStart = processStart(instance.process_start);
  if (instance.pid !== target.pid || instance.bundle_id !== "com.apple.TextEdit" || instance.executable_url !== expectedExecutableUrl ||
      instanceStart === undefined || instanceStart.seconds !== appStart.seconds || instanceStart.microseconds !== appStart.microseconds ||
      proof.frontmost_pid !== target.pid || proof.focused_window_id !== target.windowId ||
      window?.role !== "AXWindow" || window.pid !== target.pid || window.window_id !== target.windowId ||
      window.owner_pid !== target.pid || windowBounds === undefined || !sameWindowGeometry(windowBounds, bounds)) return undefined;
  const identity: VerifiedApplicationIdentity = {
    pid: target.pid, windowId: target.windowId, processStart: appStart,
    bundleId: "com.apple.TextEdit", executableUrl: expectedExecutableUrl,
  };
  if (expectedDocumentUrl === undefined) {
    return { identity, snapshotId: proof.snapshot_id, cleanDocument: false };
  }
  if (proof.status !== "identity_verified" || proof.tail_revalidated !== true) return undefined;
  const document = parseRecord(proof.document);
  const domain = parseRecord(proof.document_domain);
  const edited = parseRecord(proof.edited);
  const closeButton = parseRecord(edited?.close_button);
  const editedValue = parseRecord(edited?.value);
  if (document?.status !== "ok" || document.type !== "cf_url" && document.type !== "cf_string" ||
      document.matches_expected !== true || domain?.status !== "complete_for_ax_windows" ||
      !Array.isArray(domain.matching_window_ids) || domain.matching_window_ids.length !== 1 || domain.matching_window_ids[0] !== target.windowId ||
      edited?.source !== "ax_close_button" || closeButton?.status !== "verified" || closeButton.role !== "AXButton" ||
      closeButton.subrole !== "AXCloseButton" || closeButton.pid !== target.pid || closeButton.window_id !== target.windowId ||
      closeButton.ax_window_id !== target.windowId || closeButton.ax_window_matches_target !== true ||
      editedValue?.status !== "ok" || editedValue.type !== "cf_boolean" || editedValue.value !== false) return undefined;
  return { identity, snapshotId: proof.snapshot_id, cleanDocument: true };
}

export function sameApplicationProcess(left: VerifiedApplicationIdentity, right: VerifiedApplicationIdentity): boolean {
  return left.pid === right.pid &&
    left.processStart.seconds === right.processStart.seconds && left.processStart.microseconds === right.processStart.microseconds &&
    left.bundleId === right.bundleId && left.executableUrl === right.executableUrl;
}

export function sameApplicationIdentity(left: VerifiedApplicationIdentity, right: VerifiedApplicationIdentity): boolean {
  return sameApplicationProcess(left, right) && left.windowId === right.windowId;
}

export async function prepareReopenSavedDocumentGrant(grant: ReopenSavedDocumentGrant): Promise<PreparedReopenSavedDocumentGrant> {
  if (!isAbsolute(grant.path) || grant.path.includes("\0") || resolve(grant.path) !== grant.path || basename(grant.path).length === 0) {
    throw new Error("saved-document grant path must be one canonical absolute file path");
  }
  const parent = dirname(grant.path);
  const canonicalParent = await realpath(parent);
  if (canonicalParent !== parent) throw new Error("saved-document grant parent must already be canonical");
  const parentInfo = await lstat(parent, { bigint: true });
  if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink()) throw new Error("saved-document grant parent must be a real directory");
  try {
    await lstat(grant.path);
    throw new Error("saved-document grant must name an output file that is absent at Run open");
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") throw error;
  }
  let executablePath: string;
  try {
    const url = new URL(grant.expectedExecutableUrl);
    if (url.protocol !== "file:" || url.hostname !== "" || url.search !== "" || url.hash !== "" || url.href !== grant.expectedExecutableUrl) {
      throw new Error("invalid file URL");
    }
    executablePath = fileURLToPath(url);
  } catch {
    throw new Error("saved-document grant requires a canonical TextEdit executable file URL");
  }
  const canonicalExecutableUrl = pathToFileURL(await realpath(executablePath)).href;
  if (canonicalExecutableUrl !== grant.expectedExecutableUrl) throw new Error("saved-document executable identity is not canonical");
  return {
    path: grant.path,
    fileUrl: pathToFileURL(grant.path).href,
    canonicalExecutableUrl,
    parentIdentity: { dev: parentInfo.dev.toString(), ino: parentInfo.ino.toString() },
  };
}

export async function authorizedOutputParentIsPinned(
  path: string,
  expectedIdentity: { readonly dev: string; readonly ino: string },
): Promise<boolean> {
  const parent = dirname(path);
  if (await realpath(parent) !== parent) return false;
  const info = await lstat(parent, { bigint: true });
  return info.isDirectory() && !info.isSymbolicLink() &&
    info.dev.toString() === expectedIdentity.dev && info.ino.toString() === expectedIdentity.ino;
}

export function hasExplicitApplicationIdentityConflict(
  result: { readonly isError?: boolean; readonly structuredJson?: string },
  target: CuaWindowTarget,
  expectedExecutableUrl: string,
  expectedIdentity: VerifiedApplicationIdentity,
): boolean {
  if (result.isError === true) return false;
  const state = parseRecord(result.structuredJson);
  const proof = parseRecord(state?._private_document_proof);
  const app = parseRecord(proof?.application_identity);
  if (proof?.version !== "macos-document-identity-v1" || app?.status !== "verified") return false;
  const appTarget = parseRecord(app.target);
  const appStart = processStart(appTarget?.process_start);
  if (typeof appTarget?.pid !== "number" || appTarget.window_id !== target.windowId ||
      typeof appTarget.bundle_id !== "string" || typeof appTarget.executable_url !== "string" || appStart === undefined) return false;
  if (appTarget.pid !== expectedIdentity.pid || appTarget.bundle_id !== expectedIdentity.bundleId ||
      appTarget.executable_url !== expectedExecutableUrl || appStart.seconds !== expectedIdentity.processStart.seconds ||
      appStart.microseconds !== expectedIdentity.processStart.microseconds) return true;
  if (!Array.isArray(app.instances) || app.instances.length !== 1 || !isRecord(app.instances[0])) return true;
  const instance = app.instances[0];
  const instanceStart = processStart(instance.process_start);
  if (typeof instance.pid !== "number" || typeof instance.bundle_id !== "string" ||
      typeof instance.executable_url !== "string" || instanceStart === undefined) return false;
  return instance.pid !== expectedIdentity.pid || instance.bundle_id !== expectedIdentity.bundleId ||
    instance.executable_url !== expectedExecutableUrl || instanceStart.seconds !== expectedIdentity.processStart.seconds ||
    instanceStart.microseconds !== expectedIdentity.processStart.microseconds;
}
