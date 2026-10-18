import { createHash } from "node:crypto";
import { isGroundingWebUrl } from "@computer-harness/protocol";
import type {
  ComputerSessionId,
  GroundingCatalog,
  GroundingElement,
  GroundingElementState,
  GroundingOption,
  ObservationId,
  GroundingVisibleText,
  GroundingVisibleTextCell,
  GroundingVisibleTextRegion,
  Viewport,
} from "@computer-harness/protocol";

/**
 * Deliberately narrow transport gate for a future managed browser host.
 *
 * CUA 0.22.2 does not expose a browser/DOM/CDP typed surface. This interface
 * therefore accepts only a host-supplied managed-browser transport; the
 * adapter never discovers or attaches to arbitrary user browser ports.
 */
export interface ManagedBrowserTarget {
  readonly kind: "managed-chromium";
  readonly browser: "chromium" | "edge";
  /** Host-owned opaque profile label; no filesystem path or credentials. */
  readonly profileId: string;
  /** Must match the user-selected CUA window target for this Run. */
  readonly windowTarget: { readonly pid: number; readonly windowId: number };
  /** Host-attested tab identity and generation; neither is model-facing. */
  readonly tabId: string;
  readonly generation: string;
  readonly delivery: "loopback-cdp";
}

export interface DomGroundingCollectRequest {
  readonly observationId: ObservationId;
  readonly computerSessionId: ComputerSessionId;
  readonly viewport: Viewport;
  readonly browserTarget: ManagedBrowserTarget;
}

/** Private transport-side element; never serialize this object to Runtime. */
export interface DomGroundingRawCandidate {
  readonly role?: unknown;
  readonly tagName?: unknown;
  readonly ariaRole?: unknown;
  readonly inputType?: unknown;
  readonly name?: unknown;
  readonly description?: unknown;
  readonly frame?: unknown;
  readonly visible?: unknown;
  readonly interactive?: unknown;
  readonly tabIndex?: unknown;
  readonly canvasLike?: unknown;
  readonly options?: unknown;
  readonly optionsTruncated?: unknown;
  readonly state?: {
    readonly enabled?: unknown;
    readonly focused?: unknown;
    readonly editable?: unknown;
    readonly expanded?: unknown;
    readonly selected?: unknown;
    readonly valuePresent?: unknown;
  };
}

/**
 * Coordinates returned by a managed page are CSS viewport pixels.  They are
 * converted to the physical pixels of the CUA window capture before they are
 * placed in the shared GroundingCatalog.  The transport keeps this private
 * metadata so the public protocol never has to know about browser CSS space.
 */
export interface DomGroundingViewportMetrics {
  readonly cssWidth: number;
  readonly cssHeight: number;
  readonly deviceScaleFactor: number;
}

/** Adapter-private physical content rectangle supplied by a trusted UIA producer. */
export interface DomGroundingContentRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface DomGroundingTransportResult {
  readonly candidates: readonly DomGroundingRawCandidate[];
  /** Exact current-page URL from this collection, never the startup URL. */
  readonly pageUrl?: unknown;
  /** Adapter-private bounded rendered table payload, collected with candidates. */
  readonly visibleText?: unknown;
  readonly complete?: boolean;
  readonly degraded?: boolean;
  readonly tabId?: string;
  readonly generation?: string;
  /** Defaults to the historical physical fixture contract. */
  readonly coordinateSpace?: "physical" | "css";
  /** Present when coordinateSpace is css; never exposed to Runtime. */
  readonly viewportMetrics?: DomGroundingViewportMetrics;
}

export interface DomSelectOptionRequest {
  readonly observationId: ObservationId;
  readonly computerSessionId: ComputerSessionId;
  readonly viewport: Viewport;
  readonly browserTarget: ManagedBrowserTarget;
  /** Adapter-private candidate binding; never comes from a Provider directly. */
  readonly candidate: {
    readonly role: string;
    readonly name?: string;
    readonly description?: string;
    readonly bbox: {
      readonly x: number;
      readonly y: number;
      readonly width: number;
      readonly height: number;
    };
    /** Fresh DOM CSS frame; adapter-private and never model-facing. */
    readonly frame?: {
      readonly x: number;
      readonly y: number;
      readonly width: number;
      readonly height: number;
    };
    readonly fingerprint: string;
  };
  readonly optionText: string;
}

export interface DomSelectOptionResult {
  readonly status: "completed" | "refused" | "failed";
  readonly driverCode?: string;
  readonly message?: string;
  readonly tabId?: string;
  readonly generation?: string;
}

export interface DomClickRequest {
  readonly observationId: ObservationId;
  readonly computerSessionId: ComputerSessionId;
  readonly viewport: Viewport;
  readonly browserTarget: ManagedBrowserTarget;
  /** Adapter-private candidate binding; never comes from a Provider directly. */
  readonly candidate: {
    readonly role: string;
    readonly name?: string;
    readonly bbox: {
      readonly x: number;
      readonly y: number;
      readonly width: number;
      readonly height: number;
    };
    /** Fresh DOM CSS frame; adapter-private and never model-facing. */
    readonly frame?: {
      readonly x: number;
      readonly y: number;
      readonly width: number;
      readonly height: number;
    };
    readonly fingerprint: string;
  };
}

export interface DomClickResult {
  readonly status: "completed" | "refused" | "failed";
  readonly driverCode?: string;
  readonly message?: string;
  readonly tabId?: string;
  readonly generation?: string;
}

export interface DomGroundingTransport {
  readonly kind: "managed-loopback-cdp-v1";
  /** Identity is attested at collection time; unseen navigation requires a fresh observation. */
  collect(request: DomGroundingCollectRequest, signal: AbortSignal): Promise<DomGroundingTransportResult>;
  /** Re-locates and selects one option without opening the native popup. */
  readonly selectOption?: (request: DomSelectOptionRequest, signal: AbortSignal) => Promise<DomSelectOptionResult>;
  /** Re-locates and activates one observation-bound DOM control. */
  readonly click?: (request: DomClickRequest, signal: AbortSignal) => Promise<DomClickResult>;
  /** Read-only identity and page/control focus check before native keyboard delivery. */
  readonly verifyFocus?: (request: DomClickRequest, signal: AbortSignal) => Promise<DomClickResult>;
  /** Read-only unique candidate validation before a single native editable click. */
  readonly validateClick?: (request: DomClickRequest, signal: AbortSignal) => Promise<DomClickResult>;
}

export interface MaterializedDomGrounding {
  readonly catalog: Omit<GroundingCatalog, "surfaceRef">;
  /** Adapter-private map used to validate delivery; refs are observation-bound. */
  readonly privateElements: ReadonlyMap<string, {
    readonly element: GroundingElement;
    /** Raw bounded candidate name retained only for adapter-private revalidation. */
    readonly candidateName?: string;
    readonly point: { readonly x: number; readonly y: number };
    readonly candidateFingerprint: string;
    readonly candidateFrame?: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
    readonly selectable: boolean;
  }>;
}

export class DomGroundingUnavailableError extends Error {
  public constructor(message = "DOM grounding requires a managed-browser loopback CDP transport") {
    super(message);
    this.name = "DomGroundingUnavailableError";
  }
}

/**
 * Convert a bounded transport response into the shared GroundingCatalog.
 * Visible interactive controls and custom role/tabindex controls are admitted.
 * Canvas/WebGL/bitmap surfaces are intentionally omitted so those controls
 * continue to use the existing screenshot/visual path.
 */
export function materializeDomGrounding(
  request: DomGroundingCollectRequest,
  result: DomGroundingTransportResult,
  maxElements = 256,
  trustedContentRect?: DomGroundingContentRect,
): MaterializedDomGrounding {
  if (!Number.isInteger(maxElements) || maxElements < 1 || maxElements > 256) {
    throw new Error("DOM grounding maxElements must be an integer between 1 and 256");
  }
  const privateElements = new Map<string, {
    readonly element: GroundingElement;
    readonly candidateName?: string;
    readonly point: { readonly x: number; readonly y: number };
    readonly candidateFingerprint: string;
    readonly candidateFrame?: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
    readonly selectable: boolean;
  }>();
  const publicElements: GroundingElement[] = [];
  const cssProjection = result.coordinateSpace === "css"
    ? createCssViewportProjection(request.viewport, result.viewportMetrics, trustedContentRect)
    : undefined;
  for (const candidate of result.candidates) {
    if (publicElements.length >= maxElements) break;
    const frame = readFrame(candidate.frame);
    if (frame === undefined || !isVisibleInteractive(candidate) || isCanvasLike(candidate)) continue;
    const projected = cssProjection === undefined ? frame : cssProjection(frame);
    const clipped = clipFrame(projected, request.viewport.width, request.viewport.height);
    if (clipped === undefined) continue;
    const role = publicRole(candidate);
    if (role === undefined) continue;
    const name = safeLabel(candidate.name, 160);
    const description = safeLabel(candidate.description, 240);
    const state = publicState(candidate.state);
    const optionProjection = publicNativeSelectOptions(candidate, role);
    const elementRef = `dom-${observationDiscriminator(request.observationId)}-${publicElements.length + 1}`;
    const element: GroundingElement = {
      elementRef,
      role,
      ...(name === undefined ? {} : { name }),
      ...(description === undefined ? {} : { description }),
      bbox: { ...clipped, coordinateSpace: "physical" },
      ...(state === undefined ? {} : { state }),
      source: "dom",
      browserRegion: "content",
      ...(optionProjection === undefined ? {} : optionProjection),
    };
    const point = { x: clipped.x + clipped.width / 2, y: clipped.y + clipped.height / 2 };
    privateElements.set(elementRef, {
      element,
      ...(typeof candidate.name === "string" ? { candidateName: candidate.name.slice(0, 160) } : {}),
      point,
      candidateFingerprint: domCandidateFingerprint(candidate),
      ...(frame === undefined ? {} : { candidateFrame: frame }),
      selectable: isSelectLikeCandidate(candidate, role),
    });
    publicElements.push(element);
  }
  const truncated = result.degraded === true || result.candidates.length > publicElements.length || result.candidates.length > maxElements;
  const visibleText = materializeVisibleText(request, result, cssProjection);
  return {
    catalog: {
      version: "grounding-catalog-v2",
      source: "dom",
      observationId: request.observationId,
      computerSessionId: request.computerSessionId,
      ...(isGroundingWebUrl(result.pageUrl) ? { pageUrl: result.pageUrl } : {}),
      completeness: result.complete === true && !truncated ? "complete" : "partial",
      degraded: result.degraded === true,
      maxElements,
      elements: publicElements,
      ...(visibleText === undefined ? {} : { visibleText }),
    },
    privateElements,
  };
}

const VISIBLE_TEXT_LIMITS = {
  maxRegions: 2,
  maxRows: 24,
  maxColumns: 12,
  maxCells: 192,
  maxCellCharacters: 320,
  maxCharacters: 4800,
} as const;

/** Revalidate the private transport shape without changing or slicing cell text. */
function materializeVisibleText(
  request: DomGroundingCollectRequest,
  result: DomGroundingTransportResult,
  project: ((frame: DomGroundingContentRect) => DomGroundingContentRect) | undefined,
): GroundingVisibleText | undefined {
  const raw = record(result.visibleText);
  if (raw === undefined || raw.source !== "dom-table-v1" || raw.scope !== "current-viewport" ||
      !Array.isArray(raw.regions) || result.coordinateSpace !== "css" || project === undefined) return undefined;
  const regions: GroundingVisibleTextRegion[] = [];
  let partial = raw.completeness !== "complete";
  let truncated = raw.truncated === true || raw.regions.length > VISIBLE_TEXT_LIMITS.maxRegions;
  let rowCount = 0;
  let cellCount = 0;
  let characters = 0;
  const projectFrame = (value: unknown): GroundingVisibleTextCell["bbox"] | undefined => {
    const frame = readFrame(value);
    const metrics = result.viewportMetrics;
    if (frame === undefined || metrics === undefined || frame.x < 0 || frame.y < 0 ||
        frame.x + frame.width > metrics.cssWidth || frame.y + frame.height > metrics.cssHeight) return undefined;
    const physical = project(frame);
    if (physical.x < 0 || physical.y < 0 || physical.x + physical.width > request.viewport.width ||
        physical.y + physical.height > request.viewport.height) return undefined;
    return { ...physical, coordinateSpace: "physical" };
  };
  for (const candidate of raw.regions.slice(0, VISIBLE_TEXT_LIMITS.maxRegions)) {
    const region = record(candidate);
    const bbox = projectFrame(region?.frame);
    if (region === undefined || bbox === undefined || !Array.isArray(region.rows)) { partial = true; continue; }
    const rows: { rowIndex: number; cells: GroundingVisibleTextCell[] }[] = [];
    let regionPartial = region.completeness !== "complete";
    let regionTruncated = region.truncated === true;
    let previousRow = -1;
    for (const rawRow of region.rows.slice(0, VISIBLE_TEXT_LIMITS.maxRows)) {
      if (rowCount >= VISIBLE_TEXT_LIMITS.maxRows) { regionPartial = true; regionTruncated = true; break; }
      const row = record(rawRow);
      if (row === undefined || !boundedInteger(row.rowIndex, 0, 127) || row.rowIndex <= previousRow || !Array.isArray(row.cells)) {
        regionPartial = true; continue;
      }
      previousRow = row.rowIndex;
      const cells: GroundingVisibleTextCell[] = [];
      let previousColumnEnd = 0;
      for (const rawCell of row.cells.slice(0, VISIBLE_TEXT_LIMITS.maxColumns)) {
        const cell = record(rawCell);
        const cellBox = projectFrame(cell?.frame);
        if (cell === undefined || cellBox === undefined || typeof cell.text !== "string" ||
            typeof cell.header !== "boolean" || !boundedInteger(cell.columnIndex, 0, VISIBLE_TEXT_LIMITS.maxColumns - 1) ||
            !boundedInteger(cell.columnSpan, 1, VISIBLE_TEXT_LIMITS.maxColumns) ||
            !boundedInteger(cell.rowSpan, 1, 128) || cell.columnIndex < previousColumnEnd ||
            cell.columnIndex + cell.columnSpan > VISIBLE_TEXT_LIMITS.maxColumns ||
            row.rowIndex + cell.rowSpan > 128) { regionPartial = true; continue; }
        previousColumnEnd = cell.columnIndex + cell.columnSpan;
        if (cell.text.length > VISIBLE_TEXT_LIMITS.maxCellCharacters || characters + cell.text.length > VISIBLE_TEXT_LIMITS.maxCharacters ||
            cellCount >= VISIBLE_TEXT_LIMITS.maxCells) { regionPartial = true; regionTruncated = true; continue; }
        // Control characters cannot be represented as trustworthy rendered text;
        // omit the whole cell instead of silently changing a source string.
        if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(cell.text)) { regionPartial = true; continue; }
        const scope = cell.scope === "row" || cell.scope === "col" || cell.scope === "rowgroup" || cell.scope === "colgroup"
          ? cell.scope : undefined;
        cells.push({
          columnIndex: cell.columnIndex,
          rowSpan: cell.rowSpan,
          columnSpan: cell.columnSpan,
          header: cell.header,
          ...(scope === undefined ? {} : { scope }),
          text: cell.text,
          bbox: cellBox,
        });
        characters += cell.text.length;
        cellCount += 1;
      }
      if (row.cells.length > VISIBLE_TEXT_LIMITS.maxColumns) { regionPartial = true; regionTruncated = true; }
      if (cells.length > 0) { rows.push({ rowIndex: row.rowIndex, cells }); rowCount += 1; }
    }
    if (region.rows.length > VISIBLE_TEXT_LIMITS.maxRows) { regionPartial = true; regionTruncated = true; }
    regions.push({
      regionRef: `table-${observationDiscriminator(request.observationId)}-${regions.length + 1}`,
      bbox,
      completeness: regionPartial ? "partial" : "complete",
      truncated: regionTruncated,
      rows,
    });
    partial = partial || regionPartial;
    truncated = truncated || regionTruncated;
  }
  return {
    source: "dom-table-v1",
    scope: "current-viewport",
    completeness: partial || truncated ? "partial" : "complete",
    truncated,
    limits: VISIBLE_TEXT_LIMITS,
    regions,
  };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function boundedInteger(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= minimum && value <= maximum;
}

/**
 * Stable, bounded identity for re-locating one candidate inside the same
 * managed tab/generation. Geometry is checked separately with a bounded
 * tolerance so small layout drift does not turn a stable control into a new
 * identity. It deliberately excludes DOM node ids, selectors, input values,
 * cookies and option values.
 */
export function domCandidateFingerprint(candidate: DomGroundingRawCandidate): string {
  const canonical = [
    normalizedFingerprintPart(publicRole(candidate), 64),
    normalizedFingerprintPart(candidate.tagName, 32),
    normalizedFingerprintPart(candidate.ariaRole, 64),
    normalizedFingerprintPart(candidate.inputType, 32),
    normalizedFingerprintPart(candidate.name, 160),
  ].join("\u001f");
  let hash = 2_166_136_261;
  for (let index = 0; index < canonical.length; index += 1) {
    hash ^= canonical.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return `domf-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

/**
 * Project a DOM CSS-viewport frame into the physical pixels of the captured
 * CUA window. The trusted UIA Document/content rectangle supplies the actual
 * content origin and independent x/y scales; without it this function fails
 * closed instead of guessing browser chrome or DPI offsets.
 */
export function projectDomCssFrame(
  frame: { readonly x: number; readonly y: number; readonly width: number; readonly height: number },
  viewport: Viewport,
  metrics: DomGroundingViewportMetrics,
  trustedContentRect: DomGroundingContentRect,
): { x: number; y: number; width: number; height: number } {
  if (!validPositiveFinite(metrics.cssWidth) || !validPositiveFinite(metrics.cssHeight) || !validPositiveFinite(metrics.deviceScaleFactor)) {
    throw new DomGroundingUnavailableError("managed DOM grounding returned invalid CSS viewport metrics");
  }
  if (!validPositiveFinite(viewport.width) || !validPositiveFinite(viewport.height)) {
    throw new DomGroundingUnavailableError("managed DOM grounding received an invalid capture viewport");
  }
  if (!validContentRect(trustedContentRect, viewport)) {
    throw new DomGroundingUnavailableError("managed DOM grounding requires a trusted physical content rectangle");
  }
  const scaleX = trustedContentRect.width / metrics.cssWidth;
  const scaleY = trustedContentRect.height / metrics.cssHeight;
  return {
    x: trustedContentRect.x + frame.x * scaleX,
    y: trustedContentRect.y + frame.y * scaleY,
    width: frame.width * scaleX,
    height: frame.height * scaleY,
  };
}

function createCssViewportProjection(
  viewport: Viewport,
  metrics: DomGroundingViewportMetrics | undefined,
  trustedContentRect: DomGroundingContentRect | undefined,
): (frame: { readonly x: number; readonly y: number; readonly width: number; readonly height: number }) => { x: number; y: number; width: number; height: number } {
  if (metrics === undefined) throw new DomGroundingUnavailableError("managed DOM grounding omitted CSS viewport metrics");
  if (trustedContentRect === undefined) throw new DomGroundingUnavailableError("managed DOM grounding requires a trusted physical content rectangle");
  return (frame) => projectDomCssFrame(frame, viewport, metrics, trustedContentRect);
}

/** Test seam for offline fixture tests; it does not open a browser or socket. */
export function createMockDomGroundingTransport(
  response: DomGroundingTransportResult | ((request: DomGroundingCollectRequest) => DomGroundingTransportResult | Promise<DomGroundingTransportResult>),
): DomGroundingTransport {
  return {
    kind: "managed-loopback-cdp-v1",
    async collect(request, signal) {
      signal.throwIfAborted();
      const result = typeof response === "function" ? await response(request) : response;
      signal.throwIfAborted();
      return result;
    },
  };
}

export function validateManagedBrowserTarget(target: ManagedBrowserTarget): void {
  if (target.kind !== "managed-chromium" || (target.browser !== "chromium" && target.browser !== "edge") || target.delivery !== "loopback-cdp") {
    throw new DomGroundingUnavailableError("DOM grounding requires an explicit managed Chromium/Edge loopback CDP target");
  }
  if (!/^[A-Za-z0-9._-]{1,96}$/u.test(target.profileId)) {
    throw new DomGroundingUnavailableError("managed browser profileId must be a bounded opaque label");
  }
  if (!Number.isSafeInteger(target.windowTarget.pid) || target.windowTarget.pid <= 0 || !Number.isSafeInteger(target.windowTarget.windowId) || target.windowTarget.windowId <= 0) {
    throw new DomGroundingUnavailableError("managed browser target must include a positive user-selected window pid/windowId");
  }
  if (!/^[A-Za-z0-9._:-]{1,128}$/u.test(target.tabId) || !/^[A-Za-z0-9._:-]{1,128}$/u.test(target.generation)) {
    throw new DomGroundingUnavailableError("managed browser target requires bounded tab identity and generation");
  }
}

function isVisibleInteractive(candidate: DomGroundingRawCandidate): boolean {
  const visible = candidate.visible !== false;
  const interactive = candidate.interactive === true || Number.isInteger(candidate.tabIndex) && Number(candidate.tabIndex) >= 0 || candidate.ariaRole !== undefined || candidate.role !== undefined;
  return visible && interactive;
}

function isCanvasLike(candidate: DomGroundingRawCandidate): boolean {
  if (candidate.canvasLike === true) return true;
  const tag = typeof candidate.tagName === "string" ? candidate.tagName.toLocaleLowerCase() : "";
  const role = typeof candidate.role === "string" ? candidate.role.toLocaleLowerCase() : typeof candidate.ariaRole === "string" ? candidate.ariaRole.toLocaleLowerCase() : "";
  return tag === "canvas" || role === "canvas" || role === "img" || role === "bitmap" || role === "webgl";
}

function publicRole(candidate: DomGroundingRawCandidate): string | undefined {
  const supplied = safeLabel(candidate.ariaRole ?? candidate.role, 64);
  if (supplied !== undefined) return supplied;
  const tag = typeof candidate.tagName === "string" ? candidate.tagName.toLocaleLowerCase() : "";
  const inferred: Record<string, string> = {
    a: "link",
    button: "button",
    input: "textbox",
    select: "combobox",
    textarea: "textbox",
    summary: "button",
  };
  if (tag === "input") {
    const inputType = typeof candidate.inputType === "string" ? candidate.inputType.toLocaleLowerCase() : "text";
    return ({ checkbox: "checkbox", radio: "radio", range: "slider", button: "button", submit: "button", reset: "button", image: "button", number: "spinbutton" } as Record<string, string>)[inputType] ?? "textbox";
  }
  return inferred[tag] ?? (Number.isInteger(candidate.tabIndex) && Number(candidate.tabIndex) >= 0 ? "generic" : undefined);
}

function isSelectLikeCandidate(candidate: DomGroundingRawCandidate, role: string): boolean {
  const tag = typeof candidate.tagName === "string" ? candidate.tagName.toLocaleLowerCase() : "";
  // V1 intentionally supports only native HTMLSelectElement delivery. ARIA
  // comboboxes remain visible/clickable but are not mutated by this primitive.
  const normalizedRole = role.normalize("NFKC").toLocaleLowerCase().replace(/[\s_-]+/gu, "").trim();
  return tag === "select" && (normalizedRole === "select" || normalizedRole === "combobox");
}

function normalizedFingerprintPart(value: unknown, maxLength: number): string {
  if (typeof value !== "string") return "";
  return value.normalize("NFKC").replace(/[\u0000-\u001F\u007F]/gu, " ").replace(/\s+/gu, " ").trim().slice(0, maxLength);
}

function publicState(value: DomGroundingRawCandidate["state"]): GroundingElementState | undefined {
  if (value === undefined) return undefined;
  const state = {
    ...(typeof value.enabled === "boolean" ? { enabled: value.enabled } : {}),
    ...(typeof value.focused === "boolean" ? { focused: value.focused } : {}),
    ...(typeof value.editable === "boolean" ? { editable: value.editable } : {}),
    ...(typeof value.expanded === "boolean" ? { expanded: value.expanded } : {}),
    ...(typeof value.selected === "boolean" ? { selected: value.selected } : {}),
    ...(value.valuePresent === true ? { valuePresent: true } : {}),
  } satisfies GroundingElementState;
  return Object.keys(state).length === 0 ? undefined : state;
}

function publicNativeSelectOptions(
  candidate: DomGroundingRawCandidate,
  role: string,
): { readonly options: readonly GroundingOption[]; readonly optionsTruncated: boolean } | undefined {
  const tag = typeof candidate.tagName === "string" ? candidate.tagName.toLocaleLowerCase() : "";
  const normalizedRole = role.normalize("NFKC").toLocaleLowerCase().replace(/[\s_-]+/gu, "").trim();
  if (tag !== "select" || (normalizedRole !== "select" && normalizedRole !== "combobox")) return undefined;
  if (!Array.isArray(candidate.options)) return undefined;
  const options: GroundingOption[] = [];
  for (const raw of candidate.options.slice(0, 33)) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) continue;
    const item = raw as Record<string, unknown>;
    const text = safeLabel(item.text, 160);
    if (text === undefined || typeof item.enabled !== "boolean") continue;
    options.push({ text, enabled: item.enabled });
  }
  return {
    options: options.slice(0, 32),
    optionsTruncated: candidate.optionsTruncated === true || options.length > 32 || candidate.options.length > 32,
  };
}

function readFrame(value: unknown): { x: number; y: number; width: number; height: number } | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const item = value as Record<string, unknown>;
  const x = finite(item.x);
  const y = finite(item.y);
  const width = finite(item.width ?? item.w);
  const height = finite(item.height ?? item.h);
  return x === undefined || y === undefined || width === undefined || height === undefined || width <= 0 || height <= 0
    ? undefined
    : { x, y, width, height };
}

function clipFrame(frame: { x: number; y: number; width: number; height: number }, viewportWidth: number, viewportHeight: number): { x: number; y: number; width: number; height: number } | undefined {
  const left = Math.max(0, frame.x);
  const top = Math.max(0, frame.y);
  const right = Math.min(viewportWidth, frame.x + frame.width);
  const bottom = Math.min(viewportHeight, frame.y + frame.height);
  return right <= left || bottom <= top ? undefined : { x: left, y: top, width: right - left, height: bottom - top };
}

function safeLabel(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value
    .replace(/[\u0000-\u001F\u007F]/gu, " ")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu, "[redacted-email]")
    .replace(/\b1\d{10}\b/gu, "[redacted-phone]")
    .replace(/\s+/gu, " ")
    .trim();
  return normalized.length === 0 ? undefined : normalized.slice(0, maxLength);
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function validPositiveFinite(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function validContentRect(rect: DomGroundingContentRect, viewport: Viewport): boolean {
  return validPositiveFinite(rect.width)
    && validPositiveFinite(rect.height)
    && Number.isFinite(rect.x)
    && Number.isFinite(rect.y)
    && rect.x >= 0
    && rect.y >= 0
    && rect.x + rect.width <= viewport.width + 1
    && rect.y + rect.height <= viewport.height + 1;
}

function observationDiscriminator(observationId: ObservationId): string {
  return createHash("sha256").update(String(observationId)).digest("hex").slice(0, 12);
}
