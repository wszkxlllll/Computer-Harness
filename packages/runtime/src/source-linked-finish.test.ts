import { describe, expect, it } from "vitest";
import type { RuntimeEvent, RunId, SurfaceId, SurfaceRef } from "@computer-harness/protocol";
import { createDefaultToolRegistry } from "./control-tools.js";
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
  it("registers its terminate schema once and keeps the default terminate schema unchanged", () => {
    const defaultRegistry = createDefaultToolRegistry();
    const defaultFinishes = defaultRegistry.list().filter((tool) => tool.control === "finish");
    expect(defaultFinishes).toHaveLength(1);
    expect(defaultFinishes[0]?.name).toBe("terminate");
    expect(defaultFinishes[0]?.description).toMatch(/Call exactly once, as the only tool call in the ModelTurn/u);
    expect(defaultFinishes[0]?.description).toContain("Both arguments are required");
    expect(defaultFinishes[0]?.description).toContain("status is success or failure");
    expect(defaultFinishes[0]?.description).toContain("text is the complete user-facing result");
    expect(defaultFinishes[0]?.description).toContain("preserving verified partial results and each unknown with its reason");
    expect(defaultFinishes[0]?.description).toContain("A successful tool receipt is not proof of completion");
    expect(JSON.stringify(defaultFinishes[0]?.inputSchema)).not.toContain("resultEvidence");

    const registry = createDefaultToolRegistry({ sourceLinkedFinish: contract });
    const finishes = registry.list().filter((tool) => tool.control === "finish");
    expect(finishes).toHaveLength(1);
    expect(finishes[0]?.name).toBe("terminate");
    const schema = finishes[0]?.inputSchema as { properties?: Record<string, unknown>; required?: string[] } | undefined;
    expect(schema?.properties).toHaveProperty("resultEvidence");
    expect(schema?.required).toEqual(["status", "text", "resultEvidence"]);
    expect(finishes[0]?.description).toContain("All three arguments are required");
    expect(finishes[0]?.description).toContain("resultEvidence");
    expect(finishes[0]?.description).toContain("they do not semantically verify claims");
    expect(registry.modelTools().filter((tool) => tool.name === "terminate")).toHaveLength(1);
  });

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
    expect(canonical.summary).toContain("当时已禁用");
    expect(canonical.summary).toContain("当时未选中");
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
    expect(canonical.summary).toContain("提交方说明来源有冲突；系统未独立比对");
  });

  it("renders a Chinese user result with time and uncertainty limits while preserving raw evidence", () => {
    const contract = validateSourceLinkedFinishContract({ version: "source-linked-finish-v1", fields: [
      { fieldId: "cpu", label: "处理器型号", required: true },
      { fieldId: "selection", label: "选中状态", required: true },
      { fieldId: "matches", label: "候选信息", required: true },
      { fieldId: "estimate", label: "推断信息", required: true },
      { fieldId: "availability", label: "供货状态", required: true },
      { fieldId: "sourceStatus", label: "来源状态", required: true },
      { fieldId: "partialOptions", label: "选项信息", required: true },
    ] })!;
    const event = observationEvent({ elements: [
      { elementRef: "cpu", role: "StaticText", source: "uia", name: "M6 12-core CPU", state: { enabled: false, selected: false } },
      { elementRef: "selection", role: "Button", source: "uia", name: "16 GB", state: { enabled: false, selected: false }, options: [{ text: "16 GB", enabled: false }], optionsTruncated: true },
      { elementRef: "match-a", role: "StaticText", source: "uia", name: "Store A model", state: { enabled: true } },
      { elementRef: "match-b", role: "StaticText", source: "dom", name: "Store B model", state: { enabled: true } },
      { elementRef: "partial-options", role: "ComboBox", source: "uia", name: "Capacity", optionsTruncated: true },
    ] });
    const canonical = canonicalizeSourceLinkedFinish(finishReport([
      { fieldId: "cpu", disposition: "source_bound", sources: [{ observationId: "observation-1", elementRef: "cpu" }] },
      { fieldId: "selection", disposition: "source_bound", sources: [{ observationId: "observation-1", elementRef: "selection" }] },
      { fieldId: "matches", disposition: "source_bound", sources: [
        { observationId: "observation-1", elementRef: "match-a" },
        { observationId: "observation-1", elementRef: "match-b" },
      ] },
      { fieldId: "estimate", disposition: "inference", reason: "inferred from the visible SKU label" },
      { fieldId: "availability", disposition: "unknown", reason: "not_observed" },
      { fieldId: "sourceStatus", disposition: "unknown", reason: "source_unavailable" },
      { fieldId: "partialOptions", disposition: "source_bound", sources: [{ observationId: "observation-1", elementRef: "partial-options" }] },
    ]), contract, [event], runId, 11);

    expect(canonical.summary).toContain("处理器型号：");
    expect(canonical.summary).toContain("界面观察记录于");
    expect(canonical.summary).toContain("尚未证实为当前状态");
    expect(canonical.summary).toContain("未选中");
    expect(canonical.summary).toContain("已禁用");
    expect(canonical.summary).toContain("多个来源，需复核");
    expect(canonical.summary).toContain("列表不完整");
    expect(canonical.summary).toContain("选项信息：界面文字“Capacity”；选项列表不完整");
    expect(canonical.summary).toContain("推断（未核实；提交方说明原文：inferred from the visible SKU label）");
    expect(canonical.summary).toContain("未知（未在引用的观察中看到相关信息）");
    expect(canonical.summary).toContain("来源状态：未知（所引用来源不可用）");
    expect(canonical.summary).not.toContain("来源状态：有效");
    expect(canonical.summary).not.toContain("role=");
    expect(canonical.summary).not.toContain("source=uia");
    expect(canonical.resultEvidence.fields).toMatchObject([
      { fieldId: "cpu", disposition: "source_bound", sources: [{ role: "StaticText", source: "uia", state: { enabled: false, selected: false }, capturedAt: "2026-10-12T00:00:01.000Z" }] },
      { fieldId: "selection", disposition: "source_bound", sources: [{ state: { enabled: false, selected: false }, options: [{ text: "16 GB", enabled: false }], optionsTruncated: true }] },
      { fieldId: "matches", disposition: "source_bound", reviewRequired: true, sources: [{ name: "Store A model" }, { name: "Store B model" }] },
      { fieldId: "estimate", disposition: "inference", reason: "inferred from the visible SKU label" },
      { fieldId: "availability", disposition: "unknown", reason: "not_observed" },
      { fieldId: "sourceStatus", disposition: "unknown", reason: "source_unavailable" },
      { fieldId: "partialOptions", disposition: "source_bound", sources: [{ name: "Capacity", optionsTruncated: true }] },
    ]);
  });

  it("reports an incomplete options list even when no option values were captured", () => {
    const event = observationEvent({ elements: [
      { elementRef: "partial-options", role: "ComboBox", source: "uia", name: "Capacity", optionsTruncated: true },
    ] });
    const canonical = canonicalizeSourceLinkedFinish(
      finishReport([{ fieldId: "cpu", disposition: "source_bound", sources: [{ observationId: "observation-1", elementRef: "partial-options" }] }]),
      contract,
      [event],
      runId,
      11,
    );

    expect(canonical.summary).toContain("选项列表不完整");
    expect(canonical.resultEvidence.fields[0]).toMatchObject({
      disposition: "source_bound",
      sources: [{ name: "Capacity", optionsTruncated: true }],
    });
    expect(canonical.resultEvidence.fields[0]?.disposition === "source_bound" && canonical.resultEvidence.fields[0].sources[0]).not.toHaveProperty("options");
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
