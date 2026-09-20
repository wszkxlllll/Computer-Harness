import type { GroundingCatalog, GroundingElement, GroundingSelectionTrace } from "@computer-harness/protocol";

/** Query material available at observation commit time; no provider call is made. */
export interface GroundingSelectionQuery {
  readonly goal: string;
  readonly latestUserCorrections: readonly string[];
  readonly activePlanText?: string;
}

export interface GroundingSelector {
  select(catalog: GroundingCatalog, query: GroundingSelectionQuery): GroundingCatalog;
}

export const DEFAULT_GROUNDING_HOT_LIMIT = 16;

/**
 * Selects the small, model-facing UIA hot set without coupling Computer to
 * Context or a Provider. Lexical matches are deliberately deterministic and
 * cheap; state hints only break ties between otherwise similar controls.
 */
export class DeterministicGroundingSelector implements GroundingSelector {
  public constructor(private readonly hotLimit = DEFAULT_GROUNDING_HOT_LIMIT) {
    if (!Number.isInteger(hotLimit) || hotLimit < 1 || hotLimit > DEFAULT_GROUNDING_HOT_LIMIT) {
      throw new Error(`grounding hotLimit must be an integer between 1 and ${DEFAULT_GROUNDING_HOT_LIMIT}`);
    }
  }

  public select(catalog: GroundingCatalog, query: GroundingSelectionQuery): GroundingCatalog {
    const candidates = [...catalog.elements];
    const queryTerms = new Set(tokenize([query.goal, ...query.latestUserCorrections, query.activePlanText ?? ""].join(" ")));
    const ranked = candidates.map((element, index) => scoreElement(element, index, queryTerms))
      .sort((left, right) => right.score - left.score || left.index - right.index || left.element.elementRef.localeCompare(right.element.elementRef));
    const selected = ranked.slice(0, Math.min(this.hotLimit, catalog.maxElements, candidates.length));
    const reasons = selected.map(({ element, reasonCodes }) => ({ elementRef: element.elementRef, codes: reasonCodes }));
    const selection: GroundingSelectionTrace = {
      strategy: "deterministic-lexical-v1",
      candidateElementCount: catalog.selection?.candidateElementCount ?? candidates.length,
      selectedElementRefs: selected.map(({ element }) => element.elementRef),
      truncated: selected.length < candidates.length || catalog.selection?.truncated === true,
      reasons,
    };
    return {
      ...catalog,
      maxElements: Math.min(this.hotLimit, catalog.maxElements),
      elements: selected.map(({ element }) => element),
      selection,
    };
  }
}

interface ScoredElement {
  readonly element: GroundingElement;
  readonly index: number;
  readonly score: number;
  readonly reasonCodes: readonly string[];
}

function scoreElement(element: GroundingElement, index: number, queryTerms: ReadonlySet<string>): ScoredElement {
  // Role is a low-information accessibility type (e.g. every browser tab is
  // a TabItem), so it must not create a lexical goal match. It only receives a
  // tiny interactive fallback bonus below.
  const lexicalFields = [element.name, element.description].filter((value): value is string => value !== undefined);
  const fieldTerms = new Set(lexicalFields.flatMap(tokenize));
  const matched = [...queryTerms].filter((term) => fieldTerms.has(term));
  const phraseMatch = queryTerms.size > 0 && lexicalFields.some((field) => {
    const normalized = field.toLocaleLowerCase();
    return [...queryTerms].some((term) => term.length > 1 && normalized.includes(term));
  });
  const reasonCodes: string[] = [];
  let score = 0;
  if (matched.length > 0) {
    score += matched.length * 1000;
    reasonCodes.push("query_match");
  }
  if (phraseMatch) {
    score += 400;
    reasonCodes.push("query_substring_match");
  }
  if (queryTerms.size === 0 && /^(button|checkbox|combobox|edit|listitem|menuitem|tab|tabitem|textfield|textbox)$/iu.test(element.role)) {
    score += 2;
    reasonCodes.push("interactive_role");
  }
  if (element.state?.focused === true) {
    score += 90;
    reasonCodes.push("focused");
  }
  if (element.state?.editable === true) {
    score += 80;
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
  if (element.state?.enabled === false) {
    // Keep disabled evidence visible when it is relevant, but never make it
    // executable: click_element and the adapter enforce that invariant.
    score -= matched.length > 0 ? 5 : 100;
    reasonCodes.push("disabled_evidence");
  }
  if (reasonCodes.length === 0) reasonCodes.push("stable_fallback");
  return { element, index, score, reasonCodes };
}

function tokenize(value: string): string[] {
  const normalized = value.toLocaleLowerCase();
  const tokens: string[] = [];
  for (const match of normalized.matchAll(/[\p{Script=Han}]+|[\p{L}\p{N}]+/gu)) {
    const valuePart = match[0];
    if (/^\p{Script=Han}+$/u.test(valuePart)) {
      // Two/three-character grams avoid the one-character false positives
      // common in browser chrome (e.g. a generic tab named only "站").
      for (const size of [2, 3]) {
        if (valuePart.length < size) continue;
        for (let index = 0; index <= valuePart.length - size; index += 1) {
          tokens.push(valuePart.slice(index, index + size));
        }
      }
    } else if (valuePart.length >= 2) {
      tokens.push(valuePart);
    }
  }
  return [...new Set(tokens)];
}
