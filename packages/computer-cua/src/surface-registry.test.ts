import { describe, expect, it } from "vitest";
import {
  activatePeer,
  advanceSurfaceGeneration,
  closeSurfaceRegistry,
  createSurfaceRegistry,
  currentSurfaceRef,
  deactivateChild,
  isCurrentSurfaceRef,
  isExecutableSurfaceRef,
  markSurfaceUnknown,
  popChild,
  pushChild,
  registerNativePeer,
  registerDesktopSurface,
  resolveDisplayId,
  resolveNativeWindow,
  type NativeWindowIdentity,
  type SurfaceMutation,
  type SurfaceRef,
  type SurfaceRegistryState,
  type TransientChildEvidence,
} from "./surface-registry.js";

const BROWSER: NativeWindowIdentity = { pid: 410, hwnd: 4101 };
const WPS: NativeWindowIdentity = { pid: 420, hwnd: 4201 };

function value<T>(result: SurfaceMutation<T>): T {
  if (result.decision !== "applied") {
    throw new Error(`expected applied Surface transition, got ${result.decision}: ${result.reason}`);
  }
  return result.value;
}

function stateOf<T>(result: SurfaceMutation<T>): SurfaceRegistryState {
  if (result.decision !== "applied") {
    throw new Error(`expected applied Surface transition, got ${result.decision}: ${result.reason}`);
  }
  return result.state;
}

function registerPeer(state: SurfaceRegistryState, target: NativeWindowIdentity): { state: SurfaceRegistryState; ref: SurfaceRef } {
  const result = registerNativePeer(state, target);
  return { state: stateOf(result), ref: value(result) };
}

function activate(state: SurfaceRegistryState, ref: SurfaceRef, target: NativeWindowIdentity): SurfaceRegistryState {
  return stateOf(activatePeer(state, ref, {
    nativeWindow: target,
    identityVerified: true,
    captureVerified: true,
  }));
}

describe("SurfaceRegistry pure state machine", () => {
  it("switches explicit peers without changing the ComputerSessionId", () => {
    const initial = createSurfaceRegistry("computer-session-1");
    const browser = registerPeer(initial, BROWSER);
    const wps = registerPeer(browser.state, WPS);
    const withBrowser = activate(wps.state, browser.ref, BROWSER);
    const withWps = activate(withBrowser, wps.ref, WPS);

    expect(withWps.computerSessionId).toBe("computer-session-1");
    expect(withWps.activeSurface).toEqual(wps.ref);
    expect(withWps.surfaces.get(browser.ref.surfaceId)?.status).toBe("inactive");
    expect(withWps.surfaces.get(wps.ref.surfaceId)?.status).toBe("active");
    expect(isExecutableSurfaceRef(withWps, wps.ref)).toBe(true);
    expect(isExecutableSurfaceRef(withWps, browser.ref)).toBe(false);
  });

  it("switches from the real primary desktop Surface to a native peer without an HWND alias", () => {
    const desktopResult = registerDesktopSurface(createSurfaceRegistry("computer-session-desktop"), "primary");
    const desktop = value(desktopResult);
    const withDesktop = stateOf(desktopResult);
    const peer = registerPeer(withDesktop, WPS);
    const activePeer = activate(peer.state, peer.ref, WPS);

    expect(resolveDisplayId(withDesktop, desktop)).toBe("primary");
    expect(resolveNativeWindow(withDesktop, desktop)).toBeUndefined();
    expect(activePeer.computerSessionId).toBe("computer-session-desktop");
    expect(activePeer.activeSurface).toEqual(peer.ref);
    expect(activePeer.surfaces.get(desktop.surfaceId)?.status).toBe("inactive");
  });

  it("pops a verified independent HWND child back to its parent", () => {
    const registered = registerPeer(createSurfaceRegistry("computer-session-2"), WPS);
    const parentState = activate(registered.state, registered.ref, WPS);
    const childTarget: NativeWindowIdentity = { pid: 420, hwnd: 4202 };
    const pushed = pushChild(parentState, registered.ref, {
      kind: "native_window",
      nativeWindow: childTarget,
      owner: WPS,
      rootRole: "dialog",
      visible: true,
      rootSemanticsVerified: true,
      interactionPolicy: "modal",
      frontmostEvidence: "exact_foreground",
    });
    const child = value(pushed);
    const childState = stateOf(pushed);
    const parentAfterPush = currentSurfaceRef(childState, registered.ref.surfaceId)!;
    expect(parentAfterPush.generation).toBe(registered.ref.generation + 1);
    expect(isCurrentSurfaceRef(childState, registered.ref)).toBe(false);
    const popped = popChild(childState, child, {
      parent: parentAfterPush,
      parentRevalidated: true,
      childAbsent: true,
    });
    const final = stateOf(popped);
    const freshParent = value(popped);

    expect(final.computerSessionId).toBe("computer-session-2");
    expect(freshParent.surfaceId).toBe(registered.ref.surfaceId);
    expect(freshParent.generation).toBe(parentAfterPush.generation + 1);
    expect(freshParent.kind).toBe("native_window");
    expect(final.activeSurface).toEqual(freshParent);
    expect(final.surfaces.get(registered.ref.surfaceId)?.status).toBe("active");
    expect(final.surfaces.get(child.surfaceId)).toMatchObject({ status: "closed", generation: child.generation + 1 });
    expect(isCurrentSurfaceRef(final, child)).toBe(false);
    expect(isCurrentSurfaceRef(final, registered.ref)).toBe(false);
    expect(isExecutableSurfaceRef(final, freshParent)).toBe(true);
  });

  it("keeps managed tab and DOM Surfaces under their browser window across peer round trips", () => {
    const browser = registerPeer(createSurfaceRegistry("computer-session-browser-lineage"), BROWSER);
    const wps = registerPeer(browser.state, WPS);
    const activeBrowser = activate(wps.state, browser.ref, BROWSER);
    const tabEvidence = { kind: "browser_tab", tabId: "tab-a", hostGeneration: "page-1", hostAttested: true } as const;
    const tabResult = pushChild(activeBrowser, browser.ref, tabEvidence);
    const tab = value(tabResult);
    expect(tab.parentSurfaceId).toBe(browser.ref.surfaceId);
    const domEvidence = { kind: "dom", documentGeneration: "document-1", hostAttested: true } as const;
    const domResult = pushChild(stateOf(tabResult), tab, domEvidence);
    const dom = value(domResult);
    expect(dom.parentSurfaceId).toBe(tab.surfaceId);
    const activeDom = stateOf(domResult);

    const activeWps = activate(activeDom, wps.ref, WPS);
    const returnedBrowser = activate(activeWps, currentSurfaceRef(activeWps, browser.ref.surfaceId)!, BROWSER);
    const returnedBrowserRef = currentSurfaceRef(returnedBrowser, browser.ref.surfaceId)!;
    const returnedTabResult = pushChild(returnedBrowser, returnedBrowserRef, tabEvidence);
    const returnedTab = value(returnedTabResult);
    const returnedDomResult = pushChild(stateOf(returnedTabResult), returnedTab, domEvidence);
    const final = stateOf(returnedDomResult);

    const returnedDom = value(returnedDomResult);
    expect(returnedTab.surfaceId).toBe(tab.surfaceId);
    expect(returnedTab.generation).toBeGreaterThan(tab.generation);
    expect(returnedDom.surfaceId).toBe(dom.surfaceId);
    expect(returnedDom.generation).toBeGreaterThan(dom.generation);
    expect(returnedDom.parentSurfaceId).toBe(returnedTab.surfaceId);
    expect(isCurrentSurfaceRef(final, dom)).toBe(false);
    expect(final.activeSurface).toEqual(returnedDom);
    expect(final.computerSessionId).toBe("computer-session-browser-lineage");
    expect(isExecutableSurfaceRef(final, returnedDom)).toBe(true);
  });

  it("deactivates a still-open managed document when fresh tab evidence selects elsewhere", () => {
    const browser = registerPeer(createSurfaceRegistry("computer-session-tab-switch"), BROWSER);
    const activeBrowser = activate(browser.state, browser.ref, BROWSER);
    const tabResult = pushChild(activeBrowser, browser.ref, {
      kind: "browser_tab", tabId: "tab-a", hostGeneration: "page-1", hostAttested: true,
    });
    const tab = value(tabResult);
    const domResult = pushChild(stateOf(tabResult), tab, {
      kind: "dom", documentGeneration: "document-1", hostAttested: true,
    });
    const dom = value(domResult);
    const stateWithDom = stateOf(domResult);
    const changedTab = deactivateChild(stateWithDom, dom, {
      parent: currentSurfaceRef(stateWithDom, tab.surfaceId)!,
      parentRevalidated: true,
      childNoLongerActive: true,
    });
    const final = stateOf(changedTab);

    expect(final.activeSurface?.surfaceId).toBe(tab.surfaceId);
    expect(final.activeSurface?.generation).toBeGreaterThan(tab.generation);
    expect(isCurrentSurfaceRef(final, tab)).toBe(false);
    expect(final.surfaces.get(dom.surfaceId)?.status).toBe("inactive");
    expect(isCurrentSurfaceRef(final, dom)).toBe(false);
    expect(isExecutableSurfaceRef(final, dom)).toBe(false);
  });

  it("rejects an old generation after a Surface and its lineage advance", () => {
    const registered = registerPeer(createSurfaceRegistry("computer-session-3"), BROWSER);
    const activeWindow = activate(registered.state, registered.ref, BROWSER);
    const tabResult = pushChild(activeWindow, registered.ref, {
      kind: "browser_tab",
      tabId: "tab-7",
      hostGeneration: "page-2",
      hostAttested: true,
    });
    const tab = value(tabResult);
    const withTab = stateOf(tabResult);
    const domResult = pushChild(withTab, tab, {
      kind: "dom",
      documentGeneration: "document-2",
      hostAttested: true,
    });
    const dom = value(domResult);
    const withDom = stateOf(domResult);

    const currentWindowRef = currentSurfaceRef(withDom, registered.ref.surfaceId)!;
    const advanced = advanceSurfaceGeneration(withDom, currentWindowRef);
    const newWindow = value(advanced);
    const final = stateOf(advanced);
    const currentTabRef = currentSurfaceRef(withDom, tab.surfaceId)!;
    const newTab = final.surfaces.get(tab.surfaceId)!;
    const newDom = final.surfaces.get(dom.surfaceId)!;

    expect(newWindow.generation).toBe(currentWindowRef.generation + 1);
    expect(newTab.generation).toBe(currentTabRef.generation + 1);
    expect(newDom.generation).toBe(dom.generation + 1);
    expect(final.activeSurface).toEqual({ ...dom, generation: dom.generation + 1 });
    expect(isCurrentSurfaceRef(final, dom)).toBe(false);
    expect(isExecutableSurfaceRef(final, dom)).toBe(false);
    expect(isExecutableSurfaceRef(final, final.activeSurface!)).toBe(true);
  });

  it("rejects a SurfaceRef whose opaque ID/generation is paired with the wrong kind", () => {
    const registered = registerPeer(createSurfaceRegistry("computer-session-kind-check"), BROWSER);
    const active = activate(registered.state, registered.ref, BROWSER);
    const forged = { ...registered.ref, kind: "overlay" as const };

    expect(isCurrentSurfaceRef(active, forged)).toBe(false);
    expect(isExecutableSurfaceRef(active, forged)).toBe(false);
    expect(activatePeer(active, forged, {
      nativeWindow: BROWSER,
      identityVerified: true,
      captureVerified: true,
    })).toMatchObject({ decision: "rejected" });
  });

  it("revokes an old primary-desktop ref when its generation changes", () => {
    const created = registerDesktopSurface(createSurfaceRegistry("computer-session-desktop-generation"), "primary");
    const oldRef = value(created);
    const advanced = advanceSurfaceGeneration(stateOf(created), oldRef);
    const newRef = value(advanced);

    expect(newRef.generation).toBe(oldRef.generation + 1);
    expect(isCurrentSurfaceRef(stateOf(advanced), oldRef)).toBe(false);
    expect(isExecutableSurfaceRef(stateOf(advanced), newRef)).toBe(true);
  });

  it("routes incomplete or ambiguous child evidence to manual handling without changing state", () => {
    const registered = registerPeer(createSurfaceRegistry("computer-session-4"), WPS);
    const active = activate(registered.state, registered.ref, WPS);
    const childTarget: NativeWindowIdentity = { pid: 420, hwnd: 4203 };
    const ambiguous = pushChild(active, registered.ref, {
      kind: "native_window",
      nativeWindow: childTarget,
      owner: WPS,
      rootRole: "dialog",
      visible: true,
      rootSemanticsVerified: true,
      interactionPolicy: "modal",
      frontmostEvidence: "unique_owned_stack",
    });
    const incomplete = pushChild(active, registered.ref, {
      kind: "incomplete",
      reason: "owner HWND was not reported",
    });

    expect(ambiguous.decision).toBe("rejected");
    expect(incomplete.decision).toBe("manual");
    expect(ambiguous.state).toBe(active);
    expect(incomplete.state).toBe(active);
    expect(ambiguous.state.surfaces.size).toBe(1);
    expect(ambiguous.state.activeSurface).toEqual(registered.ref);
  });

  it("does not mistake an arbitrary MenuItem descendant for an overlay or popup root Surface", () => {
    const registered = registerPeer(createSurfaceRegistry("computer-session-8"), BROWSER);
    const active = activate(registered.state, registered.ref, BROWSER);
    const nonRootOverlayRole = {
      kind: "overlay",
      nativeWindow: BROWSER,
      rootRole: "menuitem",
      treeComplete: true,
      geometryVerified: true,
    } as unknown as TransientChildEvidence;
    const nonRootPopupRole = {
      kind: "native_window",
      nativeWindow: { pid: 410, hwnd: 4102 },
      owner: BROWSER,
      rootRole: "menuitem",
      treeComplete: true,
      uniquelyFrontmost: true,
    } as unknown as TransientChildEvidence;
    const overlayResult = pushChild(active, registered.ref, nonRootOverlayRole);
    const popupResult = pushChild(active, registered.ref, nonRootPopupRole);

    expect(overlayResult.decision).toBe("rejected");
    expect(popupResult.decision).toBe("manual");
    expect(overlayResult.state).toBe(active);
    expect(popupResult.state).toBe(active);
    expect(overlayResult.state.surfaces.size).toBe(1);
    expect(overlayResult.state.activeSurface).toEqual(registered.ref);
  });

  it("represents a same-HWND overlay without inventing an HWND and resolves capture to its parent", () => {
    const registered = registerPeer(createSurfaceRegistry("computer-session-5"), BROWSER);
    const active = activate(registered.state, registered.ref, BROWSER);
    const pushed = pushChild(active, registered.ref, {
      kind: "overlay",
      nativeWindow: BROWSER,
      owner: BROWSER,
      rootRole: "menu",
      treeComplete: true,
      geometryVerified: true,
      visible: true,
      rootSemanticsVerified: true,
      interactionPolicy: "modal",
    });
    const overlay = value(pushed);
    const withOverlay = stateOf(pushed);
    const overlayRecord = withOverlay.surfaces.get(overlay.surfaceId)!;

    expect(overlayRecord.kind).toBe("overlay");
    expect("nativeWindow" in overlayRecord).toBe(false);
    expect(overlayRecord.parentSurfaceId).toBe(registered.ref.surfaceId);
    expect(overlay.admissionSource).toBe("same_hwnd_overlay_root_proof");
    expect(resolveNativeWindow(withOverlay, overlay)).toEqual(BROWSER);
    expect(withOverlay.computerSessionId).toBe("computer-session-5");
    expect(isCurrentSurfaceRef(withOverlay, {
      surfaceId: overlay.surfaceId,
      generation: overlay.generation,
      kind: overlay.kind,
      parentSurfaceId: overlay.parentSurfaceId!,
    })).toBe(false);
  });

  it("makes repeated same-HWND overlay detection idempotent and invalidates the parent frame", () => {
    const registered = registerPeer(createSurfaceRegistry("computer-session-overlay-repeat"), BROWSER);
    const active = activate(registered.state, registered.ref, BROWSER);
    const evidence = {
      kind: "overlay",
      nativeWindow: BROWSER,
      owner: BROWSER,
      rootRole: "menu",
      treeComplete: true,
      geometryVerified: true,
      visible: true,
      rootSemanticsVerified: true,
      interactionPolicy: "modal",
    } as const;
    const pushed = pushChild(active, registered.ref, evidence);
    const child = value(pushed);
    const afterPush = stateOf(pushed);
    const freshParent = currentSurfaceRef(afterPush, registered.ref.surfaceId)!;
    const repeatedFromParent = pushChild(afterPush, freshParent, evidence);
    const repeatedFromActive = pushChild(afterPush, child, evidence);

    expect(isCurrentSurfaceRef(afterPush, registered.ref)).toBe(false);
    expect(repeatedFromParent.decision).toBe("applied");
    expect(repeatedFromActive.decision).toBe("applied");
    expect(value(repeatedFromParent)).toEqual(child);
    expect(value(repeatedFromActive)).toEqual(child);
    expect(repeatedFromParent.state).toBe(afterPush);
    expect(repeatedFromActive.state).toBe(afterPush);
    expect(afterPush.surfaces.size).toBe(2);
    expect(afterPush.nextSurfaceOrdinal).toBe(3);
  });

  it("blocks peer activation and child deactivation behind an open modal until trusted pop", () => {
    const browser = registerPeer(createSurfaceRegistry("computer-session-modal-barrier"), BROWSER);
    const wps = registerPeer(browser.state, WPS);
    const activeBrowser = activate(wps.state, browser.ref, BROWSER);
    const childTarget: NativeWindowIdentity = { pid: 410, hwnd: 4102 };
    const pushed = pushChild(activeBrowser, browser.ref, {
      kind: "native_window",
      nativeWindow: childTarget,
      owner: BROWSER,
      rootRole: "dialog",
      visible: true,
      rootSemanticsVerified: true,
      interactionPolicy: "modal",
      frontmostEvidence: "exact_foreground",
    });
    const child = value(pushed);
    const childState = stateOf(pushed);
    expect(child.admissionSource).toBe("owned_transient_window_root_proof");
    const parentAfterPush = currentSurfaceRef(childState, browser.ref.surfaceId)!;
    const peerAttempt = activatePeer(childState, wps.ref, {
      nativeWindow: WPS,
      identityVerified: true,
      captureVerified: true,
    });
    const deactivationAttempt = deactivateChild(childState, child, {
      parent: parentAfterPush,
      parentRevalidated: true,
      childNoLongerActive: true,
    });

    expect(peerAttempt.decision).toBe("manual");
    expect(deactivationAttempt.decision).toBe("rejected");
    expect(peerAttempt.state).toBe(childState);
    expect(deactivationAttempt.state).toBe(childState);
    expect(childState.activeSurface).toEqual(child);

    const popped = popChild(childState, child, {
      parent: parentAfterPush,
      parentRevalidated: true,
      childAbsent: true,
    });
    const parentAfterPop = value(popped);
    const switched = activate(popped.state, wps.ref, WPS);
    expect(switched.activeSurface).toEqual(wps.ref);
    expect(parentAfterPop.generation).toBe(parentAfterPush.generation + 1);
  });

  it("records Win32 evidence on the same modal child lifecycle without creating a second registry", () => {
    const browser = registerPeer(createSurfaceRegistry("computer-session-win32-child"), BROWSER);
    const peer = registerPeer(browser.state, WPS);
    const activeParent = activate(peer.state, browser.ref, BROWSER);
    const childTarget: NativeWindowIdentity = { pid: BROWSER.pid, hwnd: 4109 };
    const pushed = pushChild(activeParent, browser.ref, {
      kind: "native_window",
      nativeWindow: childTarget,
      owner: BROWSER,
      rootRole: "dialog",
      visible: true,
      rootSemanticsVerified: true,
      interactionPolicy: "modal",
      frontmostEvidence: "exact_foreground",
      admissionSource: "win32_relationship_probe",
    });
    const child = value(pushed);
    const childState = stateOf(pushed);
    const parentAfterPush = currentSurfaceRef(childState, browser.ref.surfaceId)!;
    const blockedPeer = activatePeer(childState, peer.ref, {
      nativeWindow: WPS,
      identityVerified: true,
      captureVerified: true,
    });

    expect(child.admissionSource).toBe("win32_relationship_probe");
    expect(childState.surfaces.get(child.surfaceId)).toMatchObject({ interactionPolicy: "modal", parentSurfaceId: browser.ref.surfaceId });
    expect(blockedPeer.decision).toBe("manual");
    const popped = popChild(childState, child, {
      parent: parentAfterPush,
      parentRevalidated: true,
      childAbsent: true,
    });
    expect(value(popped).surfaceId).toBe(browser.ref.surfaceId);
    expect(stateOf(popped).computerSessionId).toBe(activeParent.computerSessionId);
  });

  it("marks an uncertain Surface unknown and revokes its old action reference", () => {
    const registered = registerPeer(createSurfaceRegistry("computer-session-6"), WPS);
    const active = activate(registered.state, registered.ref, WPS);
    const unknown = markSurfaceUnknown(active, registered.ref);
    const newRef = value(unknown);
    const final = stateOf(unknown);

    expect(newRef.generation).toBe(registered.ref.generation + 1);
    expect(final.surfaces.get(newRef.surfaceId)?.status).toBe("unknown");
    expect(final.activeSurface).toEqual(newRef);
    expect(isCurrentSurfaceRef(final, registered.ref)).toBe(false);
    expect(isExecutableSurfaceRef(final, newRef)).toBe(false);
    expect(resolveNativeWindow(final, newRef)).toBeUndefined();
  });

  it("clears every Surface and active ref when the ComputerSession closes", () => {
    const created = registerDesktopSurface(createSurfaceRegistry("computer-session-7"), "primary");
    const desktop = value(created);
    const active = stateOf(created);
    const closed = closeSurfaceRegistry(active);

    expect(closed.computerSessionId).toBe("computer-session-7");
    expect(closed.closed).toBe(true);
    expect(closed.surfaces.size).toBe(0);
    expect(closed.activeSurface).toBeUndefined();
    expect(isCurrentSurfaceRef(closed, desktop)).toBe(false);
    expect(activatePeer(closed, desktop, {
      nativeWindow: BROWSER,
      identityVerified: true,
      captureVerified: true,
    })).toMatchObject({ decision: "rejected", state: closed });
  });
});
