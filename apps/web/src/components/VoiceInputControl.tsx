import { useContext, useEffect, useRef, useState } from "react";
import type { Pcm16AudioChunk, VoiceAudioCaptureAdapter, VoiceInputEvent } from "@computer-harness/voice";
import { VOICE_INPUT_MAX_DURATION_MS } from "@computer-harness/voice";
import {
  appendVoiceAudio,
  cancelVoiceInput,
  finishVoiceInput,
  startVoiceInput,
} from "../api";
import { notifyVoiceInputStarted } from "../run-notice-speech";
import { createVoiceTranscriptState, reduceVoiceInputEvent, transcriptText, type VoiceTranscriptState } from "@computer-harness/voice";
import { VoiceInputCapabilitiesContext } from "../voice-capabilities";
import { SerialAudioUploadQueue } from "../voice-pcm";
import { VoiceCaptureError, WebAudioCaptureAdapter } from "../web-audio-capture";

type ControlState = "idle" | "starting" | "recording" | "finalizing" | "finished" | "error" | "cancelled";

interface VoiceInputControlProps {
  disabled?: boolean;
  onTranscript: (text: string) => void;
  onActiveChange?: (active: boolean) => void;
  createCaptureAdapter?: (chunkBytes: number) => VoiceAudioCaptureAdapter;
}

export function VoiceInputControl({ disabled = false, onTranscript, onActiveChange, createCaptureAdapter }: VoiceInputControlProps) {
  const capabilities = useContext(VoiceInputCapabilitiesContext);
  const [status, setStatus] = useState<ControlState>("idle");
  const [durationSeconds, setDurationSeconds] = useState(0);
  const [transcript, setTranscript] = useState("");
  const [message, setMessage] = useState<string>();
  const generation = useRef(0);
  const statusRef = useRef<ControlState>("idle");
  const onActiveChangeRef = useRef(onActiveChange);
  onActiveChangeRef.current = onActiveChange;
  const stopTimer = useRef<number | undefined>(undefined);
  const stopRecordingRef = useRef<((automatic: boolean) => Promise<void>) | undefined>(undefined);
  const sessionId = useRef<string | undefined>(undefined);
  const eventCursor = useRef(0);
  const transcriptState = useRef<VoiceTranscriptState | undefined>(undefined);
  const captureRef = useRef<Awaited<ReturnType<WebAudioCaptureAdapter["start"]>> | undefined>(undefined);
  const queueRef = useRef<SerialAudioUploadQueue<Awaited<ReturnType<typeof appendVoiceAudio>>> | undefined>(undefined);
  const capturePump = useRef<Promise<void> | undefined>(undefined);
  const startedAt = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (status !== "recording") return;
    const timer = window.setInterval(() => {
      if (startedAt.current !== undefined) setDurationSeconds(Math.floor((Date.now() - startedAt.current) / 1000));
    }, 250);
    return () => window.clearInterval(timer);
  }, [status]);

  useEffect(() => () => {
    generation.current += 1;
    queueRef.current?.cancel();
    const activeSessionId = sessionId.current;
    const activeCapture = captureRef.current;
    captureRef.current = undefined;
    if (stopTimer.current !== undefined) window.clearTimeout(stopTimer.current);
    if (isActiveState(statusRef.current)) onActiveChangeRef.current?.(false);
    statusRef.current = "cancelled";
    if (activeCapture) void activeCapture.cancel();
    if (activeSessionId) void cancelVoiceInput(activeSessionId, eventCursor.current).catch(() => undefined);
  }, []);

  function transition(next: ControlState): void {
    const wasActive = isActiveState(statusRef.current);
    const active = isActiveState(next);
    statusRef.current = next;
    setStatus(next);
    if (wasActive !== active) onActiveChangeRef.current?.(active);
  }

  function applyUpdate(update: Awaited<ReturnType<typeof startVoiceInput>>, currentGeneration: number): void {
    if (generation.current !== currentGeneration || update.sessionId !== sessionId.current) return;
    let current = transcriptState.current;
    if (current === undefined || current.sessionId !== update.sessionId) return;
    const events = [...update.events].sort((left, right) => left.sequence - right.sequence);
    for (const envelope of events) {
      if (envelope.sequence <= eventCursor.current) continue;
      current = reduceVoiceInputEvent(current, envelope.event);
      eventCursor.current = envelope.sequence;
    }
    eventCursor.current = Math.max(eventCursor.current, update.eventCursor);
    transcriptState.current = current;
    setTranscript(transcriptText(current));
    const nextStatus = controlStateFor(current.status);
    if (nextStatus !== undefined) transition(nextStatus);
    const failedEvent = events.map((entry) => entry.event)
      .find((event) => event.type === "state_changed" && event.state === "failed");
    const failureMessage = errorTextForVoiceEvent(failedEvent);
    if (failureMessage) {
      setMessage(failureMessage);
      void failSession(currentGeneration, new Error(failureMessage));
    }
  }

  async function startRecording() {
    if (disabled || status === "starting" || status === "recording" || status === "finalizing") return;
    if (!capabilities?.available) {
      setMessage("电脑端语音识别暂不可用，仍可直接输入文字。");
      transition("error");
      return;
    }
    notifyVoiceInputStarted();
    const currentGeneration = ++generation.current;
    sessionId.current = undefined;
    transcriptState.current = undefined;
    eventCursor.current = 0;
    setTranscript("");
    setMessage(undefined);
    setDurationSeconds(0);
    transition("starting");
    try {
      const started = await startVoiceInput(crypto.randomUUID());
      if (generation.current !== currentGeneration) {
        void cancelVoiceInput(started.sessionId, started.eventCursor).catch(() => undefined);
        return;
      }
      sessionId.current = started.sessionId;
      transcriptState.current = createVoiceTranscriptState(started.sessionId);
      applyUpdate(started, currentGeneration);

      const chunkBytes = capabilities.chunkBytes ?? 3_200;
      const captureAdapter = createCaptureAdapter?.(chunkBytes) ?? new WebAudioCaptureAdapter(undefined, chunkBytes);
      const capture = await captureAdapter.start();
      if (generation.current !== currentGeneration) {
        await capture.cancel();
        return;
      }
      captureRef.current = capture;
      const activeSessionId = started.sessionId;
      const queue = new SerialAudioUploadQueue(
        (chunks, signal) => appendVoiceAudio(activeSessionId, chunks, eventCursor.current, signal),
        (update) => applyUpdate(update, currentGeneration),
        64_000,
      );
      queueRef.current = queue;
      startedAt.current = Date.now();
      transition("recording");
      stopTimer.current = window.setTimeout(
        () => { void stopRecordingRef.current?.(true); },
        capabilities.maxDurationMs ?? VOICE_INPUT_MAX_DURATION_MS,
      );
      capturePump.current = consumeCapture(capture.events, queue, currentGeneration);
      void capturePump.current.catch((error: unknown) => { void failSession(currentGeneration, error); });
    } catch (error) {
      await failSession(currentGeneration, error);
    }
  }

  async function consumeCapture(
    events: AsyncIterable<{ readonly type: string; readonly chunk?: Pcm16AudioChunk; readonly errorCode?: string }>,
    queue: SerialAudioUploadQueue<Awaited<ReturnType<typeof appendVoiceAudio>>>,
    currentGeneration: number,
  ): Promise<void> {
    for await (const event of events) {
      if (generation.current !== currentGeneration) return;
      if (event.type === "audio_chunk" && event.chunk !== undefined) queue.enqueue(event.chunk);
      else if (event.type === "capture_failed") throw new VoiceCaptureError("capture_unavailable");
    }
  }

  async function stopRecording() {
    return stopRecordingWithMode(false);
  }

  async function stopRecordingWithMode(automatic: boolean): Promise<void> {
    if (statusRef.current !== "recording") return;
    if (stopTimer.current !== undefined) window.clearTimeout(stopTimer.current);
    stopTimer.current = undefined;
    const currentGeneration = generation.current;
    const activeCapture = captureRef.current;
    const activeQueue = queueRef.current;
    const activeSessionId = sessionId.current;
    if (!activeCapture || !activeQueue || !activeSessionId) {
      await failSession(currentGeneration, new Error("capture state unavailable"));
      return;
    }
    transition("finalizing");
    if (automatic) setMessage("已到 60 秒上限，正在完成识别…");
    try {
      await activeCapture.stop();
      await capturePump.current;
      await activeQueue.flush();
      if (generation.current !== currentGeneration) return;
      const finished = await finishVoiceInput(activeSessionId, eventCursor.current);
      applyUpdate(finished, currentGeneration);
      const finalState = transcriptState.current;
      if (finalState?.status !== "finished") throw new Error("recognition did not finish");
      const finalSegments = finalState.segments;
      if (finalSegments.length === 0 || finalSegments.some((segment) => segment.state !== "final")) {
        setMessage("没有识别到完整语音，请再试一次或直接输入文字。");
      } else {
        const finalText = transcriptText(finalState);
        if (finalText) onTranscript(finalText);
        if (automatic) setMessage("已到 60 秒上限，完整识别结果已填入输入框，请检查后再发送。");
      }
      captureRef.current = undefined;
      queueRef.current = undefined;
      sessionId.current = undefined;
    } catch (error) {
      await failSession(currentGeneration, error);
    }
  }

  stopRecordingRef.current = stopRecordingWithMode;

  async function cancelRecording() {
    if (!isActiveState(statusRef.current)) return;
    generation.current += 1;
    transition("cancelled");
    if (stopTimer.current !== undefined) window.clearTimeout(stopTimer.current);
    stopTimer.current = undefined;
    setMessage("已取消录音，未将识别内容填入输入框。");
    transcriptState.current = undefined;
    setTranscript("");
    queueRef.current?.cancel();
    queueRef.current = undefined;
    const capture = captureRef.current;
    captureRef.current = undefined;
    await capture?.cancel().catch(() => undefined);
    const activeSessionId = sessionId.current;
    sessionId.current = undefined;
    if (activeSessionId) await cancelVoiceInput(activeSessionId, eventCursor.current).catch(() => undefined);
  }

  async function failSession(currentGeneration: number, error: unknown) {
    if (generation.current !== currentGeneration) return;
    generation.current += 1;
    transition("error");
    if (stopTimer.current !== undefined) window.clearTimeout(stopTimer.current);
    stopTimer.current = undefined;
    setMessage(messageForError(error));
    queueRef.current?.cancel();
    queueRef.current = undefined;
    const capture = captureRef.current;
    captureRef.current = undefined;
    await capture?.cancel().catch(() => undefined);
    const activeSessionId = sessionId.current;
    sessionId.current = undefined;
    if (activeSessionId) await cancelVoiceInput(activeSessionId, eventCursor.current).catch(() => undefined);
  }

  const active = isActiveState(status);
  return (
    <div className="voice-input-control">
      <div className="voice-input-actions">
        {!active && (
          <button className="button button-secondary voice-record-button" type="button" onClick={() => void startRecording()} disabled={disabled || capabilities === undefined || capabilities.available === false}>
            {status === "finished" || status === "cancelled" || status === "error" ? "重新录音" : "按下说话"}
          </button>
        )}
        {status === "recording" && <button className="button button-primary voice-record-button" type="button" onClick={() => void stopRecording()} disabled={disabled}>停止录音</button>}
        {(status === "starting" || status === "recording" || status === "finalizing") && (
          <button className="button button-secondary voice-cancel-button" type="button" onClick={() => void cancelRecording()} disabled={disabled}>取消</button>
        )}
        {status === "recording" && <span className="voice-record-duration" aria-label={"录音 " + formatDuration(durationSeconds)}>{formatDuration(durationSeconds)}</span>}
      </div>
      {status === "starting" && <p className="voice-input-status" role="status">正在准备麦克风和语音识别…</p>}
      {status === "recording" && <p className="voice-input-status" role="status">正在录音。再次按“停止录音”后，识别结果会填入输入框供你编辑。</p>}
      {status === "finalizing" && <p className="voice-input-status" role="status">正在完成识别…</p>}
      {transcript && active && <p className="voice-input-transcript" aria-live="off"><strong>实时转写：</strong>{transcript}</p>}
      {status === "finished" && transcript && <p className="voice-input-status" role="status">识别结果已填入输入框，请检查并编辑后再发送。</p>}
      {message && <p className={status === "error" ? "voice-input-error" : "voice-input-status"} role={status === "error" ? "alert" : "status"}>{message}</p>}
      {capabilities !== undefined && !capabilities.available && status === "idle" && (
        <p className="voice-input-status" role="note">语音输入尚不可用，仍可直接输入文字。</p>
      )}
    </div>
  );
}

function controlStateFor(state: VoiceTranscriptState["status"]): ControlState | undefined {
  if (state === "starting" || state === "recording" || state === "finalizing") return state;
  if (state === "finished") return "finished";
  if (state === "cancelled") return "cancelled";
  if (state === "failed") return "error";
  return undefined;
}

function isActiveState(state: ControlState): boolean {
  return state === "starting" || state === "recording" || state === "finalizing";
}

function errorTextForVoiceEvent(event: VoiceInputEvent | undefined): string | undefined {
  if (!event || event.type !== "state_changed" || event.state !== "failed") return undefined;
  return event.errorCode === "provider_timeout" ? "语音识别等待超时，请重试或改用文字输入。"
    : event.errorCode === "session_expired" || event.errorCode === "session_idle_timeout" ? "录音会话已过期，请重新开始。"
      : "语音识别暂时中断，请重试或改用文字输入。";
}

function messageForError(error: unknown): string {
  if (error instanceof VoiceCaptureError) {
    if (error.code === "secure_context_required") return "语音输入需要安全页面连接；请使用手机配对链接，或直接输入文字。";
    if (error.code === "microphone_denied") return "没有获得麦克风权限。请允许浏览器使用麦克风，或直接输入文字。";
    return "麦克风采集不可用。请检查浏览器权限，或直接输入文字。";
  }
  if (error instanceof Error && error.message.includes("backpressure")) return "网络较慢，录音已停止以避免丢失语音。请重试或直接输入文字。";
  return error instanceof Error ? error.message : "语音识别暂时不可用，请直接输入文字。";
}

function formatDuration(seconds: number): string {
  return Math.floor(seconds / 60) + ":" + String(seconds % 60).padStart(2, "0");
}
