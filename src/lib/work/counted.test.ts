import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { failingFirestore } from "@/lib/tenant/testing/failingFirestore";
import { shapeRecordingFirestore } from "@/lib/tenant/testing/queryShape";
import { COUNT_ROWS, countForCheck, countProductEventsExact, monthsBetween, productEventCount, purposeCount } from "./counted";
import { aStoredTask, LUMEN_US } from "./testing/fixtures";
import type { WorkBrand } from "./scope";
import type { Measure, WorkCheck } from "./types";
import { countedLine } from "./words";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const CONN = "pc_lumen";
const ctx = { tenantId: LUMEN_US, region: "us" as const, source: "system" as const };
const lumen: WorkBrand = { id: LUMEN_US, name: "Lumen Notes", region: "us", timeZone: "UTC", repos: [] };

/** `n` events, one a minute from `start`, every `every`th named `event`, the rest another name, identify rows too. */
function seedEvents(db: FakeFirestore, n: number, start: string, opts: { every?: number; event?: string; tenantId?: string; connectionId?: string } = {}) {
  const t0 = Date.parse(start);
  for (let i = 0; i < n; i++) {
    const named = i % (opts.every ?? 1) === 0;
    db.seed("product_events", `pe_${opts.tenantId ?? LUMEN_US}_${opts.connectionId ?? CONN}_${start}_${i}`, {
      tenantId: opts.tenantId ?? LUMEN_US,
      connectionId: opts.connectionId ?? CONN,
      type: i % 7 === 6 ? "identify" : "track",
      event: i % 7 === 6 ? null : named ? (opts.event ?? "note_from_template") : "note_opened",
      receivedAt: new Date(t0 + i * 60_000).toISOString(),
    });
  }
}

const ask = { connectionId: CONN, event: "note_from_template", from: "2026-11-20T00:00:00.000Z", to: "2026-12-04T08:00:00.000Z" };

/** How many of these seedEvents rows are track rows: every seventh is an identify row. */
const tracksIn = (rows: number[]) => rows.filter((i) => i % 7 !== 6).length;
const range = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => i + from);

/** The database refusing the exact count, as Firestore does while its index is missing or building. */
const building = (db: FakeFirestore) => failingFirestore(db, { countsNeedIndex: ["product_events"] });
const quiet = () => vi.spyOn(console, "warn").mockImplementation(() => {});

describe("the product event count: exact through the event index", () => {
  it("counts every matching event past 2,000 exactly, never capped", async () => {
    const db = new FakeFirestore();
    seedEvents(db, COUNT_ROWS + 600, "2026-11-21T00:00:00.000Z");
    const warn = quiet();
    const r = await productEventCount(ctx, ask, db);
    expect(r).toEqual({ n: tracksIn(range(0, COUNT_ROWS + 600)), capped: false, backTo: null });
    expect(r.n).toBeGreaterThan(COUNT_ROWS);
    expect(warn).not.toHaveBeenCalled();
  });

  it("counts only the connection's events with that name between the two times, both ends in", async () => {
    const db = new FakeFirestore();
    seedEvents(db, 30, "2026-11-21T00:00:00.000Z");
    // Another name, another connection, another brand, before and after the times: none counted.
    seedEvents(db, 15, "2026-11-23T00:00:00.000Z", { event: "note_shared" });
    seedEvents(db, 15, "2026-11-24T00:00:00.000Z", { connectionId: "pc_other" });
    seedEvents(db, 15, "2026-11-25T00:00:00.000Z", { tenantId: "ten_fernhill" });
    seedEvents(db, 15, "2026-11-10T00:00:00.000Z");
    seedEvents(db, 15, "2026-12-05T00:00:00.000Z");
    // Identify rows carry no event name, even in the time and on the connection.
    db.seed("product_events", "pe_identify", { tenantId: LUMEN_US, connectionId: CONN, type: "identify", event: null, receivedAt: "2026-11-26T00:00:00.000Z" });
    db.seed("product_events", "pe_at_from", { tenantId: LUMEN_US, connectionId: CONN, type: "track", event: ask.event, receivedAt: ask.from });
    db.seed("product_events", "pe_at_to", { tenantId: LUMEN_US, connectionId: CONN, type: "track", event: ask.event, receivedAt: ask.to });
    const expected = tracksIn(range(0, 30)) + 2;
    expect(await productEventCount(ctx, ask, db)).toEqual({ n: expected, capped: false, backTo: null });
    // The fallback reads the same rows the same way, under 2,000.
    quiet();
    expect(await productEventCount(ctx, ask, building(db))).toEqual({ n: expected, capped: false, backTo: null });
  });

  it("asks count() with the event name: the shape the (tenantId, connectionId, event, receivedAt) index serves", async () => {
    const db = new FakeFirestore();
    seedEvents(db, COUNT_ROWS + 300, "2026-11-21T00:00:00.000Z", { every: 3 });
    const ops: string[] = [];
    const exact = await countProductEventsExact(ctx, ask, shapeRecordingFirestore(db, ops));
    expect(ops).toEqual(["where tenantId ==", "where connectionId ==", "where event ==", "where receivedAt >=", "where receivedAt <="]);
    expect(exact).toBe(range(0, COUNT_ROWS + 300).filter((i) => i % 7 !== 6 && i % 3 === 0).length);
    const used: string[] = [];
    await productEventCount(ctx, ask, shapeRecordingFirestore(db, used));
    expect(used).toEqual(ops);
  });
});

describe("the product event count: the fallback while the index is missing or building", () => {
  it("past 2,000 rows says at least N, back to the oldest row read", async () => {
    const db = new FakeFirestore();
    seedEvents(db, COUNT_ROWS + 300, "2026-11-21T00:00:00.000Z");
    quiet();
    const r = await productEventCount(ctx, ask, building(db));
    expect(r.capped).toBe(true);
    // The newest 2,000 are read: the oldest of them is row 300.
    expect(r.backTo).toBe(new Date(Date.parse("2026-11-21T00:00:00.000Z") + 300 * 60_000).toISOString());
    expect(r.n).toBe(tracksIn(range(300, COUNT_ROWS + 300)));
  });

  it("counts the connection's track events with that name between the two times, exactly under 2,000", async () => {
    const db = new FakeFirestore();
    seedEvents(db, 70, "2026-11-21T00:00:00.000Z", { every: 2 });
    seedEvents(db, 20, "2026-11-10T00:00:00.000Z");
    seedEvents(db, 20, "2026-12-05T00:00:00.000Z");
    seedEvents(db, 20, "2026-11-22T00:00:00.000Z", { connectionId: "pc_other" });
    seedEvents(db, 20, "2026-11-22T00:00:00.000Z", { tenantId: "ten_fernhill" });
    quiet();
    // 70 rows: 10 identify; of the 60 tracks the even ones are named.
    const r = await productEventCount(ctx, ask, building(db));
    const expected = range(0, 70).filter((i) => i % 7 !== 6 && i % 2 === 0).length;
    expect(r).toEqual({ n: expected, capped: false, backTo: null });
  });

  it("tries the exact count first, then reads through the existing (tenantId, connectionId, receivedAt desc) index", async () => {
    quiet();
    const ops: string[] = [];
    await productEventCount(ctx, ask, shapeRecordingFirestore(building(new FakeFirestore()), ops));
    expect(ops).toEqual([
      "where tenantId ==",
      "where connectionId ==",
      "where event ==",
      "where receivedAt >=",
      "where receivedAt <=",
      "where tenantId ==",
      "where connectionId ==",
      "where receivedAt >=",
      "where receivedAt <=",
      "orderBy receivedAt",
    ]);
  });

  it("logs one structured warning naming only the collection and the index", async () => {
    const db = new FakeFirestore();
    seedEvents(db, 10, "2026-11-21T00:00:00.000Z");
    const warn = quiet();
    await productEventCount(ctx, ask, building(db));
    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0]![0]);
    expect(JSON.parse(line)).toMatchObject({
      severity: "WARNING",
      event: "work_count_index_not_ready",
      collection: "product_events",
      index: "product_events (tenantId, connectionId, event, receivedAt)",
    });
    for (const secret of [LUMEN_US, CONN, ask.event, ask.from, ask.to]) expect(line).not.toContain(secret);
  });

  it("throws any other error as it is, with no fallback and no warning", async () => {
    const db = new FakeFirestore();
    seedEvents(db, 10, "2026-11-21T00:00:00.000Z");
    const warn = quiet();
    const ops: string[] = [];
    await expect(productEventCount(ctx, ask, shapeRecordingFirestore(failingFirestore(db, { counts: true }), ops))).rejects.toThrow("count failed");
    expect(ops).not.toContain("orderBy receivedAt");
    expect(warn).not.toHaveBeenCalled();
    await expect(productEventCount(ctx, ask, failingFirestore(db, { collections: ["product_events"] }))).rejects.toThrow("reading product_events failed");
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("the purpose count (operators only)", () => {
  const meter = (db: FakeFirestore, tenantId: string, month: string, byPurpose: Record<string, number>) =>
    db.seed("usage_meters", `um_${tenantId}_${month}`, { tenantId, month, meters: { model_tokens: { total: 0, calls: 0, lostCalls: 0, byPurpose } } });

  function world(brands: number) {
    const control = new FakeFirestore();
    const us = new FakeFirestore();
    for (let i = 0; i < brands; i++) {
      const id = `ten_b${i}`;
      control.seed("tenants", id, { tenantName: `Brand ${i}`, rootDomain: `b${i}.example`, ownerId: "uid_x", status: "active", region: "us", allowedOrigins: [], createdAt: "x", updatedAt: "x", ...(i % 2 ? { organisationId: `org_${id}` } : {}) });
      meter(us, id, "2026-11", { content_angle: 100 });
      meter(us, id, "2026-12", { content_angle: 50, blog_write: 999 });
    }
    control.seed("tenants", "ten_quiet", { tenantName: "Quiet", rootDomain: "q.example", ownerId: "uid_x", status: "active", region: "us", allowedOrigins: [], createdAt: "x", updatedAt: "x" });
    return { controlDb: control, regionDb: () => us };
  }

  it("adds up the units every brand's meter kept for it over the months, and how many brands spent any", async () => {
    vi.stubEnv("USAGE_METER_ENABLED", "true");
    expect(await purposeCount("content_angle", ["2026-11", "2026-12"], world(12))).toEqual({ units: 12 * 150, brands: 12 });
  });

  it("hides the brand count below 10 organisations", async () => {
    vi.stubEnv("USAGE_METER_ENABLED", "true");
    expect(await purposeCount("content_angle", ["2026-11"], world(9))).toEqual({ units: 900, brands: null });
  });

  it("counts nothing with the meter off", async () => {
    expect(await purposeCount("content_angle", ["2026-11"], world(12))).toBeNull();
  });

  it("covers the calendar months the check touches", () => {
    expect(monthsBetween("2026-11-20T00:00:00.000Z", "2027-01-04T00:00:00.000Z")).toEqual(["2026-11", "2026-12", "2027-01"]);
    expect(monthsBetween("2026-11-20T00:00:00.000Z", "2026-11-25T00:00:00.000Z")).toEqual(["2026-11"]);
  });
});

describe("what a due measure's check counts", () => {
  const due = "2026-12-04T08:00:00.000Z";
  const check: WorkCheck = { kind: "date", at: due, taskId: null, note: "", setBy: "measure", setAt: "2026-11-20T10:00:00.000Z", which: "first", counted: null };
  const used: Measure = { kind: "used", counts: { productEvent: { connectionId: CONN, event: "note_from_template" } }, look: { days: 14 }, setBy: "uid_nina", setAt: "x" };

  it("counts a product event from closedAt to the check, for the task's brand", async () => {
    const us = new FakeFirestore();
    seedEvents(us, 10, "2026-11-25T00:00:00.000Z");
    seedEvents(us, 5, "2026-11-19T00:00:00.000Z");
    const task = aStoredTask({ status: "done", open: true, closedAt: "2026-11-20T10:00:00.000Z", measure: used, check, hasCheck: true });
    const c = await countForCheck(task, lumen, { regionDb: () => us }, new Date("2026-12-05T00:00:00.000Z"));
    expect(c).toEqual({ n: 9, from: "2026-11-20T10:00:00.000Z", to: due, at: "2026-12-05T00:00:00.000Z" });
  });

  it("counts past 2,000 events exactly, so the check says how many, not at least", async () => {
    const us = new FakeFirestore();
    seedEvents(us, COUNT_ROWS + 600, "2026-11-25T00:00:00.000Z");
    const task = aStoredTask({ status: "done", open: true, closedAt: "2026-11-20T10:00:00.000Z", measure: used, check, hasCheck: true });
    const c = await countForCheck(task, lumen, { regionDb: () => us }, new Date("2026-12-05T00:00:00.000Z"));
    const n = tracksIn(range(0, COUNT_ROWS + 600));
    expect(c).toEqual({ n, from: "2026-11-20T10:00:00.000Z", to: due, at: "2026-12-05T00:00:00.000Z" });
    expect(countedLine({ part: used, counted: c, brandName: "Lumen Notes", timeZone: "UTC" })).toBe(
      `Work counted ${n.toLocaleString("en-GB")} note_from_template events from Lumen Notes' product since 20 Nov.`,
    );
  });

  it("while the index is building, counts in the newest 2,000 events and says at least", async () => {
    const us = new FakeFirestore();
    seedEvents(us, COUNT_ROWS + 300, "2026-11-25T00:00:00.000Z");
    quiet();
    const task = aStoredTask({ status: "done", open: true, closedAt: "2026-11-20T10:00:00.000Z", measure: used, check, hasCheck: true });
    const c = await countForCheck(task, lumen, { regionDb: () => building(us) }, new Date("2026-12-05T00:00:00.000Z"));
    const backTo = new Date(Date.parse("2026-11-25T00:00:00.000Z") + 300 * 60_000).toISOString();
    const n = tracksIn(range(300, COUNT_ROWS + 300));
    expect(c).toEqual({ n, capped: true, backTo, from: "2026-11-20T10:00:00.000Z", to: due, at: "2026-12-05T00:00:00.000Z" });
    expect(countedLine({ part: used, counted: c, brandName: "Lumen Notes", timeZone: "UTC" })).toBe(
      `Work counted at least ${n.toLocaleString("en-GB")} note_from_template events from Lumen Notes' product in the newest 2,000 events, back to 25 Nov.`,
    );
  });

  it("counts from closedAt, not from when the check was set: a then's check, or one Too soon to tell moved on", async () => {
    const us = new FakeFirestore();
    // 5 events after Done and before either check was set, 4 after.
    seedEvents(us, 5, "2026-11-22T00:00:00.000Z");
    seedEvents(us, 4, "2026-12-10T00:00:00.000Z");
    const closedAt = "2026-11-20T10:00:00.000Z";
    const then = { ...used, look: { days: 7 }, then: { kind: "used", counts: { productEvent: { connectionId: CONN, event: "note_from_template" } }, look: { days: 30 } } } as Measure;
    const thenCheck: WorkCheck = { ...check, at: "2026-12-20T08:00:00.000Z", setAt: "2026-11-27T13:00:00.000Z", which: "then" };
    const now = new Date("2026-12-21T00:00:00.000Z");
    const a = await countForCheck(aStoredTask({ status: "done", closedAt, measure: then, check: thenCheck, hasCheck: true }), lumen, { regionDb: () => us }, now);
    expect(a).toMatchObject({ n: 9, from: closedAt, to: "2026-12-20T08:00:00.000Z" });
    const soon: WorkCheck = { ...check, at: "2026-12-20T08:00:00.000Z", setAt: "2026-12-13T13:00:00.000Z" };
    const b = await countForCheck(aStoredTask({ status: "done", closedAt, measure: used, check: soon, hasCheck: true }), lumen, { regionDb: () => us }, now);
    expect(b).toMatchObject({ n: 9, from: closedAt });
  });

  it("counts back only as far as events are kept: a 90 day look moved on by Too soon to tell says where the count starts", async () => {
    const us = new FakeFirestore();
    // Events from the week after Done are past the 90 days kept when the count runs, so they aren't read.
    seedEvents(us, 6, "2026-11-22T00:00:00.000Z");
    seedEvents(us, 4, "2027-01-10T00:00:00.000Z");
    const closedAt = "2026-11-20T15:00:00.000Z";
    const long: Measure = { ...used, look: { days: 90 } };
    const moved: WorkCheck = { ...check, at: "2027-02-25T13:00:00.000Z", setAt: "2027-02-18T13:00:00.000Z" };
    const c = await countForCheck(aStoredTask({ status: "done", closedAt, measure: long, check: moved, hasCheck: true }), lumen, { regionDb: () => us }, new Date("2027-02-26T00:00:00.000Z"));
    // 90 days before the count ran, not before the check's time.
    expect(c).toEqual({ n: 4, backTo: "2026-11-28T00:00:00.000Z", from: closedAt, to: "2027-02-25T13:00:00.000Z", at: "2027-02-26T00:00:00.000Z" });
    expect(countedLine({ part: long, counted: c, brandName: "Lumen Notes", timeZone: "UTC" })).toBe(
      "Work counted 4 note_from_template events from Lumen Notes' product back to 28 Nov, as far back as events are kept.",
    );
  });

  it("first counted long after the check fell due, counts only what is still kept, and says where it starts", async () => {
    const us = new FakeFirestore();
    // A 30 day look from Done on 20 Nov, due 20 Dec, first shown on 28 Feb: the events of 22 Nov
    // went on 20 Feb, so only those of 10 Dec are still there to read.
    seedEvents(us, 4, "2026-12-10T00:00:00.000Z");
    const closedAt = "2026-11-20T10:00:00.000Z";
    const month: Measure = { ...used, look: { days: 30 } };
    const due: WorkCheck = { ...check, at: "2026-12-20T08:00:00.000Z" };
    const now = new Date("2027-02-28T00:00:00.000Z");
    const c = await countForCheck(aStoredTask({ status: "done", closedAt, measure: month, check: due, hasCheck: true }), lumen, { regionDb: () => us }, now);
    expect(c).toEqual({ n: 4, backTo: "2026-11-30T00:00:00.000Z", from: closedAt, to: "2026-12-20T08:00:00.000Z", at: now.toISOString() });
    const line = countedLine({ part: month, counted: c, brandName: "Lumen Notes", timeZone: "UTC" });
    expect(line).toBe("Work counted 4 note_from_template events from Lumen Notes' product back to 30 Nov, as far back as events are kept.");
    expect(line).not.toContain("since");
  });

  it("first counted after every event of its time is gone, says so instead of a number", async () => {
    const us = new FakeFirestore();
    const closedAt = "2026-11-20T10:00:00.000Z";
    const due: WorkCheck = { ...check, at: "2026-12-04T08:00:00.000Z" };
    const now = new Date("2027-03-10T00:00:00.000Z");
    const ops: string[] = [];
    const c = await countForCheck(aStoredTask({ status: "done", closedAt, measure: used, check: due, hasCheck: true }), lumen, { regionDb: () => shapeRecordingFirestore(us, ops) }, now);
    expect(c).toEqual({ gone: true, from: closedAt, to: "2026-12-04T08:00:00.000Z", at: now.toISOString() });
    // Nothing is read: there is nothing left to read.
    expect(ops).toEqual([]);
    expect(countedLine({ part: used, counted: c, brandName: "Lumen Notes", timeZone: "UTC" })).toBe(
      "Work can't count note_from_template events from Lumen Notes' product for this check: events are kept 90 days, and those from 20 Nov to 4 Dec are gone, so your read is the record.",
    );
    expect(countedLine({ part: used, counted: c, brandName: "Lumen Notes", timeZone: "UTC", eventLabel: "Note from a template" })).toContain("Work can't count note from a template from Lumen Notes' product");
  });

  it("counts a purpose over its month bounds", async () => {
    vi.stubEnv("USAGE_METER_ENABLED", "true");
    const control = new FakeFirestore();
    const us = new FakeFirestore();
    control.seed("tenants", LUMEN_US, { tenantName: "Lumen Notes", rootDomain: "lumen.example", ownerId: "uid_x", status: "active", region: "us", allowedOrigins: [], createdAt: "x", updatedAt: "x" });
    us.seed("usage_meters", `um_${LUMEN_US}_2026-11`, { tenantId: LUMEN_US, month: "2026-11", meters: { model_tokens: { total: 5, calls: 1, lostCalls: 0, byPurpose: { content_angle: 5 } } } });
    const task = aStoredTask({ status: "done", closedAt: "2026-11-20T10:00:00.000Z", measure: { ...used, counts: { purpose: "content_angle" } }, check, hasCheck: true });
    expect(await countForCheck(task, lumen, { controlDb: control, regionDb: () => us }, new Date("2026-12-05T00:00:00.000Z"))).toEqual({
      units: 5,
      hidden: true,
      from: "2026-11-01T00:00:00.000Z",
      to: "2026-12-31T23:59:59.999Z",
      at: "2026-12-05T00:00:00.000Z",
    });
  });

  it("counts nothing for Moves a number, Runs better, none, a whole business task's event, or a date check", async () => {
    const none = new FakeFirestore();
    const at = new Date("2026-12-05T00:00:00.000Z");
    const deps = { regionDb: () => none };
    const done = { status: "done" as const, closedAt: "2026-11-20T10:00:00.000Z", check, hasCheck: true };
    expect(await countForCheck(aStoredTask({ ...done, measure: { kind: "runs_better", what: "crashes", look: { days: 14 }, setBy: "x", setAt: "x" } }), lumen, deps, at)).toBeNull();
    expect(await countForCheck(aStoredTask({ ...done, measure: { kind: "moves", meaning: "conversions", direction: "up", look: { days: 14 }, setBy: "x", setAt: "x" } }), lumen, deps, at)).toBeNull();
    expect(await countForCheck(aStoredTask({ ...done, measure: { ...used, counts: { none: "" } } }), lumen, deps, at)).toBeNull();
    expect(await countForCheck(aStoredTask({ ...done, measure: used }), undefined, deps, at)).toBeNull();
    expect(await countForCheck(aStoredTask({ ...done, measure: used, check: { ...check, setBy: "uid_nina", which: null } }), lumen, deps, at)).toBeNull();
  });
});
