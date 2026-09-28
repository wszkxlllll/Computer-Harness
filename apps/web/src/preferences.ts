export const PREFERENCES_STORAGE_KEY = "harness.preferences";
export const PREFERENCES_VERSION = 2 as const;

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
    if (!isRecord(parsed) || (parsed.version !== 1 && parsed.version !== PREFERENCES_VERSION)) return cloneDefaults();
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
      },
      // Version 1 had no voice settings. Migration keeps every existing choice and defaults speech off.
      voice: {
        runNoticesEnabled: parsed.version === PREFERENCES_VERSION
          ? booleanOr(voice.runNoticesEnabled, DEFAULT_PREFERENCES.voice.runNoticesEnabled)
          : DEFAULT_PREFERENCES.voice.runNoticesEnabled,
        speechRate: parsed.version === PREFERENCES_VERSION
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
      assistant: { ...preferences.assistant },
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
