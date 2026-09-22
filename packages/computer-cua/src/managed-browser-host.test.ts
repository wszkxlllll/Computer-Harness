import { describe, expect, it, vi } from "vitest";
import { access, mkdir, mkdtemp, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import type { ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireManagedBrowserProfileLease, buildManagedBrowserLaunchUrls, clearManagedBrowserDevToolsPort, cleanupManagedBrowser, closeManagedBrowserGracefully, defaultManagedBrowserKind, managedBrowserExecutableCandidates, MANAGED_DOM_EVALUATION_SCRIPT, LoopbackWebSocket, ManagedBrowserHost, normalizeManagedBrowserStartupUrl, readManagedBrowserStartupUrls, registerManagedBrowserStartupUrl, resolveManagedBrowserActivePage, resolveManagedBrowserActivePageSet, validateManagedBrowserPageSet, validateOwnedWindowResolution, waitForDevToolsBrowserEndpoint, waitForDevToolsPort, type ManagedBrowserHostOptions, type ManagedBrowserWindowResolution } from "./managed-browser-host.js";

describe("managed browser host pilot", () => {
  it("selects native managed browsers and bounded executable paths on every supported desktop OS", () => {
    expect(defaultManagedBrowserKind("win32")).toBe("edge");
    expect(defaultManagedBrowserKind("darwin")).toBe("chromium");
    expect(defaultManagedBrowserKind("linux")).toBe("chromium");
    expect(managedBrowserExecutableCandidates("chromium", "darwin")).toContain("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
    expect(managedBrowserExecutableCandidates("chromium", "linux")).toContain("/usr/bin/chromium");
    expect(managedBrowserExecutableCandidates("edge", "win32")).toContain("C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe");
  });

  it("keeps the CDP page expression bounded to interactive content and documents boundaries", () => {
    expect(MANAGED_DOM_EVALUATION_SCRIPT).toContain("shadowRoot");
    expect(MANAGED_DOM_EVALUATION_SCRIPT).toContain("deviceScaleFactor");
    expect(MANAGED_DOM_EVALUATION_SCRIPT).toContain('coordinateSpace: "css"');
    expect(MANAGED_DOM_EVALUATION_SCRIPT).toContain("iframe documents are intentionally not traversed");
    expect(MANAGED_DOM_EVALUATION_SCRIPT).toContain("canvasLike");
    expect(MANAGED_DOM_EVALUATION_SCRIPT).not.toContain("outerHTML");
    expect(MANAGED_DOM_EVALUATION_SCRIPT).not.toContain("nodeId");
    expect(MANAGED_DOM_EVALUATION_SCRIPT).not.toContain(".value");
  });

  it("keeps the local fixture coverage explicit for controls, canvas, shadow DOM and iframe boundaries", async () => {
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
      url: "https://example.com",
      profileMode: "persistent",
      resolveOwnedWindowTarget: async () => undefined,
    })).toThrow(/persistent.*profile label.*root/iu);
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

  it("puts the explicit Run URL first and keeps prepared URLs bounded and deduplicated", () => {
    expect(buildManagedBrowserLaunchUrls(["https://prepared.test/", "https://current.test/path"], "https://current.test/path?query=ignored")).toEqual([
      "https://current.test/path?query=ignored",
      "https://prepared.test/",
    ]);
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
    try {
      await writeFile(join(root, "DevToolsActivePort"), "1111\nstale-browser\n", "utf8");
      await writeFile(join(root, "Cookies"), "login-state-must-remain", "utf8");
      const notBefore = Date.now();
      await clearManagedBrowserDevToolsPort(root);
      await expect(access(join(root, "DevToolsActivePort"))).rejects.toThrow();
      await writeFile(join(root, "DevToolsActivePort"), "2222\nfresh-browser\n", "utf8");
      await expect(waitForDevToolsPort(root, child, 300, new AbortController().signal, notBefore)).resolves.toEqual({ port: 2222 });
      await expect(readFile(join(root, "Cookies"), "utf8")).resolves.toBe("login-state-must-remain");
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

function serverTextFrame(payload: Buffer, opcode: number, final: boolean): Buffer {
  const header = Buffer.alloc(payload.length < 126 ? 2 : 4);
  header[0] = (final ? 0x80 : 0) | opcode;
  if (payload.length < 126) header[1] = payload.length;
  else { header[1] = 126; header.writeUInt16BE(payload.length, 2); }
  return Buffer.concat([header, payload]);
}
