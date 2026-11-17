import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import {
  DARK_MODE_QUERY,
  THEME_STORAGE_KEY,
  parseThemeChoice,
  resolveTheme,
  type ThemeChoice,
} from "@/theme";

type ThemeContextValue = { themeChoice: ThemeChoice; setThemeChoice: (choice: ThemeChoice) => void };

const ThemeContext = createContext<ThemeContextValue | null>(null);

// The choice is a per-browser preference. Storage can be blocked (private
// windows), so reads and writes fall back quietly to following the system.
const readStoredChoice = (): ThemeChoice => {
  try {
    return parseThemeChoice(localStorage.getItem(THEME_STORAGE_KEY));
  } catch {
    return parseThemeChoice(null);
  }
};

const storeChoice = (choice: ThemeChoice) => {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, choice);
  } catch {
    // Not saved: the page still switches, it just won't remember next visit.
  }
};

// shadcn's colors switch on a "dark" class on <html>.
export const applyTheme = (choice: ThemeChoice) => {
  const appliedTheme = resolveTheme(choice, matchMedia(DARK_MODE_QUERY).matches);
  document.documentElement.classList.toggle("dark", appliedTheme === "dark");
};

export const applyStoredTheme = () => applyTheme(readStoredChoice());

export const ThemeProvider = ({ children }: { children: ReactNode }) => {
  const [themeChoice, setChoiceState] = useState<ThemeChoice>(readStoredChoice);

  useEffect(() => {
    applyTheme(themeChoice);
    if (themeChoice !== "system") return;
    const darkModeQuery = matchMedia(DARK_MODE_QUERY);
    const followSystem = () => applyTheme("system");
    darkModeQuery.addEventListener("change", followSystem);
    return () => darkModeQuery.removeEventListener("change", followSystem);
  }, [themeChoice]);

  const setThemeChoice = (choice: ThemeChoice) => {
    storeChoice(choice);
    setChoiceState(choice);
  };

  return <ThemeContext.Provider value={{ themeChoice, setThemeChoice }}>{children}</ThemeContext.Provider>;
};

export const useTheme = (): ThemeContextValue => {
  const themeContext = useContext(ThemeContext);
  if (!themeContext) throw new Error("useTheme needs a ThemeProvider above it");
  return themeContext;
};
