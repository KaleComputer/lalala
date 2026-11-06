import {
  T3_CODE_DARK_THEME_COLORS,
  T3_CODE_LIGHT_THEME_COLORS,
} from "@t3tools/shared/themePalettes";

import { readThemePreference, refreshTheme, setTheme } from "~/hooks/useTheme";
import {
  getCustomThemes,
  installCustomTheme,
  removeCustomTheme,
  type ThemeDefinition,
  updateCustomTheme,
} from "../themePalette";
import { type VoiceTheme, voiceTheme } from "./voiceTheme";

/**
 * Keeps `voiceTheme.ts` installed as the "Voice" theme in T3's own theme library, so it can be
 * picked in Settings like any custom theme and survives reloads and the theme editor. A change to
 * the file selects it; setting it to null removes it and restores the theme picked before.
 */
const VOICE_THEME_ID = "lalala";
const PREVIOUS_THEME_KEY = "lalala:theme-before";
const APPLIED_THEME_KEY = "lalala:theme-applied";

function definitionOf(theme: VoiceTheme): ThemeDefinition {
  const base = theme.appearance === "dark" ? T3_CODE_DARK_THEME_COLORS : T3_CODE_LIGHT_THEME_COLORS;
  return {
    id: VOICE_THEME_ID,
    label: "Voice",
    appearance: theme.appearance,
    colors: { ...base, ...theme.colors },
  };
}

function sync(theme: VoiceTheme | null): void {
  const installed = getCustomThemes().some((definition) => definition.id === VOICE_THEME_ID);
  const current = readThemePreference();
  if (theme === null) {
    localStorage.removeItem(APPLIED_THEME_KEY);
    if (current === VOICE_THEME_ID) setTheme(localStorage.getItem(PREVIOUS_THEME_KEY) ?? "system");
    if (installed) removeCustomTheme(VOICE_THEME_ID);
    return;
  }
  const definition = definitionOf(theme);
  if (installed) updateCustomTheme(definition);
  else installCustomTheme(definition);

  // Only a new version of the file takes over; a theme the user picked since then stays picked.
  const signature = JSON.stringify(theme);
  const changed = localStorage.getItem(APPLIED_THEME_KEY) !== signature;
  localStorage.setItem(APPLIED_THEME_KEY, signature);
  if (current === VOICE_THEME_ID) {
    refreshTheme();
  } else if (changed) {
    localStorage.setItem(PREVIOUS_THEME_KEY, current);
    setTheme(VOICE_THEME_ID);
  }
}

export function syncVoiceTheme(): void {
  sync(voiceTheme);
}

// The brain edits voiceTheme.ts while the page is open; apply it in place instead of reloading.
// Typed by hand: Next's types (lalala.talk builds this file too) know only webpack's `accept()`.
const hot = import.meta.hot as
  | { accept(path: string, callback: (next: unknown) => void): void }
  | undefined;
if (hot) {
  hot.accept("./voiceTheme", (next) => {
    sync((next as { voiceTheme?: VoiceTheme | null } | undefined)?.voiceTheme ?? null);
  });
}
