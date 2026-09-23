"use client";

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { isNavV2Phase2Enabled } from "@/lib/nav/flags";
import { ADMIN_THEME_ROOT_ID, themeCookie, type ThemePreference } from "@/lib/theme";

interface AdminTheme {
  preference: ThemePreference;
  setPreference: (pref: ThemePreference) => void;
}

const ThemeContext = createContext<AdminTheme | null>(null);

/**
 * The admin shell's theme boundary. With an explicit choice it carries
 * `data-theme`, which the Tailwind `darkMode` variant honours for everything
 * inside; with System it carries nothing, so `dark:` follows the OS as before.
 * `initial` comes from the cookie on the server, so the first paint is already right.
 */
export function AdminThemeRoot({ initial, children }: { initial: ThemePreference; children: ReactNode }) {
  const [preference, setState] = useState<ThemePreference>(initial);
  const setPreference = useCallback((pref: ThemePreference) => {
    setState(pref);
    document.cookie = themeCookie(pref, window.location.protocol === "https:");
  }, []);
  const explicit = preference === "system" ? undefined : preference;
  return (
    <ThemeContext.Provider value={{ preference, setPreference }}>
      <div
        id={ADMIN_THEME_ROOT_ID}
        data-theme={explicit}
        data-palette={isNavV2Phase2Enabled() ? "v2" : undefined}
        style={explicit ? { colorScheme: explicit } : undefined}
        className="yg-shell flex min-h-screen bg-shell-page"
      >
        {children}
      </div>
    </ThemeContext.Provider>
  );
}

/** The theme control, or null outside the nav v2 shell. */
export function useAdminTheme(): AdminTheme | null {
  return useContext(ThemeContext);
}

/** For libraries with their own theming (React Flow's `colorMode`). */
export function useAdminColorMode(): ThemePreference {
  return useContext(ThemeContext)?.preference ?? "system";
}

/**
 * Where portals should render so they stay inside the theme boundary. Null until
 * mounted (and outside the shell), which Radix and callers treat as <body>.
 */
export function useThemePortalContainer(): HTMLElement | null {
  const [container, setContainer] = useState<HTMLElement | null>(null);
  useEffect(() => setContainer(document.getElementById(ADMIN_THEME_ROOT_ID)), []);
  return container;
}
