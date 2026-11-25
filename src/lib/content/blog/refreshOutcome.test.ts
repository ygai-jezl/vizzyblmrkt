import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { TenantContext } from "@/lib/tenant/types";
import type { RefreshRecord } from "@/lib/types/articleRefresh";
import type { DataConnection } from "@/lib/types/dataConnection";
import type { MetricSnapshot } from "@/lib/types/metricSnapshot";
import { accountCovers } from "./freshnessPages";
import { liftOf, measureOutcomes } from "./refreshOutcome";
import { clockReadout, readoutLine } from "./refreshReadout";
import { costCents } from "./refreshRecords";

const ctx: TenantContext = { tenantId: "ten_A", region: "us", source: "system" };
const NOW = new Date("2026-12-30T12:00:00.000Z");
const PAGE = "https://www.acme.example/blog/visibility";

const record = (over: Partial<RefreshRecord> & { reviewId: string }): RefreshRecord => ({
  id: `rr_${over.reviewId}`,
  tenantId: "ten_A",
  planId: "plan_1",
  workspaceId: "ws1",
  month: "2026-11",
  startedAt: "2026-11-25T09:00:00.000Z",
  by: "person",
  observation: { clockDays: 30, arm: "test", state: "due", reasons: [], dueAt: null, waitedDays: 3, liveUrl: PAGE },
  proposal: { count: 4, kinds: { newer_figure: 1 }, at: "2026-11-25T09:10:00.000Z" },
  decision: { outcome: "applied", accepted: 2, real: true, at: "2026-11-25T10:00:00.000Z", byUid: "u1" },
  cost: { searches: 10, tokens: 40_000, cents: costCents({ searches: 10, tokens: 40_000 }) },
  outcome: null,
  ...over,
});

/** A record as the fake store takes it. */
const rec = (over: Partial<RefreshRecord> & { reviewId: string }) => record(over) as unknown as Record<string, unknown>;

const conn = { id: "dcn_1", account: "sc-domain:acme.example", collect: { gen: 1 } } as unknown as DataConnection;

/** 56 days of page rows: our page gets 10 clicks a day before and 15 after; the other page 20 then 22. */
function days(from: string, to: string, each: (doc: MetricSnapshot) => void) {
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += 86_400_000) {
    const day = new Date(t).toISOString().slice(0, 10);
    const after = day > "2026-11-25";
    each({
      day,
      rows: [
        { key: "/blog/visibility", host: "www.acme.example", m: { searchClicks: after ? 15 : 10, searchImpressions: 100, searchPosition: after ? 6 : 8 } },
        { key: "/blog/pricing", host: "www.acme.example", m: { searchClicks: after ? 22 : 20, searchImpressions: 200, searchPosition: 4 } },
      ],
    } as unknown as MetricSnapshot);
  }
}

beforeEach(() => {
  for (const s of ["BRAND_MAP_ENABLED", "BRAND_MAP_PAGES_ENABLED", "BLOG_DATES_ENABLED", "BLOG_FRESHNESS_ENABLED", "BLOG_REFRESH_ENABLED"]) vi.stubEnv(s, "true");
});
afterEach(() => vi.unstubAllEnvs());

describe("what came of a refresh", () => {
  it("knows which property reads a host", () => {
    expect(accountCovers("sc-domain:acme.example", "www.acme.example")).toBe(true);
    expect(accountCovers("sc-domain:acme.example", "blog.acme.example")).toBe(true);
    expect(accountCovers("https://www.acme.example/", "acme.example")).toBe(true);
    expect(accountCovers("https://shop.acme.example/", "acme.example")).toBe(false);
    expect(accountCovers("sc-domain:other.example", "acme.example")).toBe(false);
  });

  it("sets clicks after against before beside the articles left alone", () => {
    expect(liftOf(280, 420, 560, 616)).toBeCloseTo(0.364, 3);
    expect(liftOf(0, 10, 100, 100)).toBeNull();
    expect(liftOf(10, 10, 0, 5)).toBeNull();
  });

  it("measures refreshes 28 days on, once, from the kept page rows, with the control", async () => {
    const db = new FakeFirestore();
    db.seed("refresh_records", "rr_rv_due", rec({ reviewId: "rv_due" }));
    db.seed("refresh_records", "rr_rv_soon", rec({ reviewId: "rv_soon", decision: { outcome: "applied", accepted: 1, real: true, at: "2026-12-20T10:00:00.000Z", byUid: null } }));
    db.seed("refresh_records", "rr_rv_links", rec({ reviewId: "rv_links", decision: { outcome: "applied", accepted: 1, real: false, at: "2026-11-01T10:00:00.000Z", byUid: null } }));
    db.seed("freshness_watch", "fw_ten_A", {
      tenantId: "ten_A",
      pages: [
        { key: "acme.example/blog/visibility", planId: "plan_1", workspaceId: "ws1" },
        { key: "acme.example/blog/pricing", planId: "plan_2", workspaceId: "ws1" },
      ],
    });
    const deps = { db, now: () => NOW, connections: async () => [conn], dayDocs: async (_c: TenantContext, _k: DataConnection, from: string, to: string, each: (d: MetricSnapshot) => void) => days(from, to, each) };
    expect(await measureOutcomes(ctx, deps)).toBe(1);
    const out = (db.raw("refresh_records", "rr_rv_due") as unknown as RefreshRecord).outcome!;
    expect(out).toMatchObject({ searchConsole: true, before: { clicks: 280, impressions: 2800, position: 8 }, after: { clicks: 420, impressions: 2800, position: 6 }, control: { before: 560, after: 616, pages: 1 } });
    expect(out.lift).toBeCloseTo(0.364, 3);
    // Not yet 28 days on, or links only: left alone. Measured once.
    expect((db.raw("refresh_records", "rr_rv_soon") as unknown as RefreshRecord).outcome).toBeNull();
    expect((db.raw("refresh_records", "rr_rv_links") as unknown as RefreshRecord).outcome).toBeNull();
    expect(await measureOutcomes(ctx, deps)).toBe(0);
  });

  it("says there was no Search Console when no property reads the page", async () => {
    const db = new FakeFirestore();
    db.seed("refresh_records", "rr_rv_due", rec({ reviewId: "rv_due", observation: { ...record({ reviewId: "x" }).observation, liveUrl: "https://elsewhere.example/post" } }));
    expect(await measureOutcomes(ctx, { db, now: () => NOW, connections: async () => [conn] })).toBe(1);
    expect((db.raw("refresh_records", "rr_rv_due") as unknown as RefreshRecord).outcome).toMatchObject({ searchConsole: false, lift: null });
  });
});

describe("which clock works", () => {
  const many = (clockDays: 20 | 30 | 45, lifts: number[], nothing = 0) => [
    ...lifts.map((lift, i) =>
      record({
        reviewId: `rv_${clockDays}_${i}`,
        observation: { ...record({ reviewId: "x" }).observation, clockDays },
        outcome: { searchConsole: true, before: { clicks: 100, impressions: 1000, position: 8 }, after: null, control: null, lift, measuredAt: NOW.toISOString() },
      }),
    ),
    ...Array.from({ length: nothing }, (_, i) =>
      record({ reviewId: `rv_${clockDays}_n${i}`, observation: { ...record({ reviewId: "x" }).observation, clockDays }, decision: { outcome: "nothing", accepted: 0, real: false, at: NOW.toISOString(), byUid: null } }),
    ),
  ];

  it("is too early until a clock has 8 results, and then shows a range", () => {
    const r = clockReadout([...many(30, [0.1, 0.2, 0.1, 0.15, 0.05, 0.12, 0.18, 0.1]), ...many(20, [0.04, 0.02])]);
    const thirty = r.clocks.find((c) => c.clockDays === 30)!;
    expect(thirty).toMatchObject({ refreshes: 8, withResults: 8, resultsNeeded: 0, acceptedAvg: 2, proposedAvg: 4 });
    expect(thirty.clickLift!.low).toBeLessThan(thirty.clickLift!.mean);
    expect(thirty.clickLift!.high).toBeGreaterThan(thirty.clickLift!.mean);
    expect(r.clocks.find((c) => c.clockDays === 20)).toMatchObject({ clickLift: null, resultsNeeded: 6 });
    expect(r.suggestion).toBeNull();
    expect(readoutLine(r)).toBe("Too early to suggest a clock: 20 days needs 6 more, 45 days needs 8 more refreshes with results.");
  });

  it("suggests the clock with the most clicks per dollar once all three have 8", () => {
    const r = clockReadout([...many(20, Array(8).fill(0.02)), ...many(30, Array(8).fill(0.12)), ...many(45, Array(8).fill(0.06))]);
    expect(r.suggestion?.clockDays).toBe(30);
    expect(readoutLine(r)).toMatch(/^30 days gains the most clicks for what reviews cost/);
  });

  it("calls a clock whose reviews mostly find nothing probably too short", () => {
    const r = clockReadout(many(20, [0.01, 0.02], 7));
    expect(r.tooShort).toEqual([20]);
    expect(readoutLine(r)).toBe("Most 20-day reviews find nothing to change, so that clock is probably too short.");
  });
});
