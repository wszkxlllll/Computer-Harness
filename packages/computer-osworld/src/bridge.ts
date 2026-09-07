import type { Viewport } from "@computer-harness/protocol";

/** Screenshot bytes returned by the OSWorld bridge before Runtime persistence. */
export interface OsworldBridgeCapture {
  /** OSWorld's first bridge contract is deliberately PNG-only. */
  mediaType: "image/png";
  dataBase64: string;
  width: number;
  height: number;
  capturedAt: string;
  /** Actual guest display size reported by OSWorld when available. */
  guestScreenSize?: { width: number; height: number };
}

export interface OsworldBridgeCapabilities {
  screenshot: boolean;
  pointer: boolean;
  keyboard: boolean;
}

export interface OsworldBridgeDescription {
  viewport: Viewport;
  /** Actual guest display size reported by OSWorld when available. */
  guestScreenSize?: { width: number; height: number };
  /** Accessibility is not advertised until a producer and Context consumer exist. */
  capabilities: OsworldBridgeCapabilities;
}

/** Private, typed action format understood by the OSWorld bridge. */
export type OsworldTypedAction =
  | { kind: "click"; x: number; y: number }
  | { kind: "double_click"; x: number; y: number }
  | { kind: "right_click"; x: number; y: number }
  | { kind: "type"; text: string }
  | { kind: "keypress"; key: string }
  | { kind: "hotkey"; keys: string[] }
  | { kind: "scroll"; x: number; y: number; direction: "up" | "down" | "left" | "right"; ticks: number }
  | { kind: "drag"; fromX: number; fromY: number; toX: number; toY: number }
  | { kind: "wait"; durationMs: number };

export type OsworldBridgeExecuteResult =
  | {
      status: "completed";
      message?: string;
      /** The post-action screenshot returned by DesktopEnv.step(). */
      postActionCapture: OsworldBridgeCapture;
    }
  | { status: "refused"; code: string; message: string };

/**
 * Computer-only bridge boundary. Environment reset/evaluate/close stay with
 * the outer OSWorld runner and are deliberately absent from this interface.
 */
export interface OsworldBridge {
  describe(signal: AbortSignal): Promise<OsworldBridgeDescription>;
  observe(signal: AbortSignal): Promise<OsworldBridgeCapture>;
  execute(action: OsworldTypedAction, signal: AbortSignal): Promise<OsworldBridgeExecuteResult>;
}
