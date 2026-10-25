import { describe, expect, it } from "vitest";
import type { AssetId, ComputerSessionId, EventId, GroundingCatalog, ObservationFrame, ObservationId, RunId, RuntimeEvent, SurfaceId } from "@computer-harness/protocol";
import { createDefaultToolRegistry } from "@computer-harness/runtime";
import { DefaultContextCompiler } from "./compiler.js";

describe("stable source and progress guidance", () => {
  it("keeps concise source and progress-language guidance in the cacheable system prefix", async () => {
    const compiler = new DefaultContextCompiler(createDefaultToolRegistry(), {
      features: { planning: "off", memory: "off", batching: "off", monitor: "guidance" },
    });
    const compile = (runId: string, monitorText: string) => compiler.compile({
      runId: runId as RunId,
      goal: runId.endsWith("-zh") ? "请查阅来源并报告有证据支持的结论。" : `Review source ${runId} and report supported findings.`,
      recentEvents: [],
      features: { planning: "off", memory: "off", batching: "off", monitor: "guidance" },
      monitorGuidance: { text: monitorText, fingerprint: `fingerprint-${runId}` },
    }, new AbortController().signal);

    const first = await compile("source-guidance-run-a", "Inspect the newest image before acting.");
    const second = await compile("source-guidance-run-zh", "Earlier report is unverified; check current state.");

    expect(first.system).toContain("When a claim depends on source scope, preserve the relevant applicability limits");
    expect(first.system).toContain("Not found in inspected material is unknown for that scope, not absent everywhere.");
    expect(first.system).toContain("Separate directly observed facts from inference and uncertainty");
    expect(first.system).not.toContain("state which source, date/version, application, and channel");
    expect(first.system).toContain("For user-facing progress.summary notices, follow an explicit user language preference");
    expect(first.system).toContain("otherwise use the language of the user's Goal");
    expect(first.system).toContain("Do not switch to English just because tools, source pages, or interface text are in English");
    expect(first.system).toContain("does not require every response to use one language");
    expect(first.system).toBe(second.system);
    expect(first.contextBudget?.trace?.stablePrefixHash).toBe(second.contextBudget?.trace?.stablePrefixHash);
    expect(first.system).not.toContain("Low-confidence Monitor note");
    expect(JSON.stringify(first.messages)).toContain("Low-confidence Monitor note");
  });
});


const evidenceRunId = "source-evidence-run" as RunId;
function evidenceObservation(): ObservationFrame {
  const id = "source-evidence-observation" as ObservationId;
  const computerSessionId = "source-evidence-session" as ComputerSessionId;
  const surfaceRef = { surfaceId: "source-evidence-desktop" as SurfaceId, generation: 1, kind: "desktop" as const };
  const bbox = { x: 10, y: 20, width: 100, height: 30, coordinateSpace: "physical" as const };
  return {
    id, runId: evidenceRunId, computerSessionId, surfaceRef,
    capturedAt: "2026-10-23T12:00:00.000Z",
    viewport: { width: 800, height: 600, coordinateSpace: "physical" },
    screenshot: { assetId: "source-evidence-image" as AssetId, relativePath: "screenshots/current.png", mediaType: "image/png", byteLength: 1 },
    grounding: {
      version: "grounding-catalog-v2", source: "dom", observationId: id, computerSessionId, surfaceRef,
      pageUrl: "https://example.test/current-source", completeness: "partial", degraded: false, maxElements: 1,
      elements: [{ elementRef: "current-source-ref", role: "textbox", name: "Current field", source: "dom", browserRegion: "content" }],
      visibleText: {
        source: "dom-table-v1", scope: "current-viewport", completeness: "partial", truncated: true,
        limits: { maxRegions: 1, maxRows: 1, maxColumns: 1, maxCells: 1, maxCellCharacters: 100, maxCharacters: 100 },
        regions: [{ regionRef: "table-evidence-only", bbox, completeness: "partial", truncated: true,
          rows: [{ rowIndex: 0, cells: [{ columnIndex: 0, rowSpan: 1, columnSpan: 1, header: false, text: "2026年：１.２ µm", bbox }] }],
        }],
      },
    },
  };
}

async function compileEvidence(observation: ObservationFrame) {
  const event: RuntimeEvent = { type: "observation.created", observation, runId: evidenceRunId,
    eventId: "source-evidence-event" as EventId, sequence: 1, occurredAt: observation.capturedAt };
  return new DefaultContextCompiler(createDefaultToolRegistry()).compile({
    runId: evidenceRunId, goal: "报告当前来源中的精确值。", recentEvents: [event], latestObservation: observation,
    windowSwitchState: { options: [] },
    features: { planning: "off", memory: "off", batching: "off" },
  }, new AbortController().signal);
}

function messageText(input: Awaited<ReturnType<typeof compileEvidence>>): string {
  return input.messages.flatMap((message) => message.content.flatMap((block) => block.type === "text" ? [block.text] : [])).join("\n");
}

describe("current source evidence boundaries", () => {
  it("projects exact source URL and Unicode table text only as bounded read-only evidence", async () => {
    const input = await compileEvidence(evidenceObservation());
    const text = messageText(input);
    expect(text).toContain("Observed page URL source data:");
    expect(text).toContain("https://example.test/current-source");
    expect(text).toContain("2026年：１.２ µm");
    expect(text).toContain("Region labels are not elementRefs");
    expect(text).toContain("never whole-page coverage");
    expect(input.contextBudget?.trace?.visibleText).toMatchObject({ projected: true, truncated: true, candidateCellCount: 1, projectedCellCount: 1 });
  });

  it.each(["run", "observation", "session", "surface", "generation", "parent", "admission"])("does not project a %s-mismatched catalog as current source or target capability", async (mismatch) => {
    const observation = evidenceObservation();
    const catalog = observation.grounding!;
    const grounding: GroundingCatalog = {
      ...catalog,
      ...(mismatch === "observation" ? { observationId: "stale-observation" as ObservationId } : {}),
      ...(mismatch === "session" ? { computerSessionId: "other-session" as ComputerSessionId } : {}),
      surfaceRef: {
        ...catalog.surfaceRef,
        ...(mismatch === "surface" ? { surfaceId: "other-surface" as SurfaceId } : {}),
        ...(mismatch === "generation" ? { generation: 2 } : {}),
        ...(mismatch === "parent" ? { parentSurfaceId: "other-parent" as SurfaceId } : {}),
        ...(mismatch === "admission" ? { admissionSource: "macos_attached_sheet_proof" as const } : {}),
      },
    };
    const input = await compileEvidence({ ...observation, grounding, ...(mismatch === "run" ? { runId: "other-run" as RunId } : {}) });
    const text = messageText(input);
    expect(text).not.toContain("Observed page URL source data:");
    expect(text).not.toContain("2026年：１.２ µm");
    expect(text).not.toContain("current-source-ref");
    expect(text).not.toContain("Current observation grounding:");
    expect(text).toContain("Current observation has no usable UIA/DOM grounding catalog");
    expect(input.contextBudget?.trace?.visibleText).toMatchObject({ projected: false, omittedReason: "observation_mismatch", projectedCellCount: 0 });
  });

  it("does not create a wall-clock closing boundary when Runtime supplies none", async () => {
    const input = await compileEvidence(evidenceObservation());
    expect(messageText(input)).not.toContain("Runtime wall-clock budget:");
    expect(input.contextBudget?.trace?.wallClockBudget).toBeUndefined();
    expect(input.tools.some((tool) => tool.name === "click")).toBe(true);
  });
});
