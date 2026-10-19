import type { ThemePreference } from "@/lib/theme";

/**
 * The public site's theme: "system" (the default) follows the OS; "light" or "dark" is
 * kept in this cookie, so the server renders the chosen theme with no flash. A separate
 * name from the admin's `yg-theme` cookie (scoped to /admin), so the two never mix.
 */
export const SITE_THEME_COOKIE = "yg-site-theme";

/** A `document.cookie` assignment for `pref`. Choosing System clears the cookie. */
export function siteThemeCookie(pref: ThemePreference, secure: boolean): string {
  const attrs = `Path=/; SameSite=Lax${secure ? "; Secure" : ""}`;
  return pref === "system"
    ? `${SITE_THEME_COOKIE}=; Max-Age=0; ${attrs}`
    : `${SITE_THEME_COOKIE}=${pref}; Max-Age=31536000; ${attrs}`;
}
