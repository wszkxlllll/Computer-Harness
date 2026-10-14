import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WEB = path.join(ROOT, "apps", "web");
const REPORTS = path.join(ROOT, "runs", "diagnostics", "web-accessibility");
const RUN_IDS = new Set(["web-qa-progress", "web-qa-approval", "web-qa-result", "web-qa-connection"]);
const CONTROL_ROLES = new Set([
  "button", "link", "textbox", "combobox", "radio", "checkbox", "switch",
  "spinbutton", "slider", "menuitem", "tab", "option", "dialog",
]);
const PIXEL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNgAAAAAgABSK+kcQAAAABJRU5ErkJggg==",
  "base64",
);

function usage() {
  return [
    "Run isolated headless-browser accessibility acceptance for apps/web.",
    "",
    "Usage: node scripts/web-accessibility-qa.mjs [--browser <path>] [--help]",
    "",
    "--browser <path> overrides WEB_ACCESSIBILITY_BROWSER, CHROME_PATH, EDGE_PATH,",
    "then standard Edge/Chrome installation locations. Reports are written under",
    "runs/diagnostics/web-accessibility/<unique-run>/.",
    "",
    "One isolated browser, a local Vite server, and a loopback mock API are used.",
  ].join("\n");
}

function parseArgs(argv) {
  const options = { help: false, browser: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--help" || argv[i] === "-h") options.help = true;
    else if (argv[i] === "--browser" && argv[i + 1] && !argv[i + 1].startsWith("--")) options.browser = argv[++i];
    else throw new Error("Unknown argument or missing value: " + argv[i]);
  }
  return options;
}

const pause = (ms) => delay(ms);
const errorText = (error) => error instanceof Error ? error.name + ": " + error.message : String(error);
const normalized = (value) => String(value ?? "").replace(/\s+/gu, " ").trim();

function record(report, name, pass, details = {}) {
  report.checks.push({ ...details, name, pass: Boolean(pass) });
}

function redact(text, roots) {
  let value = String(text);
  for (const root of roots) if (root) value = value.replaceAll(root, "<local-path>");
  return value;
}

async function exists(file) {
  try { await fs.access(file); return true; } catch { return false; }
}

async function findOnPath(names) {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (await exists(candidate)) return candidate;
    }
  }
}

async function findBrowser(override) {
  const configured = override || process.env.WEB_ACCESSIBILITY_BROWSER || process.env.CHROME_PATH || process.env.EDGE_PATH;
  if (configured) {
    if (await exists(configured)) return { path: configured, source: override ? "cli" : "environment" };
    const pathMatch = await findOnPath([configured]);
    if (pathMatch) return { path: pathMatch, source: override ? "cli-path" : "environment-path" };
    throw new Error("The configured browser executable was not found.");
  }
  let candidates = [];
  if (process.platform === "win32") {
    const pf = process.env.ProgramFiles || "C:\\Program Files";
    const pf86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
    const local = process.env.LOCALAPPDATA;
    candidates = [
      path.join(pf, "Microsoft", "Edge", "Application", "msedge.exe"),
      path.join(pf86, "Microsoft", "Edge", "Application", "msedge.exe"),
      local && path.join(local, "Microsoft", "Edge", "Application", "msedge.exe"),
      path.join(pf, "Google", "Chrome", "Application", "chrome.exe"),
      path.join(pf86, "Google", "Chrome", "Application", "chrome.exe"),
      local && path.join(local, "Google", "Chrome", "Application", "chrome.exe"),
    ].filter(Boolean);
  } else if (process.platform === "darwin") {
    candidates = [
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    ];
  }
  for (const candidate of candidates) {
    if (await exists(candidate)) return { path: candidate, source: "system-install" };
  }
  const pathMatch = await findOnPath(process.platform === "win32"
    ? ["msedge.exe", "chrome.exe", "chromium.exe"]
    : ["msedge", "google-chrome", "google-chrome-stable", "chromium", "chromium-browser"]);
  if (pathMatch) return { path: pathMatch, source: "path" };
  throw new Error("Edge or Chrome was not found. Set WEB_ACCESSIBILITY_BROWSER or pass --browser.");
}

async function uniqueDirectory(parent, prefix = "") {
  await fs.mkdir(parent, { recursive: true });
  for (let tries = 0; tries < 20; tries += 1) {
    const id = new Date().toISOString().replace(/[-:.TZ]/gu, "") + "-" + process.pid + "-" + randomBytes(3).toString("hex");
    const directory = path.join(parent, prefix + id);
    try { await fs.mkdir(directory); return directory; }
    catch (error) { if (error?.code !== "EEXIST") throw error; }
  }
  throw new Error("Could not create a unique QA directory.");
}

async function sourceFingerprint() {
  const files = [];
  async function walk(directory) {
    for (const item of await fs.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, item.name);
      if (item.isDirectory()) await walk(file);
      else if (item.isFile() && /\.(?:ts|tsx|css)$/iu.test(item.name)) files.push(file);
    }
  }
  await walk(path.join(WEB, "src"));
  files.sort();
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(path.relative(ROOT, file).replaceAll("\\", "/") + "\0");
    hash.update(await fs.readFile(file));
    hash.update("\0");
  }
  return { sha256: hash.digest("hex"), fileCount: files.length };
}

function sendJson(response, status, value) {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": body.length,
  });
  response.end(body);
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1024 * 1024) throw new Error("Fixture control request was too large.");
    chunks.push(chunk);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

function snapshot(runId) {
  if (!RUN_IDS.has(runId)) return undefined;
  if (runId === "web-qa-progress" || runId === "web-qa-connection") {
    return {
      runId, goal: "Review the sample task status", status: "running", sequence: 1,
      latestAssetId: "qa-pixel", capabilities: { pause: true, abort: true, correct: true },
    };
  }
  if (runId === "web-qa-approval") {
    return {
      runId, goal: "Review a synthetic approval request", status: "waiting_approval", sequence: 1,
      latestAssetId: "qa-pixel", capabilities: { approval: true, abort: true },
      pendingRequest: {
        requestId: "web-qa-approval-request", kind: "approval", requiresVisualReview: false,
        reason: "Synthetic request for inspecting approval controls.",
      },
    };
  }
  return {
    runId, goal: "Review a synthetic completed task", status: "finished", outcome: "succeeded",
    ownerState: "released", sequence: 1, capabilities: {},
    reply: Array.from({ length: 12 }, (_, i) =>
      "Sample result item " + (i + 1) + ": synthetic text checks result reflow and keyboard expansion without starting a task.",
    ).join("\n\n"),
  };
}

function createMockApi() {
  const fixture = { sessionFailures: 0, runFailures: new Map(), streams: new Set(), progressSent: false };
  const requests = [];
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const method = request.method ?? "GET";
    if (url.pathname === "/__qa/control" && method === "POST") {
      try {
        const state = await readJson(request);
        if (Number.isSafeInteger(state.sessionFailures)) fixture.sessionFailures = state.sessionFailures;
        if (typeof state.runId === "string" && Number.isSafeInteger(state.runFailures)) {
          fixture.runFailures.set(state.runId, state.runFailures);
        }
        sendJson(response, 200, { ready: true });
      } catch (error) { sendJson(response, 400, { error: errorText(error) }); }
      return;
    }
    if (!url.pathname.startsWith("/api/")) { sendJson(response, 404, { error: { code: "NOT_FOUND" } }); return; }
    requests.push({ method, path: url.pathname });
    if (url.pathname === "/api/session" && method === "GET") {
      if (fixture.sessionFailures > 0) {
        fixture.sessionFailures -= 1;
        sendJson(response, 503, { error: { code: "host_unavailable" } });
      } else {
        sendJson(response, 200, {
          csrfToken: "web-accessibility-qa-csrf",
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
          deviceName: "Synthetic browser", deviceId: "web-accessibility-qa-device",
        });
      }
      return;
    }
    if (url.pathname === "/api/voice/capabilities" && method === "GET") {
      sendJson(response, 200, { available: false, unavailableReason: "provider_unavailable" });
      return;
    }
    if (url.pathname === "/api/runs" && method === "GET") { sendJson(response, 200, { runs: [] }); return; }
    if (url.pathname === "/api/managed-browser-profile" && method === "GET") {
      sendJson(response, 200, {
        status: "unprepared", defaultSession: "temporary",
        commands: { prepare: "synthetic", complete: "synthetic", relogin: "synthetic" },
      });
      return;
    }
    const run = url.pathname.match(/^\/api\/runs\/([^/]+)$/u);
    if (run && method === "GET") {
      const id = decodeURIComponent(run[1]);
      const failures = fixture.runFailures.get(id) ?? 0;
      if (failures > 0) {
        fixture.runFailures.set(id, failures - 1);
        sendJson(response, 503, { error: { code: "host_unavailable" } });
        return;
      }
      const value = snapshot(id);
      sendJson(response, value ? 200 : 404, value ?? { error: { code: "RUN_NOT_FOUND" } });
      return;
    }
    const event = url.pathname.match(/^\/api\/runs\/([^/]+)\/events$/u);
    if (event && method === "GET") {
      const id = decodeURIComponent(event[1]);
      if (!RUN_IDS.has(id)) { sendJson(response, 404, { error: { code: "RUN_NOT_FOUND" } }); return; }
      response.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-store",
        Connection: "keep-alive",
      });
      response.write(": local synthetic fixture\n\n");
      if (id === "web-qa-progress" && !fixture.progressSent) {
        fixture.progressSent = true;
        const payload = {
          runId: id, sequence: 2, type: "run.event",
          data: {
            type: "run.notice", noticeId: "web-qa-progress-notice", kind: "progress",
            text: "Synthetic progress: reviewing the sample task.", delivery: "polite", eventSequence: 2,
          },
        };
        response.write("id: 2\nevent: run.event\ndata: " + JSON.stringify(payload) + "\n\n");
      }
      fixture.streams.add(response);
      const remove = () => fixture.streams.delete(response);
      response.once("close", remove);
      return;
    }
    const asset = url.pathname.match(/^\/api\/runs\/([^/]+)\/assets\/([^/]+)$/u);
    if (asset && method === "GET" && decodeURIComponent(asset[2]) === "qa-pixel") {
      response.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "no-store", "Content-Length": PIXEL.length });
      response.end(PIXEL);
      return;
    }
    sendJson(response, 404, { error: { code: "ROUTE_NOT_FOUND" } });
  });
  return { server, fixture, requests };
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Local server did not bind to TCP.");
  return "http://127.0.0.1:" + address.port;
}

async function configureMock(origin, state) {
  const response = await fetch(origin + "/__qa/control", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(state),
  });
  if (!response.ok) throw new Error("Could not set a local fixture state.");
}

async function startVite(mockOrigin, tempRoot) {
  const require = createRequire(path.join(WEB, "package.json"));
  const vite = await import(pathToFileURL(require.resolve("vite")).href);
  const loaded = await vite.loadConfigFromFile(
    { command: "serve", mode: "development" }, path.join(WEB, "vite.config.ts"), WEB, "silent",
  );
  if (!loaded) throw new Error("Could not load apps/web Vite configuration.");
  const server = await vite.createServer({
    ...loaded.config,
    configFile: false, root: WEB, cacheDir: path.join(tempRoot, "vite-cache"),
    envDir: tempRoot, envPrefix: [], appType: "spa", clearScreen: false, logLevel: "warn",
    server: {
      ...loaded.config.server, host: "127.0.0.1", port: 0, strictPort: false, open: false,
      proxy: { "/api": { target: mockOrigin, changeOrigin: true } },
      fs: { ...loaded.config.server?.fs, strict: true, allow: [ROOT] },
    },
  });
  await server.listen();
  const address = server.httpServer.address();
  if (!address || typeof address === "string") { await server.close(); throw new Error("Vite did not bind locally."); }
  return { server, origin: "http://127.0.0.1:" + address.port };
}

class Cdp {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.id = 0;
    this.pending = new Map();
    this.listeners = new Map();
    this.ready = new Promise((resolve, reject) => {
      this.ws.addEventListener("open", resolve, { once: true });
      this.ws.addEventListener("error", () => reject(new Error("Could not connect to local DevTools.")), { once: true });
    });
    this.ws.addEventListener("message", (event) => {
      let message;
      try { message = JSON.parse(String(event.data)); } catch { return; }
      if (message.id !== undefined) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.error) pending.reject(new Error(message.error.message ?? "CDP command failed."));
        else pending.resolve(message.result ?? {});
      } else {
        for (const fn of this.listeners.get(message.method) ?? []) fn(message.params ?? {});
      }
    });
    this.ws.addEventListener("close", () => {
      for (const item of this.pending.values()) {
        clearTimeout(item.timer);
        item.reject(new Error("DevTools closed."));
      }
      this.pending.clear();
    });
  }
  on(name, fn) {
    const listeners = this.listeners.get(name) ?? new Set();
    listeners.add(fn);
    this.listeners.set(name, listeners);
  }
  async send(method, params = {}, timeoutMs = 10_000) {
    await this.ready;
    if (this.ws.readyState !== WebSocket.OPEN) throw new Error("DevTools connection is closed.");
    const id = ++this.id;
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("CDP timeout: " + method));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  close() { if (this.ws.readyState < WebSocket.CLOSING) this.ws.close(); }
}

async function localJson(url) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error("Local DevTools endpoint returned HTTP " + response.status + ".");
  return await response.json();
}

async function startBrowser(browser, tempRoot, report, state) {
  const profile = path.join(tempRoot, "browser-profile");
  await fs.mkdir(profile);
  const args = [
    "--headless=new", "--disable-gpu", "--disable-background-networking", "--disable-component-update",
    "--disable-extensions", "--mute-audio", "--no-first-run",
    "--no-default-browser-check", "--enable-logging=stderr", "--remote-debugging-port=0",
    "--remote-allow-origins=*", "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost",
    "--user-data-dir=" + profile, "about:blank",
  ];
  state.browserProcess = spawn(browser.path, args, { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
  state.browserExit = new Promise((resolve) => {
    state.browserProcess.once("exit", (code, signal) => {
      state.browserExitInfo = { code, signal };
      resolve(state.browserExitInfo);
    });
    state.browserProcess.once("error", (error) => {
      state.browserSpawnError = error;
      state.browserExitInfo = { code: -1, signal: null };
      resolve(state.browserExitInfo);
    });
  });
  state.browserProcess.stderr.setEncoding("utf8");
  state.browserProcess.stderr.on("data", (chunk) => {
    state.browserStderr = ((state.browserStderr ?? "") + chunk).slice(-4_000);
  });
  const portFile = path.join(profile, "DevToolsActivePort");
  let port;
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (state.browserSpawnError) throw state.browserSpawnError;
    if (state.browserProcess.exitCode !== null) {
      const exit = state.browserExitInfo ?? { code: state.browserProcess.exitCode, signal: null };
      throw new Error("Browser exited before DevTools started (code=" + exit.code + ", signal=" + exit.signal
        + (state.browserStderr ? "; stderr=" + state.browserStderr.trim() : "") + ").");
    }
    try {
      port = Number.parseInt((await fs.readFile(portFile, "utf8")).split(/\r?\n/u)[0], 10);
      if (Number.isSafeInteger(port) && port > 0) break;
    } catch { await pause(100); }
  }
  if (!port) throw new Error("Browser did not publish a DevTools port.");
  const debugOrigin = "http://127.0.0.1:" + port;
  const version = await localJson(debugOrigin + "/json/version");
  report.browser.product = version.Browser ?? "unknown";
  report.browser.protocolVersion = version["Protocol-Version"] ?? "unknown";
  state.browserCdp = new Cdp(version.webSocketDebuggerUrl);
  await state.browserCdp.ready;
  const target = (await localJson(debugOrigin + "/json/list")).find((item) => item.type === "page");
  if (!target?.webSocketDebuggerUrl) throw new Error("No headless page target was found.");
  state.page = new Cdp(target.webSocketDebuggerUrl);
  await state.page.ready;
  for (const method of ["Page.enable", "Runtime.enable", "Network.enable"]) await state.page.send(method);
  try {
    await state.page.send("Accessibility.enable");
  } catch { /* Full AX tree support may be available without enabling this domain. */ }
  try {
    await state.browserCdp.send("Browser.setPermission", {
      origin: report.server.origin,
      permission: { name: "microphone" },
      setting: "denied",
    });
    report.isolation.microphonePermission = "denied";
  } catch { report.isolation.microphonePermission = "not-granted; browser default applies"; }
  state.page.on("Network.requestWillBeSent", ({ request }) => {
    try {
      const url = new URL(request.url);
      if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
        report.isolation.externalRequests.push({ scheme: url.protocol, host: url.hostname, path: url.pathname });
      }
    } catch { report.isolation.externalRequests.push({ url: "unparseable" }); }
  });
  state.page.on("Runtime.exceptionThrown", ({ exceptionDetails }) => {
    report.browser.exceptions.push(exceptionDetails?.text ?? "Page exception");
  });
  state.page.on("Runtime.consoleAPICalled", ({ type, args }) => {
    if (type === "error") {
      report.browser.consoleErrors.push((args ?? []).map((arg) => arg.value ?? arg.description ?? "").join(" ").slice(0, 500));
    }
  });
  state.page.on("Network.loadingFailed", ({ errorText }) => {
    if (errorText && errorText !== "net::ERR_ABORTED") report.browser.networkFailures.push(errorText);
  });
}

async function evaluate(state, expression) {
  const result = await state.page.send("Runtime.evaluate", {
    expression, returnByValue: true, awaitPromise: true, userGesture: true,
  });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text ?? "Page evaluation failed.");
  return result.result?.value;
}

async function inPage(state, fn) {
  return await evaluate(state, "(" + fn.toString() + ")()");
}

async function waitFor(state, expression, label, timeoutMs = 12_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { const value = await evaluate(state, expression); if (value) return value; } catch { /* Navigation may be in progress. */ }
    await pause(80);
  }
  throw new Error("Timed out waiting for " + label + ".");
}

async function navigate(state, url) {
  await state.page.send("Page.navigate", { url });
  await waitFor(state, "document.readyState === 'complete'", "page navigation");
}

const KEY = { Tab: ["Tab", 9], Enter: ["Enter", 13], " ": ["Space", 32], Escape: ["Escape", 27] };
async function pressKey(state, name, shift = false) {
  const [code, vk] = KEY[name];
  const common = { key: name, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers: shift ? 8 : 0 };
  const text = name === "Enter" ? "\r" : name === " " ? " " : undefined;
  await state.page.send("Input.dispatchKeyEvent", {
    type: "keyDown", ...common, ...(text ? { text, unmodifiedText: text } : {}),
  });
  if (name === " ") await state.page.send("Input.dispatchKeyEvent", { type: "char", text: " ", unmodifiedText: " " });
  await state.page.send("Input.dispatchKeyEvent", { type: "keyUp", ...common });
}

async function setViewport(state, width, height = 900, dpr = 1) {
  await state.page.send("Emulation.setDeviceMetricsOverride", {
    width, height, deviceScaleFactor: dpr, mobile: false, screenWidth: width, screenHeight: height,
  });
  await pause(50);
}

function pageMarkup() {
  const missingLabels = [...document.querySelectorAll('input:not([type="hidden"]), select, textarea')]
    .filter((el) => !(el.labels?.length) && !el.getAttribute("aria-label")
      && !el.getAttribute("aria-labelledby")?.split(/\s+/u).every((id) => document.getElementById(id)))
    .map((el) => el.id || el.tagName.toLowerCase());
  const missingRefs = [];
  for (const el of document.querySelectorAll("[aria-labelledby], [aria-describedby]")) {
    for (const attr of ["aria-labelledby", "aria-describedby"]) {
      for (const id of (el.getAttribute(attr) || "").split(/\s+/u).filter(Boolean)) {
        if (!document.getElementById(id)) missingRefs.push(attr + ":" + id);
      }
    }
  }
  return {
    mainCount: document.querySelectorAll("main,[role=main]").length,
    navigationCount: document.querySelectorAll("nav,[role=navigation]").length,
    missingLabels,
    missingRefs,
  };
}

function pageFocusInfo() {
  const el = document.activeElement;
  if (!(el instanceof HTMLElement) || el === document.body) return null;
  const rect = el.getBoundingClientRect();
  const style = getComputedStyle(el);
  return {
    tag: el.tagName.toLowerCase(),
    id: el.id || "",
    name: (el.getAttribute("aria-label") || el.innerText || el.value || "").replace(/\s+/gu, " ").trim(),
    focusVisible: el.matches(":focus-visible"),
    outline: style.outlineStyle,
    visible: rect.width > 0 && rect.height > 0 && style.visibility !== "hidden",
  };
}

function pageReflowInfo() {
  const root = document.documentElement;
  const overflowingElements = [...document.querySelectorAll("main *")].filter((el) => {
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden"
      && (rect.left < -1 || rect.right > root.clientWidth + 1);
  }).slice(0, 10).map((el) => {
    const rect = el.getBoundingClientRect();
    return {
      tag: el.tagName.toLowerCase(),
      id: el.id || "",
      className: typeof el.className === "string" ? el.className : "",
      text: (el.innerText || "").replace(/\s+/gu, " ").trim().slice(0, 120),
      left: Math.round(rect.left),
      right: Math.round(rect.right),
    };
  });
  return {
    cssWidth: innerWidth,
    dpr: devicePixelRatio,
    physicalWidth: Math.round(innerWidth * devicePixelRatio),
    rootFontPx: Number.parseFloat(getComputedStyle(root).fontSize),
    clientWidth: root.clientWidth,
    documentWidth: root.scrollWidth,
    bodyWidth: document.body.scrollWidth,
    overflow: root.scrollWidth > root.clientWidth + 1 || document.body.scrollWidth > root.clientWidth + 1,
    overflowingElements,
  };
}

function pagePreferenceState() {
  return {
    layout: document.documentElement.dataset.layout,
    textSize: document.documentElement.dataset.textSize,
    contrast: document.documentElement.dataset.contrast,
    reduceMotion: document.documentElement.dataset.reduceMotion,
    rootFontPx: Number.parseFloat(getComputedStyle(document.documentElement).fontSize),
    presetChecked: document.querySelector("#displayPreset-large_simple")?.checked,
    contrastChecked: document.querySelector("#high-contrast")?.checked,
    motionChecked: document.querySelector("#reduce-motion")?.checked,
    storagePresent: localStorage.getItem("harness.preferences") !== null,
  };
}

function pageDiagnostic() {
  return {
    href: location.href,
    title: document.title,
    readyState: document.readyState,
    bodyText: (document.body?.innerText || "").slice(0, 1200),
    rootHtml: (document.querySelector("#root")?.innerHTML || "").slice(0, 2500),
    scripts: [...document.scripts].map((script) => script.src).filter(Boolean).slice(0, 12),
  };
}

function pageModalState() {
  const dialog = document.querySelector('[role="dialog"][aria-modal="true"]');
  const selector = "button:not([disabled]),a[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex='-1'])";
  const focusables = dialog ? [...dialog.querySelectorAll(selector)].filter((el) => !el.hidden && el.getAttribute("aria-hidden") !== "true") : [];
  const titleId = dialog?.getAttribute("aria-labelledby");
  return {
    title: titleId ? document.getElementById(titleId)?.innerText.trim() : "",
    focusInside: Boolean(dialog?.contains(document.activeElement)),
    focusables: focusables.map((el) => el.innerText?.trim() || el.getAttribute("aria-label") || ""),
    backgroundInert: [".brand-header", ".phone-bottom-nav", ".run-heading", ".screenshot-open-button"]
      .every((selector) => document.querySelector(selector)?.inert === true),
    scrollLocked: document.body.style.overflow === "hidden",
  };
}

async function fullAx(state) {
  const tree = await state.page.send("Accessibility.getFullAXTree");
  const nodes = tree.nodes ?? [];
  const controls = nodes.filter((node) => !node.ignored && CONTROL_ROLES.has(node.role?.value)).map((node) => ({
    role: node.role.value,
    name: normalized(node.name?.value),
  }));
  const landmarks = nodes.filter((node) => !node.ignored && ["main", "navigation"].includes(node.role?.value)).map((node) => ({
    role: node.role.value,
    name: normalized(node.name?.value),
  }));
  return { controls, landmarks, unnamed: controls.filter((item) => !item.name) };
}

async function auditAx(state, report, label) {
  const ax = await fullAx(state);
  const markup = await inPage(state, pageMarkup);
  const unnamedNav = ax.landmarks.filter((item) => item.role === "navigation" && !item.name);
  record(report, label + "-ax-names", ax.controls.length > 0 && ax.unnamed.length === 0, {
    controls: ax.controls.length, unnamed: ax.unnamed,
  });
  record(report, label + "-main-and-navigation-landmarks",
    markup.mainCount > 0 && (!markup.navigationCount || unnamedNav.length === 0),
    { mainCount: markup.mainCount, navigationCount: markup.navigationCount, unnamedNavigation: unnamedNav },
  );
  record(report, label + "-labels-and-aria-references",
    markup.missingLabels.length === 0 && markup.missingRefs.length === 0,
    { missingLabels: markup.missingLabels, missingRefs: markup.missingRefs },
  );
  return ax;
}

async function tabOrder(state, count = 12) {
  await evaluate(state, "document.activeElement?.blur(); window.scrollTo(0, 0)");
  const order = [];
  const seen = new Set();
  for (let i = 0; i < count; i += 1) {
    await pressKey(state, "Tab");
    const item = await inPage(state, pageFocusInfo);
    if (!item) break;
    const id = item.tag + ":" + item.id + ":" + item.name;
    if (seen.has(id)) break;
    seen.add(id);
    order.push(item);
  }
  return order;
}

async function reflow(state, report, output, label, {
  cssWidth = 320, rootScale = 1, gate = true, capture = true,
} = {}) {
  await setViewport(state, cssWidth, 900, 1);
  let fontBefore;
  let result;
  try {
    if (rootScale !== 1) {
      fontBefore = await evaluate(state, `(() => {
        const root = document.documentElement;
        const baselinePx = Number.parseFloat(getComputedStyle(root).fontSize);
        const inlineValue = root.style.getPropertyValue('font-size');
        const inlinePriority = root.style.getPropertyPriority('font-size');
        root.style.setProperty('font-size', (baselinePx * ${Number(rootScale)}).toFixed(3) + 'px', 'important');
        return { baselinePx, inlineValue, inlinePriority };
      })()`);
    }
    result = await inPage(state, pageReflowInfo);
    const methodology = rootScale === 2
      ? "320 CSS-pixel viewport at DPR 1 with the computed root font-size doubled to 200%; this is not full browser or Safari zoom"
      : `${cssWidth} CSS-pixel layout viewport at DPR 1`;
    const fontScale = fontBefore ? {
      baselineRootFontPx: fontBefore.baselinePx,
      enlargedRootFontPx: result.rootFontPx,
      measuredScale: Number((result.rootFontPx / fontBefore.baselinePx).toFixed(3)),
    } : undefined;
    const details = { label, methodology, ...(fontScale ? { fontScale } : {}), ...result };
    report.viewports.push({ ...details, informational: !gate });
    if (gate) {
      record(report, label + "-no-horizontal-overflow", !result.overflow, details);
      if (fontScale) {
        const doubled = fontScale.measuredScale >= 1.98 && fontScale.measuredScale <= 2.02;
        record(report, label + "-root-font-doubled", doubled, fontScale);
      }
    }
    if (capture) {
      const shot = await state.page.send("Page.captureScreenshot", { format: "png", fromSurface: true });
      const file = label + ".png";
      await fs.writeFile(path.join(output, file), Buffer.from(shot.data, "base64"));
      report.screenshots.push(path.relative(ROOT, path.join(output, file)).replaceAll("\\", "/"));
    }
  } finally {
    if (fontBefore) {
      await evaluate(state, `(() => {
        const style = document.documentElement.style;
        if (${JSON.stringify(fontBefore.inlineValue)}) {
          style.setProperty('font-size', ${JSON.stringify(fontBefore.inlineValue)}, ${JSON.stringify(fontBefore.inlinePriority)});
        } else {
          style.removeProperty('font-size');
        }
        return true;
      })()`);
    }
  }
}

async function inspectHomeAndSettings(state, report, output, origin) {
  await navigate(state, origin + "/");
  await waitFor(state, "Boolean(document.querySelector('.goal-composer'))", "home composer");
  await auditAx(state, report, "home");
  const homeTabs = await tabOrder(state);
  report.focusOrder.home = homeTabs;
  record(report, "home-keyboard-focus-is-visible",
    homeTabs.length > 0 && homeTabs.every((item) => item.focusVisible && item.outline !== "none" && item.visible),
    { order: homeTabs },
  );
  await reflow(state, report, output, "home-320-css", { cssWidth: 320 });
  await reflow(state, report, output, "home-320-css-root-font-200", { cssWidth: 320, rootScale: 2 });
  await reflow(state, report, output, "home-160-css-stress", { cssWidth: 160, gate: false, capture: false });

  await navigate(state, origin + "/preferences");
  await waitFor(state, "Boolean(document.querySelector('#displayPreset-large_simple'))", "settings screen");
  await auditAx(state, report, "settings");
  await reflow(state, report, output, "settings-320-css", { cssWidth: 320 });
  await reflow(state, report, output, "settings-320-css-root-font-200", { cssWidth: 320, rootScale: 2 });
  const settingsTabs = await tabOrder(state);
  report.focusOrder.settings = settingsTabs.slice(0, 16);
  record(report, "settings-keyboard-focus-is-visible",
    settingsTabs.length > 0 && settingsTabs.every((item) => item.focusVisible && item.outline !== "none" && item.visible),
    { order: settingsTabs.slice(0, 16) },
  );

  const standardRootFontPx = await evaluate(state, "Number.parseFloat(getComputedStyle(document.documentElement).fontSize)");
  await evaluate(state, "document.querySelector('#displayPreset-large_simple').focus()");
  await pressKey(state, " ");
  await evaluate(state, "document.querySelector('#high-contrast').focus()");
  await pressKey(state, " ");
  await evaluate(state, "document.querySelector('#reduce-motion').focus()");
  await pressKey(state, " ");
  await waitFor(state, "document.documentElement.dataset.reduceMotion === 'true'", "native settings changed by keyboard");
  const before = await inPage(state, pagePreferenceState);
  await state.page.send("Page.reload", { ignoreCache: true });
  await waitFor(state, "document.querySelector('#displayPreset-large_simple') && document.documentElement.dataset.layout === 'simple'", "settings reload");
  const after = await inPage(state, pagePreferenceState);
  record(report, "native-settings-persist-after-keyboard-and-reload",
    JSON.stringify(before) === JSON.stringify(after) && after.presetChecked && after.contrastChecked && after.motionChecked && after.storagePresent,
    { before, after },
  );
  const preferenceFontScale = after.rootFontPx / standardRootFontPx;
  record(report, "large-text-preset-increases-computed-root-font",
    after.textSize === "large" && preferenceFontScale > 1.1,
    { standardRootFontPx, largeTextRootFontPx: after.rootFontPx, measuredScale: Number(preferenceFontScale.toFixed(3)) },
  );
}

function pageDialogFirst() {
  const dialog = document.querySelector('[role="dialog"][aria-modal="true"]');
  const first = dialog?.querySelector("button:not([disabled]),a[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex='-1'])");
  return Boolean(first && document.activeElement === first);
}

function pageDialogLast() {
  const dialog = document.querySelector('[role="dialog"][aria-modal="true"]');
  const items = dialog ? [...dialog.querySelectorAll("button:not([disabled]),a[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex='-1'])")] : [];
  return Boolean(items.length && document.activeElement === items[items.length - 1]);
}

function pageRunStatus() {
  const buttons = [...document.querySelectorAll(".control-actions button")];
  return {
    status: document.querySelector(".run-activity-current-status")?.innerText.trim() || "",
    progress: document.querySelector(".run-activity-copy")?.innerText.trim() || "",
    connection: document.querySelector(".connection-note")?.innerText.trim() || "",
    controls: buttons.map((button) => ({
      name: button.getAttribute("aria-label") || button.innerText.trim(),
      disabled: button.disabled,
    })),
  };
}

function pageApproval() {
  return {
    status: document.querySelector(".run-activity-current-status")?.innerText.trim() || "",
    heading: document.querySelector(".pending-panel h2")?.innerText.trim() || "",
    decisions: [...document.querySelectorAll(".decision-actions button")].map((button) => ({
      name: button.getAttribute("aria-label") || button.innerText.trim(),
      disabled: button.disabled,
    })),
  };
}

function pageResult() {
  return {
    status: document.querySelector(".run-activity-current-status")?.innerText.trim() || "",
    heading: document.querySelector("#result-heading")?.innerText.trim() || "",
    outcome: document.querySelector(".outcome-label")?.innerText.trim() || "",
    expanded: document.querySelector(".result-panel button")?.getAttribute("aria-expanded") === "true",
    hasExpandButton: Boolean(document.querySelector(".result-panel button")),
    textLength: document.querySelector(".result-copy")?.innerText.length ?? 0,
  };
}

async function inspectRunStates(state, report, output, origin) {
  await navigate(state, origin + "/run/web-qa-progress");
  await waitFor(state, "Boolean(document.querySelector('.run-activity-panel'))", "progress state");
  await waitFor(state, "document.body.innerText.includes('Synthetic progress: reviewing the sample task.')", "synthetic progress event");
  await waitFor(state, "(document.querySelector('.screenshot-open-button img')?.naturalWidth ?? 0) > 0", "synthetic screenshot");
  await auditAx(state, report, "progress");
  await reflow(state, report, output, "progress-320-css", { cssWidth: 320 });
  await reflow(state, report, output, "progress-320-css-root-font-200", { cssWidth: 320, rootScale: 2 });
  const progress = await inPage(state, pageRunStatus);
  report.runStates.push({ name: "progress", ...progress });
  record(report, "progress-state-and-safe-controls",
    Boolean(progress.status && progress.progress && progress.connection)
      && progress.controls.length > 0 && progress.controls.every((button) => button.name && !button.disabled),
    progress,
  );

  await setViewport(state, 390, 900, 1);
  const opener = await evaluate(state, "(() => { const b=document.querySelector('.screenshot-open-button'); b?.focus(); return Boolean(b && document.activeElement===b); })()");
  await pressKey(state, "Enter");
  await waitFor(state, "Boolean(document.querySelector('[role=dialog][aria-modal=true]'))", "screenshot modal");
  await waitFor(state, "document.querySelector('[role=dialog][aria-modal=true]')?.contains(document.activeElement)", "modal initial focus");
  const modal = await inPage(state, pageModalState);
  const modalAx = await fullAx(state);
  const dialogName = modalAx.controls.find((item) => item.role === "dialog")?.name || "";
  const initiallyFirst = await inPage(state, pageDialogFirst);
  record(report, "screenshot-modal-has-name-and-focus", Boolean(dialogName && modal.title && opener && modal.focusInside), {
    name: dialogName, title: modal.title, openerFocused: opener, focusInside: modal.focusInside,
  });
  record(report, "screenshot-modal-starts-at-first-control", initiallyFirst);
  record(report, "screenshot-modal-inerts-background-and-locks-scroll", modal.backgroundInert && modal.scrollLocked, modal);
  record(report, "screenshot-modal-controls-have-ax-names", modalAx.unnamed.length === 0, { unnamed: modalAx.unnamed });
  let stayedInside = true;
  for (let i = 0; i < modal.focusables.length; i += 1) {
    await pressKey(state, "Tab");
    stayedInside = stayedInside && await inPage(state, () => Boolean(document.querySelector('[role="dialog"][aria-modal="true"]')?.contains(document.activeElement)));
  }
  const forwardWrap = await inPage(state, pageDialogFirst);
  await pressKey(state, "Tab", true);
  const backwardWrap = await inPage(state, pageDialogLast);
  record(report, "screenshot-modal-traps-forward-and-reverse-tab", stayedInside && forwardWrap && backwardWrap, {
    stayedInside, forwardWrap, backwardWrap,
  });
  await pressKey(state, "Escape");
  await waitFor(state, "!document.querySelector('[role=dialog][aria-modal=true]')", "modal escape close");
  await waitFor(state, "document.activeElement?.classList?.contains('screenshot-open-button')", "modal focus restore");
  const restore = await evaluate(state, "({ openerFocused: document.activeElement?.classList?.contains('screenshot-open-button')===true, backgroundInert: ['.brand-header','.phone-bottom-nav','.run-heading','.screenshot-open-button'].some(s=>document.querySelector(s)?.inert===true) })");
  record(report, "screenshot-modal-escape-restores-focus", restore.openerFocused && !restore.backgroundInert, restore);

  await navigate(state, origin + "/run/web-qa-approval");
  await waitFor(state, "Boolean(document.querySelector('.pending-panel'))", "approval state");
  await auditAx(state, report, "approval");
  await reflow(state, report, output, "approval-320-css", { cssWidth: 320 });
  await reflow(state, report, output, "approval-320-css-root-font-200", { cssWidth: 320, rootScale: 2 });
  const approval = await inPage(state, pageApproval);
  report.runStates.push({ name: "approval", ...approval });
  record(report, "approval-state-has-enabled-named-decisions",
    Boolean(approval.status && approval.heading) && approval.decisions.length >= 2
      && approval.decisions.every((button) => button.name && !button.disabled),
    approval,
  );

  await navigate(state, origin + "/run/web-qa-result");
  await waitFor(state, "Boolean(document.querySelector('.result-panel'))", "result state");
  await auditAx(state, report, "result");
  await reflow(state, report, output, "result-320-css", { cssWidth: 320 });
  await reflow(state, report, output, "result-320-css-root-font-200", { cssWidth: 320, rootScale: 2 });
  if (await evaluate(state, "Boolean(document.querySelector('.result-panel button'))")) {
    await evaluate(state, "document.querySelector('.result-panel button').focus()");
    await pressKey(state, "Enter");
    await waitFor(state, "document.querySelector('.result-panel button')?.getAttribute('aria-expanded')==='true'", "keyboard result expansion");
  }
  const result = await inPage(state, pageResult);
  report.runStates.push({ name: "result", ...result });
  record(report, "result-state-is-readable-and-keyboard-expandable",
    Boolean(result.status && result.heading && result.outcome) && (!result.hasExpandButton || result.expanded) && result.textLength > 500,
    result,
  );

  await configureMock(state.mockOrigin, { runId: "web-qa-connection", runFailures: 2 });
  await navigate(state, origin + "/run/web-qa-connection");
  await waitFor(state, "Boolean(document.querySelector('.run-page [role=alert]'))", "offline run state");
  const retryFocused = await evaluate(state, "(() => { const b=document.querySelector('.run-page button'); b?.focus(); return Boolean(b && document.activeElement===b); })()");
  await pressKey(state, "Enter");
  await waitFor(state, "Boolean(document.querySelector('.run-activity-panel'))", "keyboard task connection retry");
  const connection = await evaluate(state, "({ status: document.querySelector('.run-activity-current-status')?.innerText.trim(), alert: Boolean(document.querySelector('.run-page [role=alert]')) })");
  report.runStates.push({ name: "connection-recovered", keyboardRetryFocused: retryFocused, ...connection });
  record(report, "run-connection-recovers-by-keyboard", retryFocused && connection.status && !connection.alert, connection);
}

async function inspectSessionRetry(state, report, origin) {
  await configureMock(state.mockOrigin, { sessionFailures: 2 });
  await navigate(state, origin + "/?qa=connection");
  await waitFor(state, "Boolean(document.querySelector('main [role=alert]'))", "session-offline state");
  const initial = await evaluate(state, "({ heading: document.querySelector('main h1')?.innerText, alert: document.querySelector('main [role=alert]')?.innerText, button: document.querySelector('main button')?.innerText })");
  report.runStates.push({ name: "session-connection-error", ...initial });
  record(report, "session-connection-error-is-announced", Boolean(initial.heading && initial.alert && initial.button), initial);
  await evaluate(state, "document.querySelector('main button')?.focus()");
  await pressKey(state, "Enter");
  await waitFor(state, "Boolean(document.querySelector('.goal-composer'))", "keyboard session retry");
  record(report, "session-connection-retry-works-by-keyboard", true);
}

async function cleanup(state, report) {
  for (const response of state.mockFixture?.streams ?? []) {
    try { response.end(); } catch { /* The browser may already have closed its stream. */ }
  }
  state.mockFixture?.streams?.clear();
  try { state.page?.close(); } catch { /* Continue cleanup. */ }
  if (state.browserCdp) {
    try { await state.browserCdp.send("Browser.close", {}, 4_000); } catch { /* The owned browser may already be closing. */ }
    state.browserCdp.close();
  }
  let browserExited = !state.browserProcess;
  if (state.browserProcess) {
    browserExited = await Promise.race([state.browserExit.then(() => true), pause(8_000).then(() => false)]);
    if (!browserExited && state.browserProcess.exitCode === null) {
      try { state.browserProcess.kill(); } catch { /* Only the child process launched by this script is signalled. */ }
      browserExited = await Promise.race([state.browserExit.then(() => true), pause(3_000).then(() => false)]);
    }
  }
  report.cleanup.browserExited = browserExited;
  if (state.vite) {
    try { await state.vite.close(); report.cleanup.viteClosed = true; }
    catch (error) { report.cleanup.viteClosed = false; report.cleanup.viteError = errorText(error); }
  } else report.cleanup.viteClosed = true;
  if (state.mockServer) {
    try {
      for (const response of state.mockFixture?.streams ?? []) {
        try { response.end(); } catch { /* Continue local server cleanup. */ }
      }
      await new Promise((resolve) => state.mockServer.close(resolve));
      report.cleanup.mockApiClosed = true;
    } catch (error) { report.cleanup.mockApiClosed = false; report.cleanup.mockApiError = errorText(error); }
  } else report.cleanup.mockApiClosed = true;

  if (!state.tempRoot) return;
  const tempParent = path.resolve(os.tmpdir());
  const owned = path.resolve(state.tempRoot);
  const isOwnedTemp = owned.startsWith(tempParent + path.sep) && path.basename(owned).startsWith("web-accessibility-qa-");
  if (!browserExited) {
    report.cleanup.temporaryProfileRemoved = false;
    report.cleanup.profilePreservedReason = "Browser exit was not confirmed.";
  } else if (!isOwnedTemp) {
    report.cleanup.temporaryProfileRemoved = false;
    report.cleanup.profilePreservedReason = "Temporary directory ownership check failed.";
  } else {
    try {
      await fs.rm(owned, { recursive: true, force: false });
      report.cleanup.temporaryProfileRemoved = true;
    } catch (error) {
      report.cleanup.temporaryProfileRemoved = false;
      report.cleanup.profilePreservedReason = errorText(error);
    }
  }
}

async function writeReport(report, output, roots) {
  const failed = report.checks.filter((item) => !item.pass);
  report.result = report.fatal || failed.length || report.isolation.externalRequests.length
    || report.sourceStableDuringRun === false
    || report.cleanup.browserExited === false
    || report.cleanup.temporaryProfileRemoved === false
    ? "review-required" : "pass";
  report.finishedAt = new Date().toISOString();
  report.summary = {
    checksPassed: report.checks.filter((item) => item.pass).length,
    checksFailed: failed.length,
    screenshotCount: report.screenshots.length,
    externalRequestCount: report.isolation.externalRequests.length,
    voiceOverOrIPhoneScreenReaderTested: false,
  };
  if (report.fatal) report.fatal = redact(report.fatal, roots);
  const file = path.join(output, "report.json");
  const text = JSON.stringify(report, null, 2) + "\n";
  await fs.writeFile(file, text, "utf8");
  const readBack = await fs.readFile(file, "utf8");
  if (readBack !== text || readBack.includes("\uFFFD") || /\?{4,}/u.test(readBack)) {
    throw new Error("UTF-8 report write/read-back validation failed.");
  }
  process.stdout.write("Browser accessibility QA: " + report.result + "\n");
  process.stdout.write("Checks: " + report.summary.checksPassed + " passed, " + failed.length + " failed\n");
  process.stdout.write("Report: " + file + "\n");
  process.stdout.write("iPhone VoiceOver: not tested\n");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) { process.stdout.write(usage() + "\n"); return 0; }
  if (!globalThis.WebSocket) throw new Error("Node built-in WebSocket is required; use Node 22.13 or newer.");
  const output = await uniqueDirectory(REPORTS);
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "web-accessibility-qa-"));
  const roots = [ROOT, tempRoot];
  const report = {
    schemaVersion: 1,
    test: "web-real-browser-accessibility-acceptance",
    startedAt: new Date().toISOString(),
    outputDirectory: path.relative(ROOT, output).replaceAll("\\", "/"),
    browser: { executableName: "not-resolved", discovery: "not-resolved", headless: true, isolatedProfile: true, exceptions: [], consoleErrors: [], networkFailures: [] },
    server: { host: "127.0.0.1", proxyTarget: "127.0.0.1" },
    isolation: {
      mockApi: true, externalRequests: [], realMicrophoneUsed: false, forbiddenInterfacesUsed: [],
      voiceOverOrIPhoneScreenReaderTested: false,
      notes: [
        "Vite /api traffic is proxied only to an in-process loopback mock.",
        "No Host, Relay, desktop control, model API, or real microphone service is started or called.",
        "Headless browser AX results do not establish iPhone VoiceOver behavior.",
      ],
    },
    source: {}, checks: [], viewports: [], focusOrder: {}, runStates: [], screenshots: [], cleanup: {},
  };
  const state = { output, tempRoot };
  let reportError;
  try {
    const browser = await findBrowser(options.browser);
    report.browser.executableName = path.basename(browser.path);
    report.browser.discovery = browser.source;
    await fs.access(path.join(WEB, "package.json"));
    report.source.before = await sourceFingerprint();
    const mock = createMockApi();
    state.mockServer = mock.server;
    state.mockFixture = mock.fixture;
    state.mockRequests = mock.requests;
    state.mockOrigin = await listen(state.mockServer);
    report.server.mockApiOrigin = state.mockOrigin;
    const vite = await startVite(state.mockOrigin, tempRoot);
    state.vite = vite.server;
    report.server.origin = vite.origin;

    await startBrowser(browser, tempRoot, report, state);
    await navigate(state, vite.origin + "/");
    try {
    await waitFor(state, "Boolean(document.querySelector('.goal-composer'))", "application start");
    } catch (error) {
      report.browser.initialPage = await inPage(state, pageDiagnostic);
      const image = await state.page.send("Page.captureScreenshot", { format: "png", fromSurface: true });
      const file = "initial-page-failure.png";
      await fs.writeFile(path.join(output, file), Buffer.from(image.data, "base64"));
      report.screenshots.push(path.relative(ROOT, path.join(output, file)).replaceAll("\\", "/"));
      throw error;
    }
    await inspectHomeAndSettings(state, report, output, vite.origin);
    await inspectRunStates(state, report, output, vite.origin);
    await inspectSessionRetry(state, report, vite.origin);
    record(report, "all-browser-requests-remained-on-loopback", report.isolation.externalRequests.length === 0, {
      externalRequests: report.isolation.externalRequests,
    });
    record(report, "browser-had-no-page-errors",
      report.browser.exceptions.length === 0 && report.browser.consoleErrors.length === 0 && report.browser.networkFailures.length === 0,
      { exceptions: report.browser.exceptions, consoleErrors: report.browser.consoleErrors, networkFailures: report.browser.networkFailures },
    );
    record(report, "application-API-calls-were-read-only", state.mockRequests.every((item) => item.method === "GET"), {
      requestCount: state.mockRequests.length,
      nonGetRequests: state.mockRequests.filter((item) => item.method !== "GET"),
    });
    report.apiRequests = state.mockRequests;
  } catch (error) {
    report.fatal = redact(errorText(error), roots);
    report.apiRequests = state.mockRequests ?? [];
  } finally {
    await cleanup(state, report);
    try {
      report.source.after = await sourceFingerprint();
      report.sourceStableDuringRun = report.source.before?.sha256 === report.source.after.sha256;
      record(report, "web-source-stayed-stable-during-acceptance", report.sourceStableDuringRun, {
        before: report.source.before, after: report.source.after,
      });
    } catch (error) {
      report.sourceStableDuringRun = false;
      report.source.fingerprintError = redact(errorText(error), roots);
    }
    try { await writeReport(report, output, roots); }
    catch (error) {
      reportError = error;
      process.stderr.write("Report write/read-back failed: " + redact(errorText(error), roots) + "\n");
    }
  }
  if (reportError) return 1;
  return report.result === "pass" ? 0 : 1;
}

main().then((code) => { process.exitCode = code; }).catch((error) => {
  process.stderr.write("Accessibility QA did not start: " + errorText(error) + "\n");
  process.exitCode = 1;
});
