import { describe, it, expect } from "vitest";
import { parseThemePreference, themeCookie } from "./theme";

describe("parseThemePreference", () => {
  it("accepts light and dark, and treats anything else as system", () => {
    expect(parseThemePreference("light")).toBe("light");
    expect(parseThemePreference("dark")).toBe("dark");
    expect(parseThemePreference("system")).toBe("system");
    expect(parseThemePreference("purple")).toBe("system");
    expect(parseThemePreference(undefined)).toBe("system");
  });
});

describe("themeCookie", () => {
  it("remembers an explicit choice for a year, on admin paths only", () => {
    expect(themeCookie("dark", true)).toBe("yg-theme=dark; Max-Age=31536000; Path=/admin; SameSite=Lax; Secure");
  });

  it("clears the cookie for System", () => {
    expect(themeCookie("system", false)).toBe("yg-theme=; Max-Age=0; Path=/admin; SameSite=Lax");
  });
});
