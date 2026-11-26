import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// Removals from brand search are forced whatever the switches say (ADR-0023): an in-memory index stands in.
vi.mock("@/lib/tenant/searchIndex", async (original) => (await import("@/lib/search/testing/memorySearch")).withMemorySearch(await original<object>()));
import { forTenant } from "@/lib/tenant";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { KnowledgeCollectionLike, TenantContext } from "@/lib/tenant/types";
import type { CompetitorArticle } from "@/lib/types/competitor";
import { questionKey as questionKeyOf } from "@/lib/brandMap/keys";
import { anglesBlock, competitorContext, questionsBlock, statsBlock } from "./planning";
import { brandMapRecords } from "@/lib/tenant/brandMapRecords";
import { BrandMapDecidedSchema } from "@/lib/types/brandMap";
import { ensureMoved } from "@/lib/brandMap/move";
import { decideProposals, proposedQuestion, proposedSubject } from "@/lib/brandMap/proposals";
import { addQuestion, createSubject } from "@/lib/brandMap/records";
import { saveBrandMap } from "@/lib/brandMap/store";
import { competitorCoverage } from "./coverage";
import { addTopicsFromRequest, subjectCompetitorsOf, subjectCompetitorsFromRequest, subjectFlagsFromRequest, theirQuestionsOf } from "./planningApi";
import { monitorCompetitor } from "./store";
import { MemorySearchIndex } from "@/lib/search/memoryStore";
import type { SearchStore } from "@/lib/search/types";

const A: TenantContext = { tenantId: "ten_A", region: "us", source: "system" };

const article = (id: string, competitorId: string, over: Partial<CompetitorArticle> = {}): Omit<CompetitorArticle, "id" | "tenantId"> =>
  ({
    competitorId,
    url: `https://rival.test/blog/${id}`,
    title: `Post ${id}`,
    publishedAt: "2026-11-02",
    queuedAt: "2026-11-17T00:00:00.000Z",
    status: "read",
    angle: `Angle ${id}`,
    question: `Question ${id}?`,
    format: "case_study",
    subjectIds: ["sub_forms"],
    asks: [{ kind: "demo", placement: "end", url: "https://rival.test/demo", text: "Demo" }],
    stats: [
      { figure: "3x", about: "their customers", quote: "", theirOwn: true, source: null },
      { figure: "2%", about: "average sign up rate", quote: "", theirOwn: false, source: { url: "https://research.example.org/r", domain: "research.example.org" } },
    ],
    ...over,
  }) as never;

let db: FakeFirestore;
let rival: string;

beforeEach(async () => {
  db = new FakeFirestore();
  const r = await monitorCompetitor(A, { website: "rival.test", name: "Rival" }, { db });
  if (!r.ok) throw new Error(r.error);
  rival = r.value.competitor.id;
  const repo = forTenant(A, db).competitorArticles;
  await repo.create("a1", article("a1", rival));
  await repo.create("a2", article("a2", rival, { subjectIds: [], angle: "Near by meaning" }));
  await repo.create("a3", article("a3", "cmp_gone0001"));
  vi_env(true);
});
afterEach(() => vi_env(false));

function vi_env(on: boolean) {
  for (const k of ["COMPETITORS_ENABLED", "COMPETITOR_ARTICLES_ENABLED", "COMPETITOR_ARTICLES_PLANNING_ENABLED"]) {
    if (on) process.env[k] = "true";
    else delete process.env[k];
  }
}

const vectors = (refs: string[]): KnowledgeCollectionLike => {
  const rows = refs.map((ref) => ({ tenantId: "ten_A", kind: "competitor_article", ref, status: "kept", _distance: 0.1 }));
  const v: KnowledgeCollectionLike = {
    where: () => v,
    findNearest: () => ({ get: async () => ({ empty: false, size: rows.length, docs: rows.map((r, i) => ({ id: `v${i}`, data: () => r })) }) }),
  };
  return v;
};

describe("competitorContext", () => {
  const deps = () => ({ db, canUse: async () => true, vectors: vectors(["a2"]), query: async () => [1, 0] });

  it("is nothing with the planning switch off, or for a brand without the feature", async () => {
    delete process.env.COMPETITOR_ARTICLES_PLANNING_ENABLED;
    expect(await competitorContext(A, { subjectId: "sub_forms", text: "forms" }, deps())).toBeNull();
    process.env.COMPETITOR_ARTICLES_PLANNING_ENABLED = "true";
    expect(await competitorContext(A, { subjectId: "sub_forms", text: "forms" }, { ...deps(), canUse: async () => false })).toBeNull();
  });

  it("gives the angles nearest first, then the subject's, from competitors still watched, and only outside numbers", async () => {
    const c = await competitorContext(A, { subjectId: "sub_forms", text: "forms" }, deps());
    expect(c?.angles.map((a) => a.angle)).toEqual(["Near by meaning", "Angle a1"]);
    expect(c?.stats).toEqual([{ figure: "2%", about: "average sign up rate", url: "https://research.example.org/r", domain: "research.example.org" }]);
    expect(anglesBlock(c)).toBe("- Rival (case study, 2026-11-02): Near by meaning\n- Rival (case study, 2026-11-02): Angle a1");
    expect(questionsBlock(c)).toBe("- Question a2?\n- Question a1?");
    expect(statsBlock(c)).toBe("- 2% (average sign up rate): https://research.example.org/r");
  });
});

describe("on brand search (ADR-0023)", () => {
  afterEach(() => vi.unstubAllEnvs());
  /** The same fixtures as brand search keeps them: a2 near by meaning, and the competitor's summary right on top of it. */
  async function index(): Promise<SearchStore> {
    const store = new MemorySearchIndex().storeFor(A);
    const put = async (ref: string, status: "kept" | undefined, v: number[]) =>
      store.putSource(
        { sourceKey: `competitor:${ref}`, kind: "competitor", ref, hash: "h", chunks: 1, embedded: true, indexedAt: "", ...(status ? { status } : {}) },
        [{ tenantId: "ten_A", kind: "competitor", ref, sourceKey: `competitor:${ref}`, chunk: 0, title: ref, text: ref, url: "", lang: "en", updatedAt: "", ...(status ? { status } : {}), embedding: v }],
        0,
      );
    await put(`${rival}/a2`, "kept", [1, 0]);
    await put(`${rival}/a1`, "kept", [0, 1]);
    await put(rival, undefined, [1, 0]);
    return store;
  }
  const on = () => {
    for (const k of ["SEARCH_INDEX_ENABLED", "SEARCH_FAMILY_INDEX_ENABLED", "SEARCH_COMPETITOR_READS_ENABLED"]) vi.stubEnv(k, "true");
  };

  it("gives the same angles with reads on, from brand search alone", async () => {
    on();
    const search = await index();
    const embedSearch = vi.fn(async (items: unknown[]) => items.map(() => [1, 0]));
    const old = vi.fn();
    const c = await competitorContext(A, { subjectId: "sub_forms", text: "forms" }, { db, canUse: async () => true, search, embedSearch, vectors: { where: () => ({}) as never, findNearest: old } as never, query: vi.fn() });
    expect(c?.angles.map((a) => a.angle)).toEqual(["Near by meaning", "Angle a1"]);
    expect(old).not.toHaveBeenCalled();
  });

  it("names the questions no article covers with reads on, never counting a competitor's summary", async () => {
    on();
    process.env.CREATE_SUGGEST_ANGLE_ENABLED = "true";
    const search = await index();
    const questions = async () => [
      { id: "q1", text: "Covered by them?", status: "decided" },
      { id: "q2", text: "Nobody answers this?", status: "decided" },
    ];
    // q2 points where only a1 is, below the cut-off; the summary isn't an article.
    const embedSearch = vi.fn(async (items: Array<{ content: string }>) => items.map((i) => (i.content.startsWith("Covered") ? [1, 0] : [0.6, -0.8])));
    const res = await subjectCompetitorsFromRequest(A, "sub_forms", { db, canUse: async () => true, questions, search, embedSearch });
    expect((await res.json()).competitors).toMatchObject({ uncovered: ["q2"], suggestAngle: true });
    delete process.env.CREATE_SUGGEST_ANGLE_ENABLED;
  });
});

describe("planning API", () => {
  it("shows a subject's competitors, angles, outside numbers and the formats nobody used", async () => {
    const list = await forTenant(A, db).competitorArticles.find({});
    const v = subjectCompetitorsOf(list.filter((a) => a.subjectIds.includes("sub_forms")), new Map([[rival, { name: "Rival", site: "rival.test" }]]));
    expect(v).toMatchObject({
      total: 1,
      competitors: [{ name: "Rival", count: 1, formats: ["Case study"], asks: ["Book a demo"] }],
      angles: [{ competitor: "Rival", angle: "Angle a1" }],
      stats: [{ figure: "2%", domain: "research.example.org" }],
      nobodyHas: ["research", "a how to", "a comparison", "a guide"],
    });
  });

  it("takes one angle from each competitor first, and titles without the site's name", () => {
    const mk = (id: string, competitorId: string, title = `Post ${id}`) => ({ ...article(id, competitorId, { title }), id, tenantId: "ten_A" }) as CompetitorArticle;
    const names = new Map([
      [rival, { name: "Rival", site: "rival.test" }],
      ["cmp_other001", { name: "Other", site: "other.test" }],
    ]);
    const v = subjectCompetitorsOf([mk("r1", rival, "Post r1 | Rival"), mk("r2", rival), mk("r3", rival), mk("o1", "cmp_other001")], names);
    expect(v.angles.map((a) => a.competitor)).toEqual(["Rival", "Other", "Rival", "Rival"]);
    expect(v.competitors.find((c) => c.name === "Rival")?.latest.title).toBe("Post r1");
  });

  it("names the subject's questions none of their articles answer, and says when to suggest an angle", async () => {
    process.env.CREATE_SUGGEST_ANGLE_ENABLED = "true";
    // Only a question whose meaning points one way finds an article near it.
    const byMeaning: KnowledgeCollectionLike = {
      where: () => byMeaning,
      findNearest: (opts: { queryVector: number[] }) => ({
        get: async () => {
          const rows = opts.queryVector[0]! > 0.5 ? [{ tenantId: "ten_A", kind: "competitor_article", ref: "a1", status: "kept", _distance: 0.1 }] : [];
          return { empty: !rows.length, size: rows.length, docs: rows.map((r, i) => ({ id: `v${i}`, data: () => r })) };
        },
      }),
    } as unknown as KnowledgeCollectionLike;
    const questions = async () => [
      { id: "q1", text: "Covered by them?", status: "decided" },
      { id: "q2", text: "Nobody answers this?", status: "decided" },
      { id: "q3", text: "Only proposed?", status: "proposed" },
    ];
    const base = { db, canUse: async () => true, questions, vectors: byMeaning };
    const res = await subjectCompetitorsFromRequest(A, "sub_forms", { ...base, query: async (t: string) => (t.startsWith("Covered") ? [1, 0] : [0, 1]) });
    expect((await res.json()).competitors).toMatchObject({ total: 1, uncovered: ["q2"], suggestAngle: true });
    // Meaning can't be checked: nothing is called uncovered by mistake.
    const down = await subjectCompetitorsFromRequest(A, "sub_forms", { ...base, query: async () => null });
    expect((await down.json()).competitors).toMatchObject({ uncovered: [] });
    delete process.env.CREATE_SUGGEST_ANGLE_ENABLED;
    const off = await subjectCompetitorsFromRequest(A, "sub_forms", { ...base, query: async () => [0, 1] });
    expect((await off.json()).competitors).toMatchObject({ uncovered: ["q1", "q2"], suggestAngle: false });
  });

  it("gives the subject list each subject's count only when the brand has it", async () => {
    const now = () => new Date("2026-11-17T12:00:00Z");
    delete process.env.COMPETITOR_ARTICLES_PLANNING_ENABLED;
    expect((await subjectFlagsFromRequest(A, { db, now, canUse: async () => true })).status).toBe(503);
    process.env.COMPETITOR_ARTICLES_PLANNING_ENABLED = "true";
    expect((await subjectFlagsFromRequest(A, { db, now, canUse: async () => false })).status).toBe(403);
    const ok = await subjectFlagsFromRequest(A, { db, now, canUse: async () => true });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ subjects: {} });
  });

  it("answers off, not included and bad input plainly", async () => {
    delete process.env.COMPETITOR_ARTICLES_PLANNING_ENABLED;
    expect((await subjectCompetitorsFromRequest(A, "sub_forms", { db, canUse: async () => true })).status).toBe(503);
    process.env.COMPETITOR_ARTICLES_PLANNING_ENABLED = "true";
    expect((await subjectCompetitorsFromRequest(A, "sub_forms", { db, canUse: async () => false })).status).toBe(403);
    expect((await subjectCompetitorsFromRequest(A, "../etc", { db, canUse: async () => true })).status).toBe(404);
    expect((await addTopicsFromRequest(A, { topics: [] }, { db, canUse: async () => true })).status).toBe(400);
  });

  it("takes only topics the page offered", async () => {
    const res = await addTopicsFromRequest(A, { topics: ["Something made up"] }, { db, canUse: async () => true });
    expect(await res.json()).toEqual({ mode: "suggested", filed: 0, already: [] });
  });
});

describe("adding topics they write about to the map", () => {
  const now = () => new Date("2026-11-17T12:00:00Z");
  const B: TenantContext = { tenantId: "ten_B", region: "us", source: "system" };

  beforeEach(async () => {
    process.env.BRAND_MAP_ENABLED = "true";
    process.env.BRAND_MAP_SCALE_ENABLED = "true";
    await saveBrandMap(A, { baseRev: 0, decided: BrandMapDecidedSchema.parse({ identity: { name: "Acme" } }) }, { db });
    const moved = await ensureMoved(A, { db });
    if (!moved.ok) throw new Error(moved.error);
    const repo = forTenant(A, db).competitorArticles;
    const topic = (id: string, newTopic: string, over: Partial<CompetitorArticle> = {}) =>
      repo.create(id, article(id, rival, { subjectIds: [], newTopic, format: "research", ...over }));
    await topic("t1", "Open Graph tags", { question: "Do AI engines read Open Graph tags?" });
    await topic("t2", "Open graph tags", { question: "Which Open Graph tags matter?", publishedAt: "2026-11-05" });
    await topic("t3", "Shop apps");
    await topic("t4", "Old idea");
    await topic("t5", "Company milestone announcement", { format: "news" });
    // Shop apps waits as a proposal; Old idea was dismissed.
    const store = brandMapRecords(A, db);
    const base = { from: "competitors" as const, reason: "", evidence: "", now: now().toISOString() };
    await proposedSubject(A, store, { ...base, name: "Shop apps" });
    const old = await proposedSubject(A, store, { ...base, name: "Old idea" });
    await decideProposals(A, { dismiss: { subjects: [old!.id] } }, { db });
  });
  afterEach(() => {
    delete process.env.BRAND_MAP_ENABLED;
    delete process.env.BRAND_MAP_SCALE_ENABLED;
  });

  it("says where each topic stands, and never offers their news", async () => {
    const view = await competitorCoverage(A, { db, now, canUse: async () => true });
    expect(view?.moved).toBe(true);
    expect(view?.notOnMap.map((t) => [t.topic, t.count, t.state])).toEqual([
      ["Open graph tags", 2, "new"],
      ["Shop apps", 1, "suggested"],
      ["Old idea", 1, "dismissed"],
    ]);
  });

  it("adds a new topic, accepts one waiting, brings back one dismissed, and their articles count on each", async () => {
    const topics = ["open graph tags", "Shop apps", "Old idea", "Company milestone announcement"];
    const res = await addTopicsFromRequest(A, { topics }, { db, now, canUse: async () => true });
    // Named as their newest article words it.
    expect(await res.json()).toEqual({ mode: "added", added: ["Open graph tags", "Shop apps", "Old idea"], already: [] });
    const subjects = await brandMapRecords(A, db).find("sub");
    expect(subjects.map((s) => [s.name, s.status]).sort()).toEqual([
      ["Old idea", "decided"],
      ["Open graph tags", "decided"],
      ["Shop apps", "decided"],
    ]);
    const view = await competitorCoverage(A, { db, now, canUse: async () => true });
    expect(view?.notOnMap).toEqual([]);
    expect(view?.added.map((t) => [t.topic, t.count])).toEqual([
      ["Open graph tags", 2],
      ["Old idea", 1],
      ["Shop apps", 1],
    ]);
    expect(view?.rows.find((r) => r.name === "Open graph tags")).toMatchObject({ they: 2, you: 0, flag: "gap" });
    // The articles it came from, in either wording, are on it now: its box finds them.
    const og = subjects.find((s) => s.name === "Open graph tags")!;
    const box = await subjectCompetitorsFromRequest(A, og.id, { db, canUse: async () => true, query: async () => null });
    expect((await box.json()).competitors).toMatchObject({ total: 2 });
    // Ticked again on a page drawn before: nothing new, and it says they're there.
    const again = await addTopicsFromRequest(A, { topics: ["Open Graph tags"] }, { db, now, canUse: async () => true });
    expect(await again.json()).toEqual({ mode: "added", added: [], already: ["Open graph tags"] });
    // Another brand's map is untouched.
    expect(await brandMapRecords(B, db).find("sub")).toEqual([]);
  });

  it("files suggestions on a small map, as before", async () => {
    process.env.BRAND_MAP_SCALE_ENABLED = "false";
    const res = await addTopicsFromRequest(A, { topics: ["Open Graph tags"] }, { db, now, canUse: async () => true });
    expect(await res.json()).toMatchObject({ mode: "suggested" });
  });

  it("finds a subject added elsewhere by its name, and offers their questions it doesn't have", async () => {
    // Added on Brand map › Subjects, not here: the article worded exactly as it is found.
    const made = await createSubject(A, { name: "Open Graph tags" }, { db });
    if (!made.ok) throw new Error(made.error);
    await addQuestion(A, made.value.id, { text: "Which Open Graph tags matter?" }, { db });
    const res = await subjectCompetitorsFromRequest(A, made.value.id, { db, canUse: async () => true, query: async () => null });
    const body = (await res.json()).competitors;
    expect(body.total).toBe(1);
    expect(body.theirQuestions).toEqual([{ text: "Do AI engines read Open Graph tags?", competitor: "Rival", url: "https://rival.test/blog/t1" }]);
    // The table counts both wordings on it.
    const view = await competitorCoverage(A, { db, now, canUse: async () => true });
    expect(view?.rows.find((r) => r.subjectId === made.value.id)).toMatchObject({ they: 2 });
  });
});

describe("a subject's box in one request", () => {
  beforeEach(() => {
    process.env.BRAND_MAP_ENABLED = "true";
    process.env.BRAND_MAP_SCALE_ENABLED = "true";
  });
  afterEach(() => {
    delete process.env.BRAND_MAP_ENABLED;
    delete process.env.BRAND_MAP_SCALE_ENABLED;
  });

  it("brings the subject's decided questions, open unless its last count found them answered, drafted or planned", async () => {
    const made = await createSubject(A, { name: "Forms" }, { db });
    if (!made.ok) throw new Error(made.error);
    const ids: string[] = [];
    for (const text of ["Answered one?", "Drafted one?", "Planned one?", "Still open?"]) {
      const q = await addQuestion(A, made.value.id, { text }, { db });
      if (!q.ok) throw new Error(q.error);
      ids.push(q.value.id);
    }
    const store = brandMapRecords(A, db);
    await proposedQuestion(A, store, { from: "research", reason: "", evidence: "", now: new Date().toISOString(), subjectId: made.value.id, text: "Only proposed?" });
    // What the last count found, kept on the subject: read as it is, never counted again here.
    await store.claim("sub", made.value.id, () => ({ answeredIds: [ids[0]], draftedIds: [ids[1]], plannedIds: [ids[2]] }));
    const res = await subjectCompetitorsFromRequest(A, made.value.id, { db, canUse: async () => true, query: async () => null });
    expect((await res.json()).competitors.questions).toEqual([
      { id: ids[0], text: "Answered one?", open: false },
      { id: ids[1], text: "Drafted one?", open: false },
      { id: ids[2], text: "Planned one?", open: false },
      { id: ids[3], text: "Still open?", open: true },
    ]);
    const after = await store.get("sub", made.value.id);
    expect(after?.answeredIds).toEqual([ids[0]]);
  });
});

describe("theirQuestionsOf", () => {
  it("keeps one per wording, from competitors still watched, at most five", () => {
    const names = new Map([[rival, { name: "Rival", site: "rival.test" }]]);
    const mk = (id: string, question: string, competitorId = rival) => ({ ...article(id, competitorId, { question }), id, tenantId: "ten_A" }) as CompetitorArticle;
    const list = [
      mk("q1", "What is a forms audit?"),
      mk("q2", "What is a  forms audit"),
      mk("q3", "Gone competitor's question?", "cmp_gone0001"),
      mk("q4", "Already ours?"),
      ...["a", "b", "c", "d", "e"].map((x) => mk(`m${x}`, `More ${x}?`)),
    ];
    const out = theirQuestionsOf(list, names, new Set([questionKeyOf("Already ours?")]));
    expect(out.map((q) => q.text)).toEqual(["What is a forms audit?", "More a?", "More b?", "More c?", "More d?"]);
  });
});
