import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { brandMapRecords } from "@/lib/tenant/brandMapRecords";
import type { TenantContext } from "@/lib/tenant/types";
import type { Tenant } from "@/lib/types/tenant";
import { questionKey, situationKey } from "@/lib/brandMap/keys";
import { saveBrandMap } from "@/lib/brandMap/store";
import { forTenant } from "@/lib/tenant";
import type { OutcomeRead } from "@/lib/connectors/outcomes";
import { brandStrategyDocId } from "@/lib/types/brandStrategy";
import { BlogArticleMetaSchema } from "@/lib/types/contentPlan";
import { sampleHub, samplePlan } from "@/lib/content/blog/testing/samplePlan";
import { isMonthTick, lookAtMonth, runStrategyMonths, type MonthDeps } from "./month";
import { approveStrategy, deleteBrandStrategy, readBrandStrategyDoc, saveProposal, type ProposedStrategy } from "./store";

// How it went's monthly look on the tick. Made-up brands, situations and articles; the connector
// read is stubbed (src/lib/connectors/outcomes.test.ts covers it), so no provider is called.
const ADMIN = (tenantId: string): TenantContext => ({ tenantId, region: "us", source: "idtoken", userId: `usr_${tenantId}`, email: `admin@${tenantId}.example.com`, role: "admin" });
const FOCUS = ["sit_aaaaaa01", "sit_aaaaaa02", "sit_aaaaaa04"];
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
const APPROVED_AT = new Date("2026-10-20T09:00:00.000Z");

/** The first look tick at or after a moment. */
function monthTickFrom(iso: string): Date {
  let ms = Math.floor(Date.parse(iso) / 120_000) * 120_000;
  while (!isMonthTick(ms)) ms += 120_000;
  return new Date(ms + 1_000);
}
const T1 = monthTickFrom("2026-12-02T00:00:00.000Z");
const tenantRow = (id: string) => ({ id, region: "us", status: "active", name: id }) as unknown as Tenant;

const SEARCH_ONLY = (connectionId = "dcn_aaaaaaaaaaaaaaaaaaaa"): OutcomeRead => ({
  coverage: [
    { kind: "search", state: "measured", connectionId, connectorId: "search-console", connector: "Google Search Console", measure: "searchClicks", siteOnly: false, alsoConnected: [] },
    { kind: "visits", state: "not_connected", could: [] },
    { kind: "key_actions", state: "not_connected", could: [] },
    { kind: "ai_answers", state: "not_connected", could: [] },
  ],
  byPage: { "acme.example/blog/desk": { searchClicks: 38, searchImpressions: 400 }, "acme.example/blog/heel": { searchClicks: 7, searchImpressions: 90 } },
  site: {},
  more: [],
  periods: {},
  failed: [],
});

/** A brand with three focus situations and one other, and two live articles; approved when asked. */
async function brand(tenantId: string, db: FakeFirestore, opts: { approve: boolean }) {
  const ctx = ADMIN(tenantId);
  await saveBrandMap(ctx, { baseRev: 0, decided: { identity: { name: "Acme Physio", statement: "Physiotherapy for people who sit all day" }, names: [] } }, { db, nowMs: APPROVED_AT.getTime() });
  const store = brandMapRecords(ctx, db);
  const sits: Array<[string, string, number, number]> = [
    ["sit_aaaaaa01", "Back pain after desk work", 15, 9],
    ["sit_aaaaaa02", "Running knee in your 40s", 11, 2],
    ["sit_bbbbbb03", "Heel pain when you stand all day", 20, 4],
    ["sit_aaaaaa04", "Shoulder pain after the gym", 6, 0],
  ];
  for (const [i, [id, text, questions, answered]] of sits.entries()) {
    await store.create("sit", id, { status: "decided", from: "person", text, textKey: situationKey(text), rev: 0, order: i, counts: { questions, answered }, createdAt: "", updatedAt: "" });
  }
  // The focus situations' questions, read whole by the look: their counts are worked out again from them.
  await store.create("sub", "sub_aaaaaaaa", { status: "decided", from: "person", name: "Pain at work", nameKey: "pain at work", rev: 0, answeredIds: ["q_aaaaaaa1", "q_aaaaaaa2"], createdAt: "", updatedAt: "" });
  for (const [id, text, sit] of [
    ["q_aaaaaaa1", "Why does my back hurt after sitting?", "sit_aaaaaa01"],
    ["q_aaaaaaa2", "What desk height stops back pain?", "sit_aaaaaa01"],
    ["q_aaaaaaa3", "Is a standing desk worth it?", "sit_aaaaaa01"],
    ["q_aaaaaaa4", "Can I run with knee pain at 45?", "sit_aaaaaa02"],
  ] as const) {
    await store.create("q", id, { status: "decided", from: "person", subjectId: "sub_aaaaaaaa", text, textKey: questionKey(text), situationIds: [sit], rev: 0, createdAt: "", updatedAt: "" });
  }
  const ws = `ws_${tenantId}`;
  db.seed("workspaces", ws, { tenantId, name: "Blog", archivedAt: null } as never);
  // Two articles say their situation; the third is placed by its question, which is on a focus situation.
  for (const [id, url, at, situationId, primaryRef] of [
    ["plan_desk", "https://acme.example/blog/desk", "2026-11-05T09:00:00.000Z", "sit_aaaaaa01", "q_aaaaaaa1"],
    ["plan_heel", "https://acme.example/blog/heel", "2026-10-02T09:00:00.000Z", "sit_bbbbbb03", "q_zzzzzzz9"],
    ["plan_knee", "https://acme.example/blog/knee", "2026-11-20T09:00:00.000Z", undefined, "q_aaaaaaa4"],
  ] as const) {
    const hub = sampleHub({ status: "approved", blog: { ...BlogArticleMetaSchema.parse({}), live: { url, at, by: "check", titleMatched: true }, dates: { published: { at, source: "found" } } } });
    const plan = samplePlan({ id, tenantId, workspaceId: ws, createdAt: at, updatedAt: at }, hub);
    db.seed(`workspaces/${ws}/content_plans`, id, { ...plan, blog: { ...plan.blog!, primaryRef, ...(situationId ? { situationId } : {}) } } as never);
  }
  if (opts.approve) {
    const made = await saveProposal(ctx, PROPOSAL, { db, now: () => APPROVED_AT });
    if (!made.ok) throw new Error(made.error);
    const done = await approveStrategy(ctx, { baseRev: made.value.rev }, { db, now: () => APPROVED_AT });
    if (!done.ok) throw new Error(done.error);
  }
  return ctx;
}

function deps(db: FakeFirestore, ids: string[], now: Date, over: Partial<MonthDeps> = {}): MonthDeps {
  return { db, now: () => now, listTenants: async () => ids.map(tenantRow), outcomes: vi.fn(async () => SEARCH_ONLY()), ...over };
}
const run = (d: MonthDeps) => runStrategyMonths({ deadlineMs: Date.now() + 60_000 }, d);

beforeEach(() => {
  for (const k of ["BRAND_MAP_ENABLED", "BRAND_STRATEGY_ENABLED", "STRATEGY_RESULTS_ENABLED"]) vi.stubEnv(k, "true");
});
afterEach(() => vi.unstubAllEnvs());

describe("How it went's monthly look", () => {
  it("does nothing with its switch off, between its ticks, or on the 1st", async () => {
    const db = new FakeFirestore();
    await brand("ten_A", db, { approve: true });
    vi.stubEnv("STRATEGY_RESULTS_ENABLED", "false");
    expect(await run(deps(db, ["ten_A"], T1))).toEqual({ brands: 0, kept: 0, failed: 0 });
    vi.stubEnv("STRATEGY_RESULTS_ENABLED", "true");
    expect(await run(deps(db, ["ten_A"], new Date(T1.getTime() + 120_000)))).toEqual({ brands: 0, kept: 0, failed: 0 });
    expect(await run(deps(db, ["ten_A"], monthTickFrom("2026-12-01T00:00:00.000Z")))).toEqual({ brands: 0, kept: 0, failed: 0 });
    expect((await readBrandStrategyDoc(ADMIN("ten_A"), { db }))!.months).toEqual([]);
  });

  it("keeps last month on the record without moving its revision, once", async () => {
    const db = new FakeFirestore();
    const ctx = await brand("ten_A", db, { approve: true });
    const rev = (await readBrandStrategyDoc(ctx, { db }))!.rev;
    const d = deps(db, ["ten_A"], T1);
    expect(await run(d)).toEqual({ brands: 1, kept: 1, failed: 0 });
    const doc = (await readBrandStrategyDoc(ctx, { db }))!;
    expect(doc.rev).toBe(rev);
    expect(doc.months).toHaveLength(1);
    expect(doc.months[0]).toMatchObject({ month: "2026-11", strategyAt: APPROVED_AT.toISOString(), partway: false, sources: { search: { connector: "Google Search Console" } } });
    // Focus counts as worked out from their questions now; the rest as stored on the map.
    expect(doc.months[0]!.rows).toEqual([
      { id: "sit_aaaaaa01", questions: 3, answered: 2, live: 1, newLive: 1, theirs: null, m: { searchClicks: 38, searchImpressions: 400 } },
      { id: "sit_aaaaaa02", questions: 1, answered: 0, live: 1, newLive: 1, theirs: null, m: { searchClicks: 0, searchImpressions: 0 } },
      { id: "sit_aaaaaa04", questions: 0, answered: 0, live: 0, newLive: 0, theirs: null, m: { searchClicks: 0, searchImpressions: 0 } },
      { id: "rest", questions: 20, answered: 4, live: 1, newLive: 0, theirs: null, m: { searchClicks: 7, searchImpressions: 90 } },
    ]);
    // The brand's live articles were what it read numbers for.
    expect((d.outcomes as ReturnType<typeof vi.fn>).mock.calls[0]![1]).toEqual(
      expect.arrayContaining([
        { key: "acme.example/blog/desk", url: "https://acme.example/blog/desk" },
        { key: "acme.example/blog/heel", url: "https://acme.example/blog/heel" },
        { key: "acme.example/blog/knee", url: "https://acme.example/blog/knee" },
      ]),
    );
    // The month is kept: later ticks this month leave it alone.
    expect(await run(deps(db, ["ten_A"], monthTickFrom(new Date(T1.getTime() + 60_000).toISOString())))).toEqual({ brands: 0, kept: 0, failed: 0 });
    // And next month adds the next one, newest first.
    expect(await run(deps(db, ["ten_A"], monthTickFrom("2027-01-02T00:00:00.000Z")))).toMatchObject({ kept: 1 });
    expect((await readBrandStrategyDoc(ctx, { db }))!.months.map((m) => m.month)).toEqual(["2026-12", "2026-11"]);
  });

  it("looks only at brands with an approved strategy, and leaves another brand's record alone", async () => {
    const db = new FakeFirestore();
    await brand("ten_A", db, { approve: true });
    const draft = await brand("ten_B", db, { approve: false });
    await saveProposal(draft, PROPOSAL, { db, now: () => APPROVED_AT });
    expect(await run(deps(db, ["ten_A", "ten_B", "ten_C"], T1))).toEqual({ brands: 1, kept: 1, failed: 0 });
    expect((await readBrandStrategyDoc(draft, { db }))!.months).toEqual([]);
    // Approved after the month ended: nothing to say about it.
    const late = ADMIN("ten_D");
    await brand("ten_D", db, { approve: false });
    const made = await saveProposal(late, PROPOSAL, { db, now: () => new Date("2026-12-01T10:00:00.000Z") });
    await approveStrategy(late, { baseRev: made.ok ? made.value.rev : 0 }, { db, now: () => new Date("2026-12-01T10:00:00.000Z") });
    expect(await run(deps(db, ["ten_D"], T1))).toEqual({ brands: 0, kept: 0, failed: 0 });
  });

  it("looks at 3 brands a run at most, and the rest on the next run", async () => {
    const db = new FakeFirestore();
    const ids = ["ten_A", "ten_B", "ten_C", "ten_D"];
    for (const id of ids) await brand(id, db, { approve: true });
    expect(await run(deps(db, ids, T1))).toMatchObject({ brands: 3, kept: 3 });
    expect(await run(deps(db, ids, monthTickFrom(new Date(T1.getTime() + 60_000).toISOString())))).toMatchObject({ brands: 1, kept: 1 });
    for (const id of ids) expect((await readBrandStrategyDoc(ADMIN(id), { db }))!.months.map((m) => m.month)).toEqual(["2026-11"]);
  });

  it("tries a brand whose look failed again a day later, not sooner", async () => {
    const db = new FakeFirestore();
    const ctx = await brand("ten_A", db, { approve: true });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const failing = deps(db, ["ten_A"], T1, { outcomes: vi.fn(async () => Promise.reject(new Error("boom"))) });
      expect(await run(failing)).toEqual({ brands: 1, kept: 0, failed: 1 });
    } finally {
      warn.mockRestore();
    }
    const doc = (await readBrandStrategyDoc(ctx, { db }))!;
    expect(doc.months).toEqual([]);
    expect(doc.monthsRetryAt).toBe(new Date(T1.getTime() + 86_400_000).toISOString());
    expect(await run(deps(db, ["ten_A"], monthTickFrom(new Date(T1.getTime() + 60_000).toISOString())))).toEqual({ brands: 0, kept: 0, failed: 0 });
    expect(await run(deps(db, ["ten_A"], monthTickFrom(new Date(T1.getTime() + 86_400_000).toISOString())))).toEqual({ brands: 1, kept: 1, failed: 0 });
    expect((await readBrandStrategyDoc(ctx, { db }))!.monthsRetryAt).toBeNull();
  });

  it("by hand, adds up last month again in place of the one kept, and Start over erases every month", async () => {
    const db = new FakeFirestore();
    const ctx = await brand("ten_A", db, { approve: true });
    await run(deps(db, ["ten_A"], T1));
    const later = new Date("2026-12-09T10:00:00.000Z");
    const again = await lookAtMonth(ctx, null, deps(db, ["ten_A"], later, { outcomes: vi.fn(async () => SEARCH_ONLY("dcn_bbbbbbbbbbbbbbbbbbbb")) }), { replace: true });
    expect(again).toMatchObject({ month: "2026-11", at: later.toISOString() });
    const doc = (await readBrandStrategyDoc(ctx, { db }))!;
    expect(doc.months.map((m) => [m.month, m.sources.search?.connectionId])).toEqual([["2026-11", "dcn_bbbbbbbbbbbbbbbbbbbb"]]);
    // Without replace, a kept month is never written twice.
    expect(await lookAtMonth(ctx, null, deps(db, ["ten_A"], later))).toBeNull();
    expect(await deleteBrandStrategy(ctx, { db })).toBe(true);
    expect(await forTenant(ctx, db).brandStrategy.getById(brandStrategyDocId("ten_A"))).toBeNull();
  });
});
