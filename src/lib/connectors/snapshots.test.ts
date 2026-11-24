import { beforeEach, describe, expect, it } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { shapeRecordingFirestore } from "@/lib/tenant/testing/queryShape";
import { isStoredTimestamp, timestampFirestore } from "@/lib/tenant/testing/timestampFirestore";
import { forTenant, type TenantContext } from "@/lib/tenant";
import type { SnapshotRow } from "@/lib/types/metricSnapshot";
import { snapshotId } from "./keys";
import {
  countSnapshots,
  cutRows,
  dropAgedDay,
  eraseSnapshots,
  fitDoc,
  KEEP_ROWS,
  MAX_DOC_BYTES,
  MAX_KEY_LENGTH,
  oldestAlive,
  putSnapshot,
  readDayDocs,
  readSnapshot,
  TTL_MARGIN_DAYS,
  ttlFor,
  writeDayDoc,
  type DayDocInput,
  type SnapshotOwner,
} from "./snapshots";

// Made-up numbers for a made-up site: every write and read goes through the fake Firestore.
const A: TenantContext = { tenantId: "ten_a", region: "us", source: "system" };
const B: TenantContext = { tenantId: "ten_b", region: "us", source: "system" };
const OWNER: SnapshotOwner = { id: "dcn_aaaaaaaaaaaaaaaaaaaa", connectorId: "search-console", account: "sc-domain:example.com", gen: 0 };
const NOW = new Date("2026-11-23T10:00:00.000Z");

const row = (key: string, clicks: number, impressions = clicks * 10): SnapshotRow => ({ key, host: "example.com", m: { searchClicks: clicks, searchImpressions: impressions } });
const input = (over: Partial<DayDocInput> = {}): DayDocInput => ({
  owner: OWNER,
  stream: "search_performance",
  by: "page",
  day: "2026-11-20",
  timeZone: "America/Los_Angeles",
  final: true,
  totals: null,
  rows: [row("/a", 5), row("/b", 9), row("/c", 1)],
  more: false,
  keepDays: 90,
  ...over,
});

let db: FakeFirestore;
beforeEach(() => {
  db = new FakeFirestore();
});

describe("cutting rows", () => {
  it("keeps the top 500 by the main measure, with the last kept row as the floor", () => {
    const rows = Array.from({ length: 620 }, (_, i) => row(`/p${i}`, 1000 - i));
    const cut = cutRows(rows);
    expect(cut.rows).toHaveLength(KEEP_ROWS);
    expect(cut.rows[0]!.key).toBe("/p0");
    expect(cut).toMatchObject({ rowsSeen: 620, rowsDropped: 120, floor: { searchClicks: 1000 - 499, searchImpressions: (1000 - 499) * 10 } });
  });

  it("has no floor when nothing was cut, and drops and counts a key that is too long", () => {
    const long = row("/".padEnd(MAX_KEY_LENGTH + 1, "x"), 50);
    const cut = cutRows([row("/a", 1), long]);
    expect(cut.rows.map((r) => r.key)).toEqual(["/a"]);
    expect(cut).toMatchObject({ rowsSeen: 2, rowsDropped: 1, floor: null });
  });

  it("ties by impressions, then by key, so a cut is the same every time", () => {
    const cut = cutRows([row("/b", 2, 30), row("/a", 2, 30), row("/c", 2, 40)]);
    expect(cut.rows.map((r) => r.key)).toEqual(["/c", "/a", "/b"]);
  });

  it("drops rows from the bottom until a doc fits, moving the floor up", () => {
    const big = Array.from({ length: 500 }, (_, i) => ({ key: `/${"y".repeat(2400)}${i}`, m: { searchClicks: 500 - i } }));
    const doc = fitDoc({ rows: big, rowsDropped: 0, floor: null } as never);
    expect(Buffer.byteLength(JSON.stringify(doc))).toBeLessThanOrEqual(MAX_DOC_BYTES);
    expect(doc.rows.length).toBeLessThan(500);
    expect(doc.rowsDropped).toBe(500 - doc.rows.length);
    expect(doc.floor).toEqual(doc.rows.at(-1)!.m);
  });
});

describe("the snapshot store", () => {
  it("writes a day under its fixed id, again on a repeat, with the floor, the zone and a Date to live", async () => {
    const r = await writeDayDoc(A, input(), { db, now: NOW });
    expect(r).toEqual({ id: "dcn_aaaaaaaaaaaaaaaaaaaa_0_search_performance_page_2026-11-20", kept: 3, dropped: 0, seen: 3 });
    await writeDayDoc(A, input({ rows: [row("/a", 6)] }), { db, now: NOW });
    const raw = db.raw("metric_snapshots", r.id)!;
    expect(raw).toMatchObject({ tenantId: "ten_a", connectionId: OWNER.id, gen: 0, account: "sc-domain:example.com", by: "page", day: "2026-11-20", timeZone: "America/Los_Angeles", final: true, rowsSeen: 1 });
    expect(raw.rows).toEqual([{ key: "/a", host: "example.com", m: { searchClicks: 6, searchImpressions: 60 } }]);
    expect(raw.ttlAt).toBeInstanceOf(Date);
    expect((raw.ttlAt as Date).toISOString()).toBe("2027-02-25T00:00:00.000Z");
    expect(ttlFor("2026-11-20", 90).toISOString()).toBe("2027-02-25T00:00:00.000Z");
    expect(db.dump("metric_snapshots")).toHaveLength(1);
  });

  it("never writes a day of the keep window already past its time to live", async () => {
    // Search Console's last day trails today by about 3 Pacific days: the window's oldest day is
    // lastDay minus 89, and its doc must still be alive when it is written.
    const lastDay = "2026-11-21";
    const oldest = "2026-08-24";
    const r = await writeDayDoc(A, input({ day: oldest }), { db, now: new Date("2026-11-24T10:00:00.000Z") });
    expect((db.raw("metric_snapshots", r.id)!.ttlAt as Date).getTime()).toBeGreaterThan(new Date("2026-11-24T10:00:00.000Z").getTime());
    expect(oldestAlive(new Date("2026-11-24T10:00:00.000Z"), 90) <= oldest).toBe(true);
    expect(lastDay > oldest).toBe(true);
    expect(TTL_MARGIN_DAYS).toBeGreaterThanOrEqual(4);
  });

  it("reads a range by id, by day, leaving out days not collected", async () => {
    await writeDayDoc(A, input({ day: "2026-11-18" }), { db, now: NOW });
    await writeDayDoc(A, input({ day: "2026-11-20" }), { db, now: NOW });
    const ops: string[] = [];
    const days = await readDayDocs(A, OWNER, "search_performance", "page", "2026-11-17", "2026-11-20", { db: shapeRecordingFirestore(db, ops) });
    expect([...days.keys()]).toEqual(["2026-11-18", "2026-11-20"]);
    expect(ops).toEqual([]);
  });

  it("deletes the day keepDays before by id, for each grouping", async () => {
    await writeDayDoc(A, input({ day: "2026-08-22" }), { db, now: NOW });
    await writeDayDoc(A, input({ day: "2026-08-22", by: "topic" }), { db, now: NOW });
    await writeDayDoc(A, input({ day: "2026-08-23" }), { db, now: NOW });
    expect(await dropAgedDay(A, OWNER, "search_performance", ["day", "page", "topic"], "2026-11-20", 90, { db })).toBe(2);
    expect(db.dump("metric_snapshots").map((d) => d.day)).toEqual(["2026-08-23"]);
  });

  it("erases a connection's snapshots, or only its old generations, by equality", async () => {
    await writeDayDoc(A, input(), { db, now: NOW });
    await writeDayDoc(A, input({ owner: { ...OWNER, gen: 1 } }), { db, now: NOW });
    await writeDayDoc(A, input({ owner: { ...OWNER, gen: 2 } }), { db, now: NOW });
    await writeDayDoc(A, input({ owner: { ...OWNER, id: "dcn_bbbbbbbbbbbbbbbbbbbb" } }), { db, now: NOW });
    expect(await countSnapshots(A, OWNER.id, { db })).toBe(3);
    const ops: string[] = [];
    expect(await eraseSnapshots(A, OWNER.id, [0, 1], { db: shapeRecordingFirestore(db, ops) })).toBe(2);
    expect(ops.every((o) => o.endsWith(" ==")), ops.join(", ")).toBe(true);
    expect(db.dump("metric_snapshots").map((d) => `${d.connectionId}:${d.gen}`).sort()).toEqual(["dcn_aaaaaaaaaaaaaaaaaaaa:2", "dcn_bbbbbbbbbbbbbbbbbbbb:0"]);
    expect(await eraseSnapshots(A, OWNER.id, "all", { db })).toBe(1);
    expect(await countSnapshots(A, OWNER.id, { db })).toBe(0);
  });

  it("never reads, overwrites or erases another brand's numbers", async () => {
    const r = await writeDayDoc(A, input(), { db, now: NOW });
    expect(await forTenant(B, db).metricSnapshots.getById(r.id)).toBeNull();
    expect(await readDayDocs(B, OWNER, "search_performance", "page", "2026-11-20", "2026-11-20", { db })).toEqual(new Map());
    await expect(writeDayDoc(B, input(), { db, now: NOW })).rejects.toThrow("refusing to overwrite");
    expect(await eraseSnapshots(B, OWNER.id, "all", { db })).toBe(0);
    expect(await countSnapshots(B, OWNER.id, { db })).toBe(0);
    expect(db.raw("metric_snapshots", snapshotId(OWNER.id, 0, "search_performance", "page", "2026-11-20"))?.tenantId).toBe("ten_a");
  });
});

describe("snapshots as Firestore hands them back", () => {
  it("rewrite and read a day whose time to live is a Timestamp, the numbers unchanged", async () => {
    const ts = timestampFirestore(db, ["metric_snapshots"]);
    const r = await writeDayDoc(A, input(), { db: ts, now: NOW });
    await writeDayDoc(A, input({ rows: [row("/a", 6)] }), { db: ts, now: NOW });
    const ttl = db.raw("metric_snapshots", r.id)!.ttlAt;
    expect(isStoredTimestamp(ttl)).toBe(true);
    expect((ttl as { toDate(): Date }).toDate().toISOString()).toBe("2027-02-25T00:00:00.000Z");
    const days = await readDayDocs(A, OWNER, "search_performance", "page", "2026-11-19", "2026-11-20", { db: ts });
    expect([...days.keys()]).toEqual(["2026-11-20"]);
    expect(days.get("2026-11-20")).toMatchObject({ day: "2026-11-20", rows: [{ key: "/a", host: "example.com", m: { searchClicks: 6, searchImpressions: 60 } }], collectedAt: NOW.toISOString() });
    // A whole doc written over one whose time to live is a Timestamp.
    const doc = (await readSnapshot(A, r.id, { db: ts }))!;
    const { id: _id, tenantId: _t, ...rest } = doc;
    await putSnapshot(A, r.id, { ...rest, final: false, ttlAt: ttlFor("2026-11-21", 90) }, { db: ts });
    expect(await readSnapshot(A, r.id, { db: ts })).toMatchObject({ final: false, rows: doc.rows });
    expect((db.raw("metric_snapshots", r.id)!.ttlAt as { toDate(): Date }).toDate().toISOString()).toBe("2027-02-26T00:00:00.000Z");
    expect(await dropAgedDay(A, OWNER, "search_performance", ["page"], "2027-02-18", 90, { db: ts })).toBe(1);
  });
});
