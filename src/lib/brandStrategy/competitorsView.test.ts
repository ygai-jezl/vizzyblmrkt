import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { brandMapRecords } from "@/lib/tenant/brandMapRecords";
import type { TenantContext } from "@/lib/tenant/types";
import { situationKey } from "@/lib/brandMap/keys";
import { saveBrandMap } from "@/lib/brandMap/store";
import { monitorCompetitor } from "@/lib/competitors/store";
import { competitorsFromRequest, strategyCompetitorsView } from "./competitorsView";
import { saveProposal, type ProposedStrategy } from "./store";

// Made-up brands, competitors and articles.
const A: TenantContext = { tenantId: "ten_A", region: "us", source: "idtoken", userId: "usr_a", role: "member" };
const B: TenantContext = { ...A, tenantId: "ten_B" };
const NOW = new Date("2026-11-26T12:00:00.000Z");

const PROPOSAL: ProposedStrategy = {
  focusSituationIds: ["sit_aaaaaa02"],
  audiences: [],
  claims: [],
  isNotProposals: [],
  goal: null,
  watched: [],
  sources: ["identity"],
  made: { promptId: "brand.strategy_propose", version: 2, model: "test-model" },
};

function article(ctx: TenantContext, id: string, competitorId: string, over: Record<string, unknown> = {}) {
  return {
    tenantId: ctx.tenantId,
    competitorId,
    url: `https://rival.test/blog/${id}`,
    title: id,
    publishedAt: "2026-11-10",
    status: "read",
    problem: null,
    attempts: 1,
    leaseUntil: null,
    leaseId: null,
    queuedAt: "2026-11-10T00:00:00.000Z",
    readAt: "2026-11-11T00:00:00.000Z",
    readMonth: "2026-11",
    readBy: "direct",
    version: 3,
    summary: "",
    question: "",
    angle: "",
    newTopic: null,
    format: "guide",
    stage: "consideration",
    subjectIds: [],
    situationIds: ["sit_aaaaaa02"],
    audienceIds: [],
    reader: { roles: [], companies: "", pains: [] },
    words: 900,
    headings: [],
    stats: [],
    sources: [],
    links: [],
    asks: [],
    trust: { author: null, authorUrl: null, publishedAt: null, updatedAt: null, schemaTypes: [] },
    mentions: { you: [], others: [], products: [] },
    ...over,
  };
}

async function brand(ctx: TenantContext, db: FakeFirestore) {
  await saveBrandMap(
    { ...ctx, role: "admin" },
    { baseRev: 0, decided: { identity: { name: "Acme", statement: "AI visibility tracking" }, names: [{ id: "n_aaaaaaaa", name: "Bigsuite", kind: "alternative", aliases: [] }] } },
    { db, nowMs: NOW.getTime() },
  );
  const store = brandMapRecords(ctx, db);
  for (const [i, [id, text, q, answered]] of ([["sit_aaaaaa01", "Buyers now ask a chat assistant", 12, 3], ["sit_aaaaaa02", "An agency packages it into a retainer", 9, 0]] as const).entries()) {
    await store.create("sit", id, { status: "decided", from: "person", text, textKey: situationKey(text), rev: 0, order: i, counts: { questions: q, answered }, createdAt: "", updatedAt: "" });
  }
  const watched = await monitorCompetitor({ ...ctx, role: "admin" }, { website: "rival.test", name: "Rivalco" }, { db });
  if (!watched.ok) throw new Error(watched.error);
  return watched.value.competitor.id;
}

beforeEach(() => {
  for (const k of ["BRAND_MAP_ENABLED", "BRAND_STRATEGY_ENABLED", "COMPETITORS_ENABLED", "COMPETITOR_ARTICLES_ENABLED", "STRATEGY_COMPETITORS_ENABLED"]) vi.stubEnv(k, "true");
});
afterEach(() => vi.unstubAllEnvs());

describe("what the watched competitors write, against the strategy", () => {
  it("gives one line per competitor and the card for the draft's focus, from this brand's articles only", async () => {
    const db = new FakeFirestore();
    const id = await brand(A, db);
    const theirs = await brand(B, db);
    await saveProposal({ ...A, role: "admin" }, PROPOSAL, { db, now: () => NOW });
    db.seed("competitor_articles", `${id}_one`, article(A, "one", id, { stats: [{ figure: "4", about: "x", quote: "4", theirOwn: false, source: null }], mentions: { you: [], others: ["Bigsuite"], products: [] } }) as never);
    db.seed("competitor_articles", `${id}_two`, article(A, "two", id, { readBy: "google" }) as never);
    // Too old for the 90 days, though read this month.
    db.seed("competitor_articles", `${id}_old`, article(A, "old", id, { publishedAt: "2026-06-01" }) as never);
    db.seed("competitor_articles", `${theirs}_b`, article(B, "b", theirs) as never);
    const v = await strategyCompetitorsView(A, { db, now: () => NOW, loadTenant: async () => null });
    expect(v).toMatchObject({ articles: true, truncated: false });
    expect(v?.profiles).toEqual([
      { id, name: "Rivalco", read: 2, fromPage: 1, line: 'Mostly guides, for people weighing options. 1 stat, in the 1 of 2 read from their own pages. Most on "An agency packages it into a retainer".' },
    ]);
    expect(v?.against).toMatchObject({ from: "draft", approvedAt: null, onlyThem: 0, namedNotWatched: [{ name: "Bigsuite", count: 1 }] });
    expect(v?.against?.rows.map((r) => [r.text, r.they, `${r.answered} of ${r.questions}`, r.flag, r.newSince])).toEqual([["An agency packages it into a retainer", 2, "0 of 9", "gap", null]]);
  });

  it("says when their articles can't be read, and answers 403 to a brand without Competitors", async () => {
    const db = new FakeFirestore();
    await brand(A, db);
    vi.stubEnv("COMPETITOR_ARTICLES_ENABLED", "false");
    expect(await strategyCompetitorsView(A, { db, now: () => NOW, loadTenant: async () => null })).toEqual({ articles: false, days: 90, truncated: false, profiles: [], against: null });
    vi.stubEnv("GRANTED_ONLY_FEATURES", "competitors");
    const r = await competitorsFromRequest(A, { db, now: () => NOW, loadTenant: async () => null });
    expect(r.status).toBe(403);
    expect(await r.json()).toEqual({ error: "not_included" });
  });
});
