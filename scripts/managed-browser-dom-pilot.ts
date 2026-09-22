import { createServer } from "node:http";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CuaDriverComputer,
  ManagedBrowserHost,
  defaultManagedBrowserKind,
  inspectManagedBrowserProcessTree,
  resolveOwnedManagedBrowserWindow,
  type DomGroundingTransportResult,
  type ManagedBrowserStartupPageDiagnostic,
  type ManagedBrowserWindowResolutionDiagnostic,
} from "../packages/computer-cua/src/index.js";
import type { ActionId, ComputerSessionId, GroundingElement, ObservationCapture, ObservationId, Viewport } from "../packages/protocol/src/index.js";
const { CuaDriver, EndSessionInput, StartSessionInput } = await import("../packages/computer-cua/node_modules/@trycua/cua-driver/dist/index.js");

const SOCKET_PATH = process.env.COMPUTER_HARNESS_CUA_SOCKET
  ?? (process.platform === "win32"
    ? "\\\\.\\pipe\\computer-harness-local"
    : join(tmpdir(), `computer-harness-${typeof process.getuid === "function" ? process.getuid() : "local"}.sock`));
const SESSION_LABEL = `managed-dom-readonly-pilot-${Date.now()}`;
const FIXTURE_PATH = new URL("../packages/computer-cua/src/fixtures/managed-dom-fixture.html", import.meta.url);
const MANAGED_BROWSER = defaultManagedBrowserKind();
const ALLOW_INPUT = process.argv.includes("--allow-input");

interface PilotSummary {
  readonly schemaVersion: "managed-dom-pilot-v1";
  readonly status: "passed" | "gate" | "failed";
  readonly nodeMajor: number;
  readonly transport: "managed-loopback-cdp-v1";
  readonly windowBinding: "passed" | "gate";
  readonly windowResolutionDiagnostics: readonly ManagedBrowserWindowResolutionDiagnostic[];
  readonly startupPageDiagnostics: readonly { readonly pageCount: number; readonly selected: boolean }[];
  readonly cleanupDiagnostics: readonly string[];
  readonly liveOwnedProcessCountAfterClose?: number;
  readonly profileExitTypeNormalAfterClose?: boolean;
  readonly gateCode?: string;
  readonly modelCalls: 0;
  readonly desktopInputCalls: number;
  readonly screenshots: number;
  readonly cookiesRead: 0;
  readonly storageRead: 0;
  readonly accessibility: {
    readonly advertised: boolean;
    readonly source: string;
    readonly degraded: boolean;
    readonly elementCount: number;
    readonly domElementCount: number;
    readonly documentRegionObserved: boolean;
  };
  readonly actions: {
    readonly enabled: boolean;
    readonly clickElement: boolean;
    readonly typeText: boolean;
    readonly scroll: boolean;
    readonly postActionDomVerified: boolean;
  };
  readonly fixture: {
    readonly candidateCount: number;
    readonly roleCounts: Readonly<Record<string, number>>;
    readonly bboxCount: number;
    readonly customDivOrButtonObserved: boolean;
    readonly inputObserved: boolean;
    readonly shadowCandidateObserved: boolean;
    readonly cookieMarkerPresent: boolean;
    readonly storageMarkerPresent: boolean;
    readonly canvasVisualOnly: true;
    readonly iframeBoundaryUntraversed: true;
    readonly startupPageCount: number;
    readonly sameBrowserWindow: boolean;
  };
}

async function main(): Promise<void> {
  const outputDir = join("runs", `managed-browser-dom-pilot-${new Date().toISOString().replace(/[-:.TZ]/gu, "")}`);
  await mkdir(outputDir, { recursive: true });
  let status: PilotSummary["status"] = "gate";
  let gateCode = "UNSET";
  let server: ReturnType<typeof createServer> | undefined;
  let driver: ReturnType<typeof CuaDriver.connect> | undefined;
  let sessionStarted = false;
  let host: ManagedBrowserHost | undefined;
  let persistentProfileRoot: string | undefined;
  let stage = "init";
  let firstCloseLock: "present" | "released" = "released";
  let liveOwnedProcessCountAfterClose: number | undefined;
  let profileExitTypeNormalAfterClose: boolean | undefined;
  let fixture: PilotSummary["fixture"] = emptyFixtureSummary();
  let accessibility: PilotSummary["accessibility"] = { advertised: false, source: "none", degraded: true, elementCount: 0, domElementCount: 0, documentRegionObserved: false };
  let desktopInputCalls = 0;
  let screenshots = 0;
  let actions: PilotSummary["actions"] = { enabled: ALLOW_INPUT, clickElement: false, typeText: false, scroll: false, postActionDomVerified: false };
  const windowResolutionDiagnostics: ManagedBrowserWindowResolutionDiagnostic[] = [];
  const cleanupDiagnostics: string[] = [];
  const startupPageDiagnostics: ManagedBrowserStartupPageDiagnostic[] = [];
  try {
    const html = await readFile(FIXTURE_PATH, "utf8");
    stage = "fixture-server";
    server = createServer((request, response) => {
      if (request.method !== "GET" || !/^\/fixture-[ab]$/u.test(request.url ?? "")) {
        response.writeHead(404).end();
        return;
      }
      if (request.url === "/fixture-a") response.setHeader("set-cookie", "harness_dom_pilot_marker=present; Path=/; SameSite=Lax");
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      const markerScript = `<script>(() => { const addMarker = (name, left) => { if (document.querySelector('[aria-label="' + name + '"]')) return; const element = document.createElement('button'); element.setAttribute('aria-label', name); element.style.cssText = 'position:fixed;left:' + left + 'px;top:20px;width:40px;height:30px;z-index:10'; document.body.appendChild(element); }; document.body.style.minHeight = '1800px'; if (location.pathname.endsWith('/fixture-a') && localStorage.getItem('harness_dom_pilot_marker') === null) localStorage.setItem('harness_dom_pilot_marker', 'present'); const cookie = document.cookie.split(';').some((item) => item.trim() === 'harness_dom_pilot_marker=present'); const storage = localStorage.getItem('harness_dom_pilot_marker') === 'present'; if (cookie) addMarker('cookie-marker-present', 700); if (storage) addMarker('storage-marker-present', 750); document.querySelector('[aria-label="Continue"]')?.addEventListener('click', () => addMarker('click-marker-present', 800)); document.querySelector('[aria-label="Search"]')?.addEventListener('input', () => addMarker('input-marker-present', 850)); addEventListener('scroll', () => { if (scrollY > 0) addMarker('scroll-marker-present', 900); }, { passive: true }); })();</script>`;
      const routeMarker = request.url === "/fixture-b" ? '<button aria-label="route-b-marker" style="position:fixed;left:650px;top:20px;width:40px;height:30px">B</button>' : "";
      response.end(html.replace("</body>", `${routeMarker}${markerScript}</body>`));
    });
    await new Promise<void>((resolve, reject) => {
      server!.once("error", reject);
      server!.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("fixture server did not expose a loopback port");
    const fixtureBaseUrl = `http://127.0.0.1:${address.port}`;

    driver = CuaDriver.connect(SOCKET_PATH);
    stage = "cua-session";
    await driver.startSession(StartSessionInput.new({ session: SESSION_LABEL }), { signal: new AbortController().signal });
    sessionStarted = true;
    persistentProfileRoot = await mkdtemp(join(tmpdir(), "computer-harness-managed-dom-pilot-profile-"));
    stage = "first-host-start";
    host = new ManagedBrowserHost({
      browser: MANAGED_BROWSER,
      url: `${fixtureBaseUrl}/fixture-a`,
      profileMode: "persistent",
      profileLabel: "pilot",
      persistentProfileRoot,
      registerStartupUrl: true,
      resolveOwnedWindowTarget: (browserProcessId, signal, hint) => resolveOwnedManagedBrowserWindow(driver!, SESSION_LABEL, browserProcessId, signal, hint),
      onWindowResolutionDiagnostic: (diagnostic) => windowResolutionDiagnostics.push(diagnostic),
      onStartupPageDiagnostic: (diagnostic) => startupPageDiagnostics.push(diagnostic),
      onCleanupDiagnostic: (kind) => cleanupDiagnostics.push(kind),
    });
    const firstRecord = await host.start(new AbortController().signal);
    stage = "first-host-close";
    await host.close();
    liveOwnedProcessCountAfterClose = await inspectManagedBrowserProcessTree(firstRecord.processId, join(persistentProfileRoot!, "pilot"));
    profileExitTypeNormalAfterClose = await readProfileExitTypeNormal(join(persistentProfileRoot!, "pilot"));
    try {
      await access(join(persistentProfileRoot, "pilot", ".computer-harness-profile.lock"));
      firstCloseLock = "present";
    } catch {
      firstCloseLock = "released";
    }
    stage = "second-host-start";
    host = new ManagedBrowserHost({
      browser: MANAGED_BROWSER,
      url: `${fixtureBaseUrl}/fixture-b`,
      profileMode: "persistent",
      profileLabel: "pilot",
      persistentProfileRoot,
      registerStartupUrl: true,
      resolveOwnedWindowTarget: (browserProcessId, signal, hint) => resolveOwnedManagedBrowserWindow(driver!, SESSION_LABEL, browserProcessId, signal, hint),
      onWindowResolutionDiagnostic: (diagnostic) => windowResolutionDiagnostics.push(diagnostic),
      onStartupPageDiagnostic: (diagnostic) => startupPageDiagnostics.push(diagnostic),
      onCleanupDiagnostic: (kind) => cleanupDiagnostics.push(kind),
    });
    const record = await host.start(new AbortController().signal);
    stage = "second-host-collect";
    const startupPages = startupPageDiagnostics.at(-1);
    if (startupPages === undefined || !startupPages.selected || startupPages.pageCount !== 2) throw new Error("managed persistent startup did not expose two pages in one browser window");
    const transport = host.createTransport();
    const viewport: Viewport = { width: 1_280, height: 720, coordinateSpace: "physical" };
    const collectRequest = {
      observationId: "managed-dom-pilot-observation" as ObservationId,
      computerSessionId: SESSION_LABEL as ComputerSessionId,
      viewport,
      browserTarget: record.target,
    };
    const collectSignal = new AbortController().signal;
    let result: DomGroundingTransportResult | undefined;
    const fixtureReadyDeadline = Date.now() + 5_000;
    while (Date.now() < fixtureReadyDeadline) {
      const candidate = await transport.collect(collectRequest, collectSignal);
      const names = candidate.candidates.map((item) => typeof item.name === "string" ? item.name.toLocaleLowerCase() : "");
      if (candidate.candidates.length >= 11 && names.some((name) => name.includes("cookie-marker-present")) && names.some((name) => name.includes("storage-marker-present"))) {
        result = candidate;
        break;
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    }
    if (result === undefined) throw new Error("managed persistent startup did not make the explicit current URL active or retain markers");
    fixture = { ...summarizeFixture(result, record.target.tabId, record.target.generation), startupPageCount: startupPages.pageCount, sameBrowserWindow: true };
    if (!fixture.cookieMarkerPresent || !fixture.storageMarkerPresent) throw new Error("managed persistent profile markers were not retained");
    stage = "hybrid-accessibility-observe";
    const computer = new CuaDriverComputer({
      socketPath: SOCKET_PATH,
      screenshotDir: outputDir,
      windowTarget: record.target.windowTarget,
      windowDeliveryMode: "foreground",
      grounding: "hybrid-catalog-v1",
      browserTarget: record.target,
      domGroundingTransport: transport,
    });
    const computerSignal = new AbortController().signal;
    const computerSession = await computer.open({}, computerSignal);
    try {
      const capture = await computer.observe(computerSession, "managed-dom-pilot-hybrid-observation" as ObservationId, computerSignal);
      screenshots += 1;
      const elements = capture.grounding?.elements ?? [];
      accessibility = {
        advertised: computerSession.capabilities.accessibility,
        source: capture.grounding?.source ?? "none",
        degraded: capture.grounding?.degraded ?? true,
        elementCount: elements.length,
        domElementCount: elements.filter((element) => element.source === "dom").length,
        documentRegionObserved: elements.some((element) => /document|webarea/iu.test(element.role)),
      };
      if (ALLOW_INPUT) {
        await writeFile(join(outputDir, "before-actions.png"), capture.screenshot.data);
        stage = "hybrid-click-element";
        const continueElement = findGroundingElement(capture, "continue");
        const clickObservationId = "managed-dom-pilot-hybrid-observation" as ObservationId;
        const clickReceipt = await computer.execute(computerSession, {
          actionId: "managed-dom-pilot-click" as ActionId,
          basedOn: clickObservationId,
          kind: "click",
          point: center(continueElement),
          groundingRef: continueElement.elementRef,
        }, computerSignal);
        if (clickReceipt.status !== "completed") process.stderr.write(`${JSON.stringify({ clickReceipt })}\n`);
        requireCompleted(clickReceipt.status, "click_element");
        desktopInputCalls += 1;
        actions = { ...actions, clickElement: true };

        stage = "hybrid-click-verify";
        const afterClickId = "managed-dom-pilot-after-click" as ObservationId;
        const afterClick = await computer.observe(computerSession, afterClickId, computerSignal);
        await writeFile(join(outputDir, "after-click.png"), afterClick.screenshot.data);
        screenshots += 1;
        findGroundingElement(afterClick, "click-marker-present");

        stage = "hybrid-type";
        const searchElement = findGroundingElement(afterClick, "search");
        requireCompleted((await computer.execute(computerSession, {
          actionId: "managed-dom-pilot-focus-input" as ActionId,
          basedOn: afterClickId,
          kind: "click",
          point: center(searchElement),
          groundingRef: searchElement.elementRef,
        }, computerSignal)).status, "input click_element");
        desktopInputCalls += 1;
        requireCompleted((await computer.execute(computerSession, {
          actionId: "managed-dom-pilot-type" as ActionId,
          basedOn: afterClickId,
          kind: "type",
          text: "mac-dom-probe",
        }, computerSignal)).status, "type_text");
        desktopInputCalls += 1;
        actions = { ...actions, typeText: true };

        stage = "hybrid-type-verify";
        const afterTypeId = "managed-dom-pilot-after-type" as ObservationId;
        const afterType = await computer.observe(computerSession, afterTypeId, computerSignal);
        screenshots += 1;
        findGroundingElement(afterType, "input-marker-present");

        stage = "hybrid-scroll";
        requireCompleted((await computer.execute(computerSession, {
          actionId: "managed-dom-pilot-scroll" as ActionId,
          basedOn: afterTypeId,
          kind: "scroll",
          point: { x: afterType.viewport.width / 2, y: afterType.viewport.height / 2 },
          direction: "down",
          ticks: 5,
        }, computerSignal)).status, "scroll");
        desktopInputCalls += 1;
        actions = { ...actions, scroll: true };

        stage = "hybrid-scroll-verify";
        const afterScroll = await computer.observe(computerSession, "managed-dom-pilot-after-scroll" as ObservationId, computerSignal);
        screenshots += 1;
        findGroundingElement(afterScroll, "scroll-marker-present");
        actions = { ...actions, postActionDomVerified: true };
      }
    } finally {
      await computer.close(computerSession);
    }
    if (!accessibility.advertised || accessibility.source !== "hybrid" || accessibility.degraded || accessibility.domElementCount === 0) {
      throw new Error("managed hybrid accessibility grounding did not produce a complete DOM-backed catalog");
    }
    status = "passed";
    gateCode = "";
  } catch (error) {
    process.stderr.write(`managed DOM pilot failed at ${stage}: ${error instanceof Error ? error.message : String(error)}\n`);
    gateCode = `${classifyGate(error)}_${classifyError(error)}_${stage}_${firstCloseLock}`;
    status = gateCode === "WINDOW_IDENTITY_GATE" || gateCode === "CUA_PIPE_GATE" ? "gate" : "failed";
  } finally {
    if (host !== undefined) await host.close().catch(() => undefined);
    if (sessionStarted && driver !== undefined) await driver.endSession(EndSessionInput.new({ session: SESSION_LABEL })).catch(() => undefined);
    if (driver !== undefined) driver.uniffiDestroy();
    if (server !== undefined) await new Promise<void>((resolve) => server!.close(() => resolve()));
    if (persistentProfileRoot !== undefined) await rm(persistentProfileRoot, { recursive: true, force: true }).catch(() => undefined);
  }
  const summary: PilotSummary = {
    schemaVersion: "managed-dom-pilot-v1",
    status,
    nodeMajor: Number(process.versions.node.split(".")[0]),
    transport: "managed-loopback-cdp-v1",
    windowBinding: status === "passed" ? "passed" : "gate",
    windowResolutionDiagnostics,
    startupPageDiagnostics: startupPageDiagnostics.map(({ pageCount, selected }) => ({ pageCount, selected })),
    cleanupDiagnostics,
    ...(liveOwnedProcessCountAfterClose === undefined ? {} : { liveOwnedProcessCountAfterClose }),
    ...(profileExitTypeNormalAfterClose === undefined ? {} : { profileExitTypeNormalAfterClose }),
    ...(gateCode.length === 0 ? {} : { gateCode }),
    modelCalls: 0,
    desktopInputCalls,
    screenshots,
    cookiesRead: 0,
    storageRead: 0,
    accessibility,
    actions,
    fixture,
  };
  await writeFile(join(outputDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ status, gateCode: gateCode || undefined, candidateCount: fixture.candidateCount })}\n`);
  if (status === "failed") process.exitCode = 1;
}

function findGroundingElement(capture: ObservationCapture, name: string): GroundingElement {
  const normalized = name.toLocaleLowerCase();
  const element = capture.grounding?.elements.find((candidate) => candidate.name?.toLocaleLowerCase() === normalized && candidate.source === "dom");
  if (element === undefined || element.bbox === undefined || element.bbox.width <= 0 || element.bbox.height <= 0) {
    throw new Error(`DOM grounding element ${name} was not available with clickable bounds`);
  }
  return element;
}

function center(element: GroundingElement): { x: number; y: number } {
  const bbox = element.bbox!;
  return { x: bbox.x + bbox.width / 2, y: bbox.y + bbox.height / 2 };
}

function requireCompleted(status: string, action: string): void {
  if (status !== "completed") throw new Error(`${action} did not complete (${status})`);
}

function summarizeFixture(
  result: DomGroundingTransportResult,
  tabId: string,
  generation: string,
): Omit<PilotSummary["fixture"], "startupPageCount" | "sameBrowserWindow"> {
  // The transport pilot validates private CSS candidates. Production
  // materialization remains fail-closed until hybrid grounding supplies a
  // trusted accessibility content rectangle.
  if (result.tabId !== tabId || result.generation !== generation) throw new Error("managed target identity changed during pilot");
  const roleCounts: Record<string, number> = {};
  for (const candidate of result.candidates) {
    const role = typeof candidate.ariaRole === "string" ? candidate.ariaRole : typeof candidate.role === "string" ? candidate.role : typeof candidate.tagName === "string" ? candidate.tagName.toLocaleLowerCase() : "unknown";
    roleCounts[role] = (roleCounts[role] ?? 0) + 1;
  }
  const names = result.candidates.map((candidate) => typeof candidate.name === "string" ? candidate.name.toLocaleLowerCase() : "");
  return {
    candidateCount: result.candidates.length,
    roleCounts,
    bboxCount: result.candidates.filter((candidate) => candidate.frame !== undefined).length,
    customDivOrButtonObserved: names.some((name) => name.includes("custom div") || name.includes("continue")),
    inputObserved: result.candidates.some((candidate) => candidate.tagName === "input"),
    shadowCandidateObserved: names.some((name) => name.includes("shadow button")),
    cookieMarkerPresent: names.some((name) => name.includes("cookie-marker-present")),
    storageMarkerPresent: names.some((name) => name.includes("storage-marker-present")),
    canvasVisualOnly: true,
    iframeBoundaryUntraversed: true,
  };
}

function emptyFixtureSummary(): PilotSummary["fixture"] {
  return { candidateCount: 0, roleCounts: {}, bboxCount: 0, customDivOrButtonObserved: false, inputObserved: false, shadowCandidateObserved: false, cookieMarkerPresent: false, storageMarkerPresent: false, canvasVisualOnly: true, iframeBoundaryUntraversed: true, startupPageCount: 0, sameBrowserWindow: false };
}

async function readProfileExitTypeNormal(profileRoot: string): Promise<boolean> {
  try {
    const preferences = await readFile(join(profileRoot, "Default", "Preferences"), "utf8");
    return /"exit_type"\s*:\s*"Normal"/u.test(preferences);
  } catch {
    return false;
  }
}

function classifyGate(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/window resolver|owned window|one host-owned|exact target|window identity|single window/iu.test(message)) return "WINDOW_IDENTITY_GATE";
  if (/pipe|socket|daemon|transport/iu.test(message)) return "CUA_PIPE_GATE";
  if (/DevTools|browser host|managed browser|executable|startup timed out|browser exited/iu.test(message)) return "MANAGED_BROWSER_GATE";
  return "PILOT_FAILED";
}

function classifyError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/one visible page|active page|browser window/iu.test(message)) return "ACTIVE_PAGE_GATE";
  if (/DevTools.*(page list|endpoint|startup)/iu.test(message)) return "CDP_STARTUP_GATE";
  if (/startup metadata/iu.test(message)) return "STARTUP_METADATA_GATE";
  if (/already in use|stale lock/iu.test(message)) return "PROFILE_LOCK_GATE";
  if (/startup timed out/iu.test(message)) return "STARTUP_TIMEOUT_GATE";
  return "OTHER_GATE";
}

await main();
