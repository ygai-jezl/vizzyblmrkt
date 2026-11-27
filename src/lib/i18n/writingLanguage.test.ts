import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AiUsage } from "@/lib/agents/gemini";
import { aiUsage } from "@/lib/plans/meter";
import type { Tenant } from "@/lib/types/tenant";
import { writingDirective } from "./locale";
import { inBrandLanguage, isNotEnglish, withWritingLanguage, writingLanguage, writingLanguageOf } from "./writingLanguage";

const PROMPT = "Write a LinkedIn post about the launch.\nReturn JSON: {\"body\": \"...\"}";
const usageIn = (code: string): Pick<AiUsage, "brandLanguage"> => ({ brandLanguage: async () => code });

describe("writingDirective", () => {
  it("is empty for English and unknown codes, so English prompts don't change", () => {
    expect(writingDirective("en")).toBe("");
    expect(writingDirective("EN-gb")).toBe("");
    expect(writingDirective("xx")).toBe("");
    expect(writingDirective(null)).toBe("");
  });

  it("names the language and keeps the machine parts as they are", () => {
    const d = writingDirective("fr-FR");
    expect(d).toContain("WRITE IN French");
    for (const kept of ["JSON keys", "META_TITLE:", "{{double_brace}}", "URLs", "Markdown"]) expect(d).toContain(kept);
  });
});

describe("with CONTENT_LANGUAGE_ENABLED off", () => {
  beforeEach(() => vi.stubEnv("CONTENT_LANGUAGE_ENABLED", "false"));
  afterEach(() => vi.unstubAllEnvs());

  it("leaves every prompt exactly as it was, whatever the brand's language", async () => {
    expect(await inBrandLanguage(PROMPT, usageIn("fr"))).toBe(PROMPT);
    expect(await writingLanguage(usageIn("de"))).toBe("en");
    expect(writingLanguageOf({ defaultLocale: "ja" })).toBe("en");
  });

  it("never asks the usage for the language", async () => {
    const brandLanguage = vi.fn(async () => "fr");
    await inBrandLanguage(PROMPT, { brandLanguage });
    expect(brandLanguage).not.toHaveBeenCalled();
  });
});

describe("with CONTENT_LANGUAGE_ENABLED on", () => {
  beforeEach(() => vi.stubEnv("CONTENT_LANGUAGE_ENABLED", "true"));
  afterEach(() => vi.unstubAllEnvs());

  it("writes in the brand's language, after the prompt as it was", async () => {
    const out = await inBrandLanguage(PROMPT, usageIn("fr"));
    expect(out.startsWith(`${PROMPT}\n\n`)).toBe(true);
    expect(out).toContain("WRITE IN French");
  });

  it("adds what the caller adds for that language", async () => {
    const out = await inBrandLanguage(PROMPT, usageIn("es"), (lang) => `Labels for ${lang}.`);
    expect(out.endsWith("Labels for es.")).toBe(true);
    expect(withWritingLanguage(PROMPT, "en", "Labels.")).toBe(PROMPT);
  });

  it("stays English for an English brand, a usage that can't say, or a read that fails", async () => {
    expect(await inBrandLanguage(PROMPT, usageIn("en"))).toBe(PROMPT);
    expect(await inBrandLanguage(PROMPT, {})).toBe(PROMPT);
    expect(await inBrandLanguage(PROMPT, undefined)).toBe(PROMPT);
    expect(await inBrandLanguage(PROMPT, { brandLanguage: async () => Promise.reject(new Error("down")) })).toBe(PROMPT);
    expect(await inBrandLanguage(PROMPT, usageIn("klingon"))).toBe(PROMPT);
  });

  it("reads a brand record's default, tidied", () => {
    expect(writingLanguageOf({ defaultLocale: "pt-BR" })).toBe("pt");
    expect(writingLanguageOf({ defaultLocale: null })).toBe("en");
    expect(writingLanguageOf(null)).toBe("en");
  });
});

describe("AiUsage.brandLanguage", () => {
  const ctx = { tenantId: "ten_lang", region: "eu" } as const;

  it("is the brand record's default the caller passed, tidied", async () => {
    expect(await aiUsage(ctx, "content_angle", { tenant: { defaultLocale: "de-AT" } as Tenant }).brandLanguage!()).toBe("de");
    expect(await aiUsage(ctx, "content_angle", { tenant: null }).brandLanguage!()).toBe("en");
  });

  it("is worked out once for a usage", async () => {
    const usage = aiUsage(ctx, "content_angle", { tenant: { defaultLocale: "fr" } as Tenant });
    expect(usage.brandLanguage!()).toBe(usage.brandLanguage!());
  });
});

describe("isNotEnglish", () => {
  it("is true only for a known language other than English", () => {
    expect(isNotEnglish("fr")).toBe(true);
    expect(isNotEnglish("en-US")).toBe(false);
    expect(isNotEnglish(undefined)).toBe(false);
    expect(isNotEnglish("zz")).toBe(false);
  });
});
