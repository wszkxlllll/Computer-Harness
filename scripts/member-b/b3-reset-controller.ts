import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CuaDriverComputer,
  ManagedBrowserHost,
  defaultManagedBrowserKind,
  resolveOwnedManagedBrowserWindow,
} from "../../packages/computer-cua/src/index.js";
import type { ActionId, ObservationId, ObservationCapture } from "../../packages/protocol/src/index.js";
const { CuaDriver, EndSessionInput, StartSessionInput } = await import("../../packages/computer-cua/node_modules/@trycua/cua-driver/dist/index.js");

type FixtureKind = "shopping" | "communication";
type FixtureSuite = "b2" | "b3";

const REPO_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const DEFAULT_SOCKET = process.platform === "win32" ? "\\\\.\\pipe\\computer-harness-local" : `/tmp/computer-harness-${typeof process.getuid === "function" ? process.getuid() : "local"}.sock`;

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

function required(name: string): string {
  const value = option(name);
  if (value === undefined || value.trim().length === 0) throw new Error(`${name} is required`);
  return value;
}

function center(element: NonNullable<NonNullable<ObservationCapture["grounding"]>["elements"]>[number]): { x: number; y: number } {
  if (element.bbox === undefined || element.bbox.width <= 0 || element.bbox.height <= 0) throw new Error("reset button has no clickable bounds");
  return { x: element.bbox.x + element.bbox.width / 2, y: element.bbox.y + element.bbox.height / 2 };
}

function findResetButton(capture: ObservationCapture) {
  const button = capture.grounding?.elements.find((element) => element.source === "dom" && element.name === "重置本实例");
  if (button === undefined) throw new Error("DOM reset button was not available");
  return button;
}

function names(capture: ObservationCapture): string[] {
  return (capture.grounding?.elements ?? []).flatMap((element) => typeof element.name === "string" ? [element.name] : []);
}

function verifyEmptyState(instanceId: string, suite: FixtureSuite, observedNames: readonly string[]): { ok: boolean; sentinels: string[] } {
  const text = observedNames.join("\n");
  if (suite === "b2") {
    const sentinels = instanceId.startsWith("SHOP-")
      ? ["显示全部"]
      : instanceId.startsWith("COMM-F01-")
        ? ["请选择一个测试会话"]
        : ["保存草稿", "草稿箱未生成"];
    return { ok: sentinels.filter((sentinel) => sentinel !== "草稿箱未生成").every((sentinel) => text.includes(sentinel)) && (sentinels.includes("草稿箱未生成") ? !text.includes("草稿已保存") : true), sentinels };
  }
  const sentinels = instanceId.startsWith("SHOP-F04-")
    ? ["还没有加入商品"]
    : instanceId.startsWith("SHOP-F06-")
      ? ["尚未应用优惠"]
      : instanceId.startsWith("SHOP-F08-")
        ? ["已选：无"]
        : instanceId.startsWith("SHOP-F09-")
          ? ["状态：初始状态"]
          : instanceId.startsWith("COMM-F04-")
            ? ["保存到测试草稿", "草稿箱未生成"]
          : instanceId.startsWith("COMM-F05-")
            ? ["当前状态：未保存、未邀请。"]
            : instanceId.startsWith("COMM-F08-")
              ? ["尚未保存本地副本。"]
              : instanceId.startsWith("COMM-F09-")
                ? ["当前状态：仅查看。"]
                : ["草稿已保存"];
  const positive = sentinels.filter((sentinel) => sentinel !== "草稿箱未生成");
  const ok = positive.every((sentinel) => text.includes(sentinel)) && (sentinels.includes("草稿箱未生成") ? !text.includes("草稿已保存") : true);
  return { ok, sentinels };
}

function taskIdentity(instanceId: string, kind: FixtureKind, suite: FixtureSuite) {
  const taskId = `MB-${instanceId}`;
  const fixtureVersion = suite === "b2" ? "member-b-b2-fixture-v0" : kind === "shopping" ? "member-b-b3-shopping-fixture-v0" : "member-b-b3-communication-fixture-v0";
  const seedId = kind === "shopping" ? `shopping-${suite}-synthetic-v0` : `communication-${suite}-synthetic-v0`;
  const manifestId = suite === "b2" ? "member-b-b2-local-development-v0" : kind === "shopping" ? "member-b-b3-shopping-development-v0" : "member-b-b3-communication-development-v0";
  return { taskId, fixtureVersion, seedId, manifestId };
}

const instanceId = required("--instance");
const inferredSuite: FixtureSuite = /(?:SHOP|COMM)-F(?:04|06|08|09)-/u.test(instanceId) ? "b3" : "b2";
const suite = (option("--suite") ?? inferredSuite) as FixtureSuite;
if (suite !== "b2" && suite !== "b3") throw new Error("--suite must be b2 or b3");
const kind = (option("--kind") ?? (instanceId.startsWith("SHOP-") ? "shopping" : "communication")) as FixtureKind;
if (kind !== "shopping" && kind !== "communication") throw new Error("--kind must be shopping or communication");
if (!process.argv.includes("--allow-input")) throw new Error("refusing to click the reset button without --allow-input");
const socket = option("--socket") ?? DEFAULT_SOCKET;
const outputDir = resolve(REPO_ROOT, option("--output") ?? join("runs/member-b", `b3-reset-${instanceId}-${Date.now()}`));
const fixtureVersion = suite === "b2" ? "member-b-b2-fixture-v0" : kind === "shopping" ? "member-b-b3-shopping-fixture-v0" : "member-b-b3-communication-fixture-v0";
const fixtureFile = suite === "b2" ? "b2-local-fixture.v0.html" : kind === "shopping" ? "b3-shopping-fixture.v0.html" : "b3-communication-fixture.v0.html";
const url = `http://127.0.0.1:8006/eval/member-b/fixture/${fixtureFile}?instance=${encodeURIComponent(instanceId)}`;
const label = `b3-reset-${instanceId}-${Date.now()}`;
const controllerId = "b3-reset-controller-v0";

await mkdir(outputDir, { recursive: true });
const driver = CuaDriver.connect(socket);
let sessionStarted = false;
let host: ManagedBrowserHost | undefined;
let computer: CuaDriverComputer | undefined;
let computerSession: Awaited<ReturnType<CuaDriverComputer["open"]>> | undefined;
try {
  await driver.startSession(StartSessionInput.new({ session: label }), { signal: new AbortController().signal });
  sessionStarted = true;
  host = new ManagedBrowserHost({
    browser: defaultManagedBrowserKind(),
    url,
    profileMode: "ephemeral",
    resolveOwnedWindowTarget: (browserPid, signal, hint) => resolveOwnedManagedBrowserWindow(driver, label, browserPid, signal, hint),
  });
  const record = await host.start(new AbortController().signal);
  const transport = host.createTransport();
  computer = new CuaDriverComputer({
    socketPath: socket,
    screenshotDir: outputDir,
    sessionLabel: `${label}-computer`,
    windowTarget: record.target.windowTarget,
    windowDeliveryMode: "foreground",
    grounding: "hybrid-catalog-v1",
    browserTarget: record.target,
    domGroundingTransport: transport,
  });
  computerSession = await computer.open({}, new AbortController().signal);
  const beforeId = `b3-reset-before-${instanceId}` as ObservationId;
  const before = await computer.observe(computerSession, beforeId, new AbortController().signal);
  const resetButton = findResetButton(before);
  const click = await computer.execute(computerSession, {
    actionId: `b3-reset-click-${instanceId}` as ActionId,
    basedOn: beforeId,
    kind: "click",
    point: center(resetButton),
    groundingRef: resetButton.elementRef,
  }, new AbortController().signal);
  if (click.status !== "completed") throw new Error(`reset click did not complete: ${click.status}`);
  let afterId = `b3-reset-after-${instanceId}` as ObservationId;
  let after = await computer.observe(computerSession, afterId, new AbortController().signal);
  let observedNames = names(after);
  let empty = verifyEmptyState(instanceId, suite, observedNames);
  if (!empty.ok && instanceId.startsWith("COMM-F08-")) {
    const openEditor = after.grounding?.elements.find((element) => element.source === "dom" && element.name === "打开合成文本编辑器");
    if (openEditor !== undefined) {
      const reveal = await computer.execute(computerSession, {
        actionId: `b3-reset-reveal-editor-${instanceId}` as ActionId,
        basedOn: afterId,
        kind: "click",
        point: center(openEditor),
        groundingRef: openEditor.elementRef,
      }, new AbortController().signal);
      if (reveal.status === "completed") {
        afterId = `b3-reset-after-editor-${instanceId}` as ObservationId;
        after = await computer.observe(computerSession, afterId, new AbortController().signal);
        observedNames = [...new Set([...observedNames, ...names(after)])];
        empty = verifyEmptyState(instanceId, suite, observedNames);
      }
    }
  }
  for (let scrollIndex = 0; !empty.ok && scrollIndex < 4; scrollIndex += 1) {
    const scroll = await computer.execute(computerSession, {
      actionId: `b3-reset-scroll-${instanceId}-${scrollIndex}` as ActionId,
      basedOn: afterId,
      kind: "scroll",
      point: { x: after.viewport.width / 2, y: after.viewport.height / 2 },
      direction: "down",
      ticks: 5,
    }, new AbortController().signal);
    if (scroll.status !== "completed") break;
    afterId = `b3-reset-after-scroll-${instanceId}-${scrollIndex}` as ObservationId;
    after = await computer.observe(computerSession, afterId, new AbortController().signal);
    observedNames = [...new Set([...observedNames, ...names(after)])];
    empty = verifyEmptyState(instanceId, suite, observedNames);
  }
  process.stderr.write(`${JSON.stringify({ outputDir, observedNames, empty })}\n`);
  await writeFile(join(outputDir, "before-reset.png"), before.screenshot.data);
  await writeFile(join(outputDir, "after-reset.png"), after.screenshot.data);
  await writeFile(join(outputDir, "observed-dom-names.json"), `${JSON.stringify({ instanceId, observedNames }, null, 2)}\n`, "utf8");
  if (!empty.ok) throw new Error(`empty-state sentinel missing: ${empty.sentinels.join(", ")}`);
  const identity = taskIdentity(instanceId, kind, suite);
  const stateHash = `sha256:${createHash("sha256").update(JSON.stringify({ instanceId, fixtureVersion, observedNames })).digest("hex")}`;
  const receipt = {
    schemaVersion: "member-b-b3-reset-receipt-v1",
    ...identity,
    instanceId,
    fixtureVersion,
    controllerId,
    observedAt: new Date().toISOString(),
    stateHash,
    resetReceipt: { status: "completed", executed: true, method: "ui_reset_button", verifiedEmptyState: true },
    provenance: { source: "environment-controller", runId: label, browserTarget: "harness-owned-ephemeral" },
    evidenceRefs: [
      `screenshot:${join(outputDir, "after-reset.png")}`,
      `dom-observation:${join(outputDir, "observed-dom-names.json")}`,
    ],
  };
  await writeFile(join(outputDir, "reset-receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ status: "completed", instanceId, outputDir, stateHash, sentinels: empty.sentinels })}\n`);
} finally {
  if (computer !== undefined && computerSession !== undefined) await computer.close(computerSession).catch(() => undefined);
  if (host !== undefined) await host.close().catch(() => undefined);
  if (sessionStarted) await driver.endSession(EndSessionInput.new({ session: label })).catch(() => undefined);
  (driver as unknown as { uniffiDestroy?: () => void }).uniffiDestroy?.();
}
