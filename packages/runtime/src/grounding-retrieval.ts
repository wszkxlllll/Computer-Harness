import type {
  GroundingBoundingBox,
  GroundingCatalog,
  GroundingElement,
  GroundingElementSource,
  GroundingRecoveryHint,
} from "@computer-harness/protocol";

export const GROUNDING_RETRIEVAL_VERSION = "semantic-grounding-v1";

/**
 * Query material used by the experimental retrieval pass.  It intentionally
 * mirrors the Runtime selector's query vocabulary so a later shadow caller
 * can share one query compiler without changing the current selector.
 */
export interface GroundingRetrievalQuery {
  readonly goal: string;
  readonly latestUserCorrections?: readonly string[];
  readonly activePlanText?: string;
  readonly localExecutionIntent?: string;
  readonly recoveryHint?: GroundingRecoveryHint;
}

/** The single normalized query structure consumed by cluster scoring. */
export interface NormalizedGroundingRetrievalQuery {
  readonly goal: string;
  readonly corrections: readonly string[];
  readonly plan: string;
  readonly localIntent: string;
  readonly recovery: string;
}

export type GroundingClusterRelation = "peer_alias" | "same_source_alias" | "nested_alias" | "actionable_containment_alias";
export type GroundingLabelStrength = "exact" | "strong";

/** Pairwise evidence retained for every accepted complete-link merge. */
export interface GroundingClusterEvidence {
  readonly leftRef: string;
  readonly rightRef: string;
  readonly relation: GroundingClusterRelation;
  readonly labelStrength: GroundingLabelStrength;
  readonly reasons: readonly string[];
  readonly iou?: number;
  readonly centerDistance?: number;
  readonly containment?: number;
  readonly areaRatio?: number;
}

/** A member retained as an alias of the chosen actionable representative. */
export interface GroundingClusterAlias {
  readonly elementRef: string;
  readonly relation: GroundingClusterRelation;
  readonly role: string;
  readonly source?: GroundingElementSource;
  readonly normalizedLabel?: string;
  readonly evidence: readonly GroundingClusterEvidence[];
}

/** One semantic target cluster.  `members` preserves all safe source fields. */
export interface SemanticGroundingCluster {
  readonly semanticClusterId: string;
  readonly rank: number;
  readonly score: number;
  readonly memberRefs: readonly string[];
  readonly members: readonly GroundingElement[];
  readonly representativeRef: string;
  readonly representative: GroundingElement;
  readonly aliases: readonly GroundingClusterAlias[];
  readonly evidence: readonly GroundingClusterEvidence[];
  readonly reasonCodes: readonly string[];
}

/** Full deterministic order.  Consumers may take any prefix without reranking. */
export interface GroundingRetrievalResult {
  readonly observationId: GroundingCatalog["observationId"];
  readonly computerSessionId: GroundingCatalog["computerSessionId"];
  readonly rawElementCount: number;
  readonly clusters: readonly SemanticGroundingCluster[];
}

/**
 * Pure, observation-local semantic grounding retrieval.  This class is
 * intentionally remains an independent retrieval utility; Runtime selectors
 * may adopt it explicitly when a future consumer is defined.
 */
export class DeterministicGroundingRetrieval {
  public retrieve(catalog: GroundingCatalog, query: GroundingRetrievalQuery): GroundingRetrievalResult {
    return retrieveGroundingClusters(catalog, query);
  }
}

/**
 * Build conservative semantic aliases and rank every resulting cluster.
 *
 * The function never calls a provider, reads another observation, emits
 * coordinates, or applies a K/source quota.  The returned `clusters` array is
 * the complete order; callers can take a bounded prefix without reranking.
 */
export function retrieveGroundingClusters(
  catalog: GroundingCatalog,
  query: GroundingRetrievalQuery,
): GroundingRetrievalResult {
  const normalizedQuery = normalizeGroundingRetrievalQuery(query);
  const prepared = catalog.elements
    .map((element) => prepareElement(element, catalog))
    .sort(comparePreparedElements);
  const clustered = agglomerate(prepared);
  const ranked = clustered
    .map((cluster) => scoreCluster(cluster, normalizedQuery, catalog))
    .sort(compareScoredClusters)
    .map((cluster, index) => ({ ...cluster, rank: index + 1 }));

  return {
    observationId: catalog.observationId,
    computerSessionId: catalog.computerSessionId,
    rawElementCount: catalog.elements.length,
    clusters: ranked,
  };
}

/** NFKC/case/space/punctuation normalization used for labels and query text. */
export function normalizeGroundingLabel(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[\u0000-\u001F\u007F]/gu, " ")
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

export function normalizeGroundingRetrievalQuery(query: GroundingRetrievalQuery): NormalizedGroundingRetrievalQuery {
  const corrections = uniqueNormalized(query.latestUserCorrections?.map(normalizeGroundingLabel) ?? []);
  const plan = normalizeGroundingLabel(query.activePlanText ?? "");
  const localIntent = normalizeGroundingLabel(query.localExecutionIntent ?? "");
  const recovery = normalizeGroundingLabel(
    [query.recoveryHint?.reason ?? "", query.recoveryHint?.localIntent ?? ""].filter((value) => value.length > 0).join(" "),
  );
  return {
    goal: normalizeGroundingLabel(query.goal),
    corrections,
    plan,
    localIntent,
    recovery,
  };
}

interface PreparedElement {
  readonly element: GroundingElement;
  readonly role: string;
  readonly roleGroup: ActionableRole | undefined;
  readonly source: ResolvedSource;
  readonly box: GroundingBoundingBox | undefined;
  readonly label: LabelInfo;
  readonly stableKey: string;
}

interface LabelInfo {
  readonly normalized: string;
  readonly stripped: string;
  readonly tokens: readonly string[];
  readonly meaningfulTokens: readonly string[];
}

/**
 * Coarse executable role families used only for conservative aliasing and
 * retrieval reliability.  These are intentionally families rather than a
 * public protocol enum: adapters may continue to report their native role
 * spelling and unknown roles remain unclassified.
 */
type ActionableRole =
  | "edit"
  | "link"
  | "button"
  | "checkbox"
  | "radio"
  | "combobox"
  | "listbox"
  | "menuitem"
  | "option"
  | "tab"
  | "switch"
  | "slider"
  | "spinbutton"
  | "treeitem"
  | "calendar";
type ResolvedSource = GroundingElementSource | "unknown";
type StaticRole = "text" | "statictext" | "static" | "label" | "span";

interface PairEvidence {
  readonly left: PreparedElement;
  readonly right: PreparedElement;
  readonly evidence: GroundingClusterEvidence;
  readonly quality: number;
}

interface WorkingCluster {
  readonly members: readonly PreparedElement[];
  readonly edges: readonly PairEvidence[];
}

interface ScoredCluster extends Omit<SemanticGroundingCluster, "rank"> {
  readonly sortKey: string;
}

/**
 * Role spellings are normalized before this table is consulted.  Keep this
 * list deliberately small: it covers common DOM and UIA names (including
 * the names emitted by UIA's AutomationControlType family), but does not
 * turn broad containers or arbitrary custom roles into executable leaves.
 */
const ACTIONABLE_ROLE_ALIASES: Readonly<Record<ActionableRole, readonly string[]>> = {
  edit: [
    "edit",
    "textbox",
    "editbox",
    "textfield",
    "textedit",
    "uiaedit",
    "uiatextbox",
    "uiaeditcontroltypeid",
    "uiatextboxcontroltypeid",
  ],
  link: [
    "hyperlink",
    "link",
    "hyperlinkcontrol",
    "uiahyperlink",
    "uialink",
    "uiahyperlinkcontroltypeid",
  ],
  button: [
    "pushbutton",
    "button",
    "commandbutton",
    "splitbutton",
    "uiabutton",
    "uiapushbutton",
    "uiabuttoncontroltypeid",
    "uiasplitbuttoncontroltypeid",
  ],
  checkbox: [
    "checkbox",
    "checkbutton",
    "uiacheckbox",
    "uiacheckboxcontroltypeid",
  ],
  radio: [
    "radio",
    "radiobutton",
    "optionbutton",
    "uiaradiobutton",
    "uiaradiobuttoncontroltypeid",
  ],
  combobox: [
    "combobox",
    "dropdown",
    "dropdownlist",
    "selectbox",
    "uicombobox",
    "uiacombobox",
    "uiacomboboxcontroltypeid",
  ],
  listbox: [
    "listbox",
    "uialistbox",
    "uialistcontroltypeid",
  ],
  menuitem: [
    "menuitem",
    "menuentry",
    "uiamenuitem",
    "uiamenuitemcontroltypeid",
  ],
  option: [
    "option",
    "listitem",
    "listoption",
    "uiaoption",
    "uiaoptioncontroltypeid",
    "uialistitem",
    "uialistitemcontroltypeid",
  ],
  tab: [
    "tab",
    "tabitem",
    "pagetab",
    "uiatab",
    "uiatabitem",
    "uiatabitemcontroltypeid",
  ],
  switch: [
    "switch",
    "toggle",
    "togglebutton",
    "uiaswitch",
    "uiatogglebutton",
    "uiatogglebuttoncontroltypeid",
  ],
  slider: [
    "slider",
    "range",
    "rangecontrol",
    "uiaslider",
    "uiaslidercontroltypeid",
  ],
  spinbutton: [
    "spinbutton",
    "spinner",
    "spincontrol",
    "uiaspinbutton",
    "uiaspinner",
    "uiaspinnercontroltypeid",
    "uiaspinbuttoncontroltypeid",
  ],
  treeitem: [
    "treeitem",
    "outlineitem",
    "uiatreeitem",
    "uiatreeitemcontroltypeid",
  ],
  calendar: [
    "calendar",
    "calendarcell",
    "datepicker",
    "datecell",
    "calendarday",
    "daycell",
    "dateitem",
    "gridcell",
    "uiacalendar",
    "uiacalendarcell",
    "uiacalendarcellcontroltypeid",
    "uiacalendarcontroltypeid",
    "uiadatepicker",
    "uiadatepickercontroltypeid",
  ],
};

/**
 * A static label may describe an actionable control without being an
 * independent click target.  Keep the historical nested-label aliases for
 * the original role families; new role families still receive DOM/UIA peer
 * aliases, but a generic label cannot accidentally hide a checkbox, option,
 * or calendar leaf.
 */
const STATIC_NESTED_ALIAS_ROLES: ReadonlySet<ActionableRole> = new Set([
  "edit",
  "link",
  "button",
]);

const STATIC_ROLES: ReadonlySet<string> = new Set<StaticRole>([
  "text",
  "statictext",
  "static",
  "label",
  "span",
]);

const BROAD_ANCESTOR_ROLES: ReadonlySet<string> = new Set([
  "document",
  "window",
  "pane",
  "application",
  "root",
  "webarea",
  "frame",
  "region",
  "group",
]);

const LABEL_BOILERPLATE: ReadonlySet<string> = new Set([
  "button",
  "pushbutton",
  "link",
  "hyperlink",
  "edit",
  "textbox",
  "text",
  "field",
  "input",
  "control",
  "按钮",
  "链接",
  "超链接",
  "编辑",
  "文本框",
  "输入框",
  "控件",
]);

const CROSS_SOURCE_IOU = 0.72;
const SAME_SOURCE_IOU = 0.95;
const NESTED_CONTAINMENT = 0.90;
const MAX_NESTED_AREA_RATIO = 16;
const MAX_NESTED_CENTER_DISTANCE = 0.75;
/**
 * Actionable wrapper/inner aliases need stronger evidence than ordinary
 * overlap aliases. These values use only public bbox and coarse provenance;
 * no DOM/UIA parent identity is inferred.
 */
const ACTIONABLE_CONTAINMENT = 0.90;
const MAX_ACTIONABLE_AREA_RATIO = 16;
const MAX_ACTIONABLE_CENTER_DISTANCE = 0.75;
const SAME_SOURCE_ACTIONABLE_CONTAINMENT = 0.97;
const MAX_SAME_SOURCE_ACTIONABLE_AREA_RATIO = 4;
const MAX_SAME_SOURCE_ACTIONABLE_CENTER_DISTANCE = 0.25;

function prepareElement(element: GroundingElement, catalog: GroundingCatalog): PreparedElement {
  const role = normalizeRole(element.role);
  const label = labelInfo(element.name);
  const source = resolveSource(element, catalog);
  return {
    element,
    role,
    roleGroup: actionableRole(role),
    source,
    box: validBox(element.bbox),
    label,
    stableKey: stableElementKey(element, source),
  };
}

function agglomerate(elements: readonly PreparedElement[]): WorkingCluster[] {
  let clusters: WorkingCluster[] = elements.map((element) => ({ members: [element], edges: [] }));
  while (true) {
    let best: { left: number; right: number; edges: PairEvidence[]; quality: number; sortKey: string } | undefined;
    for (let leftIndex = 0; leftIndex < clusters.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < clusters.length; rightIndex += 1) {
        const leftCluster = clusters[leftIndex]!;
        const rightCluster = clusters[rightIndex]!;
        const edges: PairEvidence[] = [];
        let compatible = true;
        for (const left of leftCluster.members) {
          for (const right of rightCluster.members) {
            const pair = relationFor(left, right);
            if (pair === undefined) {
              compatible = false;
              break;
            }
            edges.push(pair);
          }
          if (!compatible) break;
        }
        if (!compatible || !safeClusterMerge(leftCluster, rightCluster, edges)) continue;
        const quality = Math.min(...edges.map((edge) => edge.quality));
        const sortKey = [clusterSortKey(leftCluster), clusterSortKey(rightCluster)].sort().join("\u001f");
        const candidate = { left: leftIndex, right: rightIndex, edges, quality, sortKey };
        if (best === undefined || compareMergeCandidates(candidate, best) < 0) best = candidate;
      }
    }
    if (best === undefined) break;
    const merged: WorkingCluster = {
      members: [...clusters[best.left]!.members, ...clusters[best.right]!.members].sort(comparePreparedElements),
      edges: [...clusters[best.left]!.edges, ...clusters[best.right]!.edges, ...best.edges].sort(comparePairEvidence),
    };
    clusters = clusters.filter((_, index) => index !== best!.left && index !== best!.right);
    clusters.push(merged);
    clusters.sort(compareWorkingClusters);
  }
  return clusters.sort(compareWorkingClusters);
}

function safeClusterMerge(left: WorkingCluster, right: WorkingCluster, edges: readonly PairEvidence[]): boolean {
  const members = [...left.members, ...right.members];
  const allEdges = [...left.edges, ...right.edges, ...edges];
  const hasNested = allEdges.some((edge) => edge.evidence.relation === "nested_alias");
  const actionableContainmentEdges = allEdges.filter((edge) => edge.evidence.relation === "actionable_containment_alias");
  if (!hasNested && actionableContainmentEdges.length === 0) return true;
  const actionable = members.filter((member) => member.roleGroup !== undefined);
  // A parent + static child remains safe only while the cluster has one
  // executable leaf. An actionable containment alias is the one explicit
  // exception: exactly two actionable members may represent the same
  // cross-source or tightly constrained same-source control. A third
  // actionable member is never folded into that semantic target.
  if (actionableContainmentEdges.length === 0) return actionable.length <= 1;
  if (actionable.length <= 1) return true;
  if (actionable.length !== 2) return false;
  const actionableRefs = new Set(actionable.map((member) => member.element.elementRef));
  return actionableContainmentEdges.some((edge) => actionableRefs.has(edge.left.element.elementRef) && actionableRefs.has(edge.right.element.elementRef));
}

function relationFor(left: PreparedElement, right: PreparedElement): PairEvidence | undefined {
  if (left.element.elementRef === right.element.elementRef) return undefined;
  if (regionConflict(left.element, right.element)) return undefined;
  if (enabledConflict(left.element, right.element)) return undefined;

  if (left.roleGroup !== undefined && left.roleGroup === right.roleGroup) {
    const label = compareLabels(left.label, right.label);
    if (label === undefined || left.box === undefined || right.box === undefined) return undefined;
    const iou = bboxIoU(left.box, right.box);
    const centerDistance = centerDistancePx(left.box, right.box);
    const centersTight = tightCenters(left.box, right.box, centerDistance);
    const sameSource = left.source !== "unknown" && left.source === right.source;
    const crossSource = left.source !== "unknown" && right.source !== "unknown" && left.source !== right.source;
    if (centersTight && sameSource && iou >= SAME_SOURCE_IOU) {
      return makePairEvidence(left, right, "same_source_alias", label, [
        "compatible_actionable_role",
        "same_source_near_identical",
      ], iou, centerDistance, undefined, undefined, label === "exact" ? 84 : 74);
    }
    if (centersTight && crossSource && iou >= CROSS_SOURCE_IOU) {
      return makePairEvidence(left, right, "peer_alias", label, [
        "compatible_actionable_role",
        "cross_source",
        "peer_overlap",
      ], iou, centerDistance, undefined, undefined, label === "exact" ? 104 : 94);
    }
    return actionableContainmentRelation(left, right, label);
  }

  const nested = nestedRelation(left, right);
  return nested;
}

/**
 * Merge a DOM/UIA wrapper and its actionable inner control only when their
 * public evidence is sufficient. The browser region must be explicitly known
 * and equal; an omitted/unknown region is never guessed.
 */
function actionableContainmentRelation(
  left: PreparedElement,
  right: PreparedElement,
  label: GroundingLabelStrength,
): PairEvidence | undefined {
  if (left.roleGroup === undefined || left.roleGroup !== right.roleGroup) return undefined;
  if (left.box === undefined || right.box === undefined) return undefined;
  if (!sameKnownBrowserRegion(left.element, right.element)) return undefined;

  const leftSource = left.source;
  const rightSource = right.source;
  const crossSource = leftSource !== rightSource && leftSource !== "unknown" && rightSource !== "unknown";
  const sameSource = leftSource === rightSource && leftSource !== "unknown";
  if (!crossSource && !sameSource) return undefined;

  const leftBox = left.box;
  const rightBox = right.box;
  const outer = boxArea(leftBox) >= boxArea(rightBox) ? left : right;
  const inner = outer === left ? right : left;
  const outerBox = outer === left ? leftBox : rightBox;
  const innerBox = inner === left ? leftBox : rightBox;
  const outerArea = boxArea(outerBox);
  const innerArea = boxArea(innerBox);
  if (outerArea <= 0 || innerArea <= 0) return undefined;
  const areaRatio = outerArea / innerArea;
  const containment = containmentRatio(outerBox, innerBox);
  const centerDistance = centerDistancePx(outerBox, innerBox);
  const centerScale = Math.min(outerBox.width, outerBox.height);

  if (crossSource) {
    if (containment < ACTIONABLE_CONTAINMENT || areaRatio > MAX_ACTIONABLE_AREA_RATIO) return undefined;
    if (centerDistance > Math.max(8, centerScale * MAX_ACTIONABLE_CENTER_DISTANCE)) return undefined;
  } else {
    // Same-source actionable nesting is much more ambiguous: require tighter
    // geometry than cross-source DOM/UIA evidence.
    if (containment < SAME_SOURCE_ACTIONABLE_CONTAINMENT || areaRatio > MAX_SAME_SOURCE_ACTIONABLE_AREA_RATIO) return undefined;
    if (centerDistance > Math.max(6, centerScale * MAX_SAME_SOURCE_ACTIONABLE_CENTER_DISTANCE)) return undefined;
  }

  const reasons = [
    "compatible_actionable_role",
    crossSource ? "cross_source" : "same_source_strict",
    "same_browser_region",
    "actionable_outer",
    "actionable_inner",
    "child_contained",
    "area_ratio_bounded",
    "close_centers",
  ];
  return makePairEvidence(
    outer,
    inner,
    "actionable_containment_alias",
    label,
    reasons,
    undefined,
    centerDistance,
    containment,
    areaRatio,
    crossSource ? (label === "exact" ? 102 : 92) : (label === "exact" ? 82 : 72),
  );
}

function nestedRelation(left: PreparedElement, right: PreparedElement): PairEvidence | undefined {
  const parent = left.roleGroup !== undefined && isStaticRole(right.role) ? left : right.roleGroup !== undefined && isStaticRole(left.role) ? right : undefined;
  const child = parent === left ? right : parent === right ? left : undefined;
  if (parent === undefined || child === undefined || parent.box === undefined || child.box === undefined) return undefined;
  // Preserve the audited nested-label behavior for the original role
  // families.  A newly recognized executable family must not make a generic
  // label disappear from the candidate set until its adapter semantics have
  // been independently verified.
  if (parent.roleGroup === undefined || !STATIC_NESTED_ALIAS_ROLES.has(parent.roleGroup)) return undefined;
  if (BROAD_ANCESTOR_ROLES.has(parent.role) || BROAD_ANCESTOR_ROLES.has(child.role)) return undefined;
  const label = compareLabels(parent.label, child.label);
  if (label === undefined) return undefined;
  const parentArea = boxArea(parent.box);
  const childArea = boxArea(child.box);
  if (parentArea <= 0 || childArea <= 0 || parentArea / childArea > MAX_NESTED_AREA_RATIO) return undefined;
  const containment = containmentRatio(parent.box, child.box);
  const centerDistance = centerDistancePx(parent.box, child.box);
  const centerLimit = Math.max(8, Math.min(parent.box.width, parent.box.height) * MAX_NESTED_CENTER_DISTANCE);
  if (containment < NESTED_CONTAINMENT || centerDistance > centerLimit) return undefined;
  return makePairEvidence(parent, child, "nested_alias", label, [
    "actionable_parent",
    "static_child",
    "child_contained",
    "close_centers",
    "unique_actionable_leaf",
  ], undefined, centerDistance, containment, undefined, label === "exact" ? 64 : 54);
}

function makePairEvidence(
  left: PreparedElement,
  right: PreparedElement,
  relation: GroundingClusterRelation,
  labelStrength: GroundingLabelStrength,
  reasons: readonly string[],
  iou: number | undefined,
  centerDistance: number | undefined,
  containment: number | undefined,
  areaRatio: number | undefined,
  quality: number,
): PairEvidence {
  const ordered = [left, right].sort(comparePreparedElements);
  const first = ordered[0]!;
  const second = ordered[1]!;
  const evidence: GroundingClusterEvidence = {
    leftRef: first.element.elementRef,
    rightRef: second.element.elementRef,
    relation,
    labelStrength,
    reasons: [...reasons],
    ...(iou === undefined ? {} : { iou }),
    ...(centerDistance === undefined ? {} : { centerDistance }),
    ...(containment === undefined ? {} : { containment }),
    ...(areaRatio === undefined ? {} : { areaRatio }),
  };
  return { left: first, right: second, evidence, quality };
}

function scoreCluster(
  working: WorkingCluster,
  query: NormalizedGroundingRetrievalQuery,
  catalog: GroundingCatalog,
): ScoredCluster {
  const scoreParts = [
    boundedChannelMatch(working.members, query.localIntent, 5_000, "local_intent_match"),
    boundedChannelMatch(working.members, query.recovery, 2_800, "recovery_match"),
    boundedChannelMatch(working.members, query.corrections.join(" "), 3_000, "correction_match"),
    boundedChannelMatch(working.members, query.plan, 1_800, "plan_match"),
    boundedChannelMatch(working.members, query.goal, 800, "goal_match"),
  ];
  let score = scoreParts.reduce((sum, value) => sum + value.score, 0);
  const reasonCodes = scoreParts.flatMap((value) => value.matched ? [value.reason] : []);
  const representative = chooseRepresentative(working.members, catalog);
  const named = working.members.some((member) => member.label.normalized.length > 0);
  const bounded = working.members.some((member) => member.box !== undefined);
  const focused = working.members.some((member) => member.element.state?.focused === true);
  const editable = working.members.some((member) => member.element.state?.editable === true);
  const enabled = working.members.some((member) => member.element.state?.enabled === true);
  if (focused) {
    score += 220;
    reasonCodes.push("focused");
  }
  if (editable) {
    score += 200;
    reasonCodes.push("editable");
  }
  if (enabled && named) {
    score += 30;
    reasonCodes.push("enabled_named");
  }
  if (bounded) {
    score += 5;
    reasonCodes.push("bounded");
  }
  const representativeSource = resolveSource(representative, catalog);
  if (representativeSource === "dom" && representative.browserRegion === "content") {
    score += 180;
    reasonCodes.push("dom_content_priority");
  } else if (representativeSource === "uia" && representative.browserRegion === "chrome") {
    score += 180;
    reasonCodes.push("uia_chrome_priority");
  }
  if (working.members.some((member) => BROAD_ANCESTOR_ROLES.has(member.role))) {
    score -= 6_000;
    reasonCodes.push("broad_ancestor_penalty");
  }
  if (working.members.every((member) => member.roleGroup === undefined)) {
    score -= 100;
    reasonCodes.push("non_actionable");
  }
  if (working.edges.some((edge) => edge.evidence.relation === "actionable_containment_alias")) {
    reasonCodes.push("actionable_containment_alias");
  }
  if (reasonCodes.length === 0) reasonCodes.push("stable_fallback");

  const members = [...working.members].sort(comparePreparedElements);
  const representativeRef = representative.elementRef;
  const edges = [...working.edges].sort(comparePairEvidence).map((edge) => edge.evidence);
  const aliases = members
    .filter((member) => member.element.elementRef !== representativeRef)
    .map((member) => makeAlias(member, working.edges, representativeRef));
  const memberElements = members.map((member) => member.element);
  const memberRefs = memberElements.map((member) => member.elementRef);
  const sortKey = memberRefs.join("\u001f");
  const semanticClusterId = `sc_${stableHash(`${catalog.observationId}|${members.map((member) => member.stableKey).join("\u001f")}`)}`;
  return {
    semanticClusterId,
    score,
    memberRefs,
    members: memberElements,
    representativeRef,
    representative,
    aliases,
    evidence: edges,
    reasonCodes: uniqueStrings(reasonCodes),
    sortKey,
  };
}

function makeAlias(
  member: PreparedElement,
  edges: readonly PairEvidence[],
  representativeRef: string,
): GroundingClusterAlias {
  const evidence = edges
    .filter((edge) => edge.left.element.elementRef === member.element.elementRef || edge.right.element.elementRef === member.element.elementRef)
    .map((edge) => edge.evidence)
    .sort(compareEvidence);
  const relation = evidence[0]?.relation ?? "peer_alias";
  return {
    elementRef: member.element.elementRef,
    relation,
    role: member.element.role,
    ...(member.element.source === undefined ? {} : { source: member.element.source }),
    ...(member.label.normalized.length === 0 ? {} : { normalizedLabel: member.label.normalized }),
    evidence,
  };
}

function chooseRepresentative(members: readonly PreparedElement[], catalog: GroundingCatalog): GroundingElement {
  return [...members]
    .sort((left, right) => compareRepresentative(left, right, catalog))[0]!
    .element;
}

function compareRepresentative(left: PreparedElement, right: PreparedElement, catalog: GroundingCatalog): number {
  const leftActionable = left.roleGroup === undefined ? 0 : 1;
  const rightActionable = right.roleGroup === undefined ? 0 : 1;
  if (leftActionable !== rightActionable) return rightActionable - leftActionable;
  const leftEnabled = enabledRank(left.element);
  const rightEnabled = enabledRank(right.element);
  if (leftEnabled !== rightEnabled) return rightEnabled - leftEnabled;
  const leftBounded = left.box === undefined ? 0 : 1;
  const rightBounded = right.box === undefined ? 0 : 1;
  if (leftBounded !== rightBounded) return rightBounded - leftBounded;
  const leftSource = representativeSourceRank(left, catalog);
  const rightSource = representativeSourceRank(right, catalog);
  if (leftSource !== rightSource) return rightSource - leftSource;
  const leftFocused = left.element.state?.focused === true ? 1 : 0;
  const rightFocused = right.element.state?.focused === true ? 1 : 0;
  if (leftFocused !== rightFocused) return rightFocused - leftFocused;
  const leftEditable = left.element.state?.editable === true ? 1 : 0;
  const rightEditable = right.element.state?.editable === true ? 1 : 0;
  if (leftEditable !== rightEditable) return rightEditable - leftEditable;
  const leftNamed = left.label.normalized.length > 0 ? 1 : 0;
  const rightNamed = right.label.normalized.length > 0 ? 1 : 0;
  if (leftNamed !== rightNamed) return rightNamed - leftNamed;
  const leftArea = left.box === undefined ? Number.POSITIVE_INFINITY : boxArea(left.box);
  const rightArea = right.box === undefined ? Number.POSITIVE_INFINITY : boxArea(right.box);
  return leftArea - rightArea || left.element.elementRef.localeCompare(right.element.elementRef) || left.stableKey.localeCompare(right.stableKey);
}

function representativeSourceRank(member: PreparedElement, catalog: GroundingCatalog): number {
  const source = resolveSource(member.element, catalog);
  if (source === "dom" && member.element.browserRegion === "content") return 4;
  if (source === "uia" && member.element.browserRegion === "chrome") return 3;
  if (source === "dom" || source === "uia") return 2;
  return 1;
}

function compareScoredClusters(left: ScoredCluster, right: ScoredCluster): number {
  return right.score - left.score || left.sortKey.localeCompare(right.sortKey) || left.semanticClusterId.localeCompare(right.semanticClusterId);
}

function compareMergeCandidates(
  left: { quality: number; sortKey: string },
  right: { quality: number; sortKey: string },
): number {
  return right.quality - left.quality || left.sortKey.localeCompare(right.sortKey);
}

function compareWorkingClusters(left: WorkingCluster, right: WorkingCluster): number {
  return clusterSortKey(left).localeCompare(clusterSortKey(right));
}

function clusterSortKey(cluster: WorkingCluster): string {
  return cluster.members.map((member) => member.stableKey).sort().join("\u001f");
}

function comparePairEvidence(left: PairEvidence, right: PairEvidence): number {
  return compareEvidence(left.evidence, right.evidence) || left.quality - right.quality;
}

function compareEvidence(left: GroundingClusterEvidence, right: GroundingClusterEvidence): number {
  return left.leftRef.localeCompare(right.leftRef) || left.rightRef.localeCompare(right.rightRef) || left.relation.localeCompare(right.relation);
}

function comparePreparedElements(left: PreparedElement, right: PreparedElement): number {
  return left.element.elementRef.localeCompare(right.element.elementRef) || left.stableKey.localeCompare(right.stableKey);
}

function compareLabels(left: LabelInfo, right: LabelInfo): GroundingLabelStrength | undefined {
  if (left.normalized.length === 0 || right.normalized.length === 0) return undefined;
  if (left.normalized === right.normalized) return "exact";
  if (left.stripped.length === 0 || right.stripped.length === 0 || left.stripped !== right.stripped) return undefined;
  const sharedMeaningful = left.meaningfulTokens.filter((token) => right.meaningfulTokens.includes(token));
  // The stripped form is never sufficient by itself: at least one original,
  // non-boilerplate token must survive on both sides.
  return sharedMeaningful.length > 0 ? "strong" : undefined;
}

function labelInfo(value: string | undefined): LabelInfo {
  const normalized = normalizeGroundingLabel(value ?? "");
  const tokens = normalized.length === 0 ? [] : normalized.split(" ").filter((token) => token.length > 0);
  const meaningfulTokens = tokens.filter((token) => !LABEL_BOILERPLATE.has(token));
  const strippedTokens = [...tokens];
  // Remove only bounded edge boilerplate.  Interior words are retained so a
  // label such as "link status" is never reduced to an unrelated identity.
  for (let pass = 0; pass < 2; pass += 1) {
    if (strippedTokens.length > 0 && LABEL_BOILERPLATE.has(strippedTokens[0]!)) strippedTokens.shift();
    if (strippedTokens.length > 0 && LABEL_BOILERPLATE.has(strippedTokens[strippedTokens.length - 1]!)) strippedTokens.pop();
  }
  return {
    normalized,
    stripped: strippedTokens.join(" "),
    tokens,
    meaningfulTokens,
  };
}

function normalizeRole(role: string): string {
  return normalizeGroundingLabel(role).replace(/\s+/gu, "");
}

function actionableRole(role: string): ActionableRole | undefined {
  for (const [group, aliases] of Object.entries(ACTIONABLE_ROLE_ALIASES) as [ActionableRole, readonly string[]][]) {
    if (aliases.includes(role)) return group;
  }
  return undefined;
}

function isStaticRole(role: string): boolean {
  return STATIC_ROLES.has(role);
}

function resolveSource(element: GroundingElement, catalog: GroundingCatalog): ResolvedSource {
  if (element.source !== undefined) return element.source;
  return catalog.source === "dom" || catalog.source === "uia" ? catalog.source : "unknown";
}

function validBox(box: GroundingBoundingBox | undefined): GroundingBoundingBox | undefined {
  if (box === undefined || box.coordinateSpace !== "physical") return undefined;
  if (![box.x, box.y, box.width, box.height].every(Number.isFinite) || box.width <= 0 || box.height <= 0) return undefined;
  return box;
}

function regionConflict(left: GroundingElement, right: GroundingElement): boolean {
  return left.browserRegion !== undefined && right.browserRegion !== undefined
    && left.browserRegion !== "unknown" && right.browserRegion !== "unknown"
    && left.browserRegion !== right.browserRegion;
}

function sameKnownBrowserRegion(left: GroundingElement, right: GroundingElement): boolean {
  return left.browserRegion !== undefined
    && right.browserRegion !== undefined
    && left.browserRegion !== "unknown"
    && right.browserRegion !== "unknown"
    && left.browserRegion === right.browserRegion;
}

function enabledConflict(left: GroundingElement, right: GroundingElement): boolean {
  return left.state?.enabled !== undefined && right.state?.enabled !== undefined && left.state.enabled !== right.state.enabled;
}

function enabledRank(element: GroundingElement): number {
  return element.state?.enabled === true ? 2 : element.state?.enabled === false ? 0 : 1;
}

function tightCenters(left: GroundingBoundingBox, right: GroundingBoundingBox, distance: number): boolean {
  const scale = Math.min(left.width, left.height, right.width, right.height);
  return distance <= Math.max(8, scale * 0.25);
}

function centerDistancePx(left: GroundingBoundingBox, right: GroundingBoundingBox): number {
  return Math.hypot(left.x + left.width / 2 - right.x - right.width / 2, left.y + left.height / 2 - right.y - right.height / 2);
}

function bboxIoU(left: GroundingBoundingBox, right: GroundingBoundingBox): number {
  const overlapWidth = Math.max(0, Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x));
  const overlapHeight = Math.max(0, Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y));
  const intersection = overlapWidth * overlapHeight;
  const union = boxArea(left) + boxArea(right) - intersection;
  return union <= 0 ? 0 : intersection / union;
}

function containmentRatio(parent: GroundingBoundingBox, child: GroundingBoundingBox): number {
  const overlapWidth = Math.max(0, Math.min(parent.x + parent.width, child.x + child.width) - Math.max(parent.x, child.x));
  const overlapHeight = Math.max(0, Math.min(parent.y + parent.height, child.y + child.height) - Math.max(parent.y, child.y));
  const intersection = overlapWidth * overlapHeight;
  return boxArea(child) <= 0 ? 0 : intersection / boxArea(child);
}

function boxArea(box: GroundingBoundingBox): number {
  return box.width * box.height;
}

interface BoundedChannelMatch {
  readonly score: number;
  readonly matched: boolean;
  readonly reason: string;
}

/**
 * Score one query channel against the best member of a semantic cluster.
 *
 * The returned similarity is always in [0, 1], so a long query or a long
 * candidate cannot create an unbounded score by contributing more n-grams.
 * Taking the best member also prevents duplicate DOM/UIA aliases from
 * amplifying text evidence.
 */
function boundedChannelMatch(
  members: readonly PreparedElement[],
  queryText: string,
  weight: number,
  reason: string,
): BoundedChannelMatch {
  const normalizedQuery = normalizeGroundingLabel(queryText);
  if (normalizedQuery.length === 0) return { score: 0, matched: false, reason };
  const similarity = members.reduce(
    (best, member) => Math.max(best, memberTextSimilarity(member, normalizedQuery)),
    0,
  );
  return {
    score: Math.min(weight, Math.max(0, similarity * weight)),
    matched: similarity > 0,
    reason,
  };
}

/** Name is primary evidence; descriptions can only provide a bounded assist. */
function memberTextSimilarity(member: PreparedElement, normalizedQuery: string): number {
  const nameScore = boundedTextSimilarity(member.label.normalized, normalizedQuery);
  const descriptionScore = boundedTextSimilarity(normalizeGroundingLabel(member.element.description ?? ""), normalizedQuery);
  if (nameScore >= 1) return 1;
  return clamp01(nameScore * 0.8 + descriptionScore * 0.2);
}

/**
 * Combine exact, phrase, precision and token overlap evidence without using
 * raw match counts.  Precision deliberately penalizes a long menu/list row
 * that happens to contain one short query term.
 */
function boundedTextSimilarity(field: string, normalizedQuery: string): number {
  if (field.length === 0 || normalizedQuery.length === 0) return 0;
  if (field === normalizedQuery) return 1;

  const queryTokens = tokenize(normalizedQuery);
  const fieldTokens = tokenize(field);
  if (queryTokens.length === 0 || fieldTokens.length === 0) return 0;
  const fieldTokenSet = new Set(fieldTokens);
  const matched = queryTokens.reduce((count, token) => count + (fieldTokenSet.has(token) ? 1 : 0), 0);
  if (matched === 0) return 0;

  const precision = matched / fieldTokens.length;
  const recall = matched / queryTokens.length;
  const overlap = matched / (queryTokens.length + fieldTokens.length - matched);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  const compactField = field.replace(/\s+/gu, "");
  const compactQuery = normalizedQuery.replace(/\s+/gu, "");
  const queryContainsField = field.length >= 2
    && fieldTokens.length <= 8
    && (normalizedQuery.includes(field) || compactQuery.includes(compactField));
  const phrase = normalizedQuery.length >= 2
    && (field.includes(normalizedQuery) || compactField.includes(compactQuery) || queryContainsField);

  // Each component is bounded; phrase evidence is intentionally modest so a
  // long result row cannot beat an exact short control on a background Goal.
  return clamp01(0.4 * f1 + 0.2 * precision + 0.2 * recall + (phrase ? 0.2 : 0));
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function tokenize(value: string): string[] {
  const normalized = normalizeGroundingLabel(value);
  const tokens: string[] = [];
  // Keep Han runs separate from adjacent digits/Latin text.  A character
  // class such as [\p{L}\p{N}] also includes Han, which would turn a date
  // like "2026-09-23上海" into one opaque token and lose the useful Chinese
  // 2/3-gram overlap.
  for (const match of normalized.matchAll(/[\p{Script=Han}]+|[^\p{Script=Han}\p{P}\p{S}\s]+/gu)) {
    const part = match[0]!;
    if (/^\p{Script=Han}+$/u.test(part)) {
      for (const size of [2, 3]) {
        if (part.length < size) continue;
        for (let index = 0; index <= part.length - size; index += 1) tokens.push(part.slice(index, index + size));
      }
    } else if (part.length >= 2) {
      tokens.push(part);
    }
  }
  return uniqueStrings(tokens);
}

function stableElementKey(element: GroundingElement, source: ResolvedSource): string {
  const box = element.bbox;
  return [
    element.elementRef,
    normalizeRole(element.role),
    normalizeGroundingLabel(element.name ?? ""),
    normalizeGroundingLabel(element.description ?? ""),
    source,
    element.browserRegion ?? "",
    element.state?.enabled === undefined ? "" : String(element.state.enabled),
    element.state?.focused === undefined ? "" : String(element.state.focused),
    box === undefined ? "" : `${box.x},${box.y},${box.width},${box.height}`,
  ].join("\u001e");
}

function stableHash(value: string): string {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function uniqueNormalized(values: readonly string[]): string[] {
  return uniqueStrings(values.filter((value) => value.length > 0));
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}
