import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import type { CuaDriverLike, ToolResult } from "@trycua/cua-driver";
import type { ActionId, ObservationId } from "@computer-harness/protocol";
import { CuaDriverComputer } from "./cua-driver-computer.js";
import { domCandidateFingerprint, type DomGroundingTransport, type DomSelectOptionRequest, type ManagedBrowserTarget } from "./dom-grounding.js";
import { buildManagedDomSelectOptionExpression } from "./managed-browser-host.js";

const ONE_BY_ONE_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");

function pngWithDimensions(width: number, height: number): string {
  const bytes = Buffer.from(ONE_BY_ONE_PNG);
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes.toString("base64");
}

function toolResult(overrides: Partial<ToolResult> = {}): ToolResult {
  return { text: "ok", images: [], isError: false, degraded: false, rawJson: "{}", ...overrides };
}

function fixture(target: { readonly pid: number; readonly windowId: number }) {
  const calls: Array<{ name: string; input?: Record<string, unknown> }> = [];
  const driver = {
    async startSession() { calls.push({ name: "startSession" }); return { active: true, revived: false } as never; },
    async endSession() { calls.push({ name: "endSession" }); return { active: false, session: "select-option" } as never; },
    async shutdown() { calls.push({ name: "shutdown" }); },
    async verifyState() {
      calls.push({ name: "verifyState" });
      return toolResult({ images: [{ mimeType: "image/png", dataBase64: pngWithDimensions(958, 678) }], verification: { status: 0, stable: true, elapsedMs: 0n, samples: 1n, predicates: [] } });
    },
    async callTool(name: string, inputJson: string) {
      const input = JSON.parse(inputJson) as Record<string, unknown>;
      calls.push({ name, input });
      if (name === "list_windows") return toolResult({ structuredJson: JSON.stringify({ windows: [{ pid: target.pid, window_id: target.windowId, title: "fixture", app_name: "fixture", bounds: { x: 100, y: 120, width: 960, height: 680 } }] }) });
      if (name === "get_window_state") return toolResult({ structuredJson: JSON.stringify({ elements_complete: true, elements: [{ role: "Document", frame: { x: 0, y: 0, width: 960, height: 680 }, enabled: true }] }) });
      return toolResult();
    },
    uniffiDestroy() {},
  } as unknown as CuaDriverLike;
  return { driver, calls };
}

type SelectOptionFixtureMode = "success" | "missing" | "ambiguous" | "disabled" | "generation" | "custom" | "abort" | "truncated" | "truncated-missing" | "truncated-ambiguous" | "truncated-disabled";

function makeTransport(target: ManagedBrowserTarget, mode: SelectOptionFixtureMode = "success") {
  const requests: DomSelectOptionRequest[] = [];
  const options = mode === "truncated-missing"
    ? [{ text: "09:00", enabled: true }]
    : mode === "truncated-ambiguous"
      ? [{ text: "08:00", enabled: true }, { text: "08:00", enabled: true }]
      : [{ text: "08:00", enabled: mode !== "truncated-disabled" && mode !== "disabled" }];
  const optionsTruncated = mode.startsWith("truncated");
  const transport: DomGroundingTransport = {
    kind: "managed-loopback-cdp-v1",
    async collect() {
      return {
        complete: true,
        coordinateSpace: "physical" as const,
        tabId: target.tabId,
        generation: target.generation,
        candidates: [{ ...(mode === "custom" ? { tagName: "div", ariaRole: "combobox" } : { tagName: "select" }), name: "Departure", frame: { x: 100, y: 100, width: 160, height: 28 }, visible: true, interactive: true, options, optionsTruncated, state: { enabled: mode !== "disabled" } }],
      };
    },
    async selectOption(request, signal) {
      requests.push(request);
      if (mode === "abort") {
        if (signal.aborted) throw signal.reason ?? new Error("aborted");
        await new Promise<never>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason ?? new Error("aborted")), { once: true }));
      }
      if (mode === "missing") return { status: "refused", driverCode: "SELECT_OPTION_OPTION_MISSING", message: "missing" };
      if (mode === "ambiguous") return { status: "refused", driverCode: "SELECT_OPTION_OPTION_AMBIGUOUS", message: "ambiguous" };
      if (mode === "disabled") return { status: "refused", driverCode: "GROUNDING_ELEMENT_DISABLED", message: "disabled" };
      if (mode === "generation") return { status: "completed", tabId: target.tabId, generation: "generation-new" };
      return { status: "completed", tabId: target.tabId, generation: target.generation };
    },
  };
  return { transport, requests };
}

async function openFixture(mode: SelectOptionFixtureMode = "success") {
  const directory = await mkdtemp(join(tmpdir(), "computer-harness-select-option-"));
  const windowTarget = { pid: 1234, windowId: 5678 };
  const browserTarget: ManagedBrowserTarget = { kind: "managed-chromium", browser: "edge", profileId: "fixture", windowTarget, tabId: "tab-1", generation: "generation-1", delivery: "loopback-cdp" };
  const fake = fixture(windowTarget);
  const selected = makeTransport(browserTarget, mode);
  const computer = new CuaDriverComputer({ socketPath: "fixture.sock", screenshotDir: directory, windowTarget, grounding: "hybrid-catalog-v1", browserTarget, domGroundingTransport: selected.transport, driverFactory: () => fake.driver });
  const session = await computer.open({}, new AbortController().signal);
  await computer.observe(session, "select-option-observation" as ObservationId, new AbortController().signal);
  return { directory, browserTarget, fake, selected, computer, session, observationId: "select-option-observation" as ObservationId };
}

describe("managed-browser select_option adapter", () => {
  it("builds a bounded native-select expression with independent select overflow handling", () => {
    const expression = buildManagedDomSelectOptionExpression({ role: "combobox", name: "Departure", frame: { x: 10, y: 20, width: 120, height: 28 }, fingerprint: "domf-deadbeef", optionText: "08:00" });
    expect(() => new Function(expression)).not.toThrow();
    expect(expression).toContain("MAX_SELECTS = 256");
    expect(expression).toContain("SELECT_OPTION_SELECT_CATALOG_INCOMPLETE");
    expect(expression).not.toContain("aria-selected");
    expect(expression).not.toContain(".value");
  });

  it("revalidates and changes a synthetic native select without opening a popup", () => {
    const frame = { x: 10, y: 20, width: 120, height: 28 };
    const select = new MiniElement("select", { attrs: { "aria-label": "Departure" }, frame, children: [
      new MiniElement("option", { textContent: "08:00" }),
      new MiniElement("option", { textContent: "09:00" }),
    ] });
    const document = new MiniDocument([select]);
    const expression = buildManagedDomSelectOptionExpression({ role: "combobox", name: "Departure", frame, fingerprint: domCandidateFingerprint({ tagName: "select", ariaRole: "combobox", name: "Departure", frame }), optionText: "08:00" });
    const result = runInNewContext(expression, { document, Element: MiniElement, getComputedStyle: () => ({ display: "block", visibility: "visible", pointerEvents: "auto" }), Event: class { public constructor(public readonly type: string) {} } }) as { status: string };
    expect(result).toEqual({ status: "completed" });
    expect(select.children[0]?.selected).toBe(true);
    expect(select.children[1]?.selected).toBe(false);
    expect(select.events).toEqual(["input", "change"]);
    const moved = new MiniElement("select", { attrs: { "aria-label": "Departure" }, frame: { x: 12, y: 22, width: 120, height: 28 }, children: [new MiniElement("option", { textContent: "08:00" })] });
    const movedExpression = buildManagedDomSelectOptionExpression({ role: "combobox", name: "Departure", frame, fingerprint: domCandidateFingerprint({ tagName: "select", ariaRole: "combobox", name: "Departure", frame }), optionText: "08:00" });
    expect(runInNewContext(movedExpression, { document: new MiniDocument([moved]), Element: MiniElement, getComputedStyle: () => ({ display: "block", visibility: "visible", pointerEvents: "auto" }), Event: class { public constructor(public readonly type: string) {} } })).toMatchObject({ status: "completed" });
    const resized = new MiniElement("select", { attrs: { "aria-label": "Departure" }, frame: { x: 10, y: 20, width: 145, height: 28 }, children: [new MiniElement("option", { textContent: "08:00" })] });
    const resizedResult = runInNewContext(expression, { document: new MiniDocument([resized]), Element: MiniElement, getComputedStyle: () => ({ display: "block", visibility: "visible", pointerEvents: "auto" }), Event: class { public constructor(public readonly type: string) {} } }) as { status: string; driverCode?: string };
    expect(resizedResult).toMatchObject({ status: "refused", driverCode: "SELECT_OPTION_BBOX_MISMATCH" });
  });

  it("revalidates a truncated observation target against the full live option list", () => {
    const frame = { x: 10, y: 20, width: 120, height: 28 };
    const fingerprint = domCandidateFingerprint({ tagName: "select", ariaRole: "combobox", name: "Departure", frame });
    const run = (options: readonly MiniElementOptions[], optionText: string) => {
      const select = new MiniElement("select", {
        attrs: { "aria-label": "Departure" },
        frame,
        children: options.map((option) => new MiniElement("option", option)),
      });
      const expression = buildManagedDomSelectOptionExpression({ role: "combobox", name: "Departure", frame, fingerprint, optionText });
      const result = runInNewContext(expression, { document: new MiniDocument([select]), Element: MiniElement, getComputedStyle: () => ({ display: "block", visibility: "visible", pointerEvents: "auto" }), Event: class { public constructor(public readonly type: string) {} } }) as { status: string; driverCode?: string };
      return { result, select };
    };
    const fullOptions = Array.from({ length: 40 }, (_, index) => ({ textContent: index === 2 ? "08:00" : `option-${index}` }));
    const selected = run(fullOptions, "08:00");
    expect(selected.result).toEqual({ status: "completed" });
    expect(selected.select.children[2]?.selected).toBe(true);

    expect(run(Array.from({ length: 40 }, (_, index) => ({ textContent: `option-${index}` })), "08:00").result)
      .toMatchObject({ status: "refused", driverCode: "SELECT_OPTION_OPTION_MISSING" });
    expect(run([...fullOptions.slice(0, 3), { textContent: "08:00" }, ...fullOptions.slice(4)], "08:00").result)
      .toMatchObject({ status: "refused", driverCode: "SELECT_OPTION_OPTION_AMBIGUOUS" });
    const otherOptions = fullOptions.filter((_option, index) => index !== 2);
    expect(run([{ textContent: "08:00", attrs: { disabled: "" } }, ...otherOptions], "08:00").result)
      .toMatchObject({ status: "refused", driverCode: "SELECT_OPTION_OPTION_MISSING" });
  });

  it("selects by exact option text through DOM delivery without a native popup click", async () => {
    const opened = await openFixture();
    try {
      const element = opened.fake.calls.length;
      expect(element).toBeGreaterThan(0);
      const capture = await opened.computer.observe(opened.session, "select-option-current" as ObservationId, new AbortController().signal);
      const select = capture.grounding?.elements.find((candidate) => candidate.source === "dom" && candidate.role === "combobox");
      expect(select).toBeDefined();
      const receipt = await opened.computer.execute(opened.session, { actionId: "select-action" as ActionId, basedOn: "select-option-current" as ObservationId, kind: "select_option", groundingRef: select!.elementRef, optionText: "08:00" }, new AbortController().signal);
      expect(receipt).toMatchObject({ status: "completed" });
      expect(opened.selected.requests[0]).toMatchObject({ optionText: "08:00", candidate: { role: "combobox", name: "Departure", fingerprint: expect.stringMatching(/^domf-/u), frame: { x: 100, y: 100 } } });
      expect(opened.fake.calls.filter((call) => call.name === "click")).toHaveLength(0);
    } finally {
      await opened.computer.close(opened.session);
      await rm(opened.directory, { recursive: true, force: true });
    }
  });

  it("allows a unique enabled option in the observed prefix of a truncated list", async () => {
    const opened = await openFixture("truncated");
    try {
      const capture = await opened.computer.observe(opened.session, "truncated-current" as ObservationId, new AbortController().signal);
      const select = capture.grounding?.elements.find((candidate) => candidate.source === "dom" && candidate.role === "combobox");
      expect(select).toMatchObject({ options: [{ text: "08:00", enabled: true }], optionsTruncated: true });
      const receipt = await opened.computer.execute(opened.session, { actionId: "truncated-action" as ActionId, basedOn: "truncated-current" as ObservationId, kind: "select_option", groundingRef: select!.elementRef, optionText: "08:00" }, new AbortController().signal);
      expect(receipt).toMatchObject({ status: "completed" });
      expect(opened.selected.requests).toHaveLength(1);
    } finally {
      await opened.computer.close(opened.session);
      await rm(opened.directory, { recursive: true, force: true });
    }
  });

  it.each([
    ["truncated-missing", "SELECT_OPTION_OPTION_MISSING"],
    ["truncated-ambiguous", "SELECT_OPTION_OPTION_AMBIGUOUS"],
    ["truncated-disabled", "SELECT_OPTION_OPTION_DISABLED"],
  ] as const)("refuses %s from the observed truncated option prefix", async (mode, driverCode) => {
    const opened = await openFixture(mode);
    try {
      const capture = await opened.computer.observe(opened.session, `${mode}-current` as ObservationId, new AbortController().signal);
      const select = capture.grounding?.elements.find((candidate) => candidate.source === "dom");
      const receipt = await opened.computer.execute(opened.session, { actionId: `${mode}-action` as ActionId, basedOn: `${mode}-current` as ObservationId, kind: "select_option", groundingRef: select!.elementRef, optionText: "08:00" }, new AbortController().signal);
      expect(receipt).toMatchObject({ status: "refused", driverCode });
      expect(opened.selected.requests).toHaveLength(0);
    } finally {
      await opened.computer.close(opened.session);
      await rm(opened.directory, { recursive: true, force: true });
    }
  });

  it.each([["missing", "SELECT_OPTION_OPTION_MISSING"], ["ambiguous", "SELECT_OPTION_OPTION_AMBIGUOUS"], ["generation", "SELECT_OPTION_GENERATION_MISMATCH"]] as const)("fails closed for %s option delivery", async (mode, code) => {
    const opened = await openFixture(mode);
    try {
      const capture = await opened.computer.observe(opened.session, `${mode}-current` as ObservationId, new AbortController().signal);
      const select = capture.grounding?.elements.find((candidate) => candidate.source === "dom");
      const receipt = await opened.computer.execute(opened.session, { actionId: `${mode}-action` as ActionId, basedOn: `${mode}-current` as ObservationId, kind: "select_option", groundingRef: select!.elementRef, optionText: "08:00" }, new AbortController().signal);
      expect(receipt).toMatchObject({ status: mode === "generation" ? "refused" : "refused", driverCode: code });
    } finally {
      await opened.computer.close(opened.session);
      await rm(opened.directory, { recursive: true, force: true });
    }
  });

  it("rejects disabled DOM controls before delivery", async () => {
    const opened = await openFixture("disabled");
    try {
      const capture = await opened.computer.observe(opened.session, "disabled-current" as ObservationId, new AbortController().signal);
      const select = capture.grounding?.elements.find((candidate) => candidate.source === "dom");
      const receipt = await opened.computer.execute(opened.session, { actionId: "disabled-action" as ActionId, basedOn: "disabled-current" as ObservationId, kind: "select_option", groundingRef: select!.elementRef, optionText: "08:00" }, new AbortController().signal);
      expect(receipt).toMatchObject({ status: "refused", driverCode: "GROUNDING_ELEMENT_DISABLED" });
      expect(opened.selected.requests).toHaveLength(0);
    } finally {
      await opened.computer.close(opened.session);
      await rm(opened.directory, { recursive: true, force: true });
    }
  });

  it("refuses custom ARIA comboboxes instead of mutating pseudo-state", async () => {
    const opened = await openFixture("custom");
    try {
      const capture = await opened.computer.observe(opened.session, "custom-current" as ObservationId, new AbortController().signal);
      const select = capture.grounding?.elements.find((candidate) => candidate.source === "dom");
      const receipt = await opened.computer.execute(opened.session, { actionId: "custom-action" as ActionId, basedOn: "custom-current" as ObservationId, kind: "select_option", groundingRef: select!.elementRef, optionText: "08:00" }, new AbortController().signal);
      expect(receipt).toMatchObject({ status: "refused", driverCode: "SELECT_OPTION_ROLE_UNSUPPORTED" });
      expect(opened.selected.requests).toHaveLength(0);
    } finally {
      await opened.computer.close(opened.session);
      await rm(opened.directory, { recursive: true, force: true });
    }
  });

  it("propagates abort to the DOM selection transport", async () => {
    const opened = await openFixture("abort");
    try {
      const capture = await opened.computer.observe(opened.session, "abort-current" as ObservationId, new AbortController().signal);
      const select = capture.grounding?.elements.find((candidate) => candidate.source === "dom");
      const controller = new AbortController();
      const pending = opened.computer.execute(opened.session, { actionId: "abort-action" as ActionId, basedOn: "abort-current" as ObservationId, kind: "select_option", groundingRef: select!.elementRef, optionText: "08:00" }, controller.signal);
      controller.abort(new Error("selection aborted"));
      await expect(pending).rejects.toThrow(/selection aborted|aborted/iu);
    } finally {
      await opened.computer.close(opened.session);
      await rm(opened.directory, { recursive: true, force: true });
    }
  });
});

interface MiniElementOptions {
  readonly attrs?: Readonly<Record<string, string>>;
  readonly children?: readonly MiniElement[];
  readonly textContent?: string;
  readonly frame?: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
}

class MiniElement {
  public readonly localName: string;
  public readonly children: MiniElement[];
  public readonly parentElement: MiniElement | null;
  public readonly textContent: string;
  public readonly hidden = false;
  public readonly disabled: boolean;
  public readonly multiple = false;
  public readonly shadowRoot: undefined;
  public selected = false;
  public labels: readonly MiniElement[] = [];
  public readonly events: string[] = [];
  private readonly attrs: Readonly<Record<string, string>>;
  private readonly frame: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };

  public constructor(localName: string, options: MiniElementOptions = {}, parentElement: MiniElement | null = null) {
    this.localName = localName;
    this.attrs = options.attrs ?? {};
    this.disabled = Object.hasOwn(this.attrs, "disabled");
    this.textContent = options.textContent ?? "";
    this.frame = options.frame ?? { x: 0, y: 0, width: 100, height: 20 };
    this.parentElement = parentElement;
    this.children = (options.children ?? []).map((child) => new MiniElement(child.localName, {
      attrs: child.attrs,
      children: child.children,
      textContent: child.textContent,
      frame: child.frame,
    }, this));
  }

  public getAttribute(name: string): string | null { return this.attrs[name] ?? null; }

  public querySelectorAll(selector: string): MiniElement[] {
    const all = this.descendants();
    if (selector === "*") return all;
    return all.filter((element) => element.localName === selector);
  }

  public getBoundingClientRect() { return this.frame; }

  public dispatchEvent(event: { readonly type: string }): boolean { this.events.push(event.type); return true; }

  private descendants(): MiniElement[] {
    const result: MiniElement[] = [];
    const visit = (element: MiniElement): void => {
      result.push(element);
      for (const child of element.children) visit(child);
    };
    for (const child of this.children) visit(child);
    return result;
  }
}

class MiniDocument {
  public constructor(private readonly roots: readonly MiniElement[]) {}
  public querySelectorAll(selector: string): MiniElement[] {
    const all = this.roots.flatMap((root) => [root, ...root.querySelectorAll("*")]);
    if (selector === "*") return all;
    return all.filter((element) => element.localName === selector);
  }
  public getElementById(_id: string): MiniElement | null { return null; }
}
