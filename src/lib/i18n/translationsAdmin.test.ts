import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { forTenant } from "@/lib/tenant";
import { updateTenantConfig } from "@/lib/tenant/control";
import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import { publishLifecycleJourney, saveLifecycleDraft } from "@/lib/lifecycle/service";
import { T0, TENANT_ID, ctx, publishOnboarding, seedWorld, system } from "@/lib/lifecycle/testing/fixtures";
import type { TranslateInput, TranslateResult } from "./translate";
import { runTranslations } from "./translationsTick";
import { translationsAction, translationsToCheck, translationsView, type TabView } from "./translationsAdmin";

/** The language tabs and their actions (ASSET_TRANSLATIONS_ENABLED). The model is a stand-in. */

const fs = (db: FakeFirestore) => db as unknown as FirestoreLike;
const admin = { ...ctx, userId: "usr_admin", role: "admin" } as TenantContext;

function on() {
  vi.stubEnv("ASSET_TRANSLATIONS_ENABLED", "true");
  vi.stubEnv("LANGUAGE_READERS_ENABLED", "true");
  vi.stubEnv("CONTENT_LANGUAGE_ENABLED", "true");
  vi.stubEnv("AUDIENCE_PERSON_LINKS_ENABLED", "true");
}
beforeEach(() => {
  vi.unstubAllEnvs();
  on();
});
afterEach(() => vi.unstubAllEnvs());

const french = async (input: TranslateInput): Promise<TranslateResult> => ({
  ok: true,
  tries: 1,
  fields: { subject: `FR ${input.words.subject}`, previewText: input.words.previewText ? `FR ${input.words.previewText}` : input.words.previewText, body: `FR ${input.words.body}` },
});

/** English and French (3 readers), German (1 reader), a threshold of 2; translations made. */
async function world() {
  const db = new FakeFirestore();
  seedWorld(db);
  await updateTenantConfig(
    TENANT_ID,
    {
      defaultLocale: "en",
      supportedLocales: ["en", "fr", "de"],
      languageSettings: { minReaders: 2 },
      languageReaders: { at: new Date().toISOString(), list: ["en", "fr", "de"], everyone: 6, counts: { fr: 3, de: 1 } },
    },
    fs(db),
  );
  const { journey } = await publishOnboarding(db, { nowMs: T0 });
  for (let i = 0; i < 20; i += 1) {
    await runTranslations({ deadlineMs: Date.now() + 600_000 }, { db: fs(db), translate: french, log: () => {} });
    if ((await forTenant(system, db).translations.find({ where: [["state", "==", "queued"]] })).length === 0) break;
  }
  const view = async () => (await translationsView(ctx, journey.id, fs(db))).body as {
    allowed: boolean;
    languages: Array<{ code: string; readers: number; ready: boolean; more: number }>;
    emails: Array<{ poolId: string; itemId: string; tabs: TabView[] }>;
  };
  const act = (input: unknown, who: TenantContext = admin) => translationsAction(who, journey.id, input, fs(db));
  return { db, journey, view, act, repo: forTenant(system, db) };
}

const tab = (v: Awaited<ReturnType<Awaited<ReturnType<typeof world>>["view"]>>, lang: string, i = 0) => v.emails[i]!.tabs.find((t) => t.lang === lang)!;

describe("the language tabs", () => {
  it("shows French to check and German not made, with each language's readers", async () => {
    const w = await world();
    const v = await w.view();
    expect(v.allowed).toBe(true);
    expect(v.languages).toEqual([
      expect.objectContaining({ code: "fr", readers: 3, ready: true, more: 0 }),
      expect.objectContaining({ code: "de", readers: 1, ready: false, more: 1 }),
    ]);
    expect(tab(v, "fr")).toMatchObject({ state: "to_check", rev: 1 });
    expect(tab(v, "fr").draft?.fields.subject.startsWith("FR ")).toBe(true);
    expect(tab(v, "de")).toMatchObject({ state: "not_made", rev: null });
  });

  it("is 503 while the switch is off", async () => {
    const w = await world();
    vi.unstubAllEnvs();
    expect((await translationsView(ctx, w.journey.id, fs(w.db))).status).toBe(503);
    expect((await w.act({ action: "make" })).status).toBe(503);
  });

  it("is 404 for another brand's journey", async () => {
    const w = await world();
    const other = { tenantId: "ten_other", region: "eu", source: "idtoken" } as TenantContext;
    w.db.seed("tenants", "ten_other", { tenantName: "Other", status: "active", region: "eu" });
    expect((await translationsView(other, w.journey.id, fs(w.db))).status).toBe(404);
    expect((await translationsAction(other, w.journey.id, { action: "make" }, fs(w.db))).status).toBe(404);
  });
});

describe("approving", () => {
  it("approves what the person saw, and refuses a rev that moved", async () => {
    const w = await world();
    const fr = tab(await w.view(), "fr");
    expect((await w.act({ action: "approve", id: fr.id, rev: fr.rev! + 1 })).status).toBe(409);
    expect((await w.act({ action: "approve", id: fr.id, rev: fr.rev })).body).toEqual({ approved: 1 });
    const after = tab(await w.view(), "fr");
    expect(after).toMatchObject({ state: "approved", draft: null });
    expect(after.approved).toMatchObject({ from: "en", approvedBy: "usr_admin" });
  });

  it("approves all the journey's French at once, from Review's list", async () => {
    const w = await world();
    const [row] = await translationsToCheck(ctx, fs(w.db));
    expect(row).toMatchObject({ journeyId: w.journey.id, langs: ["fr"] });
    const res = await w.act({ action: "approve_all", revs: row!.revs });
    expect(res.body).toEqual({ approved: Object.keys(row!.revs).length, skipped: 0 });
    expect(await translationsToCheck(ctx, fs(w.db))).toEqual([]);
  });

  it("refuses a translation of words that are no longer the published ones", async () => {
    const w = await world();
    const fr = tab(await w.view(), "fr");
    const journey = (await w.repo.lifecycleJourneys.getById(w.journey.id))!;
    const pools = journey.draft.pools.map((p) => ({ ...p, items: p.items.map((it) => ({ ...it, subject: `${it.subject} (new)` })) }));
    await saveLifecycleDraft(ctx, journey.id, { ...journey.draft, pools }, { db: w.db });
    await publishLifecycleJourney(ctx, journey.id, { db: w.db });
    expect((await w.act({ action: "approve", id: fr.id, rev: fr.rev })).body).toEqual({ error: "out_of_date" });
  });

  it("says an approved email changed in the draft updates when published", async () => {
    const w = await world();
    const fr = tab(await w.view(), "fr");
    await w.act({ action: "approve", id: fr.id, rev: fr.rev });
    const journey = (await w.repo.lifecycleJourneys.getById(w.journey.id))!;
    const pools = journey.draft.pools.map((p) => ({ ...p, items: p.items.map((it) => ({ ...it, subject: `${it.subject} (new)` })) }));
    await saveLifecycleDraft(ctx, journey.id, { ...journey.draft, pools }, { db: w.db });
    expect(tab(await w.view(), "fr").state).toBe("changed");
  });
});

describe("a person's own words", () => {
  it("saves them as the draft to check, kept apart from the model's", async () => {
    const w = await world();
    const fr = tab(await w.view(), "fr");
    const fields = { ...fr.draft!.fields, subject: fr.draft!.fields.subject.replace("FR ", "Notre ") };
    expect((await w.act({ action: "save", id: fr.id, rev: fr.rev, fields })).body).toEqual({ saved: true });
    const after = tab(await w.view(), "fr");
    expect(after).toMatchObject({ state: "to_check", rev: fr.rev! + 1 });
    expect(after.draft).toMatchObject({ by: "person", fields });
  });

  it("refuses words that lose a merge token", async () => {
    const w = await world();
    const fr = tab(await w.view(), "fr");
    const withToken = (await w.view()).emails.map((e) => tab({ emails: [e] } as never, "fr")).find((t) => /\{\{/.test(t.draft!.fields.body))!;
    const fields = { ...withToken.draft!.fields, body: withToken.draft!.fields.body.replace(/\{\{[^}]*\}\}/g, "") };
    expect((await w.act({ action: "save", id: withToken.id, rev: withToken.rev, fields })).body).toEqual({ error: "tokens_changed" });
    expect(fr.state).toBe("to_check");
  });
});

describe("making versions", () => {
  it("makes a language under the threshold when asked, and needs the feature", async () => {
    const w = await world();
    expect((await w.act({ action: "make", lang: "de" })).body).toMatchObject({ queued: expect.any(Number) });
    expect(tab(await w.view(), "de").state).toBe("translating");
    expect((await w.db.raw("tenants", TENANT_ID))?.translationsQueuedAt).toBeTruthy();
    expect((await w.act({ action: "make", lang: "en" })).body).toEqual({ error: "not_in_your_languages" });
    vi.stubEnv("GRANTED_ONLY_FEATURES", "translations");
    expect((await w.act({ action: "make", lang: "de" })).status).toBe(403);
  });

  it("refuses bad input", async () => {
    const w = await world();
    expect((await w.act({ action: "approve" })).status).toBe(400);
    expect((await w.act({ action: "nope" })).status).toBe(400);
  });
});

describe("Review", () => {
  it("lists one row a journey, with Approve all languages for admins only", async () => {
    const w = await world();
    const { translationReviewItems } = await import("./translationsAdmin");
    const [row] = await translationReviewItems(admin, fs(w.db));
    expect(row).toMatchObject({ kind: "translation_check", title: "Email · Onboarding", href: `/admin/lifecycle/${w.journey.id}`, action: "Open" });
    expect(row!.detail).toMatch(/^Français to check, \d+ emails$/);
    expect(Object.keys(row!.approveLanguages!.revs).length).toBeGreaterThan(0);
    const member = { ...admin, role: "member" } as TenantContext;
    expect((await translationReviewItems(member, fs(w.db)))[0]!.approveLanguages).toBeUndefined();
    vi.unstubAllEnvs();
    expect(await translationReviewItems(admin, fs(w.db))).toEqual([]);
  });
});
