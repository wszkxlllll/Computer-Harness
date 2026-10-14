import fs from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { isProxy } from "node:util/types";

export const GLM_ENDPOINT = "https://open.bigmodel.cn/api/paas/v4/chat/completions";
export const DEFAULT_BATCH_LIMITS = Object.freeze({ total: 132, main: 120, risk: 12 });
export const DEFAULT_RUN_RESERVATION = Object.freeze({ total: 42, main: 40, risk: 2 });
const MAIN_TOOLS = new Set([
  "click", "double_click", "right_click", "type", "keypress", "hotkey", "scroll", "drag", "wait", "switch_window", "list_windows", "reopen_saved_document",
  "click_element", "select_option", "task_create", "task_update", "task_list", "task_get", "execution_segment_set",
  "memory_get", "memory_write_fact", "memory_mark_fact_needs_check", "memory_search", "memory_upsert_entity",
  "memory_list", "memory_invalidate_entity", "terminate", "interact",
]);
const schema = "computer-harness-fetch-batch/v1";
const fail = (code) => { throw new Error(code); };

function plain(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) && !isProxy(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function ownData(value, code) {
  if (!plain(value)) fail(code);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).some((key) => typeof key !== "string" || !("value" in descriptors[key]))) fail(code);
  return Object.fromEntries(Reflect.ownKeys(descriptors).map((key) => [key, descriptors[key].value]));
}
function validCounts(value) {
  const counts = ownData(value, "COUNTER_CORRUPT");
  if (Object.keys(counts).sort().join(",") !== "main,risk,total" ||
      !Object.values(counts).every((n) => Number.isSafeInteger(n) && n >= 0) || counts.total !== counts.main + counts.risk) fail("COUNTER_CORRUPT");
  return counts;
}
function canonical(value) { return JSON.stringify(value); }
function sha(value) { return createHash("sha256").update(value).digest("hex"); }
function stateDigest(state) { const copy = { ...state }; delete copy.stateHash; return sha(canonical(copy)); }
function pathSet(root) { return { state: resolve(root, "counter.json"), anchor: resolve(root, "counter.anchor.json"), lock: resolve(root, "counter.lock"), audit: resolve(root, "audit.jsonl") }; }
function initialChainHash({ batchId, reservationId, limits, reservation }) {
  return sha(canonical({ schema, batchId, reservationId, limits, reservation, actual: { total: 0, main: 0, risk: 0 }, sequence: 0 }));
}

export function classifyGlmRequest(url, init) {
  if (typeof url === "string" && url !== GLM_ENDPOINT) {
    const match = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})\/json\/(?:version|list)$/u.exec(url);
    if (match !== null && Number(match[1]) <= 65_535) {
      const request = init === undefined ? {} : ownData(init, "FETCH_REQUEST_REFUSED");
      const allowedKeys = new Set(["method", "redirect", "signal"]);
      if (Object.keys(request).some((key) => !allowedKeys.has(key)) ||
          request.method !== undefined && request.method !== "GET" ||
          request.redirect !== undefined && request.redirect !== "error") fail("FETCH_REQUEST_REFUSED");
      return { channel: "loopback_cdp", request: { method: "GET", redirect: "error", ...(request.signal === undefined ? {} : { signal: request.signal }) } };
    }
    fail("FETCH_ENDPOINT_REFUSED");
  }
  if (typeof url !== "string" || url !== GLM_ENDPOINT) fail("FETCH_ENDPOINT_REFUSED");
  const request = ownData(init, "FETCH_REQUEST_REFUSED");
  if (request.method !== "POST" || typeof request.body !== "string" || request.redirect !== undefined && request.redirect !== "error") fail("FETCH_REQUEST_REFUSED");
  let body;
  try { body = JSON.parse(request.body); } catch { fail("FETCH_BODY_REFUSED"); }
  if (!plain(body) || body.model !== "glm-5.3-flash" || body.max_tokens !== 8192 || body.stream !== false ||
      !plain(body.thinking) || body.thinking.type !== "enabled" ||
      (body.reasoning_effort !== undefined && body.reasoning_effort !== "low" && body.reasoning_effort !== "high") ||
      !Array.isArray(body.tools) || body.tools.length === 0) fail("FETCH_PROFILE_REFUSED");
  const names = body.tools.map((tool) => {
    if (!plain(tool) || tool.type !== "function" || !plain(tool.function) || typeof tool.function.name !== "string") fail("FETCH_TOOLS_REFUSED");
    return tool.function.name;
  });
  if (new Set(names).size !== names.length) fail("FETCH_TOOLS_REFUSED");
  if (names.length === 1 && names[0] === "risk_classification") return { channel: "risk", request: { ...request, redirect: "error" } };
  if (names.some((name) => !MAIN_TOOLS.has(name))) fail("FETCH_TOOLS_REFUSED");
  return { channel: "main", request: { ...request, redirect: "error" } };
}

function checkRoot(root) {
  const st = fs.lstatSync(root);
  if (st.isSymbolicLink() || !st.isDirectory() || fs.realpathSync(root) !== root || (st.mode & 0o777) !== 0o700 || st.nlink < 2) fail("BATCH_ROOT_REFUSED");
  return { dev: st.dev, ino: st.ino, uid: st.uid };
}
function stableRead(path, rootIdentity) {
  const before = fs.lstatSync(path);
  if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1 || before.uid !== rootIdentity.uid || (before.mode & 0o777) !== 0o600) fail("COUNTER_FILE_REFUSED");
  const fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const opened = fs.fstatSync(fd);
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size > 1024 * 1024) fail("COUNTER_FILE_REFUSED");
    const bytes = Buffer.alloc(opened.size + 1); const size = fs.readSync(fd, bytes, 0, bytes.length, 0);
    const after = fs.fstatSync(fd);
    if (size !== opened.size || opened.ino !== after.ino || opened.size !== after.size || opened.mtimeMs !== after.mtimeMs) fail("COUNTER_FILE_REFUSED");
    return bytes.subarray(0, size).toString("utf8");
  } finally { fs.closeSync(fd); }
}
function writeAtomic(path, text, dirFd) {
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const fd = fs.openSync(tmp, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600);
  try { fs.writeFileSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, path);
  fs.fsyncSync(dirFd);
}
function stateAndAnchor(paths, rootIdentity, batchId, reservationId) {
  const state = JSON.parse(stableRead(paths.state, rootIdentity));
  const anchor = JSON.parse(stableRead(paths.anchor, rootIdentity));
  if (!plain(state) || state.schema !== schema || state.batchId !== batchId || state.reservationId !== reservationId) fail("COUNTER_IDENTITY_REFUSED");
  const limits = validCounts(state.limits), reservation = validCounts(state.reservation);
  if (limits.total > DEFAULT_BATCH_LIMITS.total || limits.main > DEFAULT_BATCH_LIMITS.main || limits.risk > DEFAULT_BATCH_LIMITS.risk ||
      reservation.total > limits.total || reservation.main > limits.main || reservation.risk > limits.risk) fail("COUNTER_IDENTITY_REFUSED");
  const counts = validCounts(state.actual);
  if (!Number.isSafeInteger(state.sequence) || state.sequence < 0 || typeof state.chainHash !== "string" || !/^[a-f0-9]{64}$/u.test(state.chainHash) ||
      state.stateHash !== stateDigest(state) || !plain(anchor) || anchor.schema !== schema || anchor.batchId !== batchId || anchor.sequence !== state.sequence || anchor.chainHash !== state.chainHash || anchor.stateHash !== state.stateHash ||
      (state.reservationRevision !== undefined && (!Number.isSafeInteger(state.reservationRevision) || state.reservationRevision < 0)) ||
      (state.reservationChainHash !== undefined && (typeof state.reservationChainHash !== "string" || !/^[a-f0-9]{64}$/u.test(state.reservationChainHash))) ||
      state.sequence !== counts.total || counts.total > limits.total || counts.main > limits.main || counts.risk > limits.risk || counts.total > reservation.total ||
      counts.main > reservation.main || counts.risk > reservation.risk) fail("COUNTER_ROLLBACK_OR_LIMIT");
  return { state, counts };
}

function verifyAudit(paths, rootIdentity, state) {
  const lines = stableRead(paths.audit, rootIdentity).split("\n").filter(Boolean);
  const records = lines.map((line) => {
    try { return ownData(JSON.parse(line), "COUNTER_AUDIT_REFUSED"); } catch { fail("COUNTER_AUDIT_REFUSED"); }
  });
  const firstExtension = records.find((record) => record.kind === "reservation_extended");
  const initialReservation = firstExtension === undefined ? validCounts(state.reservation) : validCounts(firstExtension.oldReservation);
  let reservation = initialReservation;
  let reservationRevision = 0;
  let reservationChainHash = initialChainHash({ batchId: state.batchId, reservationId: state.reservationId, limits: state.limits, reservation: initialReservation });
  let actual = { total: 0, main: 0, risk: 0 };
  let sequence = 0;
  let chainHash = reservationChainHash;
  for (const record of records) {
    if (record.batchId !== state.batchId) fail("COUNTER_AUDIT_REFUSED");
    if (record.kind === "reservation_extended") {
      const oldReservation = validCounts(record.oldReservation), newReservation = validCounts(record.newReservation);
      if (record.revision !== reservationRevision + 1 || canonical(oldReservation) !== canonical(reservation) ||
          newReservation.total < oldReservation.total || newReservation.main < oldReservation.main || newReservation.risk < oldReservation.risk ||
          newReservation.total === oldReservation.total && newReservation.main === oldReservation.main && newReservation.risk === oldReservation.risk ||
          newReservation.total > state.limits.total || newReservation.main > state.limits.main || newReservation.risk > state.limits.risk ||
          typeof record.reason !== "string" || typeof record.at !== "string") fail("COUNTER_AUDIT_REFUSED");
      const event = { kind: "reservation_extended", revision: record.revision, oldReservation, newReservation, reason: record.reason, at: record.at };
      reservationChainHash = sha(reservationChainHash + canonical(event));
      if (record.reservationChainHash !== reservationChainHash) fail("COUNTER_AUDIT_REFUSED");
      reservation = newReservation;
      reservationRevision += 1;
      continue;
    }
    const channel = record.channel;
    const next = { ...actual };
    if (channel !== "main" && channel !== "risk") fail("COUNTER_AUDIT_REFUSED");
    next.total += 1;
    next[channel] += 1;
    const event = { sequence: sequence + 1, channel, actual: next, at: record.at };
    chainHash = sha(chainHash + canonical(event));
    if (record.sequence !== event.sequence || canonical(validCounts(record.actual)) !== canonical(next) || record.chainHash !== chainHash ||
        next.total > reservation.total || next.main > reservation.main || next.risk > reservation.risk) fail("COUNTER_AUDIT_REFUSED");
    actual = next;
    sequence += 1;
  }
  if (sequence !== state.sequence || canonical(actual) !== canonical(state.actual) || chainHash !== state.chainHash ||
      reservationRevision !== (state.reservationRevision ?? 0) || canonical(reservation) !== canonical(state.reservation) ||
      (state.reservationChainHash !== undefined && state.reservationChainHash !== reservationChainHash)) fail("COUNTER_AUDIT_REFUSED");
  return { reservationRevision, reservationChainHash };
}

export function initializeBatch(root, { batchId, reservationId, limits = DEFAULT_BATCH_LIMITS, reservation = DEFAULT_RUN_RESERVATION } = {}) {
  if (typeof batchId !== "string" || !/^[A-Za-z0-9._-]{1,64}$/u.test(batchId) || typeof reservationId !== "string" || !/^[A-Za-z0-9._-]{1,64}$/u.test(reservationId)) fail("BATCH_CONFIG_REFUSED");
  const resolvedRoot = resolve(root);
  fs.mkdirSync(resolvedRoot, { mode: 0o700 });
  const identity = checkRoot(resolvedRoot);
  const batchLimits = validCounts(limits), reserved = validCounts(reservation);
  if (reserved.total > batchLimits.total || reserved.main > batchLimits.main || reserved.risk > batchLimits.risk) fail("RESERVATION_EXCEEDS_BATCH");
  const paths = pathSet(resolvedRoot);
  const initialHash = sha(canonical({ schema, batchId, reservationId, limits: batchLimits, reservation: reserved, actual: { total: 0, main: 0, risk: 0 }, sequence: 0 }));
  const state = { schema, batchId, reservationId, limits: batchLimits, reservation: reserved, actual: { total: 0, main: 0, risk: 0 }, sequence: 0, chainHash: initialHash };
  state.stateHash = stateDigest(state);
  const anchor = { schema, batchId, sequence: 0, chainHash: initialHash, stateHash: state.stateHash };
  const dirFd = fs.openSync(resolvedRoot, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try {
    for (const [path, value] of [[paths.state, state], [paths.anchor, anchor]]) {
      const fd = fs.openSync(path, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600);
      try { fs.writeFileSync(fd, canonical(value) + "\n"); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    }
    const auditFd = fs.openSync(paths.audit, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600);
    fs.closeSync(auditFd); fs.fsyncSync(dirFd);
  } finally { fs.closeSync(dirFd); }
  return { root: resolvedRoot, identity };
}

/** Extend one existing durable reservation without resetting its actual count or Run identity. */
export function extendBatchReservation(root, { batchId, reservationId, reservation, reason } = {}) {
  if (typeof batchId !== "string" || typeof reservationId !== "string" || !plain(reservation) ||
      typeof reason !== "string" || reason.trim().length === 0 || reason.length > 160 || /[\u0000-\u001f\u007f]/u.test(reason)) fail("RESERVATION_EXTENSION_REFUSED");
  const resolvedRoot = resolve(root), paths = pathSet(resolvedRoot), identity = checkRoot(resolvedRoot);
  let lockFd;
  try { lockFd = fs.openSync(paths.lock, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600); }
  catch { fail("COUNTER_LOCK_BUSY_OR_STALE"); }
  let dirFd;
  try {
    checkRoot(resolvedRoot);
    dirFd = fs.openSync(resolvedRoot, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    const { state, counts } = stateAndAnchor(paths, identity, batchId, reservationId);
    const verified = verifyAudit(paths, identity, state);
    const oldReservation = validCounts(state.reservation), nextReservation = validCounts(reservation);
    if (nextReservation.total < oldReservation.total || nextReservation.main < oldReservation.main || nextReservation.risk < oldReservation.risk ||
        nextReservation.total === oldReservation.total && nextReservation.main === oldReservation.main && nextReservation.risk === oldReservation.risk ||
        nextReservation.total > state.limits.total || nextReservation.main > state.limits.main || nextReservation.risk > state.limits.risk ||
        nextReservation.total < counts.total || nextReservation.main < counts.main || nextReservation.risk < counts.risk) fail("RESERVATION_EXTENSION_REFUSED");
    const revision = verified.reservationRevision + 1;
    const at = new Date().toISOString();
    const event = { kind: "reservation_extended", revision, oldReservation, newReservation: nextReservation, reason: reason.trim(), at };
    const reservationChainHash = sha(verified.reservationChainHash + canonical(event));
    const updated = { ...state, reservation: nextReservation, reservationRevision: revision, reservationChainHash };
    updated.stateHash = stateDigest(updated);
    writeAtomic(paths.state, canonical(updated) + "\n", dirFd);
    // stateHash already binds the extension revision and hash-chain fields.
    // Keep the anchor shape unchanged so an already-running older guard can
    // append the next fetch event without invalidating this reservation.
    writeAtomic(paths.anchor, canonical({ schema, batchId, sequence: state.sequence, chainHash: state.chainHash, stateHash: updated.stateHash }) + "\n", dirFd);
    const auditFd = fs.openSync(paths.audit, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_NOFOLLOW);
    try { fs.writeFileSync(auditFd, canonical({ batchId, ...event, reservationChainHash }) + "\n"); fs.fsyncSync(auditFd); } finally { fs.closeSync(auditFd); }
    fs.fsyncSync(dirFd);
    return { reservation: nextReservation, actual: counts, sequence: state.sequence, reservationRevision: revision };
  } finally {
    if (dirFd !== undefined) fs.closeSync(dirFd);
    fs.closeSync(lockFd);
    fs.unlinkSync(paths.lock);
  }
}

export function createDurableFetchGuard({ root, batchId, reservationId, delegate }) {
  if (typeof delegate !== "function") fail("FETCH_GUARD_REFUSED");
  const resolvedRoot = resolve(root), paths = pathSet(resolvedRoot), identity = checkRoot(resolvedRoot);
  let closed = false;
  const fetch = async (url, init) => {
    if (closed) fail("FETCH_GUARD_CLOSED");
    const { channel, request } = classifyGlmRequest(url, init);
    if (channel === "loopback_cdp") return delegate(url, request);
    let lockFd;
    try { lockFd = fs.openSync(paths.lock, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600); }
    catch { fail("COUNTER_LOCK_BUSY_OR_STALE"); }
    let dirFd;
    try {
      checkRoot(resolvedRoot);
      dirFd = fs.openSync(resolvedRoot, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
      const { state, counts } = stateAndAnchor(paths, identity, batchId, reservationId);
      if (counts.total >= state.reservation.total || counts[channel] >= state.reservation[channel] || counts.total >= state.limits.total || counts[channel] >= state.limits[channel]) fail("FETCH_BUDGET_EXHAUSTED");
      const next = { ...counts, total: counts.total + 1, [channel]: counts[channel] + 1 };
      const event = { sequence: state.sequence + 1, channel, actual: next, at: new Date().toISOString() };
      const chainHash = sha(state.chainHash + canonical(event));
      const updated = { ...state, actual: next, sequence: event.sequence, chainHash };
      updated.stateHash = stateDigest(updated);
      writeAtomic(paths.state, canonical(updated) + "\n", dirFd);
      writeAtomic(paths.anchor, canonical({ schema, batchId, sequence: event.sequence, chainHash, stateHash: updated.stateHash }) + "\n", dirFd);
      const auditFd = fs.openSync(paths.audit, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_NOFOLLOW);
      try { fs.writeFileSync(auditFd, canonical({ batchId, ...event, chainHash }) + "\n"); fs.fsyncSync(auditFd); } finally { fs.closeSync(auditFd); }
    } finally {
      if (dirFd !== undefined) fs.closeSync(dirFd);
      fs.closeSync(lockFd);
      fs.unlinkSync(paths.lock);
    }
    return delegate(url, request);
  };
  return Object.freeze({ fetch, close() { closed = true; } });
}

export function installGuard(host, guard) {
  const descriptor = Object.getOwnPropertyDescriptor(host, "fetch");
  if (!descriptor || !("value" in descriptor) || typeof descriptor.value !== "function" || descriptor.configurable !== true) fail("FETCH_INSTALL_REFUSED");
  Object.defineProperty(host, "fetch", { value: guard.fetch, enumerable: descriptor.enumerable, writable: false, configurable: false });
}
