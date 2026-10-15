import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { failingFirestore } from "@/lib/tenant/testing/failingFirestore";
import type { KnowledgeCollectionLike, TenantContext } from "@/lib/tenant/types";
import { BrandMapDecidedSchema } from "@/lib/types/brandMap";
import { BrandMapPageFactsSchema } from "@/lib/types/brandMapPage";
import { withDerivedFacts } from "@/lib/content/blog/pageRow";
import { loadArticleMap, reconcileWithSavedMap } from "@/lib/content/blog/mapActions";
import { reconcileMapRefs } from "@/lib/content/blog/articleMap";
import { brandMapRecords } from "@/lib/tenant/brandMapRecords";
import { articleMapAtScale, mapQuestionsByWords } from "./articleScale";
import { ensureMoved } from "./move";
import { addQuestion, mergeSubjects, removeSubject } from "./records";
import { createSituation } from "./situations";
import { readBrandMap, saveBrandMap } from "./store";

const ctx: TenantContext = { tenantId: "ten_A", region: "us", source: "idtoken", userId: "u1", role: "admin" };
const NOW = Date.parse("2026-10-15T10:00:00.000Z");
const DECIDED = BrandMapDecidedSchema.parse({
  identity: { name: "Acme", category: "AI visibility tracking", site: "https://acme.example" },
  subjects: [
    { id: "sub_aaaaaaaa", name: "Share of voice", questions: [{ id: "q_aaaaaaaa", text: "What is share of voice?", intent: "definition" }, { id: "q_bbbbbbbb", text: "How is it measured?", intent: "benchmarks" }] },
    { id: "sub_bbbbbbbb", name: "Citations", questions: [{ id: "q_cccccccc", text: "Which sources do AI engines cite?", intent: "other" }] },
    { id: "sub_cccccccc", name: "Audits", questions: [] },
  ],
  names: [{ id: "n_aaaaaaaa", name: "Rivalco", kind: "alternative" }],
});

beforeEach(() => {
  vi.stubEnv("BRAND_MAP_ENABLED", "true");
  vi.stubEnv("BRAND_MAP_PAGES_ENABLED", "true");
  vi.stubEnv("BRAND_MAP_SCALE_ENABLED", "true");
  vi.stubEnv("CREATE_BLOG_BRAND_MAP_ENABLED", "true");
  vi.stubEnv("CREATE_BLOG_CITABLE_ENABLED", "true");
});
afterEach(() => vi.unstubAllEnvs());

async function moved() {
  const db = new FakeFirestore();
  await saveBrandMap(ctx, { baseRev: 0, decided: DECIDED }, { db, nowMs: NOW });
  await ensureMoved(ctx, { db, nowMs: NOW });
  return db;
}

describe("what an article sees of a map at any size", () => {
  it("reads the brand's names and the article's own subject, and its main question's, by id", async () => {
    const db = await moved();
    const map = await loadArticleMap(ctx, { db }, { ask: { subjectId: "sub_bbbbbbbb", primaryRef: "q_aaaaaaaa" } });
    expect(map?.identity.name).toBe("Acme");
    expect(map?.names.map((n) => n.name)).toEqual(["Rivalco"]);
    expect(map?.subjects.map((s) => [s.id, s.questions.map((q) => q.id)])).toEqual([
      ["sub_bbbbbbbb", ["q_cccccccc"]],
      ["sub_aaaaaaaa", ["q_aaaaaaaa", "q_bbbbbbbb"]],
    ]);
  });

  it("reads the article's buying situation by id, while situations are on", async () => {
    vi.stubEnv("BRAND_MAP_SITUATIONS_ENABLED", "true");
    const db = await moved();
    const sit = await createSituation(ctx, { text: "Our clicks from Google are falling", who: "Head of SEO", want: "Win them back" }, { db, nowMs: NOW, embed: { embed: async () => [] } });
    const id = sit.ok ? sit.value.id : "";
    const map = await loadArticleMap(ctx, { db }, { ask: { situationId: id } });
    expect(map?.situation).toEqual({ id, text: "Our clicks from Google are falling", who: "Head of SEO", want: "Win them back", feel: "", moment: "" });
    expect(map?.situations).toEqual([]);
    vi.stubEnv("BRAND_MAP_SITUATIONS_ENABLED", "false");
    const off = await loadArticleMap(ctx, { db }, { ask: { situationId: id } });
    expect(off).not.toHaveProperty("situation");
    expect(off).not.toHaveProperty("situations");
  });

  it("never loses a link from a partial map; lets one go only when the map says it's gone", async () => {
    const db = await moved();
    const brief = { subjectId: "sub_aaaaaaaa", primaryRef: "q_bbbbbbbb" };
    expect(await reconcileWithSavedMap(ctx, brief, { db })).toEqual(brief);
    await removeSubject(ctx, "sub_aaaaaaaa", { db, nowMs: NOW });
    expect(await reconcileWithSavedMap(ctx, brief, { db })).toEqual({});
  });

  it("with no subject chosen, offers the subjects nearest the article, and their open questions", async () => {
    const db = await moved();
    const read = await readBrandMap(ctx, db);
    const map = read.state === "ok" ? read.map : null;
    const near: KnowledgeCollectionLike = {
      where: () => near,
      findNearest: () => ({
        get: async () => ({
          empty: false,
          size: 1,
          docs: [{ id: "v0", data: () => ({ tenantId: "ten_A", kind: "subject", ref: "sub_bbbbbbbb", status: "decided", _distance: 0.1 }) }],
        }),
      }),
    };
    const article = await articleMapAtScale(ctx, map!, { ask: { text: "Where do AI answers get their sources?" }, pages: true }, { db, query: async () => [1, 0], vectors: near });
    expect(article.subjects.map((s) => s.name)).toEqual(["Citations"]);
    expect(article.answered).toEqual({});
  });

  it("works out the article's own subject's answers now, never counting the article itself", async () => {
    const db = await moved();
    const row = (id: string, over: Record<string, unknown>) =>
      db.seed("brand_map_pages", id, { ...withDerivedFacts(BrandMapPageFactsSchema.parse({ kind: "article", workspaceId: "ws1", planId: id, title: id, ...over })), tenantId: "ten_A", fingerprint: id, updatedAt: "" } as never);
    row("p_self", { state: "live", url: "https://acme.example/blog/self", liveAt: "2026-10-01T00:00:00.000Z", primaryRef: "q_aaaaaaaa", subjectId: "sub_aaaaaaaa" });
    row("p_other", { state: "draft", primaryRef: "q_bbbbbbbb", subjectId: "sub_aaaaaaaa" });
    const map = await loadArticleMap(ctx, { db }, { pages: true, planId: "self", ask: { subjectId: "sub_aaaaaaaa" } });
    expect(map?.answered).toEqual({ q_bbbbbbbb: expect.objectContaining({ state: "draft" }) });
  });

  it("finds map questions by their words anywhere on the map", async () => {
    const db = await moved();
    const subjects = await mapQuestionsByWords(ctx, ["Which sources do AI engines cite?", "Something new"], { db });
    expect(subjects.map((s) => s.id)).toEqual(["sub_bbbbbbbb"]);
  });

  it("keeps every link when reading the part close to the article fails", async () => {
    const db = await moved();
    // The questions can't be read (their index isn't ready yet, say).
    const broken = failingFirestore(db, { collections: ["brand_map_questions"] });
    const brief = { subjectId: "sub_aaaaaaaa", primaryRef: "q_bbbbbbbb" };
    const map = await loadArticleMap(ctx, { db: broken }, { ask: brief });
    expect(map).toMatchObject({ atScale: true, partial: true, subjects: [] });
    expect(reconcileMapRefs(brief, map!)).toEqual(brief);
    expect(await reconcileWithSavedMap(ctx, brief, { db: broken })).toEqual(brief);
  });

  it("keeps a link to a question added since the move when the switch is turned off", async () => {
    const db = await moved();
    const added = await addQuestion(ctx, "sub_aaaaaaaa", { text: "Which tools track share of voice?" }, { db, nowMs: NOW });
    const brief = { subjectId: "sub_aaaaaaaa", primaryRef: added.ok ? added.value.id : "" };
    vi.stubEnv("BRAND_MAP_SCALE_ENABLED", "false");
    const map = await loadArticleMap(ctx, { db });
    // The list kept from before the move: it doesn't have the question, and says so.
    expect(map?.subjects.find((x) => x.id === "sub_aaaaaaaa")?.questions.map((q) => q.id)).toEqual(["q_aaaaaaaa", "q_bbbbbbbb"]);
    expect(map?.partial).toBe(true);
    expect(reconcileMapRefs(brief, map!)).toEqual(brief);
    expect(await reconcileWithSavedMap(ctx, brief, { db })).toEqual(brief);
  });

  it("follows a merge: the subject and a question asked twice lead to where they went", async () => {
    const db = await moved();
    // "Citations" asks "What is share of voice?" too (research proposed it there; a person added it).
    const store = brandMapRecords(ctx, db);
    const { id: _id, tenantId: _t, ...asked } = (await store.get("q", "q_aaaaaaaa"))!;
    void _id;
    void _t;
    await store.create("q", "q_twintwin", { ...asked, subjectId: "sub_bbbbbbbb" });
    await mergeSubjects(ctx, { from: "sub_bbbbbbbb", into: "sub_aaaaaaaa" }, { db, nowMs: NOW });

    const moved1 = { subjectId: "sub_bbbbbbbb", primaryRef: "q_cccccccc" };
    const map1 = await loadArticleMap(ctx, { db }, { ask: moved1 });
    expect(map1?.aliases).toMatchObject({ sub_bbbbbbbb: "sub_aaaaaaaa" });
    expect(reconcileMapRefs(moved1, map1!)).toEqual({ subjectId: "sub_aaaaaaaa", primaryRef: "q_cccccccc" });

    const twin = { subjectId: "sub_bbbbbbbb", primaryRef: "q_twintwin" };
    const map2 = await loadArticleMap(ctx, { db }, { ask: twin });
    expect(map2?.aliases).toMatchObject({ sub_bbbbbbbb: "sub_aaaaaaaa", q_twintwin: "q_aaaaaaaa" });
    expect(reconcileMapRefs(twin, map2!)).toEqual({ subjectId: "sub_aaaaaaaa", primaryRef: "q_aaaaaaaa" });
  });
});
