"use client";

import * as React from "react";

/**
 * Light/dark, with "follow the OS" as a real state rather than an initial guess.
 *
 * The three-way split matters: a boolean toggle can express light and dark but
 * has no way back to tracking the system once tapped, so the preference sticks
 * until someone clears localStorage. "system" is stored explicitly, and while
 * it is the stored value we keep listening to the media query — flipping the OS
 * appearance moves the app live.
 *
 * First paint is handled by the inline script in src/app/layout.tsx, not here;
 * an effect runs after the browser has already painted the wrong colours.
 */

export type Theme = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

/** Shared with the inline boot script — keep both in sync. */
export const THEME_STORAGE_KEY = "automata:theme";

interface ThemeState {
  /** What the user chose, which may be "system". */
  theme: Theme;
  /** What that actually renders as right now. */
  resolved: ResolvedTheme;
  setTheme: (theme: Theme) => void;
}

const ThemeContext = React.createContext<ThemeState>({
  theme: "system",
  resolved: "light",
  setTheme: () => {},
});

function readStored(): Theme {
  if (typeof window === "undefined") return "system";
  try {
    const raw = window.localStorage.getItem(THEME_STORAGE_KEY);
    return raw === "light" || raw === "dark" || raw === "system" ? raw : "system";
  } catch {
    // Private mode, blocked storage — fall back to following the OS.
    return "system";
  }
}

/**
 * The OS preference, as an external store.
 *
 * useSyncExternalStore rather than useState+useEffect: matchMedia IS external
 * state, and subscribing to it this way avoids a synchronous setState during
 * the effect (and the extra render that comes with it).
 */
function subscribeToSystem(onChange: () => void) {
  const query = window.matchMedia("(prefers-color-scheme: dark)");
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

function getSystemSnapshot(): ResolvedTheme {
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/** The server has no OS preference; the boot script fixes this before paint. */
function getSystemServerSnapshot(): ResolvedTheme {
  return "light";
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  /**
   * Seeded lazily from storage so the provider agrees with what the boot script
   * already put on <html>. Reading it in an initialiser is safe because it only
   * ever runs on the client.
   */
  const [theme, setThemeState] = React.useState<Theme>(readStored);

  const system = React.useSyncExternalStore(
    subscribeToSystem,
    getSystemSnapshot,
    getSystemServerSnapshot,
  );

  const resolved: ResolvedTheme = theme === "system" ? system : theme;

  React.useEffect(() => {
    // toggle(), never className assignment: <html> already carries the three
    // next/font variable classes and overwriting them drops every font.
    document.documentElement.classList.toggle("dark", resolved === "dark");
  }, [resolved]);

  const setTheme = React.useCallback((next: Theme) => {
    setThemeState(next);
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // A theme we can't persist is still a theme we can apply this session.
    }
  }, []);

  const value = React.useMemo(
    () => ({ theme, resolved, setTheme }),
    [theme, resolved, setTheme],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  return React.useContext(ThemeContext);
}
