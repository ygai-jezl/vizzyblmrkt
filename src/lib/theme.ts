/**
 * The admin's theme preference. "system" (the default) sets nothing, so `dark:`
 * styles follow the OS exactly as before; "light"/"dark" put `data-theme` on the
 * admin shell, which the Tailwind `darkMode` variant honours (tailwind.config.ts).
 * Pure + client-safe.
 */

export type ThemePreference = "system" | "light" | "dark";

/** Cookie holding an explicit choice. Scoped to /admin, so public pages never see it. */
export const THEME_COOKIE = "yg-theme";

/** The admin shell element carrying `data-theme`; portals render into it to keep the theme. */
export const ADMIN_THEME_ROOT_ID = "admin-theme-root";

export function parseThemePreference(value: string | null | undefined): ThemePreference {
  return value === "light" || value === "dark" ? value : "system";
}

/** A `document.cookie` assignment for `pref`. Choosing System clears the cookie. */
export function themeCookie(pref: ThemePreference, secure: boolean): string {
  const attrs = `Path=/admin; SameSite=Lax${secure ? "; Secure" : ""}`;
  return pref === "system"
    ? `${THEME_COOKIE}=; Max-Age=0; ${attrs}`
    : `${THEME_COOKIE}=${pref}; Max-Age=31536000; ${attrs}`;
}
