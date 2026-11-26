import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { brandMapRecords } from "@/lib/tenant/brandMapRecords";
import type { TenantContext } from "@/lib/tenant/types";
import type { Tenant } from "@/lib/types/tenant";
import { situationKey } from "@/lib/brandMap/keys";
import { saveBrandMap } from "@/lib/brandMap/store";
import { monitorCompetitor } from "@/lib/competitors/store";
import { forTenant } from "@/lib/tenant";
import { brandStrategyDocId } from "@/lib/types/brandStrategy";
import { isCheckTick, runStrategyChecks } from "./check";
import { approveStrategy, dismissStrategyCheck, readBrandStrategyDoc, saveProposal, type ProposedStrategy } from "./store";

// Made-up brands, competitors and articles.
const ADMIN = (tenantId: string): TenantContext => ({ tenantId, region: "us", source: "idtoken", userId: `usr_${tenantId}`, email: `admin@${tenantId}.example.com`, role: "admin" });
const FOCUS = ["sit_aaaaaa01", "sit_aaaaaa02"];
const PROPOSAL: ProposedStrategy = {
  focusSituationIds: FOCUS,
  audiences: [],
  claims: [],
  isNotProposals: [],
  goal: null,
  watched: [],
  sources: ["identity"],
  made: { promptId: "brand.strategy_propose", version: 2, model: "test-model" },
};

/** The first check tick at or after a moment. */
function checkTickFrom(iso: string): Date {
  let ms = Math.floor(Date.parse(iso) / 120_000) * 120_000;
  while (!isCheckTick(ms)) ms += 120_000;
  return new Date(ms + 1_000);
}
const APPROVED_AT = new Date("2026-11-02T09:00:00.000Z");
const T1 = checkTickFrom("2026-11-26T12:00:00.000Z");
const tenantRow = (id: string) => ({ id, region: "us", status: "active", name: id }) as unknown as Tenant;

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

/** A brand with its map, two decided situations and one watched competitor; approved when asked. */
async function brand(tenantId: string, db: FakeFirestore, opts: { approve: boolean; articles?: number }) {
  const ctx = ADMIN(tenantId);
  await saveBrandMap(ctx, { baseRev: 0, decided: { identity: { name: "Acme", statement: "AI visibility tracking" }, names: [] } }, { db, nowMs: APPROVED_AT.getTime() });
  const store = brandMapRecords(ctx, db);
  for (const [i, [id, text, q, answered]] of ([["sit_aaaaaa01", "Buyers now ask a chat assistant", 12, 3], ["sit_aaaaaa02", "An agency packages it into a retainer", 9, 2]] as const).entries()) {
    await store.create("sit", id, { status: "decided", from: "person", text, textKey: situationKey(text), rev: 0, order: i, counts: { questions: q, answered }, createdAt: "", updatedAt: "" });
  }
  const watched = await monitorCompetitor(ctx, { website: "rival.test", name: "Rivalco" }, { db });
  if (!watched.ok) throw new Error(watched.error);
  const id = watched.value.competitor.id;
  for (let i = 0; i < (opts.articles ?? 0); i++) db.seed("competitor_articles", `${id}_${i}`, article(ctx, `a${i}`, id) as never);
  if (opts.approve) {
    const made = await saveProposal(ctx, PROPOSAL, { db, now: () => APPROVED_AT });
    if (!made.ok) throw new Error(made.error);
    const done = await approveStrategy(ctx, { baseRev: made.value.rev }, { db, now: () => APPROVED_AT });
    if (!done.ok) throw new Error(done.error);
  }
  return { ctx, id };
}

const run = (db: FakeFirestore, ids: string[], now: Date) =>
  runStrategyChecks({ deadlineMs: Date.now() + 60_000 }, { db, now: () => now, listTenants: async () => ids.map(tenantRow) });

beforeEach(() => {
  for (const k of ["BRAND_MAP_ENABLED", "BRAND_STRATEGY_ENABLED", "COMPETITORS_ENABLED", "COMPETITOR_ARTICLES_ENABLED", "STRATEGY_COMPETITORS_ENABLED", "STRATEGY_CHECK_ENABLED"]) vi.stubEnv(k, "true");
});
afterEach(() => vi.unstubAllEnvs());

describe("the weekly strategy check", () => {
  it("does nothing with its switch off, or between check ticks", async () => {
    const db = new FakeFirestore();
    await brand("ten_A", db, { approve: true, articles: 3 });
    vi.stubEnv("STRATEGY_CHECK_ENABLED", "false");
    expect(await run(db, ["ten_A"], T1)).toEqual({ brands: 0, open: 0, failed: 0 });
    vi.stubEnv("STRATEGY_CHECK_ENABLED", "true");
    expect(await run(db, ["ten_A"], new Date(T1.getTime() + 120_000))).toEqual({ brands: 0, open: 0, failed: 0 });
  });

  it("opens one row for 3 new articles on a focus situation, without moving the strategy's revision, and looks again in a week", async () => {
    const db = new FakeFirestore();
    const { ctx } = await brand("ten_A", db, { approve: true, articles: 3 });
    const rev = (await readBrandStrategyDoc(ctx, { db }))!.rev;
    expect(await run(db, ["ten_A"], T1)).toEqual({ brands: 1, open: 1, failed: 0 });
    const doc = (await readBrandStrategyDoc(ctx, { db }))!;
    expect(doc.rev).toBe(rev);
    expect(doc.check).toMatchObject({
      since: "2026-11-03",
      lookedAt: T1.toISOString(),
      nextAt: new Date(T1.getTime() + 7 * 86_400_000).toISOString(),
      open: { reasons: [{ kind: "new_articles", ref: "sit_aaaaaa02", count: 3, by: [{ name: "Rivalco", count: 3 }] }], actedAt: null },
    });
    expect(doc.check?.focus.map((f) => [f.id, f.they, f.newSince])).toEqual([
      ["sit_aaaaaa01", 0, 0],
      ["sit_aaaaaa02", 3, 3],
    ]);
    // Not due again until next week.
    expect(await run(db, ["ten_A"], checkTickFrom(new Date(T1.getTime() + 60 * 60_000).toISOString()))).toEqual({ brands: 0, open: 0, failed: 0 });
  });

  it("looks only at brands with an approved strategy and their articles, and leaves another brand's record alone", async () => {
    const db = new FakeFirestore();
    await brand("ten_A", db, { approve: true, articles: 1 });
    const draftOnly = await brand("ten_B", db, { approve: false, articles: 3 });
    await saveProposal(draftOnly.ctx, PROPOSAL, { db, now: () => APPROVED_AT });
    await brand("ten_C", db, { approve: true, articles: 3 });
    vi.stubEnv("GRANTED_ONLY_FEATURES", "competitor_articles");
    expect(await run(db, ["ten_A", "ten_B", "ten_C"], T1)).toEqual({ brands: 0, open: 0, failed: 0 });
    vi.stubEnv("GRANTED_ONLY_FEATURES", "");
    expect(await run(db, ["ten_A", "ten_B", "ten_C"], T1)).toEqual({ brands: 2, open: 1, failed: 0 });
    expect((await readBrandStrategyDoc(draftOnly.ctx, { db }))!.check).toBeNull();
    expect((await readBrandStrategyDoc(ADMIN("ten_A"), { db }))!.check).toMatchObject({ open: null, lookedAt: T1.toISOString() });
  });

  it("looks at 3 brands a run at most, the one waiting longest first", async () => {
    const db = new FakeFirestore();
    const ids = ["ten_A", "ten_B", "ten_C", "ten_D"];
    for (const id of ids) await brand(id, db, { approve: true });
    // Each was due a look at a different time: D longest ago, then C, B and A.
    for (const [i, id] of ids.entries()) {
      await forTenant(ADMIN(id), db).brandStrategy.claim(brandStrategyDocId(id), (cur) => ({ check: { ...((cur as Record<string, unknown>).check as object), nextAt: new Date(T1.getTime() - (i + 1) * 86_400_000).toISOString() } }));
    }
    expect(await run(db, ids, T1)).toMatchObject({ brands: 3 });
    const looked = async (id: string) => (await readBrandStrategyDoc(ADMIN(id), { db }))!.check?.lookedAt ?? null;
    expect(await Promise.all(ids.map(looked))).toEqual([null, T1.toISOString(), T1.toISOString(), T1.toISOString()]);
    const next = checkTickFrom(new Date(T1.getTime() + 60_000).toISOString());
    expect(await run(db, ids, next)).toMatchObject({ brands: 1 });
    expect(await looked("ten_A")).toBe(next.toISOString());
  });
});

describe("what people do with the row", () => {
  it("Dismiss closes it for 30 days and keeps the decision, without moving the revision", async () => {
    const db = new FakeFirestore();
    const { ctx } = await brand("ten_A", db, { approve: true, articles: 3 });
    await run(db, ["ten_A"], T1);
    const before = (await readBrandStrategyDoc(ctx, { db }))!;
    expect(await dismissStrategyCheck(ctx, { db, now: () => T1 })).toBe(true);
    const doc = (await readBrandStrategyDoc(ctx, { db }))!;
    expect(doc.rev).toBe(before.rev);
    expect(doc.check).toMatchObject({ open: null, dismissedUntil: new Date(T1.getTime() + 30 * 86_400_000).toISOString(), since: "2026-11-27" });
    expect(doc.decisions[0]).toMatchObject({ kind: "check_dismissed", ref: before.check!.open!.key, after: "new_articles sit_aaaaaa02 3", by: "admin@ten_A.example.com" });
    // Nothing open: nothing to dismiss.
    expect(await dismissStrategyCheck(ctx, { db, now: () => T1 })).toBe(false);
  });

  it("a Propose while it is open is kept once, and approving starts the check again", async () => {
    const db = new FakeFirestore();
    const { ctx } = await brand("ten_A", db, { approve: true, articles: 3 });
    await run(db, ["ten_A"], T1);
    const later = new Date(T1.getTime() + 60_000);
    await saveProposal(ctx, PROPOSAL, { db, now: () => later });
    await saveProposal(ctx, PROPOSAL, { db, now: () => later });
    const doc = (await readBrandStrategyDoc(ctx, { db }))!;
    expect(doc.decisions.filter((d) => d.kind === "check_acted")).toHaveLength(1);
    expect(doc.check?.open?.actedAt).toBe(later.toISOString());
    const approved = await approveStrategy(ctx, { baseRev: doc.rev }, { db, now: () => later });
    expect(approved.ok && approved.value.check).toMatchObject({ open: null, since: "2026-11-27", nextAt: null, lookedAt: null });
  });

  it("with the switch off, a Propose keeps nothing about it, and approving clears an old check", async () => {
    const db = new FakeFirestore();
    const { ctx } = await brand("ten_A", db, { approve: true, articles: 3 });
    await run(db, ["ten_A"], T1);
    vi.stubEnv("STRATEGY_CHECK_ENABLED", "false");
    const made = await saveProposal(ctx, PROPOSAL, { db, now: () => T1 });
    expect(made.ok && made.value.decisions.some((d) => d.kind === "check_acted")).toBe(false);
    const approved = await approveStrategy(ctx, { baseRev: made.ok ? made.value.rev : 0 }, { db, now: () => T1 });
    expect(approved.ok && approved.value.check).toBeNull();
  });
});
