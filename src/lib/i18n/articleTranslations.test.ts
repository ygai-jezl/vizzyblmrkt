import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import { articleTranslationsAction, articleTranslationsView, forgetPlanTranslations, queueArticleTranslations, type ArticleTranslationsView } from "./articleTranslations";
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

describe("an article's language tabs", () => {
  beforeEach(() => vi.unstubAllEnvs());
  afterEach(() => vi.unstubAllEnvs());
  const PLANS = "workspaces/ws1/content_plans";
  const admin = { ...A, source: "idtoken", userId: "usr_admin", role: "admin" } as TenantContext;

  /** A brand, its approved article stored, its French version made and waiting to be checked. */
  async function world() {
    pagesOn();
    const db = new FakeFirestore();
    brand(db);
    const plan = approvedPlan();
    db.seed(PLANS, plan.id, plan);
    await queue(db, plan);
    const made = async (input: ArticleTranslateInput): Promise<ArticleTranslateResult> => ({ ok: true, tries: 1, fields: { ...input.words, metaTitle: "Titre" } });
    await runTranslations({ deadlineMs: NOW + 95_000 }, { db: db as unknown as FirestoreLike, now: () => NOW, translateArticle: made, log: () => {} });
    const fdb = db as unknown as FirestoreLike;
    const view = async () => (await articleTranslationsView(admin, "ws1", plan.id, fdb, () => NOW)).body as ArticleTranslationsView;
    const act = (input: unknown) => articleTranslationsAction(admin, "ws1", plan.id, input, fdb);
    return { db, plan, view, act };
  }

  it("shows French to check, at its address, and German not made: ready, but no folder", async () => {
    const w = await world();
    const v = await w.view();
    expect(v).toMatchObject({ allowed: true, approved: true, base: { code: "en", address: "https://acme.example/blog/visibility" } });
    expect(v.versions.find((x) => x.lang === "fr")).toMatchObject({ state: "to_check", rev: 1, address: "https://acme.example/fr/blog/ai-visibility", draft: { fields: { metaTitle: "Titre" } } });
    expect(v.versions.find((x) => x.lang === "de")).toMatchObject({ state: "not_made", ready: true, folder: null });
  });

  it("approves what the person saw, refuses a rev that moved, and says when the article changed since", async () => {
    const w = await world();
    const fr = (await w.view()).versions.find((x) => x.lang === "fr")!;
    expect((await w.act({ action: "approve", id: fr.id, rev: fr.rev! + 1 })).status).toBe(409);
    expect((await w.act({ action: "approve", id: fr.id, rev: fr.rev })).body).toEqual({ approved: 1 });
    expect((await w.view()).versions.find((x) => x.lang === "fr")!.state).toBe("approved");
    // The article is edited and not approved yet: the French is out of step until it is.
    const hub = { ...w.plan.graph.nodes[0]!, body: `${w.plan.graph.nodes[0]!.body}\n\nOne more line.`, status: "generated" as const };
    w.db.seed(PLANS, w.plan.id, { ...w.plan, graph: { ...w.plan.graph, nodes: [hub] } });
    expect((await w.view()).versions.find((x) => x.lang === "fr")!.state).toBe("changed");
  });

  it("saves a person's own words but keeps the article's links, and sets a version's address", async () => {
    const w = await world();
    const fr = (await w.view()).versions.find((x) => x.lang === "fr")!;
    const fields = { ...fr.draft!.fields, metaTitle: "Notre titre" };
    expect((await w.act({ action: "save", id: fr.id, rev: fr.rev, fields: { ...fields, body: fields.body.replace("https://acme.example/pricing", "https://acme.example/fr/tarifs") } })).body).toEqual({ error: "links_changed" });
    expect((await w.act({ action: "save", id: fr.id, rev: fr.rev, fields })).body).toEqual({ saved: true });
    expect((await w.act({ action: "address", id: fr.id, address: "http://acme.example/fr/x" })).status).toBe(400);
    expect((await w.act({ action: "address", id: fr.id, address: "https://acme.example/fr/blog/visibilite" })).status).toBe(200);
    expect((await w.view()).versions.find((x) => x.lang === "fr")).toMatchObject({ address: "https://acme.example/fr/blog/visibilite", draft: { by: "person" } });
  });

  it("makes a language under its rules when asked, and needs the brand's feature to", async () => {
    const w = await world();
    expect((await w.act({ action: "make", lang: "de" })).body).toEqual({ queued: 1 });
    expect((await w.act({ action: "make", lang: "en" })).body).toEqual({ error: "not_in_your_languages" });
    vi.stubEnv("GRANTED_ONLY_FEATURES", "translations");
    expect((await w.act({ action: "make", lang: "de" })).status).toBe(403);
  });

  it("is 503 while the switch is off", async () => {
    const w = await world();
    vi.unstubAllEnvs();
    expect((await w.act({ action: "make", lang: "de" })).status).toBe(503);
  });
});
