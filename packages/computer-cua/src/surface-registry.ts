/**
 * Pure, Run-scoped Surface lifecycle state. This module intentionally has no
 * CUA, Runtime, filesystem, timing, or browser-host dependency; callers must
 * turn external observations into the evidence unions below before changing
 * registry state.
 */

import type { SurfaceAdmissionSource, SurfaceId, SurfaceKind, SurfaceRef } from "@computer-harness/protocol";

export type { SurfaceAdmissionSource, SurfaceId, SurfaceKind, SurfaceRef } from "@computer-harness/protocol";

export type SurfaceStatus = "inactive" | "active" | "unknown" | "closed";

export interface NativeWindowIdentity {
  readonly pid: number;
  readonly hwnd: number;
}

interface SurfaceBase {
  readonly surfaceId: SurfaceId;
  readonly generation: number;
  readonly parentSurfaceId?: SurfaceId;
  readonly admissionSource?: SurfaceAdmissionSource;
  readonly status: SurfaceStatus;
}

export type SurfaceRecord =
  | (SurfaceBase & {
      readonly kind: "desktop";
      readonly displayId: string;
    })
  | (SurfaceBase & {
      readonly kind: "native_window";
      readonly parentSurfaceId?: SurfaceId;
      readonly interactionPolicy?: "modal";
      readonly nativeWindow: NativeWindowIdentity;
      readonly rootRole?: "menu" | "popup" | "dialog";
    })
  | (SurfaceBase & {
      readonly kind: "browser_tab";
      readonly parentSurfaceId: SurfaceId;
      /** Host-attested identity from the managed-browser transport. */
      readonly tabId: string;
      readonly hostGeneration: string;
    })
  | (SurfaceBase & {
      readonly kind: "dom";
      readonly parentSurfaceId: SurfaceId;
      /** Host-attested document/page incarnation, not a DOM node token. */
      readonly documentGeneration: string;
    })
  | (SurfaceBase & {
      readonly kind: "overlay";
      readonly parentSurfaceId: SurfaceId;
      readonly interactionPolicy: "modal";
      readonly rootRole: "menu" | "popup";
    });

export interface SurfaceRegistryState {
  /** Immutable for the lifetime of this registry, including peer switches. */
  readonly computerSessionId: string;
  readonly surfaces: ReadonlyMap<SurfaceId, SurfaceRecord>;
  readonly activeSurface?: SurfaceRef;
  /** Deterministic, opaque IDs are local to this ComputerSession. */
  readonly nextSurfaceOrdinal: number;
  readonly closed: boolean;
}

export type SurfaceMutation<T> =
  | { readonly decision: "applied"; readonly state: SurfaceRegistryState; readonly value: T }
  | { readonly decision: "manual"; readonly state: SurfaceRegistryState; readonly reason: string }
  | { readonly decision: "rejected"; readonly state: SurfaceRegistryState; readonly reason: string };

export interface PeerActivationEvidence {
  /** Identity returned by a fresh exact-target discovery. */
  readonly nativeWindow: NativeWindowIdentity;
  readonly identityVerified: boolean;
  /** True only after a fresh screenshot/capture for that same target. */
  readonly captureVerified: boolean;
}

export interface OwnedTransientSurfaceEvidence {
  /** Exact authorized parent identity; registry separately checks its current generation. */
  readonly owner: NativeWindowIdentity;
  readonly visible: true;
  readonly interactionPolicy: "modal";
}

export type TransientChildEvidence =
  | (OwnedTransientSurfaceEvidence & {
      readonly kind: "overlay";
      /** Exact HWND whose complete root state contains this overlay. */
      readonly nativeWindow: NativeWindowIdentity;
      /** Canonical role of that exact window's overlay root, never a descendant role. */
      readonly rootRole: "menu" | "popup";
      readonly rootSemanticsVerified: true;
      /** Completeness of the root state for nativeWindow. */
      readonly treeComplete: boolean;
      readonly geometryVerified: boolean;
    })
  | (OwnedTransientSurfaceEvidence & {
      /** A separately-created native HWND owned by the active parent window. */
      readonly kind: "native_window";
      readonly nativeWindow: NativeWindowIdentity;
      /** Canonical role proved by exact native class evidence or fresh exact UIA. */
      readonly rootRole: "menu" | "popup" | "dialog";
      readonly rootSemanticsVerified: true;
      readonly frontmostEvidence: "exact_foreground" | "unique_owned_stack";
      readonly admissionSource?: "owned_transient_window_root_proof" | "win32_relationship_probe";
    } | {
      /** An exact Win32 owner stack can prove a child without assigning a UIA root role. */
      readonly kind: "native_window";
      readonly nativeWindow: NativeWindowIdentity;
      readonly owner: NativeWindowIdentity;
      readonly visible: true;
      readonly interactionPolicy: "modal";
      readonly relationshipProof: "exact_foreground" | "unique_owned_stack";
      readonly frontmostEvidence: "exact_foreground" | "unique_owned_stack";
      readonly admissionSource: "win32_relationship_probe";
    })
  | {
      readonly kind: "browser_tab";
      readonly tabId: string;
      readonly hostGeneration: string;
      /** Set only by the Host-owned managed-browser attestation path. */
      readonly hostAttested: boolean;
    }
  | {
      readonly kind: "dom";
      readonly documentGeneration: string;
      readonly hostAttested: boolean;
    }
  | { readonly kind: "incomplete"; readonly reason: string };

export interface ChildPopEvidence {
  /** A fresh capture/discovery of the exact current parent incarnation. */
  readonly parent: SurfaceRef;
  readonly parentRevalidated: boolean;
  readonly childAbsent: boolean;
}

export interface ChildDeactivationEvidence {
  readonly parent: SurfaceRef;
  readonly parentRevalidated: boolean;
  /** The child remains registered, but exact fresh evidence says it is no longer selected. */
  readonly childNoLongerActive: boolean;
}

export function createSurfaceRegistry(computerSessionId: string): SurfaceRegistryState {
  if (!computerSessionId.trim()) throw new Error("SurfaceRegistry requires a ComputerSessionId");
  return {
    computerSessionId,
    surfaces: new Map(),
    nextSurfaceOrdinal: 1,
    closed: false,
  };
}

/** Register the real primary-display capture surface without inventing an HWND. */
export function registerDesktopSurface(
  state: SurfaceRegistryState,
  displayId: string,
): SurfaceMutation<SurfaceRef> {
  if (state.closed) return rejected(state, "ComputerSession is closed");
  if (state.surfaces.size !== 0 || state.activeSurface !== undefined) {
    return rejected(state, "desktop Surface can only initialize an empty registry");
  }
  if (!isNonEmptyIdentity(displayId)) return rejected(state, "desktop Surface requires a display identity");
  const surface: SurfaceRecord = {
    surfaceId: allocateSurfaceId(state.nextSurfaceOrdinal),
    generation: 1,
    kind: "desktop",
    displayId,
    status: "active",
  };
  const next = withSurfaces(state, [surface], {
    activeSurface: toSurfaceRef(surface),
    nextSurfaceOrdinal: state.nextSurfaceOrdinal + 1,
  });
  return applied(next, toSurfaceRef(surface));
}

/** Register an exact Host/driver-discovered peer without making it active. */
export function registerNativePeer(
  state: SurfaceRegistryState,
  nativeWindow: NativeWindowIdentity,
): SurfaceMutation<SurfaceRef> {
  if (state.closed) return rejected(state, "ComputerSession is closed");
  if (!isValidNativeWindowIdentity(nativeWindow)) return rejected(state, "peer has no exact positive PID/HWND identity");

  const existing = [...state.surfaces.values()].find((surface) =>
    surface.kind === "native_window" && surface.parentSurfaceId === undefined &&
    surface.status !== "closed" && sameNativeWindow(surface.nativeWindow, nativeWindow));
  if (existing !== undefined) {
    if (existing.status === "unknown") return manual(state, "peer identity is retained as unknown; a new ComputerSession is required");
    return applied(state, toSurfaceRef(existing));
  }

  const surfaceId = allocateSurfaceId(state.nextSurfaceOrdinal);
  const surface: SurfaceRecord = {
    surfaceId,
    generation: 1,
    kind: "native_window",
    nativeWindow: copyNativeWindow(nativeWindow),
    status: "inactive",
  };
  const next = withSurfaces(state, [surface], { nextSurfaceOrdinal: state.nextSurfaceOrdinal + 1 });
  return applied(next, toSurfaceRef(surface));
}

/**
 * Explicitly activate a registered peer. The adapter performs activation and
 * exact capture; this transition commits only when both are verified.
 */
export function activatePeer(
  state: SurfaceRegistryState,
  peer: SurfaceRef,
  evidence: PeerActivationEvidence,
): SurfaceMutation<SurfaceRef> {
  if (state.closed) return rejected(state, "ComputerSession is closed");
  const target = getSurface(state, peer);
  if (target === undefined) return rejected(state, "peer reference is stale or unknown");
  if (target.kind !== "native_window" || target.parentSurfaceId !== undefined) {
    return rejected(state, "explicit peer activation requires a root native window Surface");
  }
  if (target.status === "unknown" || target.status === "closed") {
    return manual(state, "peer identity is not currently actionable");
  }
  const active = state.activeSurface === undefined ? undefined : getSurface(state, state.activeSurface);
  if (active?.status === "unknown") return manual(state, "active Surface is unknown; no in-Run recovery is permitted");
  if (active !== undefined && isModalChild(active)) {
    return manual(state, "an active modal child Surface must be closed and popped before switching peer windows");
  }
  if (!isValidNativeWindowIdentity(evidence.nativeWindow) || !sameNativeWindow(evidence.nativeWindow, target.nativeWindow)) {
    return rejected(state, "fresh peer identity did not match the registered exact PID/HWND");
  }
  if (evidence.identityVerified !== true || evidence.captureVerified !== true) {
    return manual(state, "fresh exact identity and capture evidence are required before peer activation");
  }
  if (state.activeSurface?.surfaceId === peer.surfaceId && state.activeSurface.generation === peer.generation) {
    return rejected(state, "peer is already active");
  }

  const updates: SurfaceRecord[] = [];
  if (active !== undefined && active.surfaceId !== target.surfaceId) {
    updates.push({ ...active, status: "inactive" } as SurfaceRecord);
  }
  const activated: SurfaceRecord = { ...target, status: "active" } as SurfaceRecord;
  updates.push(activated);
  const next = withSurfaces(state, updates, { activeSurface: toSurfaceRef(activated) });
  return applied(next, toSurfaceRef(activated));
}

/**
 * Push a child only from typed, complete evidence. Incomplete or ambiguous
 * evidence returns manual with the input state unchanged.
 */
export function pushChild(
  state: SurfaceRegistryState,
  parent: SurfaceRef,
  evidence: TransientChildEvidence,
): SurfaceMutation<SurfaceRef> {
  if (state.closed) return rejected(state, "ComputerSession is closed");
  const parentSurface = getSurface(state, parent);
  if (parentSurface === undefined) return rejected(state, "parent Surface reference is stale or unknown");
  const activeRef = state.activeSurface;
  const activeSurface = activeRef === undefined ? undefined : getSurface(state, activeRef);
  if (activeSurface !== undefined && isModalChild(activeSurface)) {
    const activeParent = activeSurface.parentSurfaceId === undefined
      ? undefined
      : state.surfaces.get(activeSurface.parentSurfaceId);
    if (activeParent !== undefined && sameChildEvidence(state, activeParent, activeSurface, evidence)) {
      return applied(state, toSurfaceRef(activeSurface));
    }
    if (activeSurface.parentSurfaceId === parentSurface.surfaceId || activeSurface.surfaceId === parentSurface.surfaceId) {
      return manual(state, "a modal child Surface is already active; resolve it before pushing another child");
    }
  }
  if (!isActiveSurface(state, parentSurface)) return rejected(state, "child parent must be the active Surface");
  if (evidence.kind === "incomplete") return manual(state, evidence.reason || "child evidence is incomplete");

  let child: SurfaceRecord | undefined;
  switch (evidence.kind) {
    case "overlay": {
      const parentWindow = nativeWindowFor(state, parentSurface);
      if (parentWindow === undefined) return manual(state, "overlay parent has no verified native capture window");
      if (!sameNativeWindow(evidence.nativeWindow, parentWindow) || !sameNativeWindow(evidence.owner, parentWindow) || !isOverlayRootRole(evidence.rootRole)) {
        return rejected(state, "overlay HWND or exact root role does not match the active parent Surface");
      }
      if (evidence.treeComplete !== true || evidence.geometryVerified !== true || evidence.visible !== true ||
          evidence.rootSemanticsVerified !== true || evidence.interactionPolicy !== "modal") {
        return manual(state, "same-HWND overlay requires complete root-role, geometry, and parent HWND evidence");
      }
      child = {
        surfaceId: allocateSurfaceId(state.nextSurfaceOrdinal),
        generation: 1,
        kind: "overlay",
        parentSurfaceId: parentSurface.surfaceId,
        interactionPolicy: evidence.interactionPolicy,
        admissionSource: "same_hwnd_overlay_root_proof",
        rootRole: evidence.rootRole,
        status: "active",
      };
      break;
    }
    case "native_window": {
      const parentWindow = nativeWindowFor(state, parentSurface);
      if (parentWindow === undefined) return manual(state, "independent child has no verified native parent HWND");
      if (!isValidNativeWindowIdentity(evidence.nativeWindow) || !sameNativeWindow(evidence.owner, parentWindow) ||
          sameNativeWindow(evidence.nativeWindow, parentWindow)) {
        return rejected(state, "independent child identity or exact owner is contradictory");
      }
      const relationOnly = "relationshipProof" in evidence;
      const rootRole = relationOnly ? undefined : evidence.rootRole;
      const rootSemanticsVerified = relationOnly ? false : evidence.rootSemanticsVerified;
      const hasRootRoleProof = rootSemanticsVerified === true && isNativeChildRootRole(rootRole);
      const hasWin32RelationshipProof = relationOnly && evidence.admissionSource === "win32_relationship_probe" &&
        evidence.relationshipProof === evidence.frontmostEvidence;
      if (evidence.visible !== true || evidence.interactionPolicy !== "modal" ||
          (!hasRootRoleProof && !hasWin32RelationshipProof)) {
        return manual(state, "independent child HWND requires exact owner and either a verified root role or unique Win32 owned-stack evidence");
      }
      if (hasRootRoleProof && ((rootRole === "dialog" && evidence.frontmostEvidence !== "exact_foreground" &&
          !(evidence.admissionSource === "win32_relationship_probe" && evidence.frontmostEvidence === "unique_owned_stack")) ||
          ((rootRole === "menu" || rootRole === "popup") && evidence.frontmostEvidence !== "unique_owned_stack" &&
            !(evidence.admissionSource === "win32_relationship_probe" && evidence.frontmostEvidence === "exact_foreground")))) {
        return rejected(state, "independent child frontmost evidence does not match its root-role policy");
      }
      const admissionSource = evidence.admissionSource ?? "owned_transient_window_root_proof";
      child = {
        surfaceId: allocateSurfaceId(state.nextSurfaceOrdinal),
        generation: 1,
        kind: "native_window",
        parentSurfaceId: parentSurface.surfaceId,
        interactionPolicy: evidence.interactionPolicy,
        admissionSource,
        nativeWindow: copyNativeWindow(evidence.nativeWindow),
        ...(hasRootRoleProof && rootRole !== undefined ? { rootRole } : {}),
        status: "active",
      };
      break;
    }
    case "browser_tab": {
      if (parentSurface.kind !== "native_window" || parentSurface.parentSurfaceId !== undefined ||
          evidence.hostAttested !== true || !isNonEmptyIdentity(evidence.tabId) || !isNonEmptyIdentity(evidence.hostGeneration)) {
        return manual(state, "browser tab requires a Host-attested tab identity under a root native window");
      }
      const existing = [...state.surfaces.values()].find((surface) =>
        surface.kind === "browser_tab" && surface.parentSurfaceId === parentSurface.surfaceId &&
        surface.tabId === evidence.tabId && surface.hostGeneration === evidence.hostGeneration &&
        surface.status !== "closed");
      if (existing !== undefined) {
        if (existing.status !== "inactive") return manual(state, "this managed-browser tab Surface is not available for activation");
        return activateExistingChild(state, parentSurface, existing);
      }
      child = {
        surfaceId: allocateSurfaceId(state.nextSurfaceOrdinal),
        generation: 1,
        kind: "browser_tab",
        parentSurfaceId: parentSurface.surfaceId,
        tabId: evidence.tabId,
        hostGeneration: evidence.hostGeneration,
        status: "active",
      };
      break;
    }
    case "dom": {
      if (parentSurface.kind !== "browser_tab" || evidence.hostAttested !== true || !isNonEmptyIdentity(evidence.documentGeneration)) {
        return manual(state, "DOM Surface requires a Host-attested document generation under a browser tab");
      }
      const existing = [...state.surfaces.values()].find((surface) =>
        surface.kind === "dom" && surface.parentSurfaceId === parentSurface.surfaceId &&
        surface.documentGeneration === evidence.documentGeneration && surface.status !== "closed");
      if (existing !== undefined) {
        if (existing.status !== "inactive") return manual(state, "this managed-browser document Surface is not available for activation");
        return activateExistingChild(state, parentSurface, existing);
      }
      child = {
        surfaceId: allocateSurfaceId(state.nextSurfaceOrdinal),
        generation: 1,
        kind: "dom",
        parentSurfaceId: parentSurface.surfaceId,
        documentGeneration: evidence.documentGeneration,
        status: "active",
      };
      break;
    }
  }

  if (child === undefined) return manual(state, "child evidence did not identify a supported Surface kind");
  const inactiveParent: SurfaceRecord = {
    ...parentSurface,
    generation: parentSurface.generation + 1,
    status: "inactive",
  } as SurfaceRecord;
  const next = withSurfaces(state, [inactiveParent, child], {
    activeSurface: toSurfaceRef(child),
    nextSurfaceOrdinal: state.nextSurfaceOrdinal + 1,
  });
  return applied(next, toSurfaceRef(child));
}

/** Pop a verified child and reactivate its exact, freshly revalidated parent. */
export function popChild(
  state: SurfaceRegistryState,
  child: SurfaceRef,
  evidence: ChildPopEvidence,
): SurfaceMutation<SurfaceRef> {
  if (state.closed) return rejected(state, "ComputerSession is closed");
  const childSurface = getSurface(state, child);
  if (childSurface === undefined) return rejected(state, "child Surface reference is stale or unknown");
  if (state.activeSurface?.surfaceId !== child.surfaceId || state.activeSurface.generation !== child.generation ||
      state.activeSurface.kind !== child.kind || state.activeSurface.parentSurfaceId !== child.parentSurfaceId ||
      state.activeSurface.admissionSource !== child.admissionSource ||
      childSurface.status !== "active") {
    return rejected(state, "only the current active child Surface may be popped");
  }
  if (childSurface.parentSurfaceId === undefined) return rejected(state, "a root peer Surface cannot be popped");

  const parentSurface = state.surfaces.get(childSurface.parentSurfaceId);
  if (parentSurface === undefined || parentSurface.status === "closed" || parentSurface.status === "unknown") {
    return manual(state, "child parent is unavailable or unknown");
  }
  if (evidence.parent.surfaceId !== parentSurface.surfaceId || evidence.parent.generation !== parentSurface.generation ||
      evidence.parent.kind !== parentSurface.kind || evidence.parent.parentSurfaceId !== parentSurface.parentSurfaceId ||
      evidence.parent.admissionSource !== parentSurface.admissionSource ||
      evidence.parentRevalidated !== true || evidence.childAbsent !== true) {
    return manual(state, "pop requires fresh parent verification and proof that the child is absent");
  }

  const closedChild = closeSubtree(state, childSurface);
  const activeParent: SurfaceRecord = {
    ...parentSurface,
    generation: parentSurface.generation + 1,
    status: "active",
  } as SurfaceRecord;
  const updates = [...closedChild, activeParent];
  const next = withSurfaces(state, updates, { activeSurface: toSurfaceRef(activeParent) });
  return applied(next, toSurfaceRef(activeParent));
}

/** Deactivate a still-existing child, for example when the managed browser selects another tab. */
export function deactivateChild(
  state: SurfaceRegistryState,
  child: SurfaceRef,
  evidence: ChildDeactivationEvidence,
): SurfaceMutation<SurfaceRef> {
  if (state.closed) return rejected(state, "ComputerSession is closed");
  const childSurface = getSurface(state, child);
  if (childSurface === undefined) return rejected(state, "child Surface reference is stale or unknown");
  if (!isActiveSurface(state, childSurface)) return rejected(state, "only the current active child Surface may be deactivated");
  if (childSurface.parentSurfaceId === undefined) return rejected(state, "a root peer Surface cannot be deactivated as a child");
  if (isModalChild(childSurface)) return rejected(state, "a modal child Surface must be popped only after trusted absence evidence");
  const parentSurface = state.surfaces.get(childSurface.parentSurfaceId);
  if (parentSurface === undefined || parentSurface.status === "closed" || parentSurface.status === "unknown") {
    return manual(state, "child parent is unavailable or unknown");
  }
  if (evidence.parent.surfaceId !== parentSurface.surfaceId || evidence.parent.generation !== parentSurface.generation ||
      evidence.parent.kind !== parentSurface.kind || evidence.parent.parentSurfaceId !== parentSurface.parentSurfaceId ||
      evidence.parent.admissionSource !== parentSurface.admissionSource ||
      evidence.parentRevalidated !== true || evidence.childNoLongerActive !== true) {
    return manual(state, "child deactivation requires a fresh parent and exact evidence that the child is no longer active");
  }
  const inactiveChildren = generationSubtree(state, childSurface).map((surface) => ({
    ...surface,
    generation: surface.generation + 1,
    status: "inactive",
  }) as SurfaceRecord);
  const activeParent: SurfaceRecord = {
    ...parentSurface,
    generation: parentSurface.generation + 1,
    status: "active",
  } as SurfaceRecord;
  const next = withSurfaces(state, [...inactiveChildren, activeParent], { activeSurface: toSurfaceRef(activeParent) });
  return applied(next, toSurfaceRef(activeParent));
}

/** Advance an incarnation and every descendant so no old lineage ref survives. */
export function advanceSurfaceGeneration(
  state: SurfaceRegistryState,
  surface: SurfaceRef,
): SurfaceMutation<SurfaceRef> {
  if (state.closed) return rejected(state, "ComputerSession is closed");
  const root = getSurface(state, surface);
  if (root === undefined) return rejected(state, "Surface reference is stale or unknown");
  if (root.status === "unknown" || root.status === "closed") return manual(state, "unknown or closed Surface cannot advance in this ComputerSession");

  const updates = generationSubtree(state, root).map((record) => ({
    ...record,
    generation: record.generation + 1,
  }) as SurfaceRecord);
  const updatedRoot = updates.find((record) => record.surfaceId === root.surfaceId)!;
  const activeRecord = state.activeSurface === undefined ? undefined : getSurface(state, state.activeSurface);
  const activeDescendant = activeRecord === undefined
    ? undefined
    : updates.find((record) => record.surfaceId === activeRecord.surfaceId);
  const next = withSurfaces(state, updates, {
    ...(activeDescendant === undefined ? {} : { activeSurface: toSurfaceRef(activeDescendant) }),
  });
  return applied(next, toSurfaceRef(updatedRoot));
}

/** Mark an uncertain active lineage unknown and revoke its prior references. */
export function markSurfaceUnknown(
  state: SurfaceRegistryState,
  surface: SurfaceRef,
): SurfaceMutation<SurfaceRef> {
  if (state.closed) return rejected(state, "ComputerSession is closed");
  const root = getSurface(state, surface);
  if (root === undefined) return rejected(state, "Surface reference is stale or unknown");
  if (root.status === "closed") return rejected(state, "closed Surface cannot become unknown");

  const updates = generationSubtree(state, root).map((record) => ({
    ...record,
    generation: record.generation + 1,
    status: "unknown",
  }) as SurfaceRecord);
  const activeRecord = state.activeSurface === undefined ? undefined : getSurface(state, state.activeSurface);
  const activeUnknown = activeRecord === undefined
    ? undefined
    : updates.find((record) => record.surfaceId === activeRecord.surfaceId);
  const next = withSurfaces(state, updates, {
    ...(activeUnknown === undefined ? {} : { activeSurface: toSurfaceRef(activeUnknown) }),
  });
  const unknownRoot = updates.find((record) => record.surfaceId === root.surfaceId)!;
  return applied(next, toSurfaceRef(unknownRoot));
}

export function isCurrentSurfaceRef(state: SurfaceRegistryState, ref: SurfaceRef): boolean {
  if (state.closed) return false;
  const surface = state.surfaces.get(ref.surfaceId);
  return surface !== undefined && surface.kind === ref.kind && surface.status !== "closed" &&
    surface.generation === ref.generation && surface.parentSurfaceId === ref.parentSurfaceId &&
    surface.admissionSource === ref.admissionSource;
}

/** True only for the current active leaf and an executable parent lineage. */
export function isExecutableSurfaceRef(state: SurfaceRegistryState, ref: SurfaceRef): boolean {
  if (state.closed || state.activeSurface?.surfaceId !== ref.surfaceId ||
      state.activeSurface.generation !== ref.generation || state.activeSurface.kind !== ref.kind ||
      state.activeSurface.parentSurfaceId !== ref.parentSurfaceId ||
      state.activeSurface.admissionSource !== ref.admissionSource) return false;
  const surface = state.surfaces.get(ref.surfaceId);
  if (surface === undefined || surface.kind !== ref.kind || surface.status !== "active" ||
      surface.generation !== ref.generation || surface.parentSurfaceId !== ref.parentSurfaceId ||
      surface.admissionSource !== ref.admissionSource) return false;
  let parentId = surface.parentSurfaceId;
  while (parentId !== undefined) {
    const parent = state.surfaces.get(parentId);
    if (parent === undefined || parent.status === "closed" || parent.status === "unknown") return false;
    parentId = parent.parentSurfaceId;
  }
  return true;
}

/** Resolve a Surface to its real capture HWND; overlays never mint one. */
export function resolveNativeWindow(
  state: SurfaceRegistryState,
  ref: SurfaceRef,
): NativeWindowIdentity | undefined {
  if (!isCurrentSurfaceRef(state, ref)) return undefined;
  const surface = state.surfaces.get(ref.surfaceId);
  if (surface === undefined || surface.kind !== ref.kind || surface.status === "unknown") return undefined;
  return nativeWindowFor(state, surface);
}

/** Resolve a real display capture identity; native-window Surfaces return undefined. */
export function resolveDisplayId(state: SurfaceRegistryState, ref: SurfaceRef): string | undefined {
  if (!isCurrentSurfaceRef(state, ref)) return undefined;
  const surface = state.surfaces.get(ref.surfaceId);
  if (surface === undefined || surface.kind !== ref.kind || surface.status === "unknown") return undefined;
  return surface.kind === "desktop" ? surface.displayId : undefined;
}

/** Resolve the latest generation and kind for a known Surface after a transition. */
export function currentSurfaceRef(state: SurfaceRegistryState, surfaceId: SurfaceId): SurfaceRef | undefined {
  if (state.closed) return undefined;
  const surface = state.surfaces.get(surfaceId);
  return surface === undefined || surface.status === "closed" ? undefined : toSurfaceRef(surface);
}

/** Close the Run-owned registry and release every private surface binding/ref. */
export function closeSurfaceRegistry(state: SurfaceRegistryState): SurfaceRegistryState {
  if (state.closed) return state;
  return {
    computerSessionId: state.computerSessionId,
    surfaces: new Map(),
    nextSurfaceOrdinal: state.nextSurfaceOrdinal,
    closed: true,
  };
}

function nativeWindowFor(
  state: SurfaceRegistryState,
  surface: SurfaceRecord,
): NativeWindowIdentity | undefined {
  if (surface.kind === "desktop") return undefined;
  if (surface.kind === "native_window") return surface.nativeWindow;
  if (surface.parentSurfaceId === undefined) return undefined;
  const parent = state.surfaces.get(surface.parentSurfaceId);
  return parent === undefined || parent.status === "closed" || parent.status === "unknown"
    ? undefined
    : nativeWindowFor(state, parent);
}

function generationSubtree(state: SurfaceRegistryState, root: SurfaceRecord): SurfaceRecord[] {
  const included = new Set<SurfaceId>([root.surfaceId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const surface of state.surfaces.values()) {
      if (surface.parentSurfaceId !== undefined && included.has(surface.parentSurfaceId) && !included.has(surface.surfaceId)) {
        included.add(surface.surfaceId);
        changed = true;
      }
    }
  }
  return [...included].map((surfaceId) => state.surfaces.get(surfaceId)!).filter((surface) => surface.status !== "closed");
}

function closeSubtree(state: SurfaceRegistryState, root: SurfaceRecord): SurfaceRecord[] {
  return generationSubtree(state, root).map((surface) => ({
    ...surface,
    generation: surface.generation + 1,
    status: "closed",
  }) as SurfaceRecord);
}

function getSurface(state: SurfaceRegistryState, ref: SurfaceRef): SurfaceRecord | undefined {
  const surface = state.surfaces.get(ref.surfaceId);
  return surface !== undefined && surface.kind === ref.kind && surface.generation === ref.generation &&
    surface.parentSurfaceId === ref.parentSurfaceId && surface.admissionSource === ref.admissionSource &&
    surface.status !== "closed"
    ? surface
    : undefined;
}

function isActiveSurface(state: SurfaceRegistryState, surface: SurfaceRecord): boolean {
  return surface.status === "active" && state.activeSurface?.surfaceId === surface.surfaceId &&
    state.activeSurface.generation === surface.generation && state.activeSurface.kind === surface.kind &&
    state.activeSurface.parentSurfaceId === surface.parentSurfaceId &&
    state.activeSurface.admissionSource === surface.admissionSource;
}

function activateExistingChild(
  state: SurfaceRegistryState,
  parent: SurfaceRecord,
  child: SurfaceRecord,
): SurfaceMutation<SurfaceRef> {
  const inactiveParent: SurfaceRecord = {
    ...parent,
    generation: parent.generation + 1,
    status: "inactive",
  } as SurfaceRecord;
  const activeChildren = generationSubtree(state, child).map((surface) => ({
    ...surface,
    generation: surface.generation + 1,
  }) as SurfaceRecord);
  const activeChild = activeChildren.find((surface) => surface.surfaceId === child.surfaceId)!;
  const activeChildRecord = { ...activeChild, status: "active" } as SurfaceRecord;
  const updatedChildren = activeChildren.map((surface) => surface.surfaceId === child.surfaceId ? activeChildRecord : surface);
  const next = withSurfaces(state, [inactiveParent, ...updatedChildren], { activeSurface: toSurfaceRef(activeChildRecord) });
  return applied(next, toSurfaceRef(activeChildRecord));
}

function withSurfaces(
  state: SurfaceRegistryState,
  updates: readonly SurfaceRecord[],
  options: { readonly activeSurface?: SurfaceRef; readonly nextSurfaceOrdinal?: number } = {},
): SurfaceRegistryState {
  const surfaces = new Map(state.surfaces);
  for (const surface of updates) surfaces.set(surface.surfaceId, surface);
  return {
    computerSessionId: state.computerSessionId,
    surfaces,
    ...(options.activeSurface === undefined
      ? state.activeSurface === undefined ? {} : { activeSurface: state.activeSurface }
      : { activeSurface: options.activeSurface }),
    nextSurfaceOrdinal: options.nextSurfaceOrdinal ?? state.nextSurfaceOrdinal,
    closed: state.closed,
  };
}

function allocateSurfaceId(ordinal: number): SurfaceId {
  return `surface-${ordinal.toString(36)}` as SurfaceId;
}

function toSurfaceRef(surface: SurfaceRecord): SurfaceRef {
  return {
    surfaceId: surface.surfaceId,
    generation: surface.generation,
    kind: surface.kind,
    ...(surface.parentSurfaceId === undefined ? {} : { parentSurfaceId: surface.parentSurfaceId }),
    ...(surface.admissionSource === undefined ? {} : { admissionSource: surface.admissionSource }),
  };
}

function isModalChild(surface: SurfaceRecord): boolean {
  return isOwnedTransientSurface(surface);
}

/** Menu, popup, and dialog HWNDs share the same parent/generation/modal lifecycle. */
function isOwnedTransientSurface(surface: SurfaceRecord): boolean {
  return surface.parentSurfaceId !== undefined &&
    ((surface.kind === "overlay" && surface.interactionPolicy === "modal") ||
      (surface.kind === "native_window" && surface.interactionPolicy === "modal"));
}

function sameChildEvidence(
  state: SurfaceRegistryState,
  parent: SurfaceRecord,
  child: SurfaceRecord,
  evidence: TransientChildEvidence,
): boolean {
  if (child.kind === "overlay" && evidence.kind === "overlay") {
    const parentWindow = nativeWindowFor(state, parent);
    return parentWindow !== undefined && sameNativeWindow(evidence.nativeWindow, parentWindow) &&
      sameNativeWindow(evidence.owner, parentWindow) && evidence.rootRole === child.rootRole &&
      evidence.treeComplete === true && evidence.geometryVerified === true && evidence.visible === true &&
      evidence.rootSemanticsVerified === true && evidence.interactionPolicy === "modal";
  }
  if (child.kind === "native_window" && evidence.kind === "native_window") {
    const parentWindow = nativeWindowFor(state, parent);
    const relationOnly = "relationshipProof" in evidence;
    const rootRole = relationOnly ? undefined : evidence.rootRole;
    const rootSemanticsVerified = relationOnly ? false : evidence.rootSemanticsVerified;
    const rootRoleProof = rootSemanticsVerified === true && isNativeChildRootRole(rootRole) &&
      (rootRole === "dialog"
        ? evidence.frontmostEvidence === "exact_foreground" ||
          evidence.frontmostEvidence === "unique_owned_stack" && evidence.admissionSource === "win32_relationship_probe"
        : evidence.frontmostEvidence === "unique_owned_stack" ||
          evidence.frontmostEvidence === "exact_foreground" && evidence.admissionSource === "win32_relationship_probe");
    const relationshipProof = relationOnly && evidence.relationshipProof === evidence.frontmostEvidence &&
      evidence.admissionSource === "win32_relationship_probe";
    return parentWindow !== undefined && sameNativeWindow(evidence.owner, parentWindow) &&
      sameNativeWindow(evidence.nativeWindow, child.nativeWindow) && rootRole === child.rootRole &&
      evidence.visible === true && (rootRoleProof || relationshipProof) && evidence.interactionPolicy === "modal" &&
      (evidence.admissionSource ?? "owned_transient_window_root_proof") === child.admissionSource;
  }
  return false;
}

function copyNativeWindow(nativeWindow: NativeWindowIdentity): NativeWindowIdentity {
  return { pid: nativeWindow.pid, hwnd: nativeWindow.hwnd };
}

function isValidNativeWindowIdentity(value: NativeWindowIdentity): boolean {
  return typeof value === "object" && value !== null &&
    Number.isSafeInteger(value.pid) && value.pid > 0 && Number.isSafeInteger(value.hwnd) && value.hwnd > 0;
}

function sameNativeWindow(left: NativeWindowIdentity, right: NativeWindowIdentity): boolean {
  return isValidNativeWindowIdentity(left) && isValidNativeWindowIdentity(right) &&
    left.pid === right.pid && left.hwnd === right.hwnd;
}

function isOverlayRootRole(value: unknown): value is "menu" | "popup" {
  return value === "menu" || value === "popup";
}

function isNativeChildRootRole(value: unknown): value is "menu" | "popup" | "dialog" {
  return isOverlayRootRole(value) || value === "dialog";
}

function isNonEmptyIdentity(value: string): boolean {
  return value.trim().length > 0;
}

function applied<T>(state: SurfaceRegistryState, value: T): SurfaceMutation<T> {
  return { decision: "applied", state, value };
}

function manual<T = never>(state: SurfaceRegistryState, reason: string): SurfaceMutation<T> {
  return { decision: "manual", state, reason };
}

function rejected<T = never>(state: SurfaceRegistryState, reason: string): SurfaceMutation<T> {
  return { decision: "rejected", state, reason };
}
