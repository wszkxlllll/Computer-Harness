import type {
  GroundingCatalog,
  GroundingElement,
  ObservationFrame,
  RuntimeEvent,
  RunId,
  SourceLinkedFinishContract,
  SourceLinkedFinishEvidence,
  SourceLinkedFinishReport,
} from "@computer-harness/protocol";

const MAX_FIELDS = 32;
const MAX_SOURCES_PER_FIELD = 4;
const MAX_REPORT_BYTES = 16_384;
const MAX_CANONICAL_SUMMARY_BYTES = 16_384;
const MAX_CANONICAL_EVIDENCE_BYTES = 64_000;
const MAX_REPORTED_SUMMARY_BYTES = 16_384;
const MAX_PERSISTED_FINISH_PROOF_BYTES = 96_000;
const MAX_REASON_CHARS = 240;
const MAX_EXCERPT_CHARS = 2_048;

export interface CanonicalSourceLinkedFinish {
  readonly summary: string;
  readonly resultEvidence: SourceLinkedFinishEvidence;
}

type CanonicalSource = Extract<SourceLinkedFinishEvidence["fields"][number], { disposition: "source_bound" }>["sources"][number];

export function validateSourceLinkedFinishContract(
  input: unknown,
): SourceLinkedFinishContract | undefined {
  if (input === undefined) return undefined;
  if (!isRecord(input) || !hasExactKeys(input, ["version", "fields"]) ||
      input.version !== "source-linked-finish-v1" || !Array.isArray(input.fields) ||
      input.fields.length < 1 || input.fields.length > MAX_FIELDS) {
    throw new Error("source-linked finish contract must be a bounded source-linked-finish-v1 object");
  }
  const seen = new Set<string>();
  const fields = input.fields.map((field) => {
    if (!isRecord(field) || !hasExactKeys(field, ["fieldId", "label", "required"]) ||
        typeof field.fieldId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/u.test(field.fieldId) ||
        seen.has(field.fieldId) || typeof field.label !== "string" || field.label.trim().length === 0 ||
        field.label.length > 80 || /[\u0000-\u001f\u007f]/u.test(field.label) || typeof field.required !== "boolean") {
      throw new Error("source-linked finish contract contains an invalid or duplicate field");
    }
    seen.add(field.fieldId);
    return Object.freeze({ fieldId: field.fieldId, label: field.label, required: field.required });
  });
  return Object.freeze({ version: "source-linked-finish-v1", fields: Object.freeze(fields) });
}

export function parseSourceLinkedFinishContractJson(raw: string): SourceLinkedFinishContract {
  if (Buffer.byteLength(raw, "utf8") > MAX_REPORT_BYTES) throw new Error("source-linked finish contract exceeds its size limit");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("source-linked finish contract must be valid JSON");
  }
  const contract = validateSourceLinkedFinishContract(parsed);
  if (contract === undefined) throw new Error("source-linked finish contract is required");
  return contract;
}

export function isWellFormedSourceLinkedFinishReport(input: unknown): input is SourceLinkedFinishReport {
  if (!isRecord(input) || !hasExactKeys(input, ["version", "fields"]) || input.version !== "source-linked-finish-v1" ||
      !Array.isArray(input.fields) || input.fields.length > MAX_FIELDS) return false;
  return input.fields.every((entry) => {
    if (!isRecord(entry) || typeof entry.fieldId !== "string" || entry.fieldId.length === 0 || entry.fieldId.length > 64) return false;
    if (entry.disposition === "source_bound") {
      return hasExactKeys(entry, ["fieldId", "disposition", "sources"]) && Array.isArray(entry.sources) &&
        entry.sources.length >= 1 && entry.sources.length <= MAX_SOURCES_PER_FIELD && entry.sources.every((reference) =>
          isRecord(reference) && hasExactKeys(reference, ["observationId", "elementRef"]) &&
          typeof reference.observationId === "string" && reference.observationId.length > 0 && reference.observationId.length <= 128 &&
          typeof reference.elementRef === "string" && reference.elementRef.length > 0 && reference.elementRef.length <= 96);
    }
    if (entry.disposition === "inference") return hasExactKeys(entry, ["fieldId", "disposition", "reason"]) && isBoundedReason(entry.reason);
    return entry.disposition === "unknown" && hasExactKeys(entry, ["fieldId", "disposition", "reason"]) && isUnknownReason(entry.reason);
  });
}

export function canonicalizeSourceLinkedFinish(
  input: unknown,
  contract: SourceLinkedFinishContract,
  events: readonly RuntimeEvent[],
  runId: RunId,
  finishResponseSequence: number,
  reportedSummary = "",
): CanonicalSourceLinkedFinish {
  const normalizedContract = validateSourceLinkedFinishContract(contract);
  if (normalizedContract === undefined) throw new Error("source-linked finish is not enabled for this Run");
  if (!isRecord(input) || !hasExactKeys(input, ["version", "fields"]) ||
      input.version !== "source-linked-finish-v1" || !Array.isArray(input.fields) ||
      input.fields.length > MAX_FIELDS || Buffer.byteLength(JSON.stringify(input), "utf8") > MAX_REPORT_BYTES) {
    throw new Error("source-linked finish report has an invalid shape or exceeds its size limit");
  }

  const contractById = new Map(normalizedContract.fields.map((field) => [field.fieldId, field]));
  const reports = new Map<string, Record<string, unknown>>();
  for (const entry of input.fields) {
    if (!isRecord(entry) || typeof entry.fieldId !== "string" || !contractById.has(entry.fieldId) || reports.has(entry.fieldId)) {
      throw new Error("source-linked finish report contains an unknown or duplicate field");
    }
    reports.set(entry.fieldId, entry);
  }
  for (const field of normalizedContract.fields) {
    if (field.required && !reports.has(field.fieldId)) throw new Error("source-linked finish report omitted a required field");
  }

  const canonicalFields: SourceLinkedFinishEvidence["fields"][number][] = [];
  for (const field of normalizedContract.fields) {
    const report = reports.get(field.fieldId);
    if (report === undefined) continue;
    const disposition = report.disposition;
    if (disposition === "source_bound") {
      if (!hasExactKeys(report, ["fieldId", "disposition", "sources"]) || !Array.isArray(report.sources) ||
          report.sources.length < 1 || report.sources.length > MAX_SOURCES_PER_FIELD) {
        throw new Error("source-bound evidence must contain a bounded list of references only");
      }
      const seenRefs = new Set<string>();
      const sources = report.sources.map((reference) => {
        if (!isRecord(reference) || !hasExactKeys(reference, ["observationId", "elementRef"]) ||
            typeof reference.observationId !== "string" || reference.observationId.length === 0 ||
            typeof reference.elementRef !== "string" || reference.elementRef.length === 0 || reference.elementRef.length > 96) {
          throw new Error("source-bound evidence contains a malformed observation reference");
        }
        const refKey = `${reference.observationId}\u0000${reference.elementRef}`;
        if (seenRefs.has(refKey)) throw new Error("source-bound evidence repeats an observation element reference");
        seenRefs.add(refKey);
        const element = findCommittedElement(events, runId, finishResponseSequence, reference.observationId, reference.elementRef);
        return renderCanonicalSource(element.observation, element.catalog, element.element);
      });
      canonicalFields.push({ fieldId: field.fieldId, label: field.label, disposition, sources, reviewRequired: sources.length > 1 });
    } else if (disposition === "inference") {
      if (!hasExactKeys(report, ["fieldId", "disposition", "reason"]) || !isBoundedReason(report.reason)) {
        throw new Error("inference evidence requires a bounded reason and no value");
      }
      canonicalFields.push({ fieldId: field.fieldId, label: field.label, disposition, reason: report.reason });
    } else if (disposition === "unknown") {
      if (!hasExactKeys(report, ["fieldId", "disposition", "reason"]) || !isUnknownReason(report.reason)) {
        throw new Error("unknown evidence requires a supported reason and no value");
      }
      canonicalFields.push({ fieldId: field.fieldId, label: field.label, disposition, reason: report.reason });
    } else {
      throw new Error("source-linked finish report contains an unsupported disposition");
    }
  }

  const resultEvidence: SourceLinkedFinishEvidence = { version: "source-linked-finish-v1", fields: canonicalFields };
  const summary = canonicalFields.map((field) => {
    if (field.disposition === "source_bound") {
      const review = field.reviewRequired ? " (multiple sources; review required)" : "";
      return `${field.label}: ${field.sources.map((source) => source.excerpt).join(" || ")}${review}`;
    }
    if (field.disposition === "inference") return `${field.label}: Inference (unverified): ${field.reason}`;
    const reasonLabel = field.reason === "conflicting_sources" ? "model-reported reason: conflicting_sources" : field.reason;
    return `${field.label}: Unknown (${reasonLabel})`;
  }).join("\n");
  if (summary.trim().length === 0) throw new Error("source-linked finish report produced an empty canonical result");
  if (Buffer.byteLength(summary, "utf8") > MAX_CANONICAL_SUMMARY_BYTES ||
      Buffer.byteLength(JSON.stringify(resultEvidence), "utf8") > MAX_CANONICAL_EVIDENCE_BYTES ||
      Buffer.byteLength(reportedSummary, "utf8") > MAX_REPORTED_SUMMARY_BYTES ||
      Buffer.byteLength(summary, "utf8") + Buffer.byteLength(JSON.stringify(resultEvidence), "utf8") + Buffer.byteLength(reportedSummary, "utf8") > MAX_PERSISTED_FINISH_PROOF_BYTES) {
    throw new Error("canonical source-linked result exceeds the persisted summary or evidence size limit");
  }
  return { summary, resultEvidence };
}

function findCommittedElement(
  events: readonly RuntimeEvent[],
  runId: RunId,
  finishResponseSequence: number,
  observationId: string,
  elementRef: string,
): { observation: ObservationFrame; catalog: GroundingCatalog; element: GroundingElement } {
  const matches: Array<{ observation: ObservationFrame; catalog: GroundingCatalog; element: GroundingElement }> = [];
  for (const event of events) {
    if (event.type !== "observation.created" || event.runId !== runId || event.sequence >= finishResponseSequence) continue;
    const observation = event.observation;
    const catalog = observation.grounding;
    if (String(observation.id) !== observationId || catalog === undefined) continue;
    if (String(observation.runId) !== String(runId) || String(catalog.observationId) !== String(observation.id) ||
        String(catalog.computerSessionId) !== String(observation.computerSessionId) ||
        !sameSurfaceRef(observation.surfaceRef, catalog.surfaceRef)) {
      throw new Error("committed Observation grounding identity is inconsistent");
    }
    for (const element of catalog.elements) {
      if (element.elementRef === elementRef) matches.push({ observation, catalog, element });
    }
  }
  if (matches.length !== 1) throw new Error("source reference is missing, future, ambiguous, or outside the retained Observation projection");
  const match = matches[0]!;
  const source = match.element.source ?? (match.catalog.source === "uia" || match.catalog.source === "dom" ? match.catalog.source : undefined);
  if (source !== "uia" && source !== "dom") throw new Error("source reference has no verified UIA or DOM provenance");
  return match;
}

function renderCanonicalSource(
  observation: ObservationFrame,
  catalog: GroundingCatalog,
  element: GroundingElement,
): CanonicalSource {
  const source = element.source ?? (catalog.source === "uia" || catalog.source === "dom" ? catalog.source : undefined);
  if (source !== "uia" && source !== "dom") throw new Error("source reference has no verified UIA or DOM provenance");
  const parts = [`role=${element.role}`, `source=${source}`];
  if (element.name !== undefined) parts.push(`name=${element.name}`);
  if (element.description !== undefined) parts.push(`description=${element.description}`);
  if (element.state !== undefined) {
    for (const key of ["enabled", "focused", "editable", "expanded", "selected", "valuePresent"] as const) {
      const value = element.state[key];
      if (value !== undefined) parts.push(`${key}=${String(value)}`);
    }
  }
  if (element.options !== undefined) {
    parts.push(`options=${element.options.map((option) => `${option.text}:${option.enabled ? "enabled" : "disabled"}`).join(" | ")}`);
  }
  if (element.optionsTruncated === true) parts.push("optionsTruncated=true");
  if (element.textFormat !== undefined) parts.push(`textFormat=${JSON.stringify(element.textFormat)}`);
  return {
    observationId: observation.id,
    capturedAt: observation.capturedAt,
    surfaceRef: structuredClone(observation.surfaceRef),
    elementRef: element.elementRef,
    source,
    role: element.role,
    ...(element.name === undefined ? {} : { name: element.name }),
    ...(element.description === undefined ? {} : { description: element.description }),
    ...(element.state === undefined ? {} : { state: structuredClone(element.state) }),
    ...(element.options === undefined ? {} : { options: structuredClone(element.options) }),
    ...(element.optionsTruncated === undefined ? {} : { optionsTruncated: element.optionsTruncated }),
    ...(element.textFormat === undefined ? {} : { textFormat: structuredClone(element.textFormat) }),
    excerpt: boundedExcerpt(parts),
  };
}

function boundedExcerpt(parts: readonly string[]): string {
  const excerpt = parts.join("; ");
  if (Buffer.byteLength(excerpt, "utf8") > MAX_EXCERPT_CHARS) {
    throw new Error("source element is too large for a complete canonical excerpt");
  }
  return excerpt;
}

function sameSurfaceRef(left: ObservationFrame["surfaceRef"], right: ObservationFrame["surfaceRef"]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isBoundedReason(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= MAX_REASON_CHARS;
}

function isUnknownReason(value: unknown): value is "not_observed" | "no_grounding" | "ambiguous_source" | "conflicting_sources" | "source_unavailable" {
  return value === "not_observed" || value === "no_grounding" || value === "ambiguous_source" ||
    value === "conflicting_sources" || value === "source_unavailable";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}
