import {
  ApiError,
  type CommandReceipt,
  type DeviceList,
  type LocalPairingState,
  type ManagedBrowserDefaultSession,
  type ManagedBrowserProfileSettings,
  type PairRequestReceipt,
  type PairRequestStatus,
  type PairSession,
  type PairingChallenge,
  type RunSnapshot,
  type RunSummary,
  type RunTarget,
  type WindowTargetList,
} from "./types";
import type { Pcm16AudioChunk, VoiceInputCapabilities, VoiceSessionUpdate } from "@computer-harness/voice";
import type { RunAssistantPreferencesSnapshot } from "@computer-harness/protocol";

export { ApiError } from "./types";

let phoneCsrfToken: string | undefined;
let localCsrfToken: string | undefined;

export function setPhoneCsrfToken(token: string | undefined): void {
  phoneCsrfToken = token;
}

export function setLocalCsrfToken(token: string | undefined): void {
  localCsrfToken = token;
}

async function request<T>(
  path: string,
  init: RequestInit = {},
  csrf: "phone" | "local" | "none" = "none",
): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/json");
  if (init.body !== undefined && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  if (csrf === "phone" && phoneCsrfToken) headers.set("X-CSRF-Token", phoneCsrfToken);
  if (csrf === "local" && localCsrfToken) headers.set("X-CSRF-Token", localCsrfToken);

  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      headers,
      credentials: "same-origin",
      cache: "no-store",
    });
  } catch {
    throw new ApiError("电脑控制服务暂时无法连接。确认 Harness 正在运行后再试。", 0, "HOST_UNREACHABLE");
  }

  const body = await response.json().catch(() => undefined) as {
    message?: string;
    error?: string | { message?: string; code?: string };
    code?: string;
  } | undefined;
  if (!response.ok) {
    const errorBody = typeof body?.error === "object" ? body.error : undefined;
    const code = errorBody?.code ?? body?.code ?? (typeof body?.error === "string" ? body.error : undefined);
    const message = errorMessageForCode(code) ?? body?.message ?? errorBody?.message ?? errorMessageForStatus(response.status);
    if (response.status === 401) {
      if (csrf === "phone") setPhoneCsrfToken(undefined);
      if (csrf === "local") setLocalCsrfToken(undefined);
    }
    throw new ApiError(message, response.status, code);
  }
  if (response.status === 204) return undefined as T;
  return body as T;
}

function errorMessageForStatus(status: number): string {
  if (status === 401) return "连接已失效，请重新配对或刷新页面。";
  if (status === 403) return "电脑拒绝了此操作。请在电脑上确认连接，并检查请求是否仍有效。";
  if (status === 409) return "状态已变化，请先刷新后再操作。";
  if (status === 410) return "此请求已过期，请重新发起。";
  if (status === 429) return "尝试次数过多，请稍后再试。";
  if (status === 404) return "请求的内容已不可用，请刷新任务状态后重试。";
  return "操作没有完成，请查看当前状态后再试。";
}

function errorMessageForCode(code?: string): string | undefined {
  if (!code) return undefined;
  const messages: Record<string, string> = {
    invalid_or_expired_pairing_token: "这个二维码已过期或已使用。请让电脑生成新的二维码。",
    PAIRING_TOKEN_INVALID: "这个二维码已过期或已使用。请让电脑生成新的二维码。",
    pairing_request_not_found: "配对请求已过期或已处理。请重新扫描电脑上的新二维码。",
    PAIRING_REQUEST_NOT_FOUND: "配对请求已过期或已处理。请重新扫描电脑上的新二维码。",
    PAIRING_REQUEST_EXPIRED: "配对请求已过期。请重新扫描电脑上生成的新二维码。",
    PAIRING_NOT_APPROVED: "请先在电脑上确认这次配对请求。",
    PAIRING_BUSY: "电脑上有太多待处理的配对请求，请先处理后再试。",
    PAIRING_RATE_LIMIT: "配对尝试过多，请稍等片刻后再扫描。",
    DEVICE_LIMIT_REACHED: "电脑已达到授权手机数量上限。先撤销一台旧手机，再继续配对。",
    SESSION_INVALID: "手机授权已失效。请重新扫描电脑端的配对二维码。",
    DEVICE_NOT_FOUND: "这台手机已经不在授权列表中。请刷新连接管理页面。",
    session_required: "手机授权已失效。请重新扫描电脑端的配对二维码。",
    SESSION_REQUIRED: "手机授权已失效。请重新扫描电脑端的配对二维码。",
    host_unavailable: "电脑当前离线或无法连接。确认电脑已开机并运行 Harness。",
    host_disconnected: "电脑连接中断。请查看电脑状态后再重新连接。",
    host_busy: "电脑正在处理其他请求，请稍后再试。",
    csrf_check_failed: "页面连接已失效。请刷新页面或重新配对。",
    CSRF_REJECTED: "页面连接已失效。请刷新页面或重新配对。",
    origin_check_failed: "这个页面未通过电脑的安全校验。请从电脑提供的链接重新打开。",
    ORIGIN_CHECK_FAILED: "这个页面未通过电脑的安全校验。请从电脑提供的链接重新打开。",
    ORIGIN_REJECTED: "这个页面未通过电脑的安全校验。请从 Harness 电脑重新打开。",
    LOCAL_ONLY: "连接授权只能在运行 Harness 的电脑本机完成。",
    RELAY_UNAVAILABLE: "电脑的中继连接尚未就绪。请稍后再生成配对二维码。",
    outcome_unknown_refresh_state: "电脑服务在处理中断开，无法确认操作是否完成。请先检查电脑画面。",
    route_not_found: "当前 Host 没有提供这个功能。请更新电脑端后重试。",
    ROUTE_NOT_FOUND: "当前电脑端没有提供这个功能。请更新 Harness 后重试。",
    NOT_FOUND: "请求的内容已不可用，请刷新后重试。",
    RUN_NOT_FOUND: "找不到这个任务。请返回列表刷新后再试。",
    COMMAND_NOT_FOUND: "电脑尚未保存这项操作的回执。请刷新状态后再试。",
    ASSET_NOT_FOUND: "这张截图已不可用，请刷新任务状态。",
    INVALID_COMMAND: "这项操作已过期或不符合当前任务状态。请先刷新。",
    INVALID_EVENT_CURSOR: "任务进度需要重新同步。请刷新状态。",
    INVALID_REQUEST: "请求内容无法处理。请刷新页面后再试。",
    HOST_ERROR: "电脑服务遇到问题。请查看电脑端状态后再试。",
    WEB_NOT_BUILT: "电脑端控制页面尚未构建。请更新 Harness 后重试。",
    ASSET_TOO_LARGE: "这张截图无法通过手机显示。",
    SSE_LIMIT: "打开的任务页面过多。关闭其他页面后再试。",
    request_too_large: "这次请求内容过长，请缩短后再试。",
    WINDOW_TARGET_STALE: "所选窗口已过期或发生变化。请刷新可用窗口并重新选择后再开始。",
    WINDOW_SELECTION_REQUIRED: "电脑无法唯一确定要操作的窗口。请从刷新后的列表中手动选择一个窗口。",
    WINDOW_ACTIVATION_FAILED: "电脑找到了匹配窗口，但无法将它恢复到屏幕上。任务尚未开始，请手动选择一个当前可见的窗口后重试。",
    WINDOW_DISCOVERY_FAILED: "电脑暂时无法安全读取可用窗口。你可以改为手动选择窗口，或稍后重试。",
    RUN_BUSY: "电脑正在处理另一个任务。请等待当前任务结束后再开始。",
    INVALID_TARGET: "目标信息无效。请检查窗口选择或 http://、https:// 地址后重试。",
    MANAGED_BROWSER_UNAVAILABLE: "电脑上的受管理浏览器当前不可用。请在电脑端检查 Harness 状态后重试。",
    MANAGED_BROWSER_PROFILE_UNAVAILABLE: "受管浏览器配置当前被占用，或上次异常退出留下了运行标记。任务尚未启动。请停止使用它的浏览器和 Harness Host，再在电脑运行 scripts/mobile.ps1 recover-browser-profile。该命令只归档运行标记，不会删除登录数据。",
    MANAGED_BROWSER_SETUP_REQUIRED: "受管浏览器的本机登录状态尚未准备好。请先在设置中准备浏览器，再开始此任务。",
    PROFILE_OPERATION_STALE: "浏览器准备状态已变化。请刷新设置页面后重试。",
    PROFILE_STATE_UNAVAILABLE: "电脑无法确认受管浏览器的状态。请查看电脑端 Harness 状态后重试。",
    VOICE_UNAVAILABLE: "电脑端尚未配置语音识别，仍可直接输入文字。",
    VOICE_PROVIDER_UNAVAILABLE: "语音识别暂时中断。请重试，或改用文字输入。",
    VOICE_FINISH_TIMEOUT: "语音识别没有及时完成。请重试，或检查转写内容后再提交。",
    VOICE_SESSION_ACTIVE: "这台手机已有一段录音正在处理。请先结束或取消它。",
    VOICE_SESSION_EXPIRED: "录音时间过长或连接中断，请重新开始。",
    VOICE_AUDIO_LIMIT: "录音已达到时长上限。请停止录音后检查转写内容。",
    VOICE_EVENT_GAP: "录音进度连接中断，请重新录制这段语音。",
    INVALID_AUDIO_CHUNK: "录音数据格式不受支持，请重试或改用文字输入。",
  };
  return messages[code];
}

export function listWindowTargets(): Promise<WindowTargetList> {
  return request("/api/windows");
}

export async function getManagedBrowserProfileSettings(): Promise<ManagedBrowserProfileSettings> {
  return validateManagedBrowserProfileSettings(await request<unknown>("/api/managed-browser-profile"));
}

export async function setManagedBrowserDefaultSession(defaultSession: ManagedBrowserDefaultSession): Promise<ManagedBrowserProfileSettings> {
  return validateManagedBrowserProfileSettings(await request<unknown>("/api/managed-browser-profile/preference", {
    method: "PUT",
    body: JSON.stringify({ defaultSession }),
  }, "phone"));
}

export async function prepareManagedBrowserLogin(): Promise<ManagedBrowserProfileSettings> {
  return validateManagedBrowserProfileSettings(await request<unknown>("/api/managed-browser-profile/prepare", {
    method: "POST",
    body: JSON.stringify({}),
  }, "phone"));
}

export async function completeManagedBrowserLogin(operationId: string): Promise<ManagedBrowserProfileSettings> {
  return validateManagedBrowserProfileSettings(await request<unknown>("/api/managed-browser-profile/complete", {
    method: "POST",
    body: JSON.stringify({ operationId }),
  }, "phone"));
}

export async function reloginManagedBrowser(): Promise<ManagedBrowserProfileSettings> {
  return validateManagedBrowserProfileSettings(await request<unknown>("/api/managed-browser-profile/relogin", {
    method: "POST",
    body: JSON.stringify({}),
  }, "phone"));
}

function validateManagedBrowserProfileSettings(value: unknown): ManagedBrowserProfileSettings {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("电脑返回的浏览器状态格式无效。");
  const record = value as Record<string, unknown>;
  const status = record.status;
  const defaultSession = record.defaultSession;
  const commands = record.commands;
  if (status !== "unprepared" && status !== "preparing" && status !== "ready" && status !== "in_use" && status !== "relogin_required" && status !== "cleanup_failed") {
    throw new Error("电脑返回的浏览器状态格式无效。");
  }
  if (defaultSession !== "saved" && defaultSession !== "temporary") throw new Error("电脑返回的浏览器默认状态无效。");
  if (typeof commands !== "object" || commands === null || Array.isArray(commands)) throw new Error("电脑返回的浏览器操作格式无效。");
  const commandRecord = commands as Record<string, unknown>;
  if (typeof commandRecord.prepare !== "string" || typeof commandRecord.complete !== "string" || typeof commandRecord.relogin !== "string") {
    throw new Error("电脑返回的浏览器操作格式无效。");
  }
  if (record.operationId !== undefined && (typeof record.operationId !== "string" || !/^[0-9a-f-]{36}$/iu.test(record.operationId))) {
    throw new Error("电脑返回的浏览器操作标识无效。");
  }
  if (status === "preparing" && typeof record.operationId !== "string") throw new Error("电脑返回的浏览器准备状态缺少操作标识。");
  return {
    status,
    defaultSession,
    commands: { prepare: commandRecord.prepare, complete: commandRecord.complete, relogin: commandRecord.relogin },
    ...(typeof record.operationId === "string" ? { operationId: record.operationId } : {}),
  };
}

export function createRun(
  goal: string,
  commandId: string,
  target: RunTarget,
  assistantPreferences?: RunAssistantPreferencesSnapshot,
  runNoticeContentEnabled?: boolean,
): Promise<{ runId: string; status: string }> {
  return request("/api/runs", {
    method: "POST",
    body: JSON.stringify({
      commandId,
      goal,
      target,
      ...(assistantPreferences === undefined ? {} : { assistantPreferences }),
      ...(runNoticeContentEnabled === undefined ? {} : { runNoticeContentEnabled }),
    }),
  }, "phone");
}

export async function listRuns(): Promise<RunSummary[]> {
  const response = await request<{ runs: RunSummary[] }>("/api/runs");
  return Array.isArray(response.runs) ? response.runs : [];
}

export function getRun(runId: string): Promise<RunSnapshot> {
  return request(`/api/runs/${encodeURIComponent(runId)}`);
}

export function runEventsUrl(runId: string, after: number): string {
  const query = new URLSearchParams({ after: String(after) });
  return `/api/runs/${encodeURIComponent(runId)}/events?${query.toString()}`;
}

export function runAssetUrl(runId: string, assetId: string): string {
  return `/api/runs/${encodeURIComponent(runId)}/assets/${encodeURIComponent(assetId)}`;
}

export function sendCommand(runId: string, commandId: string, command: Record<string, unknown>): Promise<CommandReceipt> {
  return request<{ receipt: CommandReceipt }>(`/api/runs/${encodeURIComponent(runId)}/commands`, {
    method: "POST",
    body: JSON.stringify({ commandId, ...command }),
  }, "phone").then((response) => response.receipt);
}

export function getCommand(runId: string, commandId: string): Promise<CommandReceipt> {
  return request<CommandReceipt>(`/api/runs/${encodeURIComponent(runId)}/commands/${encodeURIComponent(commandId)}`);
}

export function submitPairRequest(token: string, clientName: string): Promise<PairRequestReceipt> {
  return request("/api/pair/requests", {
    method: "POST",
    body: JSON.stringify({ token, clientName }),
  });
}

export function establishPairSession(requestId: string): Promise<PairSession> {
  return request(`/api/pair/requests/${encodeURIComponent(requestId)}/session`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export function getPairRequest(requestId: string): Promise<PairRequestStatus> {
  return request(`/api/pair/requests/${encodeURIComponent(requestId)}`);
}

export function getPhoneSession(): Promise<PairSession> {
  return request("/api/session");
}

export function getVoiceInputCapabilities(): Promise<VoiceInputCapabilities> {
  return request("/api/voice/capabilities");
}

export function startVoiceInput(requestId: string): Promise<VoiceSessionUpdate> {
  return request("/api/voice/sessions", {
    method: "POST",
    body: JSON.stringify({ requestId }),
  }, "phone");
}

export function appendVoiceAudio(
  sessionId: string,
  chunks: readonly Pcm16AudioChunk[],
  afterEventSequence: number,
  signal?: AbortSignal,
): Promise<VoiceSessionUpdate> {
  return request(`/api/voice/sessions/${encodeURIComponent(sessionId)}/audio`, {
    method: "POST",
    ...(signal === undefined ? {} : { signal }),
    body: JSON.stringify({
      chunks: chunks.map((chunk) => ({ sequence: chunk.sequence, audio: bytesToBase64(chunk.data) })),
      afterEventSequence,
    }),
  }, "phone");
}

export function finishVoiceInput(sessionId: string, afterEventSequence: number): Promise<VoiceSessionUpdate> {
  return request(`/api/voice/sessions/${encodeURIComponent(sessionId)}/finish`, {
    method: "POST",
    body: JSON.stringify({ afterEventSequence }),
  }, "phone");
}

export function cancelVoiceInput(sessionId: string, afterEventSequence: number, signal?: AbortSignal): Promise<VoiceSessionUpdate> {
  return request(`/api/voice/sessions/${encodeURIComponent(sessionId)}/cancel`, {
    method: "POST",
    ...(signal === undefined ? {} : { signal }),
    body: JSON.stringify({ afterEventSequence }),
  }, "phone");
}

export function deletePhoneSession(): Promise<void> {
  return request("/api/session", { method: "DELETE", body: JSON.stringify({}) }, "phone");
}

export async function getLocalSession(): Promise<void> {
  const session = await request<{ csrfToken: string }>("/api/local/session");
  setLocalCsrfToken(session.csrfToken);
}

export function getLocalPairing(): Promise<LocalPairingState> {
  return request("/api/local/pairing");
}

export function createPairingChallenge(): Promise<PairingChallenge> {
  return request("/api/local/pairing", { method: "POST", body: JSON.stringify({}) }, "local");
}

export function confirmPairingRequest(requestId: string, approved: boolean, label?: string): Promise<{ requestId: string; status: string; deviceId?: string }> {
  return request(`/api/local/pairing/requests/${encodeURIComponent(requestId)}/confirm`, {
    method: "POST",
    body: JSON.stringify({ approved, ...(approved && label ? { label } : {}) }),
  }, "local");
}

export async function getDevices(): Promise<DeviceList> {
  const response = await request<DeviceList>("/api/local/devices");
  return { devices: Array.isArray(response.devices) ? response.devices : [] };
}

export function revokeDevice(deviceId: string): Promise<void> {
  return request(`/api/local/devices/${encodeURIComponent(deviceId)}`, { method: "DELETE" }, "local");
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const blockSize = 0x8000;
  for (let start = 0; start < bytes.length; start += blockSize) {
    const block = bytes.subarray(start, Math.min(bytes.length, start + blockSize));
    binary += String.fromCharCode(...block);
  }
  return btoa(binary);
}
