import { describe, expect, it } from "vitest";
import type { RuntimeEvent, RunId, SurfaceId, SurfaceRef } from "@computer-harness/protocol";
import { canonicalizeSourceLinkedFinish, parseSourceLinkedFinishContractJson, validateSourceLinkedFinishContract } from "./source-linked-finish.js";

const runId = "source-linked-test" as RunId;
const surfaceRef: SurfaceRef = { surfaceId: "source-linked-surface" as SurfaceId, generation: 1, kind: "desktop" };

function observationEvent(overrides: { runId?: RunId; sessionId?: string; catalogSessionId?: string; elements?: unknown[] } = {}): RuntimeEvent {
  const eventRunId = overrides.runId ?? runId;
  const sessionId = overrides.sessionId ?? "session-1";
  const catalogSessionId = overrides.catalogSessionId ?? sessionId;
  const elements = overrides.elements ?? [{
    elementRef: "cpu-m6",
    role: "StaticText",
    source: "uia",
    name: "M6 12-core CPU",
    state: { enabled: false, selected: false },
    options: [{ text: "M6 12-core CPU", enabled: false }],
  }];
  const observation = {
    id: "observation-1",
    runId: eventRunId,
    computerSessionId: sessionId,
    capturedAt: "2026-10-12T00:00:01.000Z",
    surfaceRef,
    screenshot: { mediaType: "image/png", data: new Uint8Array([1]), assetId: "asset-1" },
    grounding: {
      version: "uia-catalog-v1",
      source: "uia",
      observationId: "observation-1",
      computerSessionId: catalogSessionId,
      surfaceRef,
      completeness: "partial",
      degraded: false,
      maxElements: 256,
      elements,
    },
  };
  return { type: "observation.created", runId: eventRunId, sequence: 10, eventId: "event-1", occurredAt: observation.capturedAt, observation } as unknown as RuntimeEvent;
}

function finishReport(fields: unknown[]) {
  return { version: "source-linked-finish-v1", fields };
}

const contract = { version: "source-linked-finish-v1", fields: [{ fieldId: "cpu", label: "CPU", required: true }] } as const;

describe("source-linked finish validation", () => {
  it("parses the explicit bounded contract and rejects oversized JSON before decoding", () => {
    expect(parseSourceLinkedFinishContractJson(JSON.stringify(contract))).toEqual(contract);
    expect(() => parseSourceLinkedFinishContractJson(" ".repeat(16_385))).toThrow(/size limit/u);
    expect(() => validateSourceLinkedFinishContract({
      version: "source-linked-finish-v1",
      fields: Array.from({ length: 33 }, (_, index) => ({ fieldId: `f${index}`, label: `Field ${index}`, required: false })),
    })).toThrow(/bounded source-linked-finish-v1/u);
  });

  it("renders from same-Run committed Observation data and preserves disabled/unselected qualifiers", () => {
    const event = observationEvent();
    const canonical = canonicalizeSourceLinkedFinish(
      finishReport([{ fieldId: "cpu", disposition: "source_bound", sources: [{ observationId: "observation-1", elementRef: "cpu-m6" }] }]),
      contract,
      [event],
      runId,
      11,
    );
    expect(canonical.summary).toContain("M6 12-core CPU");
    expect(canonical.summary).toContain("enabled=false");
    expect(canonical.summary).toContain("selected=false");
    expect(canonical.summary).toContain("disabled");
    expect(canonical.resultEvidence.fields[0]).toMatchObject({
      disposition: "source_bound",
      sources: [{ capturedAt: "2026-10-12T00:00:01.000Z", state: { enabled: false, selected: false } }],
    });
  });

  it("marks conflicting_sources as a model-reported label and never invents a Runtime comparison", () => {
    const canonical = canonicalizeSourceLinkedFinish(
      finishReport([{ fieldId: "cpu", disposition: "unknown", reason: "conflicting_sources" }]),
      contract,
      [],
      runId,
      1,
    );
    expect(canonical.summary).toContain("model-reported reason: conflicting_sources");
  });

  it("rejects an empty canonical result when all contract fields are optional", () => {
    const optionalContract = { version: "source-linked-finish-v1", fields: [{ fieldId: "note", label: "Note", required: false }] } as const;
    expect(() => canonicalizeSourceLinkedFinish(finishReport([]), optionalContract, [], runId, 1)).toThrow(/empty canonical result/u);
  });

  it.each([
    ["forged quote", finishReport([{ fieldId: "cpu", disposition: "source_bound", value: "M4", quote: "M4", sources: [{ observationId: "observation-1", elementRef: "cpu-m6" }] }]), [observationEvent()], /bounded list of references only/u],
    ["wrong Run", finishReport([{ fieldId: "cpu", disposition: "source_bound", sources: [{ observationId: "observation-1", elementRef: "cpu-m6" }] }]), [observationEvent({ runId: "another-run" as RunId })], /missing, future, ambiguous/u],
    ["missing observation reference", finishReport([{ fieldId: "cpu", disposition: "source_bound", sources: [{ observationId: "observation-other", elementRef: "cpu-m6" }] }]), [observationEvent()], /missing, future, ambiguous/u],
    ["wrong session", finishReport([{ fieldId: "cpu", disposition: "source_bound", sources: [{ observationId: "observation-1", elementRef: "cpu-m6" }] }]), [observationEvent({ catalogSessionId: "session-other" })], /identity is inconsistent/u],
    ["future event", finishReport([{ fieldId: "cpu", disposition: "source_bound", sources: [{ observationId: "observation-1", elementRef: "cpu-m6" }] }]), [observationEvent()], /missing, future, ambiguous/u],
    ["missing required field", finishReport([]), [observationEvent()], /omitted a required field/u],
  ] as const)("rejects %s", (_label, report, events, message) => {
    expect(() => canonicalizeSourceLinkedFinish(report, contract, events, runId, _label === "future event" ? 10 : 11)).toThrow(message);
  });

  it("rejects over-bound aggregate output before any terminal event can be persisted", () => {
    const manyFields = Array.from({ length: 32 }, (_, index) => ({ fieldId: `f${index}`, label: `Field ${index}`, required: true }));
    const wideContract = validateSourceLinkedFinishContract({ version: "source-linked-finish-v1", fields: manyFields })!;
    const elements = Array.from({ length: 4 }, (_, index) => ({
      elementRef: `ref-${index}`,
      role: "Text",
      source: "uia",
      name: "x".repeat(160),
      description: "d".repeat(240),
      options: Array.from({ length: 4 }, (_, optionIndex) => ({ text: `${optionIndex}${"o".repeat(158)}`, enabled: true })),
    }));
    const report = finishReport(manyFields.map((field, index) => ({
      fieldId: field.fieldId,
      disposition: "source_bound",
      sources: Array.from({ length: 4 }, (_, sourceIndex) => ({ observationId: "observation-1", elementRef: `ref-${sourceIndex}` })),
    })));
    expect(() => canonicalizeSourceLinkedFinish(report, wideContract, [observationEvent({ elements })], runId, 11)).toThrow(/size limit/u);
  });
});
