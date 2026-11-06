// Standalone: no theme library, so the brain's voiceTheme.ts has nothing to install into.
export type ThemeAppearance = "light" | "dark";
export type ThemeColors = Record<string, string>;
export type ThemeDefinition = {
  readonly id: string;
  readonly label: string;
  readonly appearance: ThemeAppearance;
  readonly colors: ThemeColors;
};
export const getCustomThemes = (): ReadonlyArray<ThemeDefinition> => [];
export const installCustomTheme = (_definition: ThemeDefinition) => {};
export const updateCustomTheme = (_definition: ThemeDefinition) => {};
export const removeCustomTheme = (_id: string) => {};
