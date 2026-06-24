import { describe, it, expect } from "vitest";
import {
  DEFAULT_LOCALE,
  SUPPORTED_LOCALES,
  isSupportedLocale,
  isLiveSupportedLocale,
  languageDirective,
  languageName,
  normalizeLocale,
  resolveCampaignLocale,
  resolveVisitorLocale,
  supportedLocalesFor,
} from "./locale";

describe("normalizeLocale", () => {
  it("coerces region-tagged / cased / separator variants down to a supported base code", () => {
    expect(normalizeLocale("fr-FR")).toBe("fr");
    expect(normalizeLocale("PT_br")).toBe("pt");
    expect(normalizeLocale("  EN  ")).toBe("en");
    expect(normalizeLocale("ja")).toBe("ja");
  });
  it("returns null for unsupported / empty input", () => {
    expect(normalizeLocale("xx")).toBeNull();
    expect(normalizeLocale("")).toBeNull();
    expect(normalizeLocale(null)).toBeNull();
    expect(normalizeLocale(undefined)).toBeNull();
  });
});

describe("isSupportedLocale / isLiveSupportedLocale", () => {
  it("accepts curated codes and rejects others", () => {
    expect(isSupportedLocale("fr")).toBe(true);
    expect(isSupportedLocale("zh")).toBe(true);
    expect(isSupportedLocale("xx")).toBe(false);
    expect(isSupportedLocale(null)).toBe(false);
  });
  it("flags text-only locales (no Gemini Live voice support)", () => {
    expect(isLiveSupportedLocale("fr")).toBe(true);
    expect(isLiveSupportedLocale("zh")).toBe(false); // text only, not in the Live set
    expect(isLiveSupportedLocale("en")).toBe(true);
  });
  it("includes English in the supported set", () => {
    expect(SUPPORTED_LOCALES).toContain(DEFAULT_LOCALE);
  });
});

describe("languageDirective", () => {
  it("returns an empty string for English / unknown so English prompts are unchanged", () => {
    expect(languageDirective("en")).toBe("");
    expect(languageDirective("EN")).toBe("");
    expect(languageDirective(null)).toBe("");
    expect(languageDirective("xx")).toBe("");
  });
  it("names the target language for non-English locales", () => {
    const d = languageDirective("fr");
    expect(d).not.toBe("");
    expect(d).toContain("French");
    expect(d).toMatch(/RESPOND ONLY IN French/);
    // resolves region tags too
    expect(languageDirective("ja-JP")).toContain("Japanese");
  });
  it("instructs the model to preserve merge tokens, HTML, and JSON keys verbatim (cross-cutting risk)", () => {
    const d = languageDirective("de");
    expect(d).toMatch(/merge tokens/i);
    expect(d).toMatch(/HTML/i);
    // JSON field names/keys must NOT be translated, or parseVariants drops the output.
    expect(d).toMatch(/JSON field names|keys/i);
  });
});

describe("languageName", () => {
  it("maps codes to English names with an English fallback", () => {
    expect(languageName("ja")).toBe("Japanese");
    expect(languageName("xx")).toBe("English");
    expect(languageName(null)).toBe("English");
  });
});

describe("resolveCampaignLocale", () => {
  it("prefers the campaign default, then the tenant default, then English", () => {
    expect(resolveCampaignLocale({ strategy: { defaultLocale: "fr" } }, { defaultLocale: "de" })).toBe("fr");
    expect(resolveCampaignLocale({ strategy: {} }, { defaultLocale: "de" })).toBe("de");
    expect(resolveCampaignLocale({}, {})).toBe("en");
    expect(resolveCampaignLocale(null, null)).toBe("en");
  });
  it("normalises stored values and ignores unsupported ones", () => {
    expect(resolveCampaignLocale({ strategy: { defaultLocale: "PT-br" } })).toBe("pt");
    expect(resolveCampaignLocale({ strategy: { defaultLocale: "xx" } }, { defaultLocale: "ko" })).toBe("ko");
  });
});

describe("supportedLocalesFor", () => {
  it("includes the default and the admin-declared set (campaign over tenant), normalised + deduped", () => {
    expect(
      supportedLocalesFor(
        { strategy: { defaultLocale: "fr", supportedLocales: ["fr-FR", "EN", "ja"] } },
        { defaultLocale: "de", supportedLocales: ["de"] },
      ),
    ).toEqual(["fr", "en", "ja"]);
  });
  it("falls back to just the default when nothing is declared", () => {
    expect(supportedLocalesFor({ strategy: { defaultLocale: "ja" } })).toEqual(["ja"]);
    expect(supportedLocalesFor(null, null)).toEqual(["en"]);
  });
});

describe("resolveVisitorLocale", () => {
  const campaign = { strategy: { defaultLocale: "en", supportedLocales: ["en", "fr", "ja"] } };

  it("prefers an explicit choice when supported", () => {
    expect(resolveVisitorLocale({ explicit: "fr", campaign })).toBe("fr");
    expect(resolveVisitorLocale({ explicit: "ja-JP", campaign })).toBe("ja");
  });
  it("ignores an explicit choice the launch does not support, then tries saved/header", () => {
    expect(resolveVisitorLocale({ explicit: "de", savedLocale: "fr", campaign })).toBe("fr");
    expect(resolveVisitorLocale({ explicit: "de", acceptLanguage: "ja,en;q=0.8", campaign })).toBe("ja");
  });
  it("falls back to a returning signup's saved locale before the browser header", () => {
    expect(resolveVisitorLocale({ savedLocale: "ja", acceptLanguage: "fr", campaign })).toBe("ja");
  });
  it("negotiates Accept-Language by q-weight, clamped to supportedLocales", () => {
    expect(resolveVisitorLocale({ acceptLanguage: "de-DE,fr;q=0.9,en;q=0.7", campaign })).toBe("fr");
    // de is highest but unsupported by this launch ⇒ skipped.
    expect(resolveVisitorLocale({ acceptLanguage: "de;q=1.0", campaign })).toBe("en"); // default
  });
  it("defaults to the launch default when nothing matches", () => {
    expect(resolveVisitorLocale({ campaign })).toBe("en");
    expect(resolveVisitorLocale({ explicit: "zz", acceptLanguage: "xx", campaign })).toBe("en");
  });
});
