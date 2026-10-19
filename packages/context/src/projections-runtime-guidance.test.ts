import { describe, expect, it } from "vitest";
import type {
  ComputerSessionDescriptor,
  ComputerSessionId,
  GroundingCatalog,
  ObservationId,
  SurfaceId,
  SurfaceRef,
} from "@computer-harness/protocol";
import { composeSystemPrompt, formatWindowSwitchState } from "./projections.js";

const sessionId = "projection-session" as ComputerSessionId;
const viewport = { width: 1440, height: 900, coordinateSpace: "physical" as const };
const desktopSurface: SurfaceRef = { surfaceId: "desktop-surface" as SurfaceId, generation: 1, kind: "desktop" };

function session(backend = "cua-driver-daemon"): ComputerSessionDescriptor {
  return {
    id: sessionId,
    backend,
    platform: "win32",
    viewport,
    capabilities: { screenshot: true, pointer: true, keyboard: true, accessibility: false },
    openedAt: "2026-10-18T00:00:00.000Z",
  };
}

const targetState = {
  currentWindow: { appName: "Managed Browser", title: "Current page" },
  options: [],
};

function grounding(overrides: Partial<GroundingCatalog> = {}): GroundingCatalog {
  return {
    version: "grounding-catalog-v2",
    source: "dom",
    observationId: "observation-current" as ObservationId,
    computerSessionId: sessionId,
    surfaceRef: desktopSurface,
    completeness: "partial",
    degraded: false,
    maxElements: 1,
    elements: [{ elementRef: "managed-browser-search", role: "textbox", name: "Search", source: "dom", browserRegion: "content" }],
    ...overrides,
  };
}

function desktopProjection(catalog: GroundingCatalog | undefined): string {
  return formatWindowSwitchState(session(), targetState, catalog, viewport, "desktop") ?? "";
}

describe("runtime projections for action effects and desktop grounding", () => {
  it("defines ordinary navigation/edit effects and prevents approval claims without Runtime evidence", () => {
    const text = composeSystemPrompt("Base prompt", {
      planning: "off",
      memory: "off",
      batching: "off",
      riskGuard: "layered",
    });
    expect(text).toContain("Use navigate for ordinary page or view navigation");
    expect(text).toContain("use local_edit for focusing ordinary input controls or reversible edits that do not submit");
    expect(text).toContain("Runtime controls approvals");
    expect(text).toContain("A screenshot that does not show an approval cannot establish that approval was unnecessary or did not occur");
    expect(text).toContain("unless explicit Runtime evidence says so, do not state whether approval occurred");
    expect(text).not.toContain("Never imply approval/safety");
  });

  it("classifies Planning and Memory as schema-only non-Computer tools for effect metadata", () => {
    const text = composeSystemPrompt("Base prompt", {
      planning: "tasks-v1",
      memory: "facts-v1",
      batching: "off",
      riskGuard: "layered",
    });
    expect(text).toContain("Planning and Memory tools are non-Computer tools");
    expect(text).toContain("pass only their declared arguments");
    expect(text).toContain("do not attach GUI effect metadata unless that specific schema explicitly declares it");
  });

  it("does not name disabled Planning or Memory features in effect guidance", () => {
    const planningOnly = composeSystemPrompt("Base prompt", {
      planning: "tasks-v1",
      memory: "off",
      batching: "off",
      riskGuard: "layered",
    });
    expect(planningOnly).toContain("Planning tools are non-Computer tools");
    expect(planningOnly).not.toContain("Memory tools are non-Computer tools");
    expect(planningOnly).not.toContain("Planning and Memory tools are non-Computer tools");

    const memoryOnly = composeSystemPrompt("Base prompt", {
      planning: "off",
      memory: "facts-v1",
      batching: "off",
      riskGuard: "layered",
    });
    expect(memoryOnly).toContain("Memory tools are non-Computer tools");
    expect(memoryOnly).not.toContain("Planning tools are non-Computer tools");
    expect(memoryOnly).not.toContain("Planning and Memory tools are non-Computer tools");

    const neither = composeSystemPrompt("Base prompt", {
      planning: "off",
      memory: "off",
      batching: "off",
      riskGuard: "layered",
    });
    expect(neither).toContain("Non-Computer tools are not GUI actions");
    expect(neither).not.toContain("Planning tools are non-Computer tools");
    expect(neither).not.toContain("Memory tools are non-Computer tools");
    expect(neither).not.toContain("Planning and Memory tools are non-Computer tools");
  });

  it("uses visual fallback on desktop when there is no catalog", () => {
    const text = desktopProjection(undefined);
    expect(text).toContain("visual-only");
    expect(text).toContain("do not attach a native-window UIA/DOM element scope");
    expect(text).toContain("full-primary-desktop screenshot");
    expect(text).toContain("Do not assume native UIA/DOM is available in desktop apps");
    expect(text).toContain("do not use element references or select_option");
  });

  it("uses visual fallback when the desktop catalog is marked unknown", () => {
    const text = desktopProjection(grounding({ completeness: "unknown" }));
    expect(text).toContain("visual-only");
    expect(text).toContain("full-primary-desktop screenshot");
    expect(text).toContain("Do not assume native UIA/DOM is available in desktop apps");
    expect(text).not.toContain("bounded grounding candidate list for the currently observed target");
  });

  it("scopes an actual desktop catalog to its current observation and target", () => {
    const text = desktopProjection(grounding());
    expect(text).toContain("bounded grounding candidate list for the currently observed target");
    expect(text).toContain("Use only refs exposed with this observation and target");
    expect(text).toContain("do not carry refs across observations or target changes");
    expect(text).toContain("full-desktop screenshot/input scope");
    expect(text).toContain("does not imply native UIA/DOM availability in other desktop apps");
    expect(text).toContain("source=dom, completeness=partial");
    expect(text).not.toContain("visual-only");
  });

  it("leaves the exact native-window capture guidance unchanged", () => {
    const text = formatWindowSwitchState(session(), targetState, undefined, viewport, "native_window") ?? "";
    expect(text).toContain("Current capture scope: the exact native window");
    expect(text).toContain("switch_window rebinds screenshot/input scope to the selected listed window");
    expect(text).not.toContain("full-primary-desktop screenshot");
    expect(text).not.toContain("no usable grounding candidates; target controls visually");
  });
});
