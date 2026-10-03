export const PREFERENCES_STORAGE_KEY = "harness.preferences";
export const PREFERENCES_VERSION = 3 as const;
export { RUN_ASSISTANT_PREFERENCES_MAX_GUIDANCE_CHARS } from "@computer-harness/protocol";
import {
  normalizeRunAssistantPreferencesSnapshot,
  RUN_ASSISTANT_PREFERENCES_MAX_GUIDANCE_CHARS,
  type RunAssistantPreferencesSnapshot,
} from "@computer-harness/protocol";

export type LayoutMode = "standard" | "simple";
export type TextSize = "standard" | "large";
export type DisplayPreset = "standard" | "large_simple";
export type ResponseDetail = "concise" | "standard" | "detailed";
export type StepExplanation = "standard" | "more";
export type PreferredLanguage = "follow_conversation" | "zh-CN" | "en";
export type SpeechRate = "slow" | "normal" | "fast";

export interface PresentationPreferences {
  layoutMode: LayoutMode;
  textSize: TextSize;
  highContrast: boolean;
  reduceMotion: boolean;
}

export interface AssistantPreferences {
  responseDetail: ResponseDetail;
  stepExplanation: StepExplanation;
  preferredLanguage: PreferredLanguage;
  additionalGuidance: string;
}

export interface VoicePreferences {
  runNoticesEnabled: boolean;
  speechRate: SpeechRate;
}

export interface UserPreferences {
  version: typeof PREFERENCES_VERSION;
  presentation: PresentationPreferences;
  assistant: AssistantPreferences;
  voice: VoicePreferences;
}

export interface PreferenceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const DEFAULT_PREFERENCES: UserPreferences = {
  version: PREFERENCES_VERSION,
  presentation: {
    layoutMode: "standard",
    textSize: "standard",
    highContrast: false,
    reduceMotion: false,
  },
  assistant: {
    responseDetail: "standard",
    stepExplanation: "standard",
    preferredLanguage: "follow_conversation",
    additionalGuidance: "",
  },
  voice: {
    runNoticesEnabled: false,
    speechRate: "normal",
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function oneOf<T extends string>(value: unknown, values: readonly T[], fallback: T): T {
  return typeof value === "string" && values.includes(value as T) ? value as T : fallback;
}

function booleanOr(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

export function readPreferences(storage?: PreferenceStorage): UserPreferences {
  if (!storage) return cloneDefaults();
  try {
    const raw = storage.getItem(PREFERENCES_STORAGE_KEY);
    if (!raw) return cloneDefaults();
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || (parsed.version !== 1 && parsed.version !== 2 && parsed.version !== PREFERENCES_VERSION)) return cloneDefaults();
    const presentation = isRecord(parsed.presentation) ? parsed.presentation : {};
    const assistant = isRecord(parsed.assistant) ? parsed.assistant : {};
    const voice = isRecord(parsed.voice) ? parsed.voice : {};

    return {
      version: PREFERENCES_VERSION,
      presentation: {
        layoutMode: oneOf(presentation.layoutMode, ["standard", "simple"], DEFAULT_PREFERENCES.presentation.layoutMode),
        textSize: oneOf(presentation.textSize, ["standard", "large"], DEFAULT_PREFERENCES.presentation.textSize),
        highContrast: booleanOr(presentation.highContrast, DEFAULT_PREFERENCES.presentation.highContrast),
        reduceMotion: booleanOr(presentation.reduceMotion, DEFAULT_PREFERENCES.presentation.reduceMotion),
      },
      assistant: {
        responseDetail: oneOf(assistant.responseDetail, ["concise", "standard", "detailed"], DEFAULT_PREFERENCES.assistant.responseDetail),
        stepExplanation: oneOf(assistant.stepExplanation, ["standard", "more"], DEFAULT_PREFERENCES.assistant.stepExplanation),
        preferredLanguage: oneOf(assistant.preferredLanguage, ["follow_conversation", "zh-CN", "en"], DEFAULT_PREFERENCES.assistant.preferredLanguage),
        additionalGuidance: readAdditionalGuidance(assistant.additionalGuidance),
      },
      // Versions 1 and 2 had no custom guidance. Preserve their other choices.
      voice: {
        runNoticesEnabled: parsed.version === 2 || parsed.version === PREFERENCES_VERSION
          ? booleanOr(voice.runNoticesEnabled, DEFAULT_PREFERENCES.voice.runNoticesEnabled)
          : DEFAULT_PREFERENCES.voice.runNoticesEnabled,
        speechRate: parsed.version === 2 || parsed.version === PREFERENCES_VERSION
          ? oneOf(voice.speechRate, ["slow", "normal", "fast"], DEFAULT_PREFERENCES.voice.speechRate)
          : DEFAULT_PREFERENCES.voice.speechRate,
      },
    };
  } catch {
    return cloneDefaults();
  }
}

export function writePreferences(preferences: UserPreferences, storage?: PreferenceStorage): boolean {
  if (!storage) return false;
  try {
    const value: UserPreferences = {
      version: PREFERENCES_VERSION,
      presentation: { ...preferences.presentation },
      assistant: { ...preferences.assistant, additionalGuidance: readAdditionalGuidance(preferences.assistant.additionalGuidance) },
      voice: { ...preferences.voice },
    };
    storage.setItem(PREFERENCES_STORAGE_KEY, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export function cloneDefaults(): UserPreferences {
  return {
    version: PREFERENCES_VERSION,
    presentation: { ...DEFAULT_PREFERENCES.presentation },
    assistant: { ...DEFAULT_PREFERENCES.assistant },
    voice: { ...DEFAULT_PREFERENCES.voice },
  };
}

export function toRunAssistantPreferencesSnapshot(assistant: AssistantPreferences): RunAssistantPreferencesSnapshot {
  return normalizeRunAssistantPreferencesSnapshot({
    version: 1,
    responseDetail: assistant.responseDetail,
    stepExplanation: assistant.stepExplanation,
    preferredLanguage: assistant.preferredLanguage,
    additionalGuidance: assistant.additionalGuidance,
  });
}

function readAdditionalGuidance(value: unknown): string {
  if (typeof value !== "string" || [...value].length > RUN_ASSISTANT_PREFERENCES_MAX_GUIDANCE_CHARS) return "";
  try {
    return normalizeRunAssistantPreferencesSnapshot({
      version: 1,
      responseDetail: DEFAULT_PREFERENCES.assistant.responseDetail,
      stepExplanation: DEFAULT_PREFERENCES.assistant.stepExplanation,
      preferredLanguage: DEFAULT_PREFERENCES.assistant.preferredLanguage,
      additionalGuidance: value,
    }).additionalGuidance;
  } catch {
    return "";
  }
}
