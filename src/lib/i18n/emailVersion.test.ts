import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Translation } from "@/lib/types/translation";
import { emailLanguageFor, emailVersionFor, versionLanguage, withApprovedWords } from "./emailVersion";

/** Which version of a journey email a reader gets (ASSET_TRANSLATIONS_ENABLED). */

const ITEM = { subject: "Welcome, {{user.first_name|there}}", previewText: "Start here", body: "Hello.", layout: null };
const AT = "2026-11-27T09:00:00.000Z";
const FR_WORDS = { subject: "Bienvenue, {{user.first_name|vous}}", previewText: "Commencez ici", body: "Bonjour." };

function translation(over: Partial<Translation> = {}): Translation {
  return {
    id: "tr_j_p_e_fr",
    tenantId: "ten_A",
    kind: "journey_email",
    journeyId: "j",
    poolId: "p",
    itemId: "e",
    lang: "fr",
    from: "en",
    state: "approved",
    rev: 2,
    sourceHash: "h1",
    draft: null,
    approved: { fields: FR_WORDS, sourceHash: "h1", by: "ai", at: AT, from: "en", approvedBy: "usr_1", approvedAt: AT },
    failReason: null,
    leaseUntil: null,
    createdAt: AT,
    updatedAt: AT,
    ...over,
  };
}

function on() {
  vi.stubEnv("ASSET_TRANSLATIONS_ENABLED", "true");
  vi.stubEnv("LANGUAGE_READERS_ENABLED", "true");
  vi.stubEnv("CONTENT_LANGUAGE_ENABLED", "true");
  vi.stubEnv("AUDIENCE_PERSON_LINKS_ENABLED", "true");
}
beforeEach(() => vi.unstubAllEnvs());
afterEach(() => vi.unstubAllEnvs());

describe("versionLanguage", () => {
  it("is the reader's language when the list has it and it isn't the base", () => {
    expect(versionLanguage("fr-FR", "en", ["en", "fr"])).toBe("fr");
    expect(versionLanguage("en", "en", ["en", "fr"])).toBeNull();
    expect(versionLanguage("pt", "en", ["en", "fr"])).toBeNull();
    expect(versionLanguage(null, "en", ["en", "fr"])).toBeNull();
  });
});

describe("withApprovedWords", () => {
  it("swaps in the approved words from the same base only", () => {
    expect(withApprovedWords(ITEM, translation(), "en")).toEqual({ ...ITEM, ...FR_WORDS });
    expect(withApprovedWords(ITEM, translation(), "de")).toBeNull();
    expect(withApprovedWords(ITEM, translation({ approved: null, state: "to_check" }), "en")).toBeNull();
    expect(withApprovedWords({ ...ITEM, layout: { blocks: [] } as never }, translation(), "en")).toBeNull();
  });
});

describe("emailVersionFor", () => {
  it("reads nothing for a reader of the base, or while the switch is off", async () => {
    const load = vi.fn(async () => translation());
    on();
    expect(await emailVersionFor({ item: ITEM, base: "en", lang: null, load })).toEqual({ item: ITEM, language: null });
    vi.unstubAllEnvs();
    expect(await emailVersionFor({ item: ITEM, base: "en", lang: "fr", load })).toEqual({ item: ITEM, language: null });
    expect(load).not.toHaveBeenCalled();
  });

  it("gives a reader of another language its approved version, with that language's fixed words", async () => {
    on();
    const v = await emailVersionFor({ item: ITEM, base: "en", lang: "fr", load: async () => translation() });
    expect(v.item).toEqual({ ...ITEM, ...FR_WORDS });
    expect(v.language).toMatchObject({ lang: "fr", dir: "ltr", footer: { unsubscribe: "Se désabonner" }, stepsDone: "{done} étapes sur {total} terminées" });
  });

  it("falls back to the base when there's no approved version or the read fails", async () => {
    on();
    expect((await emailVersionFor({ item: ITEM, base: "en", lang: "fr", load: async () => null })).language).toBeNull();
    expect((await emailVersionFor({ item: ITEM, base: "en", lang: "fr", load: async () => Promise.reject(new Error("down")) })).item).toBe(ITEM);
  });

  it("writes right to left for Arabic", () => {
    expect(emailLanguageFor("ar")).toMatchObject({ lang: "ar", dir: "rtl" });
  });
});
