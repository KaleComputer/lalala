import type { ThemeAppearance, ThemeColors } from "../themePalette";

/**
 * The voice brain's theme, installed as the "Voice" theme in this dev client's theme library and
 * selected when it changes. `colors` overrides any of T3's color roles (see THEME_COLOR_ROLES),
 * starting from the built-in T3 Code palette for `appearance`. `null` removes it again.
 */
export type VoiceTheme = {
  readonly appearance: ThemeAppearance;
  readonly colors: Partial<ThemeColors>;
};

export const voiceTheme: VoiceTheme | null = null;
