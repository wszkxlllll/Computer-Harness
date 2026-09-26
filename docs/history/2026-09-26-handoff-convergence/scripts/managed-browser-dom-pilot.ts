import { createServer } from "node:http";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ManagedBrowserHost,
  inspectManagedBrowserProcessTree,
  materializeDomGrounding,
  resolveOwnedManagedBrowserWindow,
  type DomGroundingTransportResult,
  type ManagedBrowserStartupPageDiagnostic,
  type ManagedBrowserWindowResolutionDiagnostic,
} from "../packages/computer-cua/src/index.js";
import type { ComputerSessionId, ObservationId, Viewport } from "../packages/protocol/src/index.js";
const { CuaDriver, EndSessionInput, StartSessionInput } = await import("../packages/computer-cua/node_modules/@trycua/cua-driver/dist/index.js");

const SOCKET_PATH = "\\\\.\\pipe\\computer-harness-local";
const SESSION_LABEL = `managed-dom-readonly-pilot-${Date.now()}`;
const FIXTURE_PATH = new URL("../packages/computer-cua/src/fixtures/managed-dom-fixture.html", import.meta.url);

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
  readonly desktopInputCalls: 0;
  readonly screenshots: 0;
  readonly cookiesRead: 0;
  readonly storageRead: 0;
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
      const markerScript = `<script>(() => { if (location.pathname.endsWith('/fixture-a') && localStorage.getItem('harness_dom_pilot_marker') === null) localStorage.setItem('harness_dom_pilot_marker', 'present'); const cookie = document.cookie.split(';').some((item) => item.trim() === 'harness_dom_pilot_marker=present'); const storage = localStorage.getItem('harness_dom_pilot_marker') === 'present'; if (cookie) { const element = document.createElement('button'); element.setAttribute('aria-label', 'cookie-marker-present'); element.style.cssText = 'position:fixed;left:70px;top:20px;width:40px;height:30px'; document.body.appendChild(element); } if (storage) { const element = document.createElement('button'); element.setAttribute('aria-label', 'storage-marker-present'); element.style.cssText = 'position:fixed;left:120px;top:20px;width:40px;height:30px'; document.body.appendChild(element); } })();</script>`;
      const routeMarker = request.url === "/fixture-b" ? '<button aria-label="route-b-marker" style="position:fixed;left:20px;top:20px;width:40px;height:30px">B</button>' : "";
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
      browser: "edge",
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
      browser: "edge",
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
    const result = await transport.collect({
      observationId: "managed-dom-pilot-observation" as ObservationId,
      computerSessionId: SESSION_LABEL as ComputerSessionId,
      viewport,
      browserTarget: record.target,
    }, new AbortController().signal);
    if (result.candidates.length < 11) throw new Error("managed persistent startup did not make the explicit current URL active or retain markers");
    fixture = { ...summarizeFixture(result, viewport, record.target.tabId, record.target.generation), startupPageCount: startupPages.pageCount, sameBrowserWindow: true };
    if (!fixture.cookieMarkerPresent || !fixture.storageMarkerPresent) throw new Error("managed persistent profile markers were not retained");
    status = "passed";
    gateCode = "";
  } catch (error) {
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
    desktopInputCalls: 0,
    screenshots: 0,
    cookiesRead: 0,
    storageRead: 0,
    fixture,
  };
  await writeFile(join(outputDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ status, gateCode: gateCode || undefined, candidateCount: fixture.candidateCount })}\n`);
  if (status === "failed") process.exitCode = 1;
}

function summarizeFixture(
  result: DomGroundingTransportResult,
  viewport: Viewport,
  tabId: string,
  generation: string,
): Omit<PilotSummary["fixture"], "startupPageCount" | "sameBrowserWindow"> {
  // Materialization is the same redaction boundary used by CUA; tab/generation
  // are checked locally but never written to the summary.
  if (result.tabId !== tabId || result.generation !== generation) throw new Error("managed target identity changed during pilot");
  const materialized = materializeDomGrounding({
    observationId: "managed-dom-pilot-observation" as ObservationId,
    computerSessionId: SESSION_LABEL as ComputerSessionId,
    viewport,
    browserTarget: { kind: "managed-chromium", browser: "edge", profileId: "pilot", windowTarget: { pid: 1, windowId: 1 }, tabId, generation, delivery: "loopback-cdp" },
  }, result);
  const roleCounts: Record<string, number> = {};
  for (const element of materialized.catalog.elements) roleCounts[element.role] = (roleCounts[element.role] ?? 0) + 1;
  const names = materialized.catalog.elements.map((element) => element.name?.toLocaleLowerCase() ?? "");
  return {
    candidateCount: materialized.catalog.elements.length,
    roleCounts,
    bboxCount: materialized.catalog.elements.filter((element) => element.bbox !== undefined).length,
    customDivOrButtonObserved: names.some((name) => name.includes("custom div") || name.includes("continue")),
    inputObserved: materialized.catalog.elements.some((element) => ["textbox", "checkbox", "radio", "slider", "spinbutton"].includes(element.role)),
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
