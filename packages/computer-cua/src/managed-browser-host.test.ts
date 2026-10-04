import { describe, expect, it, vi } from "vitest";
import { access, mkdir, mkdtemp, open, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import type { ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { runInNewContext } from "node:vm";
import { domCandidateFingerprint, type DomGroundingRawCandidate } from "./dom-grounding.js";
import { activateManagedBrowserPage, acquireManagedBrowserProfileLease, buildManagedBrowserLaunchUrls, buildManagedDomClickExpression, cleanupManagedBrowser, formatManagedBrowserStartupDiagnostic, closeManagedBrowserGracefully, createManagedBrowserPage, defaultManagedBrowserKind, managedBrowserExecutableCandidates, MANAGED_DOM_EVALUATION_SCRIPT, LoopbackWebSocket, ManagedBrowserHost, normalizeManagedBrowserStartupUrl, prepareManagedBrowserDevToolsLaunch, readManagedBrowserStartupUrls, registerManagedBrowserStartupUrl, resolveManagedBrowserActivePage, resolveManagedBrowserActivePageSet, selectManagedBrowserStartupActivity, validateManagedBrowserPageSet, validateOwnedWindowResolution, waitForDevToolsBrowserEndpoint, waitForDevToolsPort, waitForManagedBrowserNavigationReady, type ManagedBrowserHostOptions, type ManagedBrowserWindowResolution } from "./managed-browser-host.js";

describe("managed browser host pilot", () => {
  it("selects a platform browser and bounded executable candidates", () => {
    expect(defaultManagedBrowserKind("win32")).toBe("edge");
    expect(defaultManagedBrowserKind("darwin")).toBe("chromium");
    expect(defaultManagedBrowserKind("linux")).toBe("chromium");
    expect(managedBrowserExecutableCandidates("chromium", "darwin", "/Users/fixture"))
      .toContain("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
    expect(managedBrowserExecutableCandidates("edge", "win32"))
      .toContain("C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe");
    expect(managedBrowserExecutableCandidates("chromium", "linux"))
      .toContain("/usr/bin/chromium");
  });
  it("keeps the CDP page expression bounded to interactive content and documents boundaries", () => {
    expect(MANAGED_DOM_EVALUATION_SCRIPT).toContain("shadowRoot");
    expect(MANAGED_DOM_EVALUATION_SCRIPT).toContain("deviceScaleFactor");
    expect(MANAGED_DOM_EVALUATION_SCRIPT).toContain('coordinateSpace: "css"');
    expect(MANAGED_DOM_EVALUATION_SCRIPT).toContain("iframe documents are intentionally not traversed");
    expect(MANAGED_DOM_EVALUATION_SCRIPT).toContain("canvasLike");
    expect(MANAGED_DOM_EVALUATION_SCRIPT).toContain("aria-labelledby");
    expect(MANAGED_DOM_EVALUATION_SCRIPT).toContain("selectedOptions");
    expect(MANAGED_DOM_EVALUATION_SCRIPT).not.toContain("outerHTML");
    expect(MANAGED_DOM_EVALUATION_SCRIPT).not.toContain("nodeId");
    expect(MANAGED_DOM_EVALUATION_SCRIPT).not.toContain(".value");
  });

  it("uses bounded accessible names and selected descriptions in a synthetic page", () => {
    const departureLabel = syntheticElement("label", { attrs: { for: "departure-time" }, textContent: "Departure time" });
    const departureOption = syntheticElement("option", { attrs: { value: "08:00" }, textContent: "08:00" });
    const disabledDepartureOption = syntheticElement("option", { attrs: { value: "09:00" }, textContent: "09:00", disabled: true });
    const departure = syntheticElement("select", {
      attrs: { id: "departure-time" },
      children: [departureOption, disabledDepartureOption],
      selectedOptions: [departureOption],
    });
    const ariaLabel = syntheticElement("span", { attrs: { id: "aria-departure-label" }, textContent: "Arrival time" });
    const ariaOption = syntheticElement("option", { textContent: "09:00" });
    const ariaDeparture = syntheticElement("select", {
      attrs: { id: "aria-departure", "aria-labelledby": "aria-departure-label" },
      children: [ariaOption],
      selectedOptions: [ariaOption],
    });
    const button = syntheticElement("button", { textContent: "Save itinerary" });
    const password = syntheticElement("input", {
      attrs: { type: "password", "aria-label": "Password", value: "secret-password-value" },
      textContent: "typed-password-value",
    });
    const input = syntheticElement("input", {
      attrs: { type: "text", "aria-label": "Account", value: "secret-account-value" },
      textContent: "typed-account-value",
    });
    const longLabel = syntheticElement("label", { attrs: { for: "long-options" }, textContent: "Long option list" });
    const longOptions = Array.from({ length: 400 }, (_, index) => syntheticElement("option", {
      attrs: { value: `option-value-${index}` },
      textContent: `option-${index}`,
    }));
    const longSelect = syntheticElement("select", {
      attrs: { id: "long-options" },
      children: longOptions,
      labels: [longLabel],
      selectedOptions: [longOptions[0]!],
      textContent: longOptions.map((option) => option.textContent).join(" "),
    });
    const page = new SyntheticDocument([
      departureLabel,
      departure,
      ariaLabel,
      ariaDeparture,
      button,
      password,
      input,
      longLabel,
      longSelect,
    ]);

    const evaluation = runInNewContext(MANAGED_DOM_EVALUATION_SCRIPT, {
      document: page,
      Element: SyntheticElement,
      getComputedStyle: () => ({ display: "block", visibility: "visible", pointerEvents: "auto" }),
      window: { innerWidth: 1_000, innerHeight: 800, devicePixelRatio: 1 },
    }) as SyntheticEvaluation;
    const departureCandidate = evaluation.candidates.find((candidate) => candidate.name === "Departure time");
    const ariaDepartureCandidate = evaluation.candidates.find((candidate) => candidate.name === "Arrival time");
    const longSelectCandidate = evaluation.candidates.find((candidate) => candidate.name === "Long option list");
    const buttonCandidate = evaluation.candidates.find((candidate) => candidate.name === "Save itinerary");
    const passwordCandidate = evaluation.candidates.find((candidate) => candidate.inputType === "password");
    const inputCandidate = evaluation.candidates.find((candidate) => candidate.inputType === "text");

    expect(departureCandidate).toMatchObject({ name: "Departure time", description: "08:00", options: [{ text: "08:00", enabled: true }, { text: "09:00", enabled: false }], optionsTruncated: false });
    expect(ariaDepartureCandidate).toMatchObject({ name: "Arrival time", description: "09:00" });
    expect(buttonCandidate).toMatchObject({ name: "Save itinerary" });
    expect(passwordCandidate).toMatchObject({ name: "Password" });
    expect(inputCandidate).toMatchObject({ name: "Account" });
    expect(passwordCandidate?.description).toBeUndefined();
    expect(inputCandidate?.description).toBeUndefined();
    expect(longSelectCandidate).toMatchObject({ name: "Long option list", description: "option-0", optionsTruncated: true, options: expect.arrayContaining([{ text: "option-0", enabled: true }]) });
    expect(longSelectCandidate?.options).toHaveLength(32);
    expect(longSelectCandidate?.name).not.toContain("option-399");
    expect(JSON.stringify(evaluation)).not.toContain("secret-password-value");
    expect(JSON.stringify(evaluation)).not.toContain("secret-account-value");
    expect(JSON.stringify(evaluation)).not.toContain("typed-password-value");
    expect(JSON.stringify(evaluation)).not.toContain("aria-departure-label");
    expect(JSON.stringify(evaluation)).not.toContain("option-399");
    expect(evaluation.candidates.length).toBeLessThanOrEqual(256);
  });

  it("reuses label and aria-labelledby names when revalidating a DOM click", () => {
    const label = syntheticElement("label", { attrs: { for: "arrival" }, textContent: "Arrival time" });
    const labelledInput = syntheticElement("input", {
      attrs: { id: "arrival", type: "text" },
      labels: [label],
      rect: { x: 10, y: 10, width: 120, height: 24 },
    });
    const ariaLabel = syntheticElement("span", { attrs: { id: "departure-label" }, textContent: "Departure time" });
    const ariaInput = syntheticElement("input", {
      attrs: { id: "departure", type: "text", "aria-labelledby": "departure-label" },
      rect: { x: 10, y: 50, width: 120, height: 24 },
    });
    const emailButton = syntheticElement("button", {
      attrs: { "aria-label": "user@example.com" },
      rect: { x: 10, y: 90, width: 120, height: 24 },
    });
    const page = new SyntheticDocument([label, labelledInput, ariaLabel, ariaInput, emailButton]);
    const context = {
      document: page,
      Element: SyntheticElement,
      getComputedStyle: () => ({ display: "block", visibility: "visible", pointerEvents: "auto" }),
    };
    const evaluation = runInNewContext(MANAGED_DOM_EVALUATION_SCRIPT, {
      ...context,
      window: { innerWidth: 1_000, innerHeight: 800, devicePixelRatio: 1 },
    }) as SyntheticEvaluation;
    for (const expected of [
      { role: "textbox", name: "Arrival time", element: labelledInput },
      { role: "textbox", name: "Departure time", element: ariaInput },
      { role: "button", name: "user@example.com", element: emailButton },
    ]) {
      const candidate = evaluation.candidates.find((item) => item.name === expected.name);
      expect(candidate).toBeDefined();
      const result = runInNewContext(buildManagedDomClickExpression({
        role: expected.role,
        name: expected.name,
        frame: candidate?.frame as { x: number; y: number; width: number; height: number },
        fingerprint: domCandidateFingerprint(candidate as DomGroundingRawCandidate),
      }), context) as { status: string };
      expect(result).toMatchObject({ status: "completed" });
      expect(expected.element.clicked).toBe(true);
    }
  });

  it.each([undefined, "SEARCH", "text"])("round-trips production collector fingerprints for input type %s", (type) => {
    const input = syntheticElement("input", { attrs: { "aria-label": "Query", ...(type === undefined ? {} : { type }) } });
    const page = new SyntheticDocument([input]);
    const context = { document: page, Element: SyntheticElement, getComputedStyle: () => ({ display: "block", visibility: "visible", pointerEvents: "auto" }), window: { innerWidth: 1000, innerHeight: 800, devicePixelRatio: 1 } };
    const candidate = (runInNewContext(MANAGED_DOM_EVALUATION_SCRIPT, context) as SyntheticEvaluation).candidates[0]!;
    const binding = { role: "textbox", name: "Query", frame: candidate.frame as { x: number; y: number; width: number; height: number }, fingerprint: domCandidateFingerprint(candidate as DomGroundingRawCandidate) };
    expect(runInNewContext(buildManagedDomClickExpression(binding), context)).toMatchObject({ status: "completed" });
    expect(page.activeElement).toBe(input);
    expect(runInNewContext(buildManagedDomClickExpression({ ...binding, verifyFocusOnly: true }), context)).toMatchObject({ status: "completed" });
    page.focused = false; // Chrome address bar owns focus, activeElement is retained.
    expect((runInNewContext(MANAGED_DOM_EVALUATION_SCRIPT, context) as SyntheticEvaluation).candidates[0]?.state).toMatchObject({ focused: false });
    input.clicked = false;
    expect(runInNewContext(buildManagedDomClickExpression({ ...binding, verifyFocusOnly: true }), context)).toMatchObject({ status: "refused", driverCode: "DOM_INPUT_FOCUS_MISMATCH" });
    expect(input.clicked).toBe(false);
    page.focused = true;
    page.activeElement = null;
    expect(runInNewContext(buildManagedDomClickExpression({ ...binding, verifyFocusOnly: true }), context)).toMatchObject({ status: "refused" });
    expect(runInNewContext(buildManagedDomClickExpression({ ...binding, fingerprint: "domf-00000000" }), context)).toMatchObject({ status: "refused", driverCode: "DOM_CLICK_CANDIDATE_STALE" });
    const replacement = syntheticElement("input", { attrs: { "aria-label": "Query", type: type === "SEARCH" ? "text" : "search" } });
    expect(runInNewContext(buildManagedDomClickExpression(binding), { ...context, document: new SyntheticDocument([replacement]) })).toMatchObject({ status: "refused", driverCode: "DOM_CLICK_CANDIDATE_STALE" });
    expect(replacement.clicked).toBe(false);
  });

  it("ignores non-input type and refuses occluded native click probes without dispatch", () => {
    const button = syntheticElement("button", { attrs: { type: "submit", "aria-label": "Go" } });
    const page = new SyntheticDocument([button]);
    const context = { document: page, Element: SyntheticElement, getComputedStyle: () => ({ display: "block", visibility: "visible", pointerEvents: "auto" }), window: { innerWidth: 1000, innerHeight: 800, devicePixelRatio: 1 } };
    const candidate = (runInNewContext(MANAGED_DOM_EVALUATION_SCRIPT, context) as SyntheticEvaluation).candidates[0]!;
    const binding = { role: "button", name: "Go", frame: candidate.frame as { x: number; y: number; width: number; height: number }, fingerprint: domCandidateFingerprint(candidate as DomGroundingRawCandidate) };
    expect(runInNewContext(buildManagedDomClickExpression({ ...binding, validateOnly: true }), context)).toMatchObject({ status: "completed" });
    expect(button.clicked).toBe(false);
    page.hitTarget = syntheticElement("div");
    expect(runInNewContext(buildManagedDomClickExpression({ ...binding, validateOnly: true }), context)).toMatchObject({ status: "refused", driverCode: "DOM_CLICK_OCCLUDED" });
    expect(button.clicked).toBe(false);
    expect(runInNewContext(buildManagedDomClickExpression(binding), context)).toMatchObject({ status: "completed" });
  });

  it.each([
    { x: -10, y: 10, width: 120, height: 24 },
    { x: 10, y: -10, width: 120, height: 24 },
    { x: 950, y: 10, width: 120, height: 24 },
    { x: 10, y: 790, width: 120, height: 24 },
  ])("refuses a clipped editable native-click probe at %j without input", (rect) => {
    const input = syntheticElement("input", { attrs: { "aria-label": "Query" }, rect });
    const page = new SyntheticDocument([input]);
    const context = { document: page, Element: SyntheticElement, getComputedStyle: () => ({ display: "block", visibility: "visible", pointerEvents: "auto" }), window: { innerWidth: 1000, innerHeight: 800, devicePixelRatio: 1 } };
    const candidate = (runInNewContext(MANAGED_DOM_EVALUATION_SCRIPT, context) as SyntheticEvaluation).candidates[0]!;
    const result = runInNewContext(buildManagedDomClickExpression({ role: "textbox", name: "Query", frame: rect, fingerprint: domCandidateFingerprint(candidate as DomGroundingRawCandidate), validateOnly: true }), context);
    expect(result).toMatchObject({ status: "refused", driverCode: "DOM_CLICK_CLIPPED" });
    expect(input.clicked).toBe(false);
    expect(page.activeElement).toBeNull();
  });

  it("keeps the local fixture coverage explicit for controls, canvas, shadow DOM and iframe boundaries", async () => {
    // Fixture strings are supplementary; executable round-trip tests above
    // and below exercise the production collector and fingerprint function.
    const fixture = await readFile(new URL("./fixtures/managed-dom-fixture.html", import.meta.url), "utf8");
    expect(fixture).toContain('role="button"');
    expect(fixture).toContain("<input");
    expect(fixture).toContain('type="checkbox"');
    expect(fixture).toContain('type="radio"');
    expect(fixture).toContain('type="range"');
    expect(fixture).toContain("<canvas");
    expect(fixture).toContain("attachShadow");
    expect(fixture).toContain("<iframe");
    expect(fixture).not.toContain("value=");
  });

  it("requires an owned-window resolver and managed URL", () => {
    expect(() => new ManagedBrowserHost({ browser: "edge", url: "https://example.com" } as ManagedBrowserHostOptions)).toThrow(/owned-window resolver/iu);
    expect(() => new ManagedBrowserHost({
      browser: "edge",
      url: "file:///private.html",
      resolveOwnedWindowTarget: async () => undefined,
    })).toThrow(/explicit http|data URL/iu);
    expect(() => new ManagedBrowserHost({
      browser: "edge",
      url: "https://example.com",
      resolveOwnedWindowTarget: async () => undefined,
    })).not.toThrow();
    expect(() => new ManagedBrowserHost({
      browser: "edge",
      url: "data:text/html,fixture",
      resolveOwnedWindowTarget: async () => undefined,
    })).not.toThrow();
    expect(() => new ManagedBrowserHost({
      browser: "edge",
      url: "about:blank",
      resolveOwnedWindowTarget: async () => undefined,
    })).not.toThrow();
    expect(() => new ManagedBrowserHost({
      browser: "edge",
      url: "about:blank",
      registerStartupUrl: true,
      resolveOwnedWindowTarget: async () => undefined,
    })).toThrow(/cannot be registered/iu);
    for (const url of ["about:blank#fragment", "about:newtab", "file:///private.html"]) {
      expect(() => new ManagedBrowserHost({ browser: "edge", url, resolveOwnedWindowTarget: async () => undefined }))
        .toThrow(/explicit http|exact about:blank|data URL/iu);
    }
    expect(() => new ManagedBrowserHost({
      browser: "edge",
      url: "https://example.com",
      profileMode: "persistent",
      resolveOwnedWindowTarget: async () => undefined,
    })).toThrow(/persistent.*profile label.*root/iu);
  });

  it("exposes both read-only gates through the production managed transport", async () => {
    const host = new ManagedBrowserHost({ browser: "chromium", url: "about:blank", resolveOwnedWindowTarget: async () => undefined });
    // Attest a fixture state only; no browser process is launched in this test.
    (host as unknown as { state: object }).state = {};
    const validate = vi.spyOn(host, "validateClick").mockResolvedValue({ status: "completed" });
    const verify = vi.spyOn(host, "verifyFocus").mockResolvedValue({ status: "refused", driverCode: "DOM_INPUT_FOCUS_MISMATCH" });
    const transport = host.createTransport();
    const request = {} as Parameters<ManagedBrowserHost["validateClick"]>[0];
    const signal = new AbortController().signal;
    expect(await transport.validateClick!(request, signal)).toMatchObject({ status: "completed" });
    expect(await transport.verifyFocus!(request, signal)).toMatchObject({ status: "refused" });
    expect(validate).toHaveBeenCalledWith(request, signal);
    expect(verify).toHaveBeenCalledWith(request, signal);
  });

  it("cleans an already-spawned browser and ephemeral profile when startup is aborted", async () => {
    const abort = new AbortController();
    const child = { pid: 654321, exitCode: null } as unknown as ChildProcess;
    const waitForProcessTree = vi.fn(async () => true);
    let profileRoot: string | undefined;
    const host = new ManagedBrowserHost({
      browser: "edge",
      url: "about:blank",
      executablePath: process.execPath,
      startupTimeoutMs: 100,
      resolveOwnedWindowTarget: async () => undefined,
      spawnManagedBrowser: (_executable, args) => {
        const profileArgument = args.find((argument) => argument.startsWith("--user-data-dir="));
        if (profileArgument === undefined) throw new Error("test did not receive the owned profile argument");
        profileRoot = profileArgument.slice("--user-data-dir=".length);
        abort.abort(new Error("fixture abort after spawn"));
        return child;
      },
      cleanupHooks: { waitForProcessTree, closeGracefully: async () => true },
    });

    await expect(host.start(abort.signal)).rejects.toThrow("fixture abort after spawn");
    expect(waitForProcessTree).toHaveBeenCalledOnce();
    expect(profileRoot).toBeDefined();
    await expect(access(profileRoot!)).rejects.toThrow();
  });

  it("reports the exact startup phase with bounded redacted stderr and cleanup certainty", async () => {
    const stderr = new PassThrough();
    const child = { pid: 654322, exitCode: 7, signalCode: null, stderr } as unknown as ChildProcess;
    const diagnostics: Parameters<NonNullable<ManagedBrowserHostOptions["onStartupDiagnostic"]>>[0][] = [];
    const host = new ManagedBrowserHost({
      browser: "edge",
      url: "about:blank",
      executablePath: process.execPath,
      resolveOwnedWindowTarget: async () => undefined,
      spawnManagedBrowser: (_executable, _args, options) => {
        expect(options.stdio).toEqual(["ignore", "ignore", "pipe"]);
        stderr.write("x".repeat(10_000));
        stderr.write("[123:ERROR] profile C:\\Users\\private\\AppData\\Local\\Temp\\profile https://private.example/?token=secret\n");
        stderr.write("[123:ERROR] remote endpoint https://private.example/?token=secret\n");
        stderr.write("[123:ERROR] request token=secret2 api_key=secret3\n");
        return child;
      },
      cleanupHooks: { waitForProcessTree: async () => true, closeGracefully: async () => true },
      onStartupDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });

    await expect(host.start(new AbortController().signal)).rejects.toThrow(/exited before DevTools became ready/iu);
    stderr.destroy();

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      stage: "wait_devtools_port",
      processState: "child_exited",
      exitCode: 7,
      devToolsPortObserved: false,
      cleanup: "confirmed",
    });
    expect(diagnostics[0]?.stderrExcerpt).toContain("<path>");
    expect(diagnostics[0]?.stderrExcerpt).toContain("<url>");
    expect(diagnostics[0]?.stderrExcerpt).toContain("token=<redacted>");
    expect(diagnostics[0]?.stderrExcerpt?.length).toBeLessThanOrEqual(768);
    const formatted = formatManagedBrowserStartupDiagnostic(diagnostics[0]!);
    expect(formatted).toContain("stage=wait_devtools_port");
    expect(formatted).toContain("elapsed_ms=");
    expect(formatted).toContain("process=child_exited");
    expect(formatted).toContain("exit_code=7");
    expect(formatted).toContain("signal=none");
    expect(formatted).toContain("devtools_port=not_observed");
    expect(formatted).toContain("cleanup=confirmed");
    expect(formatted).not.toContain("C:\\Users");
    expect(formatted).not.toContain("private.example");
    expect(formatted).not.toContain("secret");
  });

  it("locks persistent Harness-owned profiles and leaves state for later Runs", async () => {
    const root = await mkdtemp(join(tmpdir(), "computer-harness-profile-lock-"));
    try {
      const first = await acquireManagedBrowserProfileLease({ profileMode: "persistent", profileLabel: "fixture-account", persistentProfileRoot: root });
      await expect(acquireManagedBrowserProfileLease({ profileMode: "persistent", profileLabel: "fixture-account", persistentProfileRoot: root })).rejects.toThrow(/already in use|locked/iu);
      await first.release();
      await expect(access(first.profileRoot)).resolves.toBeUndefined();
      const second = await acquireManagedBrowserProfileLease({ profileMode: "persistent", profileLabel: "fixture-account", persistentProfileRoot: root });
      await second.release();
      const ephemeral = await acquireManagedBrowserProfileLease({ profileMode: "ephemeral" });
      const ephemeralRoot = ephemeral.profileRoot;
      await ephemeral.release();
      await expect(access(ephemeralRoot)).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("stores only bounded, normalized browser-login startup URLs without query or fragment", async () => {
    const root = await mkdtemp(join(tmpdir(), "computer-harness-startup-metadata-"));
    try {
      await expect(readManagedBrowserStartupUrls(root)).resolves.toEqual([]);
      expect(normalizeManagedBrowserStartupUrl("https://example.test/path?token=secret#fragment")).toBe("https://example.test/path");
      expect(() => normalizeManagedBrowserStartupUrl("about:blank")).toThrow(/http\(s\) URL/iu);
      await expect(registerManagedBrowserStartupUrl(root, "about:blank")).rejects.toThrow(/http\(s\) URL/iu);
      await expect(registerManagedBrowserStartupUrl(root, "https://example.test/path?token=secret#fragment")).resolves.toEqual(["https://example.test/path"]);
      await expect(registerManagedBrowserStartupUrl(root, "https://example.test/path?another=secret")).resolves.toEqual(["https://example.test/path"]);
      for (let index = 1; index < 8; index += 1) {
        await registerManagedBrowserStartupUrl(root, `https://site-${index}.test/`);
      }
      await expect(registerManagedBrowserStartupUrl(root, "https://ninth.test/")).rejects.toThrow(/limit is 8/iu);
      const metadata = await readFile(join(root, "managed-browser-startup.json"), "utf8");
      expect(metadata).not.toContain("secret");
      expect(JSON.parse(metadata)).toMatchObject({ schemaVersion: 1, urls: expect.any(Array) });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps prepared startup URLs bounded while reserving the current URL for CDP creation", () => {
    expect(buildManagedBrowserLaunchUrls(["https://prepared.test/", "https://current.test/path"], "https://current.test/path?query=ignored")).toEqual(["https://prepared.test/"]);
    expect(buildManagedBrowserLaunchUrls(["https://prepared.test/", "https://other.test/"], "about:blank")).toEqual([
      "https://prepared.test/",
      "https://other.test/",
    ]);
    expect(buildManagedBrowserLaunchUrls([], "https://current.test/path")).toEqual(["about:blank"]);
    expect(buildManagedBrowserLaunchUrls(["https://prepared.test/"], "data:text/html,fixture")).toEqual(["https://prepared.test/"]);
    expect(buildManagedBrowserLaunchUrls([], "data:text/html,fixture")).toEqual(["about:blank"]);
    expect(buildManagedBrowserLaunchUrls([], "https://current.test/path", "data:text/html,computer-harness-bootstrap-fixture")).toEqual(["data:text/html,computer-harness-bootstrap-fixture"]);
  });


  it("creates an exact startup target for explicit URLs, including about:blank", async () => {
    const command = vi.fn(async (_method: string, params: Record<string, unknown>) => {
      expect(params.newWindow).toBe(false);
      return { result: { targetId: params.url === "about:blank" ? "blank-target" : "current-target" } };
    });
    const close = vi.fn();
    const connect = async () => ({ command, close });
    await expect(createManagedBrowserPage("ws://127.0.0.1:1234/devtools/browser/test", "https://example.test/start", new AbortController().signal, connect)).resolves.toBe("current-target");
    await expect(createManagedBrowserPage("ws://127.0.0.1:1234/devtools/browser/test", "about:blank", new AbortController().signal, connect)).resolves.toBe("blank-target");
    expect(command.mock.calls[0]?.[1]).toMatchObject({ url: "https://example.test/start", newWindow: false });
    expect(command.mock.calls[1]?.[1]).toMatchObject({ url: "about:blank", newWindow: false });
    expect(command).toHaveBeenCalledTimes(2);
  });

  it("activates a startup target through the browser CDP endpoint", async () => {
    const command = vi.fn(async (method: string, params: Record<string, unknown>) => {
      expect(method).toBe("Target.activateTarget");
      expect(params).toEqual({ targetId: "current-tab" });
      return { result: { success: true } };
    });
    const close = vi.fn();
    await activateManagedBrowserPage("ws://127.0.0.1:1234/devtools/browser/test", "current-tab", new AbortController().signal, async () => ({ command, close }));
    expect(command).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("keeps the exact CDP target identity across a redirect even when activity remains hidden", () => {
    const page = { type: "page", id: "current-target", webSocketDebuggerUrl: "ws://current" };
    const activity = { page, browserWindowId: 7, visibilityState: "hidden" as const, hasFocus: false };
    expect(selectManagedBrowserStartupActivity([activity], "current-target", true)).toBe(activity);
    expect(selectManagedBrowserStartupActivity([activity], "prepared-target", true)).toBeUndefined();
    expect(selectManagedBrowserStartupActivity([activity], "current-target", false)).toBeUndefined();
    expect(selectManagedBrowserStartupActivity([{ ...activity, visibilityState: "unloaded" as const }], "current-target", true)).toBeUndefined();
  });

  it("waits for the explicit startup target to leave blank and expose a ready redirected document", async () => {
    const target = { id: "startup-target", type: "page" };
    const readiness = vi.fn()
      .mockResolvedValueOnce({ url: "about:blank", readyState: "complete", hasDocumentElement: true, hasBody: true })
      .mockResolvedValueOnce({ url: "https://redirected.example/path", readyState: "loading", hasDocumentElement: true, hasBody: true })
      .mockResolvedValueOnce({ url: "https://redirected.example/path", readyState: "interactive", hasDocumentElement: true, hasBody: true });

    await expect(waitForManagedBrowserNavigationReady(target, readiness, new AbortController().signal, 1_000))
      .resolves.toMatchObject({ url: "https://redirected.example/path", readyState: "interactive" });
    expect(readiness).toHaveBeenCalledTimes(3);
    expect(readiness.mock.calls.every(([page]) => page.id === "startup-target")).toBe(true);
  });

  it("does not treat a blank, non-http, loading, or bodyless page as navigation ready", async () => {
    const target = { id: "startup-target", type: "page" };
    const readiness = vi.fn().mockResolvedValue({
      url: "about:blank",
      readyState: "complete",
      hasDocumentElement: true,
      hasBody: true,
    });
    await expect(waitForManagedBrowserNavigationReady(target, readiness, new AbortController().signal, 20)).resolves.toBeUndefined();
    expect(readiness).toHaveBeenCalled();
  });

  it("bounds a navigation readiness reader that never resolves and aborts its signal", async () => {
    const target = { id: "startup-target", type: "page" };
    let readerSignal: AbortSignal | undefined;
    const readiness = vi.fn((_page, signal: AbortSignal) => {
      readerSignal = signal;
      return new Promise<undefined>(() => undefined);
    });
    const startedAt = Date.now();
    await expect(waitForManagedBrowserNavigationReady(target, readiness, new AbortController().signal, 30)).resolves.toBeUndefined();
    expect(Date.now() - startedAt).toBeLessThan(250);
    expect(readerSignal?.aborted).toBe(true);
  });

  it("requests Browser.close and treats the expected websocket shutdown as graceful", async () => {
    const command = vi.fn(async (method: string) => {
      expect(method).toBe("Browser.close");
      throw new Error("browser closed websocket after accepting command");
    });
    const close = vi.fn();
    await expect(closeManagedBrowserGracefully("ws://127.0.0.1:1234/devtools/browser/fixture", 100, async () => ({ command, close }))).resolves.toBe(true);
    expect(command).toHaveBeenCalledWith("Browser.close", {}, expect.any(AbortSignal));
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("keeps persistent profile data and lock fail-closed when graceful close and force cleanup time out", async () => {
    const root = await mkdtemp(join(tmpdir(), "computer-harness-cleanup-timeout-"));
    const lockPath = join(root, ".computer-harness-profile.lock");
    const lock = await open(lockPath, "w");
    const cookiesPath = join(root, "Cookies");
    const localStoragePath = join(root, "Local Storage", "marker");
    await writeFile(cookiesPath, "fixture-cookie-marker", "utf8");
    await mkdir(join(root, "Local Storage"), { recursive: true });
    await writeFile(localStoragePath, "fixture-storage-marker", "utf8");
    const diagnostics: string[] = [];
    const waitForProcessTree = vi.fn(async () => false);
    const forceTerminate = vi.fn(async () => undefined);
    const child = { exitCode: null } as unknown as ChildProcess;
    try {
      await cleanupManagedBrowser(child, 4321, "ws://127.0.0.1:1234/devtools/browser/fixture", root, "persistent", lock, (kind) => diagnostics.push(kind), {
        closeGracefully: async () => false,
        waitForProcessTree,
        forceTerminate,
      });
      expect(forceTerminate).toHaveBeenCalledTimes(1);
      expect(waitForProcessTree).toHaveBeenCalledTimes(2);
      expect(diagnostics).toEqual(["graceful_close_failed", "process_exit_timeout"]);
      await expect(access(lockPath)).resolves.toBeUndefined();
      await expect(access(cookiesPath)).resolves.toBeUndefined();
      await expect(access(localStoragePath)).resolves.toBeUndefined();
      await expect(stat(cookiesPath)).resolves.toMatchObject({ size: expect.any(Number) });
    } finally {
      await lock.close().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preserves an ephemeral profile when browser exit cannot be proven", async () => {
    const root = await mkdtemp(join(tmpdir(), "computer-harness-ephemeral-timeout-"));
    const markerPath = join(root, "active-profile-marker");
    await writeFile(markerPath, "must-remain-until-process-exits", "utf8");
    const diagnostics: string[] = [];
    const child = { exitCode: null } as unknown as ChildProcess;
    try {
      await cleanupManagedBrowser(child, 4321, "ws://127.0.0.1:1234/devtools/browser/fixture", root, "ephemeral", undefined, (kind) => diagnostics.push(kind), {
        closeGracefully: async () => false,
        waitForProcessTree: async () => false,
        forceTerminate: async () => undefined,
      });
      expect(diagnostics).toEqual(["graceful_close_failed", "process_exit_timeout", "profile_cleanup_failed"]);
      await expect(access(root)).resolves.toBeUndefined();
      await expect(readFile(markerPath, "utf8")).resolves.toBe("must-remain-until-process-exits");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("releases the persistent lock after graceful close even when Browser.close reports a transport error", async () => {
    const root = await mkdtemp(join(tmpdir(), "computer-harness-cleanup-graceful-"));
    const lockPath = join(root, ".computer-harness-profile.lock");
    const lock = await open(lockPath, "w");
    const diagnostics: string[] = [];
    const child = { exitCode: null } as unknown as ChildProcess;
    try {
      await cleanupManagedBrowser(child, 4321, "ws://127.0.0.1:1234/devtools/browser/fixture", root, "persistent", lock, (kind) => diagnostics.push(kind), {
        closeGracefully: async () => { throw new Error("fixture close error"); },
        waitForProcessTree: async () => true,
      });
      expect(diagnostics).toEqual(["graceful_close_failed"]);
      await expect(access(lockPath)).rejects.toThrow();
    } finally {
      await lock.close().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  });

  it("on Windows still closes the browser when the broker child already reports exit but its owned tree is live", async () => {
    if (process.platform !== "win32") return;
    const root = await mkdtemp(join(tmpdir(), "computer-harness-cleanup-broker-child-"));
    const lockPath = join(root, ".computer-harness-profile.lock");
    const lock = await open(lockPath, "w");
    const child = { exitCode: 0 } as unknown as ChildProcess;
    const closeGracefully = vi.fn(async () => true);
    const waitForProcessTree = vi.fn(async () => waitForProcessTree.mock.calls.length > 1);
    const forceTerminate = vi.fn(async () => undefined);
    try {
      await cleanupManagedBrowser(child, 4321, "ws://127.0.0.1:1234/devtools/browser/fixture", root, "persistent", lock, undefined, {
        closeGracefully,
        waitForProcessTree,
        forceTerminate,
      });
      expect(closeGracefully).toHaveBeenCalledTimes(1);
      expect(waitForProcessTree).toHaveBeenCalledTimes(2);
      expect(forceTerminate).toHaveBeenCalledTimes(1);
      await expect(access(lockPath)).rejects.toThrow();
    } finally {
      await lock.close().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not force terminate when an already-exited child has an empty owned tree", async () => {
    if (process.platform !== "win32") return;
    const root = await mkdtemp(join(tmpdir(), "computer-harness-cleanup-empty-tree-"));
    const lockPath = join(root, ".computer-harness-profile.lock");
    const lock = await open(lockPath, "w");
    const child = { exitCode: 0 } as unknown as ChildProcess;
    const closeGracefully = vi.fn(async () => true);
    const waitForProcessTree = vi.fn(async () => true);
    const forceTerminate = vi.fn(async () => undefined);
    try {
      await cleanupManagedBrowser(child, 4321, "ws://127.0.0.1:1234/devtools/browser/fixture", root, "persistent", lock, undefined, {
        closeGracefully,
        waitForProcessTree,
        forceTerminate,
      });
      expect(closeGracefully).toHaveBeenCalledTimes(1);
      expect(waitForProcessTree).toHaveBeenCalledTimes(1);
      expect(forceTerminate).not.toHaveBeenCalled();
      await expect(access(lockPath)).rejects.toThrow();
    } finally {
      await lock.close().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  });

  it("clears only stale DevToolsActivePort and accepts the next fresh port file", async () => {
    const root = await mkdtemp(join(tmpdir(), "computer-harness-devtools-fresh-"));
    const child = { exitCode: null } as unknown as ChildProcess;
    const portFile = join(root, "DevToolsActivePort");
    try {
      await writeFile(portFile, "1111\nstale-browser\n", "utf8");
      await writeFile(join(root, "Cookies"), "login-state-must-remain", "utf8");
      const freshnessBoundaryMs = await prepareManagedBrowserDevToolsLaunch(root);
      await expect(access(portFile)).rejects.toThrow();
      await writeFile(portFile, "2222\nfresh-browser\n", "utf8");
      // Real filesystem I/O stays covered, but this test allows normal CI
      // scheduling delays instead of treating 300 ms as a startup contract.
      await expect(waitForDevToolsPort(root, child, 2_000, new AbortController().signal, freshnessBoundaryMs)).resolves.toEqual({ port: 2222 });
      await expect(readFile(join(root, "Cookies"), "utf8")).resolves.toBe("login-state-must-remain");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("continues rejecting a DevTools port file whose explicit mtime predates launch", async () => {
    const root = await mkdtemp(join(tmpdir(), "computer-harness-devtools-old-mtime-"));
    const portFile = join(root, "DevToolsActivePort");
    const child = { exitCode: null } as unknown as ChildProcess;
    try {
      await writeFile(portFile, "3333\nstale-browser\n", "utf8");
      const freshnessBoundaryMs = await prepareManagedBrowserDevToolsLaunch(root);
      await writeFile(portFile, "3333\nstale-browser\n", "utf8");
      const oldTime = new Date(freshnessBoundaryMs - 60_000);
      await utimes(portFile, oldTime, oldTime);
      await expect(waitForDevToolsPort(root, child, 150, new AbortController().signal, freshnessBoundaryMs))
        .rejects.toThrow(/startup timed out/iu);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("handles a missing port file, an exited browser, abort, and bounded timeout", async () => {
    const root = await mkdtemp(join(tmpdir(), "computer-harness-devtools-unavailable-"));
    const child = { exitCode: null } as unknown as ChildProcess;
    try {
      await expect(waitForDevToolsPort(root, child, 100, new AbortController().signal))
        .rejects.toThrow(/startup timed out/iu);
      await expect(waitForDevToolsPort(root, { exitCode: 1 } as unknown as ChildProcess, 1_000, new AbortController().signal))
        .rejects.toThrow(/exited before DevTools became ready/iu);

      const controller = new AbortController();
      const pending = waitForDevToolsPort(root, child, 1_000, controller.signal);
      setTimeout(() => controller.abort(new Error("fixture abort")), 20);
      await expect(pending).rejects.toThrow("fixture abort");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("retries a transient /json/version gap and times out permanently unavailable endpoints", async () => {
    const child = { exitCode: null } as unknown as ChildProcess;
    let attempts = 0;
    await expect(waitForDevToolsBrowserEndpoint(1234, child, 300, new AbortController().signal, async () => {
      attempts += 1;
      if (attempts < 3) throw new Error("endpoint not ready");
      return "ws://127.0.0.1:1234/devtools/browser/fresh";
    })).resolves.toContain("fresh");
    expect(attempts).toBeGreaterThanOrEqual(3);
    await expect(waitForDevToolsBrowserEndpoint(1234, child, 120, new AbortController().signal, async () => {
      throw new Error("endpoint permanently unavailable");
    })).rejects.toThrow(/startup timed out/iu);
  });

  it("rejects missing, multi-window and mismatched ownership evidence", () => {
    expect(() => validateOwnedWindowResolution(10, undefined)).toThrow(/no exact target/iu);
    const base: ManagedBrowserWindowResolution = {
      target: { pid: 10, windowId: 20 },
      ownershipEvidence: { ownedByHost: true, hostProcessId: 10, processId: 10, windowId: 20, windowCount: 1 },
    };
    expect(validateOwnedWindowResolution(10, base)).toEqual(base.target);
    expect(() => validateOwnedWindowResolution(10, { ...base, ownershipEvidence: { ...base.ownershipEvidence, windowCount: 2 } })).toThrow(/ownership_mismatch/iu);
    expect(() => validateOwnedWindowResolution(10, { ...base, ownershipEvidence: { ...base.ownershipEvidence, processId: 99 } })).toThrow(/ownership_mismatch/iu);
  });

  it("revalidates the bound page set without confusing navigation or a replacement tab", () => {
    const sameTab = [{ type: "page", id: "tab-1", webSocketDebuggerUrl: "ws://127.0.0.1:1/devtools/page/tab-1-navigation" }];
    expect(validateManagedBrowserPageSet(sameTab, "tab-1")).toMatchObject({ id: "tab-1" });
    expect(validateManagedBrowserPageSet([{ type: "page", id: "tab-1", webSocketDebuggerUrl: "ws://127.0.0.1:1/old" }, { type: "page", id: "popup", webSocketDebuggerUrl: "ws://127.0.0.1:1/popup" }], "tab-1")).toBeUndefined();
    expect(validateManagedBrowserPageSet([{ type: "page", id: "replacement", webSocketDebuggerUrl: "ws://127.0.0.1:1/replacement" }], "tab-1")).toBeUndefined();
    expect(validateManagedBrowserPageSet([], "tab-1")).toBeUndefined();
  });

  it("selects one visible active tab only inside the attested browser window", () => {
    const hiddenMain = { page: { type: "page", id: "tab-main", webSocketDebuggerUrl: "ws://main" }, browserWindowId: 7, visibilityState: "hidden" as const, hasFocus: false };
    const visibleSwitched = { page: { type: "page", id: "tab-switched", webSocketDebuggerUrl: "ws://switched" }, browserWindowId: 7, visibilityState: "visible" as const, hasFocus: true };
    const visiblePopup = { page: { type: "page", id: "popup", webSocketDebuggerUrl: "ws://popup" }, browserWindowId: 8, visibilityState: "visible" as const, hasFocus: true };
    expect(resolveManagedBrowserActivePage([hiddenMain, visibleSwitched], 7)).toBe(visibleSwitched);
    expect(resolveManagedBrowserActivePage([hiddenMain, visiblePopup], 7)).toBeUndefined();
    expect(resolveManagedBrowserActivePage([{ ...visibleSwitched, page: { ...visibleSwitched.page, id: "another-visible" } }, visibleSwitched], 7)).toBeUndefined();
    expect(resolveManagedBrowserActivePage([{ ...hiddenMain, visibilityState: "hidden" as const }], 7)).toBeUndefined();
  });

  it("selects the active about:blank page ahead of hidden restored startup tabs", async () => {
    const pages = [
      { type: "page", id: "blank-start-tab", webSocketDebuggerUrl: "ws://blank" },
      { type: "page", id: "restored-travel-tab", webSocketDebuggerUrl: "ws://restored" },
    ];
    const activities = new Map([
      ["blank-start-tab", { page: pages[0]!, browserWindowId: 7, visibilityState: "visible" as const, hasFocus: true }],
      ["restored-travel-tab", { page: pages[1]!, browserWindowId: 7, visibilityState: "hidden" as const, hasFocus: false }],
    ]);
    const readActivity = vi.fn(async (page: { id?: unknown }) => activities.get(String(page.id)));
    await expect(resolveManagedBrowserActivePageSet(pages, readActivity, new AbortController().signal, undefined, true))
      .resolves.toMatchObject({ page: { id: "blank-start-tab" }, browserWindowId: 7 });
  });

  it("selects the uniquely focused page when a persistent profile restores another visible window", async () => {
    const pages = [
      { type: "page", id: "focused-start-tab", webSocketDebuggerUrl: "ws://focused" },
      { type: "page", id: "restored-window-tab", webSocketDebuggerUrl: "ws://restored" },
    ];
    const activities = new Map([
      ["focused-start-tab", { page: pages[0]!, browserWindowId: 7, visibilityState: "visible" as const, hasFocus: true }],
      ["restored-window-tab", { page: pages[1]!, browserWindowId: 8, visibilityState: "visible" as const, hasFocus: false }],
    ]);
    const readActivity = vi.fn(async (page: { id?: unknown }) => activities.get(String(page.id)));
    await expect(resolveManagedBrowserActivePageSet(pages, readActivity, new AbortController().signal, undefined, true))
      .resolves.toMatchObject({ page: { id: "focused-start-tab" }, browserWindowId: 7 });
  });

  it("rejects two visible pages in the selected startup window even when one has focus", async () => {
    const pages = [
      { type: "page", id: "focused-tab", webSocketDebuggerUrl: "ws://focused" },
      { type: "page", id: "second-visible-tab", webSocketDebuggerUrl: "ws://second" },
    ];
    const activities = new Map([
      ["focused-tab", { page: pages[0]!, browserWindowId: 7, visibilityState: "visible" as const, hasFocus: true }],
      ["second-visible-tab", { page: pages[1]!, browserWindowId: 7, visibilityState: "visible" as const, hasFocus: false }],
    ]);
    const readActivity = vi.fn(async (page: { id?: unknown }) => activities.get(String(page.id)));
    await expect(resolveManagedBrowserActivePageSet(pages, readActivity, new AbortController().signal, undefined, true)).resolves.toBeUndefined();
    await expect(resolveManagedBrowserActivePageSet(pages, readActivity, new AbortController().signal, 7)).resolves.toBeUndefined();
  });

  it("uses a bounded fake CDP activity reader for a multi-tab active selection", async () => {
    const pages = [
      { type: "page", id: "tab-main", webSocketDebuggerUrl: "ws://main" },
      { type: "page", id: "tab-switched", webSocketDebuggerUrl: "ws://switched" },
      { type: "page", id: "popup", webSocketDebuggerUrl: "ws://popup" },
    ];
    const activities = new Map([
      ["tab-main", { page: pages[0]!, browserWindowId: 7, visibilityState: "hidden" as const, hasFocus: false }],
      ["tab-switched", { page: pages[1]!, browserWindowId: 7, visibilityState: "visible" as const, hasFocus: true }],
      ["popup", { page: pages[2]!, browserWindowId: 8, visibilityState: "visible" as const, hasFocus: true }],
    ]);
    const readActivity = vi.fn(async (page: { id?: unknown }) => activities.get(String(page.id)));
    await expect(resolveManagedBrowserActivePageSet(pages, readActivity, new AbortController().signal, 7)).resolves.toMatchObject({ page: { id: "tab-switched" }, browserWindowId: 7 });
    expect(readActivity).toHaveBeenCalledTimes(3);
    await expect(resolveManagedBrowserActivePageSet(pages, readActivity, new AbortController().signal, undefined, true)).resolves.toBeUndefined();
    await expect(resolveManagedBrowserActivePageSet(pages, readActivity, new AbortController().signal, 8)).resolves.toMatchObject({ page: { id: "popup" }, browserWindowId: 8 });
  });

  it("reassembles bounded fragmented CDP text frames", async () => {
    const server = createServer((socket) => {
      let request = Buffer.alloc(0);
      let handshakeDone = false;
      let responseSent = false;
      socket.on("data", (chunk) => {
        request = Buffer.concat([request, Buffer.from(chunk)]);
        if (!handshakeDone) {
          const marker = request.indexOf("\r\n\r\n");
          if (marker < 0) return;
          const headers = request.subarray(0, marker).toString("ascii");
          const key = headers.split(/\r\n/u).find((line) => /^sec-websocket-key:/iu.test(line))?.split(":", 2)[1]?.trim() ?? "";
          const accept = createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
          socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
          request = request.subarray(marker + 4);
          handshakeDone = true;
        }
        if (responseSent || request.length === 0) return;
        const payload = Buffer.from(JSON.stringify({ id: 1, result: { result: { value: { candidates: [], complete: true } } } }), "utf8");
        const split = Math.floor(payload.length / 2);
        socket.write(serverTextFrame(payload.subarray(0, split), 0x1, false));
        socket.write(serverTextFrame(payload.subarray(split), 0x0, true));
        responseSent = true;
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    const client = await LoopbackWebSocket.connect(`ws://127.0.0.1:${port}/devtools/page/fixture`, new AbortController().signal);
    try {
      await expect(client.command("Runtime.evaluate", {}, new AbortController().signal)).resolves.toMatchObject({ result: { result: { value: { candidates: [], complete: true } } } });
    } finally {
      client.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

interface SyntheticElementOptions {
  readonly attrs?: Readonly<Record<string, string>>;
  readonly children?: readonly SyntheticElement[];
  readonly labels?: readonly SyntheticElement[];
  readonly selectedOptions?: readonly SyntheticElement[];
  readonly textContent?: string;
  readonly tabIndex?: number;
  readonly disabled?: boolean;
  readonly isContentEditable?: boolean;
  readonly rect?: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
}

interface SyntheticCandidate {
  readonly name?: string;
  readonly description?: string;
  readonly inputType?: string;
  readonly [key: string]: unknown;
}

interface SyntheticEvaluation {
  readonly candidates: readonly SyntheticCandidate[];
}

class SyntheticElement {
  public onFocus: (() => void) | undefined;
  public readonly localName: string;
  public readonly children: readonly SyntheticElement[];
  public readonly labels: readonly SyntheticElement[] | undefined;
  public readonly selectedOptions: readonly SyntheticElement[] | undefined;
  public readonly textContent: string;
  public readonly tabIndex: number;
  public readonly disabled: boolean;
  public readonly isContentEditable: boolean;
  public readonly shadowRoot: undefined;
  public clicked = false;
  private readonly attrs: Readonly<Record<string, string>>;
  private readonly rect: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };

  public constructor(localName: string, options: SyntheticElementOptions = {}) {
    this.localName = localName;
    this.attrs = options.attrs ?? {};
    this.children = options.children ?? [];
    this.labels = options.labels;
    this.selectedOptions = options.selectedOptions;
    this.textContent = options.textContent ?? "";
    this.tabIndex = options.tabIndex ?? -1;
    this.disabled = options.disabled === true;
    this.isContentEditable = options.isContentEditable === true;
    this.shadowRoot = undefined;
    this.rect = options.rect ?? { x: 10, y: 10, width: 120, height: 24 };
  }

  public getAttribute(name: string): string | null {
    return this.attrs[name] ?? null;
  }

  public getBoundingClientRect(): { readonly x: number; readonly y: number; readonly width: number; readonly height: number } {
    return this.rect;
  }

  public click(): void {
    this.clicked = true;
  }

  public focus(): void { this.onFocus?.(); }

  public querySelectorAll(selector: string): readonly SyntheticElement[] {
    const descendants = this.descendants();
    if (selector === "*") return descendants;
    if (selector === "option") return descendants.filter((element) => element.localName === "option");
    if (selector === '[role="option"][aria-selected="true"]') {
      return descendants.filter((element) => element.getAttribute("role") === "option" && element.getAttribute("aria-selected") === "true");
    }
    return [];
  }

  private descendants(): SyntheticElement[] {
    const result: SyntheticElement[] = [];
    const visit = (element: SyntheticElement): void => {
      result.push(element);
      for (const child of element.children) visit(child);
    };
    for (const child of this.children) visit(child);
    return result;
  }
}

class SyntheticDocument {
  public activeElement: SyntheticElement | null = null;
  public focused = true;
  public hitTarget: SyntheticElement | undefined;
  public elementFromPoint(): SyntheticElement | null { return this.hitTarget ?? this.allElements()[0] ?? null; }
  public hasFocus(): boolean { return this.focused; }
  private readonly roots: readonly SyntheticElement[];

  public constructor(roots: readonly SyntheticElement[]) {
    this.roots = roots;
    for (const element of this.allElements()) element.onFocus = () => { this.activeElement = element; };
  }

  public querySelectorAll(selector: string): readonly SyntheticElement[] {
    const elements = this.allElements();
    if (selector === "*") return elements;
    if (selector === "label[for]") return elements.filter((element) => element.localName === "label" && element.getAttribute("for") !== null);
    return [];
  }

  public getElementById(id: string): SyntheticElement | null {
    return this.allElements().find((element) => element.getAttribute("id") === id) ?? null;
  }

  private allElements(): SyntheticElement[] {
    const elements: SyntheticElement[] = [];
    const seen = new Set<SyntheticElement>();
    const visit = (element: SyntheticElement): void => {
      if (seen.has(element)) return;
      seen.add(element);
      elements.push(element);
      for (const child of element.children) visit(child);
    };
    for (const root of this.roots) visit(root);
    return elements;
  }
}

function syntheticElement(localName: string, options: SyntheticElementOptions = {}): SyntheticElement {
  return new SyntheticElement(localName, options);
}

function serverTextFrame(payload: Buffer, opcode: number, final: boolean): Buffer {
  const header = Buffer.alloc(payload.length < 126 ? 2 : 4);
  header[0] = (final ? 0x80 : 0) | opcode;
  if (payload.length < 126) header[1] = payload.length;
  else { header[1] = 126; header.writeUInt16BE(payload.length, 2); }
  return Buffer.concat([header, payload]);
}
