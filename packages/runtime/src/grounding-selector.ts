import type {
  GroundingCatalog,
  GroundingCatalogSource,
  GroundingElement,
  GroundingElementSource,
  GroundingRecoveryHint,
  GroundingSelectionTrace,
} from "@computer-harness/protocol";

/** Bounded, internal hint from an enabled structured-control tool. */
export interface GroundingStructuredToolHint {
  readonly toolName: string;
  readonly preferredRoles: readonly string[];
  readonly preferredSources: readonly GroundingElementSource[];
}

/** Query material available at observation commit time; no provider call is made. */
export interface GroundingSelectionQuery {
  readonly goal: string;
  readonly latestUserCorrections: readonly string[];
  readonly activePlanText?: string;
  /** Union of roles advertised by the structured tool hints below. */
  readonly preferredRoles?: readonly string[];
  /** Structured tool hints are produced only from the current enabled registry. */
  readonly structuredToolHints?: readonly GroundingStructuredToolHint[];
  /** Normal-path short-lived execution intent. Separate from global Plan and
   * Monitor recovery so ranking cannot confuse their lifecycles. */
  readonly localExecutionIntent?: string;
  /** Optional short-lived Monitor evidence; it never schedules a retry. */
  readonly recoveryHint?: GroundingRecoveryHint;
}

export interface GroundingSelectorOptions {
  readonly hotLimit?: number;
  /** Maximum candidates reserved for the latest failed-action neighborhood. */
  readonly localQuota?: number;
  /** Maximum candidates reserved for focused/editable controls. */
  readonly focusedEditableQuota?: number;
  /** Maximum candidates admitted solely as a global background fallback. */
  readonly globalQuota?: number;
  /** Maximum structured-control candidates reserved inside the hot set. */
  readonly structuredControlQuota?: number;
  readonly dedupeIoU?: number;
}

export interface GroundingSelector {
  select(catalog: GroundingCatalog, query: GroundingSelectionQuery): GroundingCatalog;
}

export const DEFAULT_GROUNDING_HOT_LIMIT = 16;
const DEFAULT_LOCAL_QUOTA = 6;
const DEFAULT_FOCUSED_EDITABLE_QUOTA = 4;
const DEFAULT_GLOBAL_QUOTA = 4;
const DEFAULT_STRUCTURED_CONTROL_QUOTA = 2;
const MAX_STRUCTURED_CONTROL_QUOTA = 4;
const DEFAULT_DEDUPE_IOU = 0.55;
const MAX_SELECTION_REASON_CODES = 8;
const SPECIFIC_MATCH_REASON_CODES = new Set([
  "local_recovery_region",
  "recovery_intent_match",
  "correction_match",
  "plan_match",
  "goal_match",
  "structured_control",
]);
const REASON_CODE_PRIORITY = [
  "local_recovery_region",
  "recovery_intent_match",
  "correction_match",
  "plan_match",
  "goal_match",
  "structured_control",
  "focused",
  "editable",
  "dom_content_priority",
  "uia_chrome_priority",
  "disabled_evidence",
  "expanded",
  "enabled_named",
  "bounded",
  "stable_fallback",
  "query_match",
  "query_substring_match",
] as const;

/**
 * Deterministic, bounded UIA/DOM fusion. The selector is deliberately owned
 * by Runtime: Computer adapters produce safe candidates, while Context and
 * Providers continue to consume one GroundingCatalog and one click_element
 * tool. The selector never executes, retries or performs a browser query.
 */
export class DeterministicGroundingSelector implements GroundingSelector {
  private readonly options: Required<GroundingSelectorOptions>;

  public constructor(hotLimitOrOptions: number | GroundingSelectorOptions = DEFAULT_GROUNDING_HOT_LIMIT, options?: GroundingSelectorOptions) {
    const requested = typeof hotLimitOrOptions === "number"
      ? { ...(options ?? {}), hotLimit: hotLimitOrOptions }
      : hotLimitOrOptions;
    const hotLimit = requested.hotLimit ?? DEFAULT_GROUNDING_HOT_LIMIT;
    if (!Number.isInteger(hotLimit) || hotLimit < 1 || hotLimit > DEFAULT_GROUNDING_HOT_LIMIT) {
      throw new Error(`grounding hotLimit must be an integer between 1 and ${DEFAULT_GROUNDING_HOT_LIMIT}`);
    }
    const localQuota = boundedQuota(requested.localQuota, DEFAULT_LOCAL_QUOTA, hotLimit);
    const focusedEditableQuota = boundedQuota(requested.focusedEditableQuota, DEFAULT_FOCUSED_EDITABLE_QUOTA, hotLimit);
    const globalQuota = boundedQuota(requested.globalQuota, DEFAULT_GLOBAL_QUOTA, hotLimit);
    const structuredControlQuota = boundedQuota(
      requested.structuredControlQuota,
      DEFAULT_STRUCTURED_CONTROL_QUOTA,
      Math.min(hotLimit, MAX_STRUCTURED_CONTROL_QUOTA),
    );
    const dedupeIoU = requested.dedupeIoU ?? DEFAULT_DEDUPE_IOU;
    if (!Number.isFinite(dedupeIoU) || dedupeIoU < 0 || dedupeIoU > 1) {
      throw new Error("grounding dedupeIoU must be between 0 and 1");
    }
    this.options = { hotLimit, localQuota, focusedEditableQuota, globalQuota, structuredControlQuota, dedupeIoU };
  }

  public select(catalog: GroundingCatalog, query: GroundingSelectionQuery): GroundingCatalog {
    const candidates = [...catalog.elements];
    const unique = deduplicateCandidates(candidates, catalog.source, this.options.dedupeIoU);
    const terms = weightedQueryTerms(query);
    const structuredHints = normalizeStructuredToolHints(query);
    const ranked = unique.map((element, index) => scoreElement(element, index, catalog.source, terms, query.recoveryHint, structuredHints))
      .sort(compareScoredElements);
    const limit = Math.min(this.options.hotLimit, catalog.maxElements, unique.length);
    const selected = boundedFusion(ranked, limit, this.options, catalog.source);
    const selectedRefs = selected.map(({ element }) => element.elementRef);
    const reasons = selected.map(({ element, reasonCodes }) => ({ elementRef: element.elementRef, codes: compressReasonCodes(reasonCodes) }));
    const recovery = query.recoveryHint === undefined
      ? undefined
      : {
          reason: query.recoveryHint.reason,
          attempt: normalizeAttempt(query.recoveryHint.attempt),
          regionApplied: ranked.some((candidate) => candidate.local),
          localIntentApplied: query.recoveryHint.localIntent !== undefined && tokenize(query.recoveryHint.localIntent).length > 0,
          ...(query.recoveryHint.localIntentSource === undefined ? {} : { localIntentSource: query.recoveryHint.localIntentSource }),
          ...(query.recoveryHint.actionId === undefined ? {} : { actionId: query.recoveryHint.actionId }),
        };
    const selection: GroundingSelectionTrace = {
      // Keep the old trace label for UIA-only catalogs so existing UIA traces
      // remain readable; DOM and hybrid catalogs explicitly identify fusion.
      strategy: catalog.source === "uia" && query.recoveryHint === undefined
        ? "deterministic-lexical-v1"
        : "bounded-fusion-v1",
      candidateElementCount: catalog.selection?.candidateElementCount ?? candidates.length,
      selectedElementRefs: selectedRefs,
      truncated: selected.length < unique.length || catalog.selection?.truncated === true,
      reasons,
      sourceCounts: sourceCounts(candidates, catalog.source),
      deduplicatedElementCount: unique.length,
      ...(recovery === undefined ? {} : { recovery }),
    };
    return {
      ...catalog,
      maxElements: Math.min(this.options.hotLimit, catalog.maxElements),
      elements: selected.map(({ element }) => element),
      selection,
    };
  }
}

interface WeightedTerms {
  readonly goal: ReadonlySet<string>;
  readonly correction: ReadonlySet<string>;
  readonly plan: ReadonlySet<string>;
  readonly local: ReadonlySet<string>;
}

interface ScoredElement {
  readonly element: GroundingElement;
  readonly index: number;
  readonly score: number;
  readonly reasonCodes: readonly string[];
  readonly local: boolean;
  readonly intent: boolean;
  readonly focusedOrEditable: boolean;
  readonly structured: boolean;
}

interface NormalizedStructuredToolHint {
  readonly preferredRoles: ReadonlySet<string>;
  readonly preferredSources: ReadonlySet<GroundingElementSource>;
}

function weightedQueryTerms(query: GroundingSelectionQuery): WeightedTerms {
  return {
    // Goal is deliberately background context: corrections and the active
    // plan carry more weight when a local recovery hint is present.
    goal: new Set(tokenize(query.goal)),
    correction: new Set(tokenize(query.latestUserCorrections.join(" "))),
    plan: new Set(tokenize(query.activePlanText ?? "")),
    local: new Set(tokenize(query.localExecutionIntent ?? query.recoveryHint?.localIntent ?? "")),
  };
}

function normalizeStructuredToolHints(query: GroundingSelectionQuery): readonly NormalizedStructuredToolHint[] {
  const preferredRoles = new Set(
    (query.preferredRoles ?? [])
      .slice(0, 16)
      .map(normalizeStructuredRole)
      .filter((role) => role.length > 0),
  );
  const hints: NormalizedStructuredToolHint[] = [];
  for (const hint of (query.structuredToolHints ?? []).slice(0, 8)) {
    if (typeof hint.toolName !== "string" || hint.toolName.trim().length === 0) continue;
    const roles = new Set(
      [...preferredRoles, ...hint.preferredRoles.slice(0, 8).map(normalizeStructuredRole)]
        .filter((role) => role.length > 0),
    );
    const sources = new Set<GroundingElementSource>(
      hint.preferredSources.filter((source): source is GroundingElementSource => source === "dom" || source === "uia").slice(0, 2),
    );
    // A structured hint without both dimensions is not safe to project: a
    // role alone would turn every matching native control into a tool target.
    if (roles.size === 0 || sources.size === 0) continue;
    hints.push({ preferredRoles: roles, preferredSources: sources });
  }
  return hints;
}

function matchesStructuredControl(
  element: GroundingElement,
  catalogSource: GroundingCatalogSource,
  hints: readonly NormalizedStructuredToolHint[],
): boolean {
  if (hints.length === 0 || element.state?.enabled !== true || !hasUsableBoundingBox(element.bbox)) return false;
  const role = normalizeStructuredRole(element.role);
  const source = structuredElementSource(element, catalogSource);
  if (role.length === 0 || source === undefined) return false;
  return hints.some((hint) => hint.preferredRoles.has(role) && hint.preferredSources.has(source));
}

function normalizeStructuredRole(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase().replace(/[\s_-]+/gu, "").trim();
}

function structuredElementSource(element: GroundingElement, catalogSource: GroundingCatalogSource): GroundingElementSource | undefined {
  if (element.source === "dom" || element.source === "uia") return element.source;
  // A single-source catalog can safely provide the omitted provenance. A
  // hybrid catalog must carry explicit source metadata, otherwise UIA-only
  // elements could be mistaken for managed DOM controls.
  return catalogSource === "dom" || catalogSource === "uia" ? catalogSource : undefined;
}

function hasUsableBoundingBox(box: GroundingElement["bbox"]): boolean {
  return box !== undefined
    && box.coordinateSpace === "physical"
    && Number.isFinite(box.x)
    && Number.isFinite(box.y)
    && Number.isFinite(box.width)
    && Number.isFinite(box.height)
    && box.width > 0
    && box.height > 0;
}

function scoreElement(
  element: GroundingElement,
  index: number,
  catalogSource: GroundingCatalogSource,
  terms: WeightedTerms,
  recovery: GroundingRecoveryHint | undefined,
  structuredHints: readonly NormalizedStructuredToolHint[],
): ScoredElement {
  // Role is a low-information accessibility type, so it is not included in
  // lexical matching. This also avoids making every browser TabItem a goal hit.
  const lexicalFields = [element.name, element.description].filter((value): value is string => value !== undefined);
  const fieldTerms = new Set(lexicalFields.flatMap(tokenize));
  const correctionMatches = countMatches(fieldTerms, terms.correction);
  const planMatches = countMatches(fieldTerms, terms.plan);
  const localMatches = countMatches(fieldTerms, terms.local);
  const goalMatches = countMatches(fieldTerms, terms.goal);
  const phraseMatch = [...terms.correction, ...terms.plan, ...terms.local, ...terms.goal].some((term) =>
    term.length > 1 && lexicalFields.some((field) => field.toLocaleLowerCase().includes(term)));
  const local = recovery?.region !== undefined && element.bbox !== undefined
    ? nearbyOrOverlapping(element.bbox, recovery.region)
    : false;
  const reasonCodes: string[] = [];
  let score = 0;
  if (localMatches + correctionMatches + planMatches + goalMatches > 0) reasonCodes.push("query_match");
  if (local) {
    score += 4_000;
    reasonCodes.push("local_recovery_region");
  }
  if (localMatches > 0) {
    const localWeight = recovery === undefined
      ? 1_000
      : recovery.localIntentSource === "user_correction"
      ? 1_200
      : recovery.localIntentSource === "active_plan"
        ? 650
        : 300;
    score += localMatches * localWeight;
    reasonCodes.push("recovery_intent_match");
  }
  if (correctionMatches > 0) {
    score += correctionMatches * 900;
    reasonCodes.push("correction_match");
  }
  if (planMatches > 0) {
    score += planMatches * 500;
    reasonCodes.push("plan_match");
  }
  if (goalMatches > 0) {
    // Keep goal recall, but lower its priority than short-lived local intent.
    score += goalMatches * 120;
    reasonCodes.push("goal_match");
  }
  if (phraseMatch) {
    score += 80;
    reasonCodes.push("query_substring_match");
  }
  const structured = matchesStructuredControl(element, catalogSource, structuredHints);
  if (structured) {
    // The dedicated fusion quota provides bounded admission; this modest
    // score keeps ties deterministic without letting structured controls
    // replace a local recovery match in the main ranking.
    score += 1_500;
    reasonCodes.push("structured_control");
  }
  const focusedOrEditable = element.state?.focused === true || element.state?.editable === true;
  if (element.state?.focused === true) {
    score += 220;
    reasonCodes.push("focused");
  }
  if (element.state?.editable === true) {
    score += 200;
    reasonCodes.push("editable");
  }
  if (element.state?.expanded === true) {
    score += 30;
    reasonCodes.push("expanded");
  }
  if (element.state?.enabled === true && element.name !== undefined) {
    score += 20;
    reasonCodes.push("enabled_named");
  }
  if (element.bbox !== undefined) {
    score += 5;
    reasonCodes.push("bounded");
  }
  const source = element.source ?? inferElementSource(catalogSource);
  if (source === "dom" && element.browserRegion === "content") {
    score += 180;
    reasonCodes.push("dom_content_priority");
  } else if (source === "uia" && element.browserRegion === "chrome") {
    score += 180;
    reasonCodes.push("uia_chrome_priority");
  }
  if (element.state?.enabled === false) {
    // Preserve relevant disabled evidence, but never let it outrank an
    // executable local candidate. Adapter/runtime execution remains fail-closed.
    score -= local || goalMatches + correctionMatches + planMatches > 0 ? 5 : 100;
    reasonCodes.push("disabled_evidence");
  }
  if (reasonCodes.length === 0) reasonCodes.push("stable_fallback");
  return {
    element,
    index,
    score,
    reasonCodes,
    local,
    intent: localMatches + correctionMatches + planMatches + goalMatches > 0,
    focusedOrEditable,
    structured,
  };
}

function boundedFusion(
  ranked: readonly ScoredElement[],
  limit: number,
  options: Required<GroundingSelectorOptions>,
  catalogSource: GroundingCatalogSource,
): ScoredElement[] {
  if (limit <= 0) return [];
  const selected: ScoredElement[] = [];
  const used = new Set<string>();
  let selectedStructured = 0;
  const availableSources = new Set(ranked.map((candidate) => candidate.element.source ?? inferElementSource(catalogSource)));
  const sourceCaps = new Map<GroundingElementSource, number>();
  if (availableSources.size > 1) {
    const cap = Math.max(1, Math.ceil(limit / 2));
    sourceCaps.set("uia", cap);
    sourceCaps.set("dom", cap);
  } else {
    for (const source of availableSources) sourceCaps.set(source as GroundingElementSource, limit);
  }
  const selectedBySource = new Map<GroundingElementSource, number>();
  const take = (predicate: (candidate: ScoredElement) => boolean, quota: number, respectSourceCaps = true): void => {
    if (quota <= 0 || selected.length >= limit) return;
    for (const candidate of ranked) {
      if (selected.length >= limit || quota <= 0) break;
      if (used.has(candidate.element.elementRef) || !predicate(candidate)) continue;
      if (candidate.structured && selectedStructured >= options.structuredControlQuota) continue;
      const source = candidate.element.source ?? inferElementSource(catalogSource);
      if (respectSourceCaps && (selectedBySource.get(source) ?? 0) >= (sourceCaps.get(source) ?? limit)) continue;
      selected.push(candidate);
      used.add(candidate.element.elementRef);
      selectedBySource.set(source, (selectedBySource.get(source) ?? 0) + 1);
      if (candidate.structured) selectedStructured += 1;
      quota -= 1;
    }
  };
  // First spend a bounded local budget around the last failed point.
  take((candidate) => candidate.local, options.localQuota);
  // Reserve a very small slice for enabled, bounded controls whose role and
  // source match a structured tool. This never admits every select-like
  // element and remains subject to source fairness caps.
  take((candidate) => candidate.structured, options.structuredControlQuota);
  // Focus/editable controls retain a reserved slice even if their names are
  // absent from the current goal or correction.
  take((candidate) => candidate.focusedOrEditable, options.focusedEditableQuota);
  // Related global candidates get a small slice; the final fill is still
  // deterministic and bounded so a large DOM cannot crowd out UIA/visual use.
  take((candidate) => candidate.intent, Math.max(0, limit - selected.length - options.globalQuota));
  take(() => true, options.globalQuota);
  // Source caps are a fairness guard, not a hard total. Borrow any remaining
  // capacity when one source has fewer candidates or a high-confidence local
  // candidate from one source should not be crowded out by unrelated items.
  take(() => true, limit - selected.length, false);
  return selected;
}

/**
 * Keep the trace within the trajectory contract without losing the signals
 * that explain why a candidate was selected.  The generic query labels are
 * redundant whenever a concrete goal/plan/correction/recovery match exists,
 * so remove them before applying the hard eight-code cap.
 */
function compressReasonCodes(reasonCodes: readonly string[]): readonly string[] {
  const unique = [...new Set(reasonCodes)];
  const hasSpecificMatch = unique.some((code) => SPECIFIC_MATCH_REASON_CODES.has(code));
  const withoutGenericMatches = hasSpecificMatch
    ? unique.filter((code) => code !== "query_match" && code !== "query_substring_match")
    : unique;
  if (withoutGenericMatches.length <= MAX_SELECTION_REASON_CODES) return withoutGenericMatches;
  const prioritized = REASON_CODE_PRIORITY.filter((code) => withoutGenericMatches.includes(code));
  const prioritizedSet = new Set<string>(prioritized);
  return [...prioritized, ...withoutGenericMatches.filter((code) => !prioritizedSet.has(code))].slice(0, MAX_SELECTION_REASON_CODES);
}

function deduplicateCandidates(
  candidates: readonly GroundingElement[],
  catalogSource: GroundingCatalogSource,
  threshold: number,
): GroundingElement[] {
  const unique: GroundingElement[] = [];
  for (const candidate of candidates) {
    const duplicateIndex = unique.findIndex((existing) => sameCandidate(existing, candidate, catalogSource, threshold));
    if (duplicateIndex < 0) {
      unique.push(candidate);
      continue;
    }
    const existing = unique[duplicateIndex]!;
    if (preferCandidate(candidate, existing, catalogSource)) unique[duplicateIndex] = candidate;
  }
  return unique;
}

function sameCandidate(
  left: GroundingElement,
  right: GroundingElement,
  catalogSource: GroundingCatalogSource,
  threshold: number,
): boolean {
  const leftRole = normalizeLabel(left.role);
  const rightRole = normalizeLabel(right.role);
  if (leftRole !== rightRole) return false;
  const leftName = normalizeLabel(left.name ?? "");
  const rightName = normalizeLabel(right.name ?? "");
  if (leftName !== rightName && leftName !== "" && rightName !== "") return false;
  const overlap = bboxIoU(left.bbox, right.bbox);
  if (overlap < threshold) return false;
  const leftSource = left.source ?? inferElementSource(catalogSource);
  const rightSource = right.source ?? inferElementSource(catalogSource);
  // Only two explicitly known, conflicting browser regions are kept apart.
  // Missing region metadata must not prevent a high-IoU cross-source merge;
  // DOM content then wins through preferCandidate below.
  if (leftSource !== rightSource && left.browserRegion !== undefined && right.browserRegion !== undefined && left.browserRegion !== right.browserRegion) return false;
  return true;
}

function preferCandidate(candidate: GroundingElement, existing: GroundingElement, catalogSource: GroundingCatalogSource): boolean {
  const candidateSource = candidate.source ?? inferElementSource(catalogSource);
  const existingSource = existing.source ?? inferElementSource(catalogSource);
  if (candidate.browserRegion === "content" && candidateSource === "dom" && !(existing.browserRegion === "content" && existingSource === "dom")) return true;
  if (candidate.browserRegion === "chrome" && candidateSource === "uia" && !(existing.browserRegion === "chrome" && existingSource === "uia")) return true;
  if (candidate.state?.focused === true && existing.state?.focused !== true) return true;
  if (candidate.state?.editable === true && existing.state?.editable !== true) return true;
  if (candidate.state?.enabled === true && existing.state?.enabled !== true) return true;
  return false;
}

function sourceCounts(candidates: readonly GroundingElement[], catalogSource: GroundingCatalogSource): Readonly<Partial<Record<GroundingElementSource, number>>> {
  const counts: Partial<Record<GroundingElementSource, number>> = {};
  for (const candidate of candidates) {
    const source = candidate.source ?? inferElementSource(catalogSource);
    counts[source] = (counts[source] ?? 0) + 1;
  }
  return counts;
}

function inferElementSource(source: GroundingCatalogSource): GroundingElementSource {
  return source === "dom" ? "dom" : "uia";
}

function compareScoredElements(left: ScoredElement, right: ScoredElement): number {
  return right.score - left.score || left.index - right.index || left.element.elementRef.localeCompare(right.element.elementRef);
}

function countMatches(fields: ReadonlySet<string>, query: ReadonlySet<string>): number {
  let count = 0;
  for (const term of query) if (fields.has(term)) count += 1;
  return count;
}

function nearbyOrOverlapping(left: { x: number; y: number; width: number; height: number }, right: { x: number; y: number; width: number; height: number }): boolean {
  if (bboxIoU(left, right) > 0) return true;
  const leftX = left.x + left.width / 2;
  const leftY = left.y + left.height / 2;
  const rightX = right.x + right.width / 2;
  const rightY = right.y + right.height / 2;
  return Math.hypot(leftX - rightX, leftY - rightY) <= 96;
}

function bboxIoU(
  left: { x: number; y: number; width: number; height: number } | undefined,
  right: { x: number; y: number; width: number; height: number } | undefined,
): number {
  if (left === undefined || right === undefined) return 0;
  const overlapWidth = Math.max(0, Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x));
  const overlapHeight = Math.max(0, Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y));
  const intersection = overlapWidth * overlapHeight;
  const union = left.width * left.height + right.width * right.height - intersection;
  return union <= 0 ? 0 : intersection / union;
}

function boundedQuota(value: number | undefined, fallback: number, limit: number): number {
  if (value === undefined || !Number.isSafeInteger(value) || value < 0) return Math.min(fallback, limit);
  return Math.min(value, limit);
}

function normalizeAttempt(value: number): number {
  return Number.isSafeInteger(value) && value > 0 ? Math.min(value, 3) : 1;
}

function normalizeLabel(value: string): string {
  return value
    .toLocaleLowerCase()
    .normalize("NFKC")
    .replace(/[\u0000-\u001F\u007F]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function tokenize(value: string): string[] {
  const normalized = value.toLocaleLowerCase();
  const tokens: string[] = [];
  for (const match of normalized.matchAll(/[\p{Script=Han}]+|[\p{L}\p{N}]+/gu)) {
    const valuePart = match[0];
    if (/^\p{Script=Han}+$/u.test(valuePart)) {
      // Two/three-character grams avoid one-character false positives common
      // in browser chrome (for example a generic tab named only "站").
      for (const size of [2, 3]) {
        if (valuePart.length < size) continue;
        for (let index = 0; index <= valuePart.length - size; index += 1) tokens.push(valuePart.slice(index, index + size));
      }
    } else if (valuePart.length >= 2) {
      tokens.push(valuePart);
    }
  }
  return [...new Set(tokens)];
}
