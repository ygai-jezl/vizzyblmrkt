import { describe, it, expect } from "vitest";
import { LocaleSettingsSchema } from "./localeSettings";

describe("LocaleSettingsSchema (tenant-level locale form)", () => {
  it("accepts a supported default + supported set including it", () => {
    const parsed = LocaleSettingsSchema.safeParse({
      defaultLocale: "fr",
      supportedLocales: ["fr", "en", "ja"],
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects an unsupported default language", () => {
    expect(
      LocaleSettingsSchema.safeParse({ defaultLocale: "xx", supportedLocales: ["xx"] }).success,
    ).toBe(false);
  });

  it("rejects an unsupported language in the supported set", () => {
    expect(
      LocaleSettingsSchema.safeParse({ defaultLocale: "en", supportedLocales: ["en", "xx"] })
        .success,
    ).toBe(false);
  });

  it("rejects a default that is not in the supported set", () => {
    const parsed = LocaleSettingsSchema.safeParse({
      defaultLocale: "fr",
      supportedLocales: ["en"],
    });
    expect(parsed.success).toBe(false);
  });
});
