import { describe, expect, it } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { TenantContext } from "@/lib/tenant/types";
import type { Tenant } from "@/lib/types/tenant";
import { brandLanguages, languageReaders, minReadersOf, readersByLanguage, READERS_FRESH_MS } from "./languageReaders";
import { versionReadiness } from "./readerRules";

/** Readers per language (LANGUAGE_READERS_ENABLED). Made-up people at .test addresses. */

const A: TenantContext = { tenantId: "ten_A", region: "us", source: "idtoken" } as TenantContext;
const NOW = Date.parse("2026-11-27T09:00:00.000Z");

function seedPeople(db: FakeFirestore, tenantId: string, languages: Array<string | null>, memberOf = ["all"]) {
  languages.forEach((language, i) => {
    db.seed("contacts", `con_${tenantId}_${memberOf.join("")}_${i}`, {
      tenantId,
      contactKey: `p${i}@customer.test`,
      memberOf,
      ...(language ? { language } : {}),
    });
  });
}

function brand(over: Partial<Tenant> = {}): Tenant {
  return { id: "ten_A", defaultLocale: "en", supportedLocales: ["en", "fr", "de"], ...over } as Tenant;
}

describe("brandLanguages and minReadersOf", () => {
  it("puts the default first, normalised and once", () => {
    expect(brandLanguages({ defaultLocale: "fr-FR", supportedLocales: ["en", "FR", "xx"] })).toEqual(["fr", "en"]);
    expect(brandLanguages(null)).toEqual(["en"]);
  });

  it("uses 10 unless the brand sets its own number", () => {
    expect(minReadersOf(null)).toBe(10);
    expect(minReadersOf({ languageSettings: { minReaders: 3 } } as Tenant)).toBe(3);
  });
});

describe("readersByLanguage and versionReadiness", () => {
  it("counts everyone we don't know as the default", () => {
    expect(readersByLanguage(["en", "fr", "de"], { everyone: 20, counts: { fr: 12, de: 3 } })).toEqual({ en: 5, fr: 12, de: 3 });
    expect(readersByLanguage(["en", "fr"], { everyone: 2, counts: { fr: 5 } })).toEqual({ en: 0, fr: 5 });
  });

  it("says how many more readers a language needs", () => {
    expect(versionReadiness(12, 10)).toEqual({ ready: true, more: 0 });
    expect(versionReadiness(3, 10)).toEqual({ ready: false, more: 7 });
  });
});

describe("languageReaders", () => {
  it("reads nothing for a brand with one language", async () => {
    const db = new FakeFirestore();
    seedPeople(db, "ten_A", ["fr"]);
    expect(await languageReaders(A, brand({ supportedLocales: ["en"] }), { db, now: () => NOW })).toBeNull();
  });

  it("counts this brand's people per language and keeps the count on the brand", async () => {
    const db = new FakeFirestore();
    db.seed("tenants", "ten_A", { defaultLocale: "en", supportedLocales: ["en", "fr", "de"] });
    seedPeople(db, "ten_A", ["fr", "fr", "de", null, "es"]);
    // Out of Everyone: no longer counted.
    seedPeople(db, "ten_A", [null], []);
    // Another brand's French readers are not ours.
    seedPeople(db, "ten_B", ["fr", "fr", "fr"]);

    const res = await languageReaders(A, brand(), { db, now: () => NOW });
    // Five in Everyone: two French, one German, and two (unknown, Spanish) counted as English.
    expect(res?.readers).toEqual({ en: 2, fr: 2, de: 1 });
    expect(db.raw("tenants", "ten_A")).toMatchObject({
      languageReaders: { at: new Date(NOW).toISOString(), list: ["en", "fr", "de"], everyone: 5, counts: { fr: 2, de: 1 } },
    });
  });

  it("uses the day's count, and counts again after a day or when the list changes", async () => {
    const db = new FakeFirestore();
    db.seed("tenants", "ten_A", {});
    seedPeople(db, "ten_A", ["fr", "fr"]);
    const kept = { at: new Date(NOW).toISOString(), list: ["en", "fr", "de"], everyone: 40, counts: { fr: 30, de: 0 } };

    const sameDay = await languageReaders(A, brand({ languageReaders: kept }), { db, now: () => NOW + 3_600_000 });
    expect(sameDay?.readers).toEqual({ en: 10, fr: 30, de: 0 });

    const nextDay = await languageReaders(A, brand({ languageReaders: kept }), { db, now: () => NOW + READERS_FRESH_MS + 1 });
    expect(nextDay?.readers).toEqual({ en: 0, fr: 2, de: 0 });

    const newList = await languageReaders(A, brand({ supportedLocales: ["en", "fr"], languageReaders: kept }), { db, now: () => NOW + 60_000 });
    expect(newList?.readers).toEqual({ en: 0, fr: 2 });
  });
});
