import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  cloneDefaults,
  readPreferences,
  writePreferences,
  type AssistantPreferences,
  type DisplayPreset,
  type PresentationPreferences,
  type UserPreferences,
} from "./preferences";

interface PreferencesContextValue {
  preferences: UserPreferences;
  saved: boolean | undefined;
  setPresentation<K extends keyof PresentationPreferences>(key: K, value: PresentationPreferences[K]): boolean;
  setDisplayPreset(preset: DisplayPreset): boolean;
  setAssistant<K extends keyof AssistantPreferences>(key: K, value: AssistantPreferences[K]): boolean;
  reset(): boolean;
}

const PreferencesContext = createContext<PreferencesContextValue | undefined>(undefined);

function browserPreferences(): UserPreferences {
  try {
    return readPreferences(window.localStorage);
  } catch {
    return readPreferences();
  }
}

function saveToBrowser(preferences: UserPreferences): boolean {
  try {
    return writePreferences(preferences, window.localStorage);
  } catch {
    return false;
  }
}

export function PreferencesProvider({ children }: { children: ReactNode }) {
  const [preferences, setPreferences] = useState(browserPreferences);
  const [saved, setSaved] = useState<boolean | undefined>(undefined);

  const setPresentation = useCallback(<K extends keyof PresentationPreferences>(key: K, value: PresentationPreferences[K]) => {
    const next: UserPreferences = { ...preferences, presentation: { ...preferences.presentation, [key]: value } };
    setPreferences(next);
    const wasSaved = saveToBrowser(next);
    setSaved(wasSaved);
    return wasSaved;
  }, [preferences]);

  const setDisplayPreset = useCallback((preset: DisplayPreset) => {
    const next: UserPreferences = {
      ...preferences,
      presentation: {
        ...preferences.presentation,
        layoutMode: preset === "large_simple" ? "simple" : "standard",
        textSize: preset === "large_simple" ? "large" : "standard",
      },
    };
    setPreferences(next);
    const wasSaved = saveToBrowser(next);
    setSaved(wasSaved);
    return wasSaved;
  }, [preferences]);

  const setAssistant = useCallback(<K extends keyof AssistantPreferences>(key: K, value: AssistantPreferences[K]) => {
    const next: UserPreferences = { ...preferences, assistant: { ...preferences.assistant, [key]: value } };
    setPreferences(next);
    const wasSaved = saveToBrowser(next);
    setSaved(wasSaved);
    return wasSaved;
  }, [preferences]);

  const reset = useCallback(() => {
    const next = cloneDefaults();
    setPreferences(next);
    const wasSaved = saveToBrowser(next);
    setSaved(wasSaved);
    return wasSaved;
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.layout = preferences.presentation.layoutMode;
    root.dataset.textSize = preferences.presentation.textSize;
    root.dataset.contrast = preferences.presentation.highContrast ? "high" : "standard";
    root.dataset.reduceMotion = String(preferences.presentation.reduceMotion);
  }, [preferences.presentation]);

  const contextValue = useMemo(() => ({ preferences, saved, setPresentation, setDisplayPreset, setAssistant, reset }), [preferences, saved, setPresentation, setDisplayPreset, setAssistant, reset]);
  return <PreferencesContext.Provider value={contextValue}>{children}</PreferencesContext.Provider>;
}

export function usePreferences(): PreferencesContextValue {
  const value = useContext(PreferencesContext);
  if (!value) throw new Error("usePreferences must be used inside PreferencesProvider");
  return value;
}
