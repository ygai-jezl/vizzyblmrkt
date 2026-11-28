import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import { forgetPlanTranslations, queueArticleTranslations } from "./articleTranslations";
import { BlogArticleMetaSchema, type ContentPlan } from "@/lib/types/contentPlan";
import { sampleHub, samplePlan } from "@/lib/content/blog/testing/samplePlan";
import { isArticleTranslation, type ArticleTranslation } from "@/lib/types/translation";
import { runTranslations } from "./translationsTick";
import type { ArticleTranslateInput, ArticleTranslateResult } from "./translateArticle";
import { forTenant } from "@/lib/tenant";
/** An article's versions in other languages (PAGE_LANGUAGES_ENABLED). */

const A = { tenantId: "ten_A", region: "us", source: "system" } as TenantContext;

describe("deleting a plan", () => {
  it("removes its article versions, and nobody else's", async () => {
    const db = new FakeFirestore();
    db.seed("translations", "tra_plan1_hub_fr", { tenantId: "ten_A", kind: "article", planId: "plan1", lang: "fr" });
    db.seed("translations", "tra_plan2_hub_fr", { tenantId: "ten_A", kind: "article", planId: "plan2", lang: "fr" });
    db.seed("translations", "tra_plan1_hub_de", { tenantId: "ten_B", kind: "article", planId: "plan1", lang: "de" });
    await forgetPlanTranslations(A, "plan1", db as unknown as FirestoreLike);
    expect(db.raw("translations", "tra_plan1_hub_fr")).toBeUndefined();
    expect(db.raw("translations", "tra_plan2_hub_fr")).toBeTruthy();
    expect(db.raw("translations", "tra_plan1_hub_de")).toBeTruthy();
  });
});

// ---- Queueing on approval, and the lane making them ------------------------------------------------


const NOW = Date.parse("2026-11-28T09:00:00.000Z");

function pagesOn() {
  for (const n of ["PAGE_LANGUAGES_ENABLED", "ASSET_TRANSLATIONS_ENABLED", "LANGUAGE_READERS_ENABLED", "CONTENT_LANGUAGE_ENABLED", "AUDIENCE_PERSON_LINKS_ENABLED"]) vi.stubEnv(n, "true");
}

/** English with French (3 readers, a folder) and German (3 readers, no folder), threshold 2. */
function brand(db: FakeFirestore, over: Record<string, unknown> = {}) {
  db.seed("tenants", "ten_A", {
    tenantName: "Acme",
    rootDomain: "acme.example",
    status: "active",
    region: "us",
    allowedOrigins: [],
    billingTier: "pro",
    ownerId: "usr_1",
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    defaultLocale: "en",
    supportedLocales: ["en", "fr", "de"],
    languageSettings: { minReaders: 2, siteAddresses: { fr: "https://acme.example/fr/blog/" } },
    languageReaders: { at: new Date(NOW).toISOString(), list: ["en", "fr", "de"], everyone: 9, counts: { fr: 3, de: 3 } },
    ...over,
  });
}

const approvedPlan = (over: Partial<ContentPlan> = {}) =>
  samplePlan(over, sampleHub({ status: "approved", blog: { ...BlogArticleMetaSchema.parse({}), metaTitle: "What is AI search visibility monitoring?", slug: "ai-visibility" } }));

async function versions(db: FakeFirestore): Promise<ArticleTranslation[]> {
  return (await forTenant(A, db as unknown as FirestoreLike).translations.find({ where: [["planId", "==", "plan_1"]] })).filter(isArticleTranslation);
}

const queue = (db: FakeFirestore, plan: ContentPlan, extra: string[] = []) =>
  queueArticleTranslations(A, { workspaceId: "ws1", plan, node: plan.graph.nodes[0]!, extra, nowMs: NOW }, db as unknown as FirestoreLike);

describe("queueing an approved article's versions", () => {
  beforeEach(() => vi.unstubAllEnvs());
  afterEach(() => vi.unstubAllEnvs());

  it("queues each language with enough readers and a site folder, with the approved words and its address", async () => {
    pagesOn();
    const db = new FakeFirestore();
    brand(db);
    expect(await queue(db, approvedPlan())).toBe(1);
    const [fr] = await versions(db);
    expect(fr).toMatchObject({ lang: "fr", state: "queued", from: "en", address: "https://acme.example/fr/blog/ai-visibility", source: { metaTitle: "What is AI search visibility monitoring?" } });
    expect(db.raw("tenants", "ten_A")?.translationsQueuedAt).toBeTruthy();
  });

  it("queues nothing again for the same words, and again once they change", async () => {
    pagesOn();
    const db = new FakeFirestore();
    brand(db);
    const plan = approvedPlan();
    await queue(db, plan);
    expect(await queue(db, plan)).toBe(0);
    const edited = { ...plan, graph: { ...plan.graph, nodes: [{ ...plan.graph.nodes[0]!, blog: { ...plan.graph.nodes[0]!.blog!, metaTitle: "A new title" } }] } };
    expect(await queue(db, edited)).toBe(1);
    expect((await versions(db))[0]).toMatchObject({ state: "queued", rev: 1, source: { metaTitle: "A new title" } });
  });

  it("follows the languages chosen in Create, and Make anyway adds one", async () => {
    pagesOn();
    const db = new FakeFirestore();
    brand(db);
    expect(await queue(db, approvedPlan({ topology: { hubChannel: "blog", spokeChannels: [], languages: ["de"] } }))).toBe(1);
    expect((await versions(db)).map((v) => v.lang)).toEqual(["de"]);
    const none = new FakeFirestore();
    brand(none);
    expect(await queue(none, approvedPlan({ topology: { hubChannel: "blog", spokeChannels: [], languages: [] } }), ["de"])).toBe(1);
    expect((await versions(none))[0]).toMatchObject({ lang: "de", anyway: true, address: null });
  });

  it("does nothing for an article not approved, a brand with one language, or with the switch off", async () => {
    const db = new FakeFirestore();
    brand(db);
    expect(await queue(db, approvedPlan())).toBe(0);
    pagesOn();
    expect(await queue(db, samplePlan())).toBe(0);
    const one = new FakeFirestore();
    brand(one, { supportedLocales: ["en"] });
    expect(await queue(one, approvedPlan())).toBe(0);
  });
});

describe("the lane makes article versions", () => {
  beforeEach(() => vi.unstubAllEnvs());
  afterEach(() => vi.unstubAllEnvs());

  it("makes a queued article when a run has time for one, and keeps the draft to check", async () => {
    pagesOn();
    const db = new FakeFirestore();
    brand(db);
    await queue(db, approvedPlan());
    const translateArticle = vi.fn(
      async (input: ArticleTranslateInput): Promise<ArticleTranslateResult> => ({ ok: true, tries: 1, fields: { ...input.words, metaTitle: "Qu’est-ce que la visibilité ?" } }),
    );
    const deps = { db: db as unknown as FirestoreLike, now: () => NOW, translateArticle, log: () => {} };
    // Not enough time for an article: it waits.
    await runTranslations({ deadlineMs: NOW + 60_000 }, deps);
    expect(translateArticle).not.toHaveBeenCalled();
    expect(await runTranslations({ deadlineMs: NOW + 95_000 }, deps)).toMatchObject({ made: 1 });
    expect(translateArticle.mock.calls[0]![0]).toMatchObject({ from: "en", to: "fr", glossary: expect.arrayContaining(["Acme"]) });
    const [fr] = await versions(db);
    expect(fr).toMatchObject({ state: "to_check", rev: 1, draft: { by: "ai", fields: { metaTitle: "Qu’est-ce que la visibilité ?" } } });
    expect(db.raw("tenants", "ten_A")?.translationsQueuedAt).toBeNull();
  });

  it("keeps a failure's reason, and only a person asking tries it again", async () => {
    pagesOn();
    const db = new FakeFirestore();
    brand(db);
    const plan = approvedPlan();
    await queue(db, plan);
    const failing = vi.fn(async (): Promise<ArticleTranslateResult> => ({ ok: false, tries: 2, reason: "The article has a different number of sections." }));
    await runTranslations({ deadlineMs: NOW + 95_000 }, { db: db as unknown as FirestoreLike, now: () => NOW, translateArticle: failing, log: () => {} });
    expect((await versions(db))[0]).toMatchObject({ state: "failed", failReason: "The article has a different number of sections." });
    expect(await queue(db, plan)).toBe(0);
    expect(await queue(db, plan, ["fr"])).toBe(1);
  });
});
