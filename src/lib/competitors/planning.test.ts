import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { forTenant } from "@/lib/tenant";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { KnowledgeCollectionLike, TenantContext } from "@/lib/tenant/types";
import type { CompetitorArticle } from "@/lib/types/competitor";
import { anglesBlock, competitorContext, questionsBlock, statsBlock } from "./planning";
import { subjectCompetitorsOf, subjectCompetitorsFromRequest, subjectFlagsFromRequest, suggestTopicsFromRequest } from "./planningApi";
import { monitorCompetitor } from "./store";

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
    expect((await suggestTopicsFromRequest(A, { topics: [] }, { db, canUse: async () => true })).status).toBe(400);
  });

  it("files only topics the page offered", async () => {
    const res = await suggestTopicsFromRequest(A, { topics: ["Something made up"] }, { db, canUse: async () => true });
    expect(await res.json()).toEqual({ filed: 0 });
  });
});
