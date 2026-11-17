export const THEME_CHOICES = ["light", "dark", "system"] as const;
export type ThemeChoice = (typeof THEME_CHOICES)[number];
export type AppliedTheme = "light" | "dark";

export const THEME_STORAGE_KEY = "talos-theme";
export const DEFAULT_THEME_CHOICE: ThemeChoice = "system";
export const DARK_MODE_QUERY = "(prefers-color-scheme: dark)";

// "system" follows the computer's own light or dark setting.
export const resolveTheme = (choice: ThemeChoice, prefersDark: boolean): AppliedTheme => {
  if (choice === "system") return prefersDark ? "dark" : "light";
  return choice;
};

export const parseThemeChoice = (storedValue: string | null): ThemeChoice =>
  THEME_CHOICES.find((choice) => choice === storedValue) ?? DEFAULT_THEME_CHOICE;
