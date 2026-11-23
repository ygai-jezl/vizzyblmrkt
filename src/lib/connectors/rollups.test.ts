import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { shapeRecordingFirestore } from "@/lib/tenant/testing/queryShape";
import type { TenantContext } from "@/lib/tenant/types";
import { saveBrandMap } from "@/lib/brandMap/store";
import { BrandMapDecidedSchema } from "@/lib/types/brandMap";
import type { MetricSnapshot, SnapshotRow } from "@/lib/types/metricSnapshot";
import { planningId, rolledId } from "./keys";
import { addDays } from "./period";
import { rollConnection, rollTotals, RowRoller, windowOf } from "./rollups";
import { writeDayDoc, type SnapshotOwner } from "./snapshots";

// Made-up numbers for a made-up site, added up across days as each number allows.
const A: TenantContext = { tenantId: "ten_a", region: "us", source: "system" };
const OWNER: SnapshotOwner = { id: "dcn_aaaaaaaaaaaaaaaaaaaa", connectorId: "search-console", account: "sc-domain:example.com", gen: 0 };
const NOW = new Date("2026-11-23T10:00:00.000Z");

const snap = (day: string, rows: SnapshotRow[], over: Partial<MetricSnapshot> = {}): MetricSnapshot =>
  ({ id: "", tenantId: "ten_a", connectionId: OWNER.id, gen: 0, account: OWNER.account, connectorId: OWNER.connectorId, stream: "search_performance", by: "topic", day, window: null, days: null, timeZone: "America/Los_Angeles", final: true, totals: null, rows, rowsSeen: rows.length, rowsDropped: 0, more: false, floor: null, basis: null, notes: [], collectedAt: "", ttlAt: new Date(), ...over }) as MetricSnapshot;

let db: FakeFirestore;
beforeEach(() => {
  db = new FakeFirestore();
});
afterEach(() => vi.unstubAllEnvs());

describe("adding totals across days", () => {
  it("adds counts, works click rate out again, weights position by impressions and leaves people empty", () => {
    expect(
      rollTotals([
        { searchClicks: 10, searchImpressions: 100, searchCtr: 0.1, searchPosition: 4 },
        { searchClicks: 30, searchImpressions: 300, searchCtr: 0.1, searchPosition: 8 },
      ]),
    ).toEqual({ searchClicks: 40, searchImpressions: 400, searchCtr: 0.1, searchPosition: 7 });
    expect(rollTotals([{ ga4Sessions: 5, ga4ActiveUsers: 4, ga4Views: 9 }, { ga4Sessions: 6, ga4ActiveUsers: 5, ga4Views: 10 }])).toEqual({ ga4Sessions: 11, ga4ActiveUsers: null, ga4Views: 19 });
    expect(rollTotals([{ cfRequests: 10, cfVisits: 3, cfUniqueVisitors: 2 }, { cfRequests: 20, cfVisits: null, cfUniqueVisitors: 2 }])).toEqual({ cfRequests: 30, cfVisits: null, cfUniqueVisitors: null });
  });
});

describe("adding rows across days", () => {
  it("adds each key's numbers, people left out, and counts the cut days it was missing from", () => {
    const r = new RowRoller();
    r.include(snap("2026-11-19", [{ key: "a", m: { searchClicks: 2, searchImpressions: 20, searchPosition: 5, searchCtr: 0.1 } }]));
    r.include(snap("2026-11-20", [{ key: "a", m: { searchClicks: 4, searchImpressions: 60, searchPosition: 9 } }, { key: "b", m: { searchClicks: 1, searchImpressions: 10 } }], { rowsDropped: 200, more: true }));
    r.include(snap("2026-11-21", [{ key: "a", m: { searchClicks: 1, searchImpressions: 20 } }], { rowsDropped: 5 }));
    const out = r.result(500);
    expect(out.rows[0]).toEqual({ key: "a", m: { searchClicks: 7, searchImpressions: 100, searchCtr: 0.07, searchPosition: 8 } });
    // b was missing on 21 Nov, whose rows were cut: it may have been below the floor there.
    expect(out.rows[1]).toEqual({ key: "b", m: { searchClicks: 1, searchImpressions: 10, searchCtr: 0.1 }, cutDays: 1 });
    expect(r.more).toBe(true);

    const people = new RowRoller();
    people.include(snap("2026-11-20", [{ key: "/p", m: { ga4Views: 5, ga4ActiveUsers: 4 } }], { by: "page" }));
    people.include(snap("2026-11-21", [{ key: "/p", m: { ga4Views: 6, ga4ActiveUsers: 3 } }], { by: "page" }));
    expect(people.result(500).rows).toEqual([{ key: "/p", m: { ga4Views: 11 } }]);
  });

  it("never reaches a window before the oldest day kept", () => {
    expect(windowOf("r28", "2026-11-20", "2026-11-10")).toEqual({ from: "2026-11-10", to: "2026-11-20" });
    expect(windowOf("r90", "2026-11-20", "2026-01-01")).toEqual({ from: "2026-08-23", to: "2026-11-20" });
  });
});

describe("rolling a connection", () => {
  async function collected(days: number) {
    for (let i = 0; i < days; i++) {
      const day = addDays("2026-11-20", -i);
      const base = { owner: OWNER, stream: "search_performance", day, timeZone: "America/Los_Angeles", final: true, more: false, keepDays: 90 };
      await writeDayDoc(A, { ...base, by: "day", totals: { searchClicks: 10, searchImpressions: 200, searchCtr: 0.05, searchPosition: 6 + (i % 2) * 2 }, rows: [] }, { db, now: NOW });
      await writeDayDoc(A, { ...base, by: "page", totals: null, rows: [{ key: "/pricing", host: "example.com", m: { searchClicks: 3, searchImpressions: 40 } }] }, { db, now: NOW });
      await writeDayDoc(A, { ...base, by: "topic", totals: null, rows: [{ key: "what is share of voice", m: { searchClicks: 2, searchImpressions: 30, searchPosition: 11 } }] }, { db, now: NOW });
    }
  }

  it("writes each grouping's 28 and 90 days by id, reading each day once", async () => {
    await collected(40);
    const ops: string[] = [];
    const written = await rollConnection(
      A,
      { owner: OWNER, stream: "search_performance", by: ["day", "page", "topic"], keepDays: 90, lastDay: "2026-11-20", backfilledTo: "2026-10-12", timeZone: "America/Los_Angeles" },
      { db: shapeRecordingFirestore(db, ops), now: NOW },
    );
    expect(written).toBe(7);
    expect(ops).toEqual([]);
    const day28 = db.raw("metric_snapshots", rolledId(OWNER.id, 0, "search_performance", "day", "r28"))!;
    expect(day28).toMatchObject({ window: { from: "2026-10-24", to: "2026-11-20" }, days: 28, final: true, totals: { searchClicks: 280, searchImpressions: 5600, searchCtr: 0.05, searchPosition: 7 } });
    expect((day28.rows as SnapshotRow[])).toHaveLength(28);
    const page90 = db.raw("metric_snapshots", rolledId(OWNER.id, 0, "search_performance", "page", "r90"))!;
    expect(page90).toMatchObject({ window: { from: "2026-10-12", to: "2026-11-20" }, days: 40, totals: null });
    expect(page90.rows).toEqual([{ key: "/pricing", host: "example.com", m: { searchClicks: 120, searchImpressions: 1600, searchCtr: 0.075 } }]);
    // With the brand map off, the questions' planning doc is written empty.
    expect(db.raw("metric_snapshots", planningId(OWNER.id, 0, "search_performance", "question"))).toMatchObject({ by: "question", rows: [] });
  });

  it("writes a ready line for each decided question people searched in its own words", async () => {
    vi.stubEnv("BRAND_MAP_ENABLED", "true");
    const decided = BrandMapDecidedSchema.parse({
      identity: { name: "Acme", site: "https://acme.example" },
      subjects: [{ id: "sub_aaaaaaaa", name: "Share of voice", questions: [{ id: "q_aaaaaaaa", text: "What is share of voice?", intent: "definition" }, { id: "q_bbbbbbbb", text: "How is it measured?", intent: "benchmarks" }] }],
    });
    expect((await saveBrandMap({ ...A, source: "idtoken", userId: "u1", role: "admin" }, { baseRev: 0, decided }, { db, nowMs: NOW.getTime() })).ok).toBe(true);
    await collected(3);
    await rollConnection(A, { owner: OWNER, stream: "search_performance", by: ["topic"], keepDays: 90, lastDay: "2026-11-20", backfilledTo: "2026-11-18", timeZone: "America/Los_Angeles" }, { db, now: NOW });
    const lines = db.raw("metric_snapshots", planningId(OWNER.id, 0, "search_performance", "question"))!;
    expect(lines).toMatchObject({ window: { from: "2026-11-18", to: "2026-11-20" }, days: 3 });
    expect(lines.rows).toEqual([{ key: "q_aaaaaaaa", label: "what is share of voice", subjectId: "sub_aaaaaaaa", m: { searchClicks: 6, searchImpressions: 90, searchCtr: 0.06666666666666667, searchPosition: 11 } }]);
  });
});
