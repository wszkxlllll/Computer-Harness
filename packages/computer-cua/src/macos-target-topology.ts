import { randomUUID } from "node:crypto";
import type { CuaDriverLike } from "./cua-sdk-contract.js";
import type { CuaWindowTarget } from "./window-contract.js";

export const MACOS_TOPOLOGY_SCOPE = "target-ax-closure-cg-all-layers-v1";
export const MACOS_TOPOLOGY_PRODUCER = "harness-topology-v2";
export const MACOS_TOPOLOGY_COMMIT = "d114f35fec05ecd37bf529e5587be86852205b64";
const MAX_ROWS = 4096;
const MAX_NODES = 2048;
const MAX_ELAPSED_MS = 6000;

export class MacosTopologyError extends Error {
  readonly code = "WINDOW_TOPOLOGY_UNKNOWN";
  constructor(readonly reason: "unsupported" | "schema" | "target_mismatch" | "unknown" | "timeout" | "stale" | "changed") {
    super("macOS target topology " + reason + "; no complete target-bound evidence is available");
    this.name = "MacosTopologyError";
  }
}

export interface MacosTopologyRow {
  readonly pid: number;
  readonly window_id: number;
  readonly layer: number;
  readonly z_index: number;
  readonly bounds: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
  readonly space_ids: readonly number[];
  readonly current_space_id: number;
}

export interface MacosTopologyOverlay {
  readonly identityToken: string;
  readonly kind: "menu" | "popup" | "dialog";
  readonly pid: number;
  readonly window_id: number;
  readonly parent_window_id: number;
  readonly path: string;
  readonly visible: true;
  readonly geometryVerified: true;
  readonly frame: MacosTopologyRow["bounds"];
}

/** Two bounded observations, NOT an OS window-lifetime generation or global ownership proof. */
export interface MacosTargetTopology {
  readonly targetIdentityToken: string;
  readonly target: CuaWindowTarget;
  readonly sessionEpoch: string;
  readonly sequence: number;
  readonly startedUnixMs: number;
  readonly elapsedMs: number;
  readonly rows: readonly MacosTopologyRow[];
  readonly overlays: readonly MacosTopologyOverlay[];
  readonly nodeCount: number;
}

export function parseMacosTopologyCapabilities(value: unknown): void {
  if (!record(value) || value.schema_version !== 2 || value.producer_version !== MACOS_TOPOLOGY_PRODUCER ||
      value.source_commit !== MACOS_TOPOLOGY_COMMIT || value.scope !== MACOS_TOPOLOGY_SCOPE ||
      value.read_only !== true || value.global_topology_complete !== false ||
      value.identity_lifecycle !== "bounded-observation" || value.max_rows !== MAX_ROWS ||
      value.max_nodes !== MAX_NODES || value.max_elapsed_ms !== MAX_ELAPSED_MS || value.max_queries !== 32768) throw new MacosTopologyError("unsupported");
}

function parseRows(value: unknown): readonly MacosTopologyRow[] {
  if (!record(value) || value.status !== "success" || !count(value.raw_count, MAX_ROWS) ||
      value.raw_count !== value.retained_count || value.skipped_count !== 0 || value.duplicate_count !== 0 ||
      !Array.isArray(value.rows) || value.rows.length !== value.raw_count) throw new MacosTopologyError("schema");
  const keys = new Set<number>();
  const rawCount = value.raw_count;
  return value.rows.map((row: unknown, index: number) => {
    if (!record(row) || !positive(row.pid) || !positive(row.window_id) || keys.has(row.window_id) ||
        row.pid > 2147483647 || row.window_id > 4294967295 ||
        !integer(row.layer) || row.layer < -2147483648 || row.layer > 2147483647 ||
        row.z_index !== rawCount - index || !record(row.bounds) ||
        !finite(row.bounds.x) || !finite(row.bounds.y) || !finite(row.bounds.width) || !finite(row.bounds.height) ||
        row.bounds.width <= 0 || row.bounds.height <= 0 || !positive(row.current_space_id) ||
        !Array.isArray(row.space_ids) || row.space_ids.length === 0 || row.space_ids.length > 32 ||
        !row.space_ids.every(positive) || new Set(row.space_ids).size !== row.space_ids.length ||
        !row.space_ids.includes(row.current_space_id)) throw new MacosTopologyError("schema");
    keys.add(row.window_id);
    return {
      pid: row.pid, window_id: row.window_id, layer: row.layer, z_index: row.z_index,
      bounds: { x: row.bounds.x, y: row.bounds.y, width: row.bounds.width, height: row.bounds.height },
      space_ids: [...row.space_ids].sort((a: number, b: number) => a - b), current_space_id: row.current_space_id,
    };
  });
}

export function parseMacosTargetTopology(value: unknown, target: CuaWindowTarget, nonce: string): MacosTargetTopology {
  parseMacosTopologyCapabilities(value);
  if (!record(value) || !record(value.target) || value.target.pid !== target.pid ||
      value.target.window_id !== target.windowId || value.request_nonce !== nonce) throw new MacosTopologyError("target_mismatch");
  if (value.status !== "verified" || value.cg_enumeration_complete !== true || value.target_closure_complete !== true ||
      value.stable !== true) throw new MacosTopologyError("unknown");
  if (!uuid(value.session_epoch) || !positive(value.sequence) || !positive(value.started_unix_ms) ||
      !count(value.elapsed_ms, MAX_ELAPSED_MS) || !record(value.ax) || value.ax.status !== "success" ||
      value.ax.target_resolved !== true || value.ax.closure_complete !== true || value.ax.truncated !== false ||
      value.ax.skipped_count !== 0 || !count(value.ax.query_count, 32768) || value.ax.query_count === 0 ||
      !count(value.ax.node_count, MAX_NODES) || value.ax.node_count === 0 ||
      value.ax.root_role !== "AXWindow" || value.ax.root_subrole !== "AXStandardWindow" ||
      value.ax.root_query_status !== "success" || value.ax.root_classification !== "ordinary" ||
      value.ax.unassociated_menu_present !== false ||
      !uuid(value.ax.target_identity_token) ||
      !Array.isArray(value.ax.overlays) || value.ax.overlays.length > 32 ||
      value.ax.overlays.length >= value.ax.node_count) throw new MacosTopologyError("schema");
  const before = parseRows(value.cg_before), after = parseRows(value.cg_after);
  if (JSON.stringify(before) !== JSON.stringify(after)) throw new MacosTopologyError("changed");
  if (after.filter((row) => row.pid === target.pid && row.window_id === target.windowId && row.layer === 0).length !== 1) {
    throw new MacosTopologyError("target_mismatch");
  }
  const paths = new Set<string>();
  const tokens = new Set<string>();
  const rootIdentityToken = value.ax.target_identity_token;
  const overlays = value.ax.overlays.map((row: unknown): MacosTopologyOverlay => {
    if (!record(row) || (row.kind !== "menu" && row.kind !== "popup" && row.kind !== "dialog") ||
        row.pid !== target.pid || !positive(row.window_id) || row.parent_window_id !== target.windowId ||
        typeof row.path !== "string" || !/^target(?:\/(?:children|sheets)\.[0-9]+){1,40}$/.test(row.path) ||
        paths.has(row.path) || row.visible !== true || row.geometry_verified !== true ||
        !uuid(row.identity_token) || row.identity_token === rootIdentityToken || tokens.has(row.identity_token) ||
        (row.visibility_source !== "AXHidden" && row.visibility_source !== "AXVisible" && row.visibility_source !== "consistent_both") ||
        !record(row.frame) || !finite(row.frame.x) || !finite(row.frame.y) || !finite(row.frame.width) || !finite(row.frame.height) ||
        row.frame.width <= 0 || row.frame.height <= 0 ||
        !after.some((window) => window.pid === row.pid && window.window_id === row.window_id &&
          record(row.frame) && typeof row.frame.x === "number" && typeof row.frame.y === "number" &&
          typeof row.frame.width === "number" && typeof row.frame.height === "number" &&
          row.frame.x >= window.bounds.x && row.frame.y >= window.bounds.y &&
          row.frame.x + row.frame.width <= window.bounds.x + window.bounds.width &&
          row.frame.y + row.frame.height <= window.bounds.y + window.bounds.height)) {
      throw new MacosTopologyError("schema");
    }
    paths.add(row.path);
    tokens.add(row.identity_token);
    return { identityToken: row.identity_token, kind: row.kind, pid: row.pid, window_id: row.window_id,
      parent_window_id: row.parent_window_id, path: row.path, visible: true, geometryVerified: true,
      frame: { x: row.frame.x, y: row.frame.y, width: row.frame.width, height: row.frame.height } };
  });
  return { targetIdentityToken: value.ax.target_identity_token, target: { ...target }, sessionEpoch: value.session_epoch, sequence: value.sequence,
    startedUnixMs: value.started_unix_ms, elapsedMs: value.elapsed_ms, rows: after, overlays, nodeCount: value.ax.node_count };
}

/** Negotiate in each read; never fall back to list_windows or a stale cached capability. */
export async function readMacosTargetTopology(driver: CuaDriverLike, target: CuaWindowTarget, signal: AbortSignal): Promise<MacosTargetTopology> {
  signal.throwIfAborted();
  const controller = new AbortController();
  const combined = AbortSignal.any([signal, controller.signal]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abortListener: (() => void) | undefined;
  try {
    const work = async (): Promise<MacosTargetTopology> => {
      const capabilities = await driver.callTool("get_target_window_topology_capabilities", "{}", { signal: combined });
      combined.throwIfAborted();
      if (capabilities.isError || capabilities.degraded) throw new MacosTopologyError("unsupported");
      parseMacosTopologyCapabilities(json(capabilities.structuredJson));
      signal.throwIfAborted();
      const nonce = randomUUID();
      const result = await driver.callTool("get_target_window_topology", JSON.stringify({ pid: target.pid, window_id: target.windowId, request_nonce: nonce }), { signal: combined });
      combined.throwIfAborted();
      signal.throwIfAborted();
      if (result.isError || result.degraded) throw new MacosTopologyError("unknown");
      const topology = parseMacosTargetTopology(json(result.structuredJson), target, nonce);
      const age = Date.now() - topology.startedUnixMs;
      if (age < -1000 || age > MAX_ELAPSED_MS + 1000) throw new MacosTopologyError("stale");
      return topology;
    };
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => {
      controller.abort(); reject(new MacosTopologyError("timeout"));
    }, MAX_ELAPSED_MS + 500); });
    const abort = new Promise<never>((_, reject) => {
      abortListener = () => reject(signal.reason ?? new Error("topology read aborted"));
      signal.addEventListener("abort", abortListener, { once: true });
      if (signal.aborted) abortListener();
    });
    return await Promise.race([work(), timeout, abort]);
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof MacosTopologyError) throw error;
    throw new MacosTopologyError("unknown");
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (abortListener !== undefined) signal.removeEventListener("abort", abortListener);
    controller.abort();
  }
}

export function assertTopologySuccessor(previous: MacosTargetTopology, current: MacosTargetTopology): void {
  if (previous.target.pid !== current.target.pid || previous.target.windowId !== current.target.windowId ||
      previous.sessionEpoch !== current.sessionEpoch || current.sequence <= previous.sequence ||
      current.startedUnixMs < previous.startedUnixMs) throw new MacosTopologyError("stale");
  if (previous.targetIdentityToken !== current.targetIdentityToken) throw new MacosTopologyError("changed");
}

export function topologyEvidence(topology: MacosTargetTopology): string {
  return JSON.stringify({ scope: MACOS_TOPOLOGY_SCOPE, cgRows: topology.rows.length, axNodes: topology.nodeCount,
    overlayCount: topology.overlays.length, sequence: topology.sequence, elapsedMs: topology.elapsedMs,
    identityLifecycle: "bounded-observation", globalTopologyComplete: false });
}

function json(value: unknown): unknown {
  if (typeof value !== "string" || value.length > 2_000_000) throw new MacosTopologyError("schema");
  try { return JSON.parse(value); } catch { throw new MacosTopologyError("schema"); }
}
function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function finite(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 1e9; }
function integer(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value); }
function positive(value: unknown): value is number { return integer(value) && value > 0; }
function count(value: unknown, limit: number): value is number { return integer(value) && value >= 0 && value <= limit; }
function uuid(value: unknown): value is string { return typeof value === "string" && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value); }
