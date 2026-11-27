import { describe, expect, it } from "vitest";
import { FakeFirestore } from "./testing/fakeFirestore";
import { forTenant } from "./repository";
import { clearTranslationsQueued, markTranslationsQueued, takeTranslationCall } from "./translations";
import type { TenantContext, FirestoreLike } from "./types";

/** The brand's translation mark and daily call count (ASSET_TRANSLATIONS_ENABLED). */

const fs = (db: FakeFirestore) => db as unknown as FirestoreLike;

describe("the brand's translations mark", () => {
  it("clears only the mark the lane read, so a newer publish keeps its work", async () => {
    const db = new FakeFirestore();
    db.seed("tenants", "ten_A", {});
    await markTranslationsQueued("ten_A", "2026-11-27T10:00:00.000Z", fs(db));
    await markTranslationsQueued("ten_A", "2026-11-27T10:05:00.000Z", fs(db));
    expect(await clearTranslationsQueued("ten_A", "2026-11-27T10:00:00.000Z", fs(db))).toBe(false);
    expect(db.raw("tenants", "ten_A")?.translationsQueuedAt).toBe("2026-11-27T10:05:00.000Z");
    expect(await clearTranslationsQueued("ten_A", "2026-11-27T10:05:00.000Z", fs(db))).toBe(true);
    expect(db.raw("tenants", "ten_A")?.translationsQueuedAt).toBeNull();
  });
});

describe("the daily translation calls", () => {
  it("allows the cap each day, then nothing until the next day", async () => {
    const db = new FakeFirestore();
    db.seed("tenants", "ten_A", {});
    expect(await takeTranslationCall("ten_A", "2026-11-27", 2, fs(db))).toBe(true);
    expect(await takeTranslationCall("ten_A", "2026-11-27", 2, fs(db))).toBe(true);
    expect(await takeTranslationCall("ten_A", "2026-11-27", 2, fs(db))).toBe(false);
    expect(db.raw("tenants", "ten_A")?.translationCalls).toEqual({ day: "2026-11-27", count: 2 });
    expect(await takeTranslationCall("ten_A", "2026-11-28", 2, fs(db))).toBe(true);
    expect(db.raw("tenants", "ten_A")?.translationCalls).toEqual({ day: "2026-11-28", count: 1 });
  });

  it("counts nothing for a brand that isn't there", async () => {
    expect(await takeTranslationCall("ten_gone", "2026-11-27", 5, fs(new FakeFirestore()))).toBe(false);
  });
});

describe("translations through forTenant", () => {
  it("never shows one brand's translations to another", async () => {
    const db = new FakeFirestore();
    db.seed("translations", "tr_j1_p1_e1_fr", { tenantId: "ten_B", journeyId: "j1", lang: "fr" });
    const a = forTenant({ tenantId: "ten_A", region: "us", source: "system" } as TenantContext, fs(db));
    expect(await a.translations.getById("tr_j1_p1_e1_fr")).toBeNull();
    expect(await a.translations.find({ where: [["journeyId", "==", "j1"]] })).toEqual([]);
  });
});
