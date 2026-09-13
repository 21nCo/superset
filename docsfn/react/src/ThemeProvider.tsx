"use client";

import React, {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

export type Theme = "light" | "dark" | "system";

export interface ThemeProviderProps {
  children: ReactNode;
  defaultTheme?: Theme;
  storageKey?: string;
}

export interface ThemeContextValue {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  actualTheme: "light" | "dark";
}

const ThemeContext = createContext<ThemeContextValue | undefined>(undefined);

function resolveSystemTheme(): "light" | "dark" {
  if (typeof window === "undefined") {
    return "light";
  }
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function applyThemeToDocument(theme: Theme, actualTheme: "light" | "dark") {
  if (typeof document === "undefined") {
    return;
  }
  const root = document.documentElement;
  root.classList.remove("light", "dark");
  root.classList.add(actualTheme);
  root.dataset.docsfnTheme = theme;
}

export function ThemeProvider({
  children,
  defaultTheme = "system",
  storageKey = "docsfn-theme",
}: ThemeProviderProps) {
  const [theme, setTheme] = useState<Theme>(defaultTheme);
  const [actualTheme, setActualTheme] = useState<"light" | "dark">("light");

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const stored = window.localStorage.getItem(storageKey);
    if (stored === "light" || stored === "dark" || stored === "system") {
      setTheme(stored);
    }
  }, [storageKey]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const nextActualTheme = theme === "system" ? resolveSystemTheme() : theme;
    setActualTheme(nextActualTheme);
    applyThemeToDocument(theme, nextActualTheme);
    window.localStorage.setItem(storageKey, theme);

    const handleSystemThemeChange = () => {
      if (theme !== "system") {
        return;
      }
      const systemTheme = resolveSystemTheme();
      setActualTheme(systemTheme);
      applyThemeToDocument(theme, systemTheme);
    };

    media.addEventListener("change", handleSystemThemeChange);
    return () => media.removeEventListener("change", handleSystemThemeChange);
  }, [theme, storageKey]);

  const value = useMemo<ThemeContextValue>(
    () => ({
      theme,
      setTheme,
      actualTheme,
    }),
    [theme, actualTheme]
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error("useTheme must be used within ThemeProvider");
  }
  return context;
}

export function ThemeToggle({ className }: { className?: string }) {
  const { theme, setTheme } = useTheme();

  const cycleTheme = () => {
    const themes: Theme[] = ["light", "dark", "system"];
    const currentIndex = themes.indexOf(theme);
    const nextIndex = (currentIndex + 1) % themes.length;
    setTheme(themes[nextIndex]);
  };

  return (
    <button onClick={cycleTheme} className={`docsfn-theme-toggle ${className || ""}`} aria-label="Toggle theme">
      {theme === "light" ? "Light" : null}
      {theme === "dark" ? "Dark" : null}
      {theme === "system" ? "System" : null}
    </button>
  );
}
