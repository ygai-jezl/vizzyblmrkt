import { describe, expect, it } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { forTenant } from "@/lib/tenant";
import type { TenantContext } from "@/lib/tenant/types";
import type { SerpFindings, SerpNumbers } from "@/lib/types/brandSignal";
import { brandMarket, isKnownMarket, marketLabel } from "./markets";
import {
  claimSignal,
  dueSignals,
  finishSignal,
  FIRST_LOOK_MS,
  FRESH_MS,
  GIVE_UP_MS,
  isFresh,
  isPending,
  lookupsThisMonth,
  readySignals,
  recordPosted,
  SIGNAL_LEASE_MS,
  signalFor,
  signalIdFor,
  type SignalStoreDeps,
} from "./store";

const A: TenantContext = { tenantId: "ten_A", region: "us", source: "system" };
const B: TenantContext = { tenantId: "ten_B", region: "us", source: "system" };
const US = { country: "US", language: "en" };
const GB = { country: "GB", language: "en" };

const NUMBERS: SerpNumbers = { googlePosition: 4, peopleAlsoAsk: 3, aiOverviewSources: 2, aiOverviewCitesYou: false };
const RESULTS: SerpFindings = { top: [], paa: [{ question: "How?", url: null, domain: null }], alsoSearched: [], related: [], aiOverview: null };

function deps(at = "2026-11-18T12:00:00.000Z"): SignalStoreDeps & { db: FakeFirestore; clock: { t: number } } {
  const clock = { t: Date.parse(at) };
  return { db: new FakeFirestore(), now: () => new Date(clock.t), clock };
}

const post = (ctx: TenantContext, d: SignalStoreDeps, query = "How do I get cited by AI answers?", market = US, askedBy: "person" | "schedule" = "person") =>
  recordPosted(ctx, { query, questionId: "q_1", subjectId: "sub_1", market, askedBy, taskId: `task-${query.length}`, cost: 0.0012 }, d);

describe("the signals store", () => {
  it("keeps one record per question wording and market, per brand", async () => {
    expect(signalIdFor("ten_A", "How do I get cited?", US)).toBe(signalIdFor("ten_A", "  how do I get CITED ", US));
    expect(signalIdFor("ten_A", "How do I get cited?", US)).not.toBe(signalIdFor("ten_A", "How do I get cited?", GB));
    expect(signalIdFor("ten_A", "How do I get cited?", US)).not.toBe(signalIdFor("ten_B", "How do I get cited?", US));
  });

  it("never shows or changes another brand's lookups", async () => {
    const d = deps();
    const mine = await post(A, d);
    expect(await signalFor(B, mine.about.query, US, d)).toBeNull();
    expect(await forTenant(B, d.db).brandSignals.getById(mine.id)).toBeNull();
    expect(await claimSignal(B, mine.id, "l", d)).toBeNull();
    expect(await lookupsThisMonth(B, d)).toBe(0);
    expect(await dueSignals(B, 10, { ...d, now: () => new Date(d.clock.t + FIRST_LOOK_MS) })).toEqual([]);
  });

  it("waits a moment before the first collect, then hands each lookup to one run at a time", async () => {
    const d = deps();
    const s = await post(A, d);
    expect(await dueSignals(A, 10, d)).toEqual([]);
    d.clock.t += FIRST_LOOK_MS;
    expect((await dueSignals(A, 10, d)).map((x) => x.id)).toEqual([s.id]);
    expect(await claimSignal(A, s.id, "lease-1", d)).toMatchObject({ leaseId: "lease-1", attempts: 1 });
    expect(await claimSignal(A, s.id, "lease-2", d)).toBeNull();
    expect(await dueSignals(A, 10, d)).toEqual([]);
    d.clock.t += SIGNAL_LEASE_MS + 1;
    expect(await claimSignal(A, s.id, "lease-2", d)).toMatchObject({ leaseId: "lease-2", attempts: 2 });
    // The first run comes back late: what it found isn't saved over the second's.
    expect(await finishSignal(A, s.id, "lease-1", { status: "ready", numbers: NUMBERS, results: RESULTS, cost: null }, d)).toBeNull();
    const done = await finishSignal(A, s.id, "lease-2", { status: "ready", numbers: NUMBERS, results: RESULTS, cost: null }, d);
    expect(done).toMatchObject({ status: "ready", numbers: NUMBERS, leaseId: null, cost: 0.0012 });
  });

  it("looks again later when not ready, and gives up after a while", async () => {
    const d = deps();
    const s = await post(A, d);
    d.clock.t += FIRST_LOOK_MS;
    await claimSignal(A, s.id, "l1", d);
    const later = await finishSignal(A, s.id, "l1", { status: "not_yet", nextLookMs: 20_000 }, d);
    expect(later).toMatchObject({ status: "posted", leaseId: null });
    expect(Date.parse(later!.dueAt)).toBe(d.clock.t + 20_000);
    d.clock.t = Date.parse(s.postedAt) + GIVE_UP_MS;
    await claimSignal(A, s.id, "l2", d);
    expect(await finishSignal(A, s.id, "l2", { status: "not_yet", nextLookMs: 20_000 }, d)).toMatchObject({ status: "failed", error: "not_ready_in_time" });
  });

  it("is fresh for 90 days once ready, and pending while posted", async () => {
    const d = deps();
    const s = await post(A, d);
    const now = new Date(d.clock.t);
    expect(isPending(s, now)).toBe(true);
    expect(isFresh(s, now)).toBe(false);
    d.clock.t += FIRST_LOOK_MS;
    await claimSignal(A, s.id, "l", d);
    const ready = await finishSignal(A, s.id, "l", { status: "ready", numbers: NUMBERS, results: RESULTS, cost: 0.002 }, d);
    expect(isFresh(ready, new Date(d.clock.t + FRESH_MS - 1))).toBe(true);
    expect(isFresh(ready, new Date(d.clock.t + FRESH_MS))).toBe(false);
    expect(isPending(s, new Date(Date.parse(s.postedAt) + GIVE_UP_MS))).toBe(false);
  });

  it("starts a new lookup of the same question afresh in the same record", async () => {
    const d = deps();
    const s = await post(A, d);
    d.clock.t += FIRST_LOOK_MS;
    await claimSignal(A, s.id, "l", d);
    await finishSignal(A, s.id, "l", { status: "ready", numbers: NUMBERS, results: RESULTS, cost: null }, d);
    d.clock.t += FRESH_MS;
    const again = await post(A, d);
    expect(again.id).toBe(s.id);
    expect(again).toMatchObject({ status: "posted", numbers: null, results: null, readyAt: null });
    expect(await readySignals(A, 10, d)).toEqual([]);
  });

  it("counts this month's lookups against the cap, and collects a waiting person's first", async () => {
    const d = deps();
    await post(A, d, "Question one", US, "schedule");
    await post(A, d, "Question two", US, "person");
    expect(await lookupsThisMonth(A, d)).toBe(2);
    d.clock.t += FIRST_LOOK_MS;
    expect((await dueSignals(A, 10, d)).map((s) => s.about.query)).toEqual(["Question two", "Question one"]);
    d.clock.t = Date.parse("2026-12-01T00:00:00.000Z");
    expect(await lookupsThisMonth(A, d)).toBe(0);
  });
});

describe("markets", () => {
  it("falls back to the United States for a market we don't list", () => {
    expect(brandMarket(undefined)).toEqual(US);
    expect(brandMarket({ country: "xx", language: "en" })).toEqual(US);
    expect(brandMarket({ country: "gb", language: "en" })).toEqual(GB);
    expect(isKnownMarket({ country: "DE", language: "tlh" })).toBe(false);
    expect(marketLabel(GB)).toBe("Google United Kingdom, English");
  });
});
