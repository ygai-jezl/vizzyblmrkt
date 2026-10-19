import { describe, expect, it } from "vitest";
import { parseThemePreference } from "@/lib/theme";
import { SITE_THEME_COOKIE, siteThemeCookie } from "./theme";

describe("site theme cookie", () => {
  it("keeps an explicit choice for a year across the site, and clears it for System", () => {
    expect(siteThemeCookie("light", true)).toBe(`${SITE_THEME_COOKIE}=light; Max-Age=31536000; Path=/; SameSite=Lax; Secure`);
    expect(siteThemeCookie("dark", false)).toBe(`${SITE_THEME_COOKIE}=dark; Max-Age=31536000; Path=/; SameSite=Lax`);
    expect(siteThemeCookie("system", true)).toBe(`${SITE_THEME_COOKIE}=; Max-Age=0; Path=/; SameSite=Lax; Secure`);
  });

  it("reads anything unknown as System", () => {
    expect(parseThemePreference("dark")).toBe("dark");
    expect(parseThemePreference("blue")).toBe("system");
    expect(parseThemePreference(undefined)).toBe("system");
  });
});
