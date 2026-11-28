import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { failingFirestore } from "@/lib/tenant/testing/failingFirestore";
import { shapeRecordingFirestore } from "@/lib/tenant/testing/queryShape";
import { USED_WEEKS_MAX } from "@/lib/loops/used";
import { COUNT_ROWS, countForCheck, countProductEventsExact, monthsBetween, productEventCount, purposeCount } from "./counted";
import { aStoredTask, LUMEN_US } from "./testing/fixtures";
import type { WorkBrand } from "./scope";
import { CheckSchema, COUNTED_WEEKS_MAX, type Measure, type WorkCheck } from "./types";
import { countedLine, IMAGES_OFF_LINE, LOOPS_COUNT_NOTE } from "./words";

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

  it("leaves out a brand that opted out of counts across brands, read from its lb: record, and floors on the rest", async () => {
    vi.stubEnv("USAGE_METER_ENABLED", "true");
    const w = world(12);
    const us = w.regionDb();
    // Three brands turned the counts off in their learning setting: 9 organisations are left.
    for (const id of ["ten_b0", "ten_b3", "ten_b7"]) us.seed("loop_days", `lb:${id}`, { tenantId: id, d: { scopes: {}, fleetOptOut: { at: "2026-11-02T09:00:00.000Z" } } });
    // A brand whose record holds only its looks still counts.
    us.seed("loop_days", "lb:ten_b1", { tenantId: "ten_b1", d: { scopes: {} } });
    expect(await purposeCount("content_angle", ["2026-11", "2026-12"], w)).toEqual({ units: 9 * 150, brands: null });
    expect(await purposeCount("content_angle", ["2026-11", "2026-12"], world(12))).toEqual({ units: 12 * 150, brands: 12 });
  });

  it("walks every brand's meter as before with the loops off, whatever the opt outs: no read across brands", async () => {
    vi.stubEnv("USAGE_METER_ENABLED", "true");
    const w = world(12);
    await purposeCount("content_angle", ["2026-11"], w);
    expect(w.controlDb.collectionCalls("fleet_cells")).toBe(0);
    expect(w.controlDb.collectionCalls("tenants")).toBeGreaterThan(0);
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

describe("what a due measure's check counts with the learning loops on (step 5, 4.10)", () => {
  // Done on Friday 20 Nov (2026-W47), due Friday 4 Dec (W49), first shown on Saturday 5 Dec: W47
  // and W48 are closed, W49 isn't over.
  const closedAt = "2026-11-20T10:00:00.000Z";
  const due = "2026-12-04T08:00:00.000Z";
  const now = new Date("2026-12-05T00:00:00.000Z");
  const check: WorkCheck = { kind: "date", at: due, taskId: null, note: "", setBy: "measure", setAt: closedAt, which: "first", counted: null };
  const usedOf = (counts: Extract<Measure, { kind: "used" }>["counts"], days = 14): Measure => ({ kind: "used", counts, look: { days }, setBy: "uid_nina", setAt: "x" });
  const purpose = usedOf({ purpose: "content_angle" });
  const taskOf = (measure: Measure, over: { closedAt?: string; check?: WorkCheck } = {}) =>
    aStoredTask({ status: "done", closedAt: over.closedAt ?? closedAt, measure, check: over.check ?? check, hasCheck: true });

  /** A control plane with the heartbeat's rows, and brands and meters a walk would read. */
  function world(rows: Record<string, Record<string, unknown>>) {
    const control = new FakeFirestore();
    const us = new FakeFirestore();
    for (const [id, n] of Object.entries(rows)) control.seed("fleet_cells", id, { n });
    for (let i = 0; i < 12; i++) {
      control.seed("tenants", `ten_b${i}`, { tenantName: `Brand ${i}`, rootDomain: `b${i}.example`, ownerId: "uid_x", status: "active", region: "us", allowedOrigins: [], createdAt: "x", updatedAt: "x" });
      us.seed("usage_meters", `um_ten_b${i}_2026-11`, { tenantId: `ten_b${i}`, month: "2026-11", meters: { model_tokens: { total: 9, calls: 1, lostCalls: 0, byPurpose: { content_angle: 9 } } } });
    }
    return { control, us, deps: { controlDb: control, regionDb: () => us } };
  }
  const calls = (orgs: number, n: number) => ({ orgs: { content_angle: orgs }, calls: { content_angle: n } });
  const line = (measure: Measure, counted: Awaited<ReturnType<typeof countForCheck>>) =>
    countedLine({ part: measure as Extract<Measure, { kind: "used" }>, counted, brandName: "Lumen Notes", timeZone: "America/New_York", loopsOn: true });

  beforeEach(() => {
    vi.stubEnv("LOOPS_ENABLED", "true");
    vi.stubEnv("USAGE_METER_ENABLED", "true");
  });

  it("reads a purpose's uses from the closed weeks the check covers, never walking brands, and says the week not over yet", async () => {
    const w = world({ "fh:_calls:2026-W47": calls(12, 640), "fh:_calls:2026-W48": calls(14, 1234), "fh:_calls:2026-W49": calls(15, 5000) });
    const c = await countForCheck(taskOf(purpose), lumen, w.deps, now);
    // 640 and 1,200 as each week shows, added up and rounded to 2 figures; W49 isn't read.
    expect(c).toEqual({
      n: 1800,
      from: "2026-11-16T00:00:00.000Z",
      to: "2026-11-29T23:59:59.999Z",
      at: now.toISOString(),
      weeks: { read: 2, shown: 2, orgs: 12, open: 1, openFrom: "2026-11-30T00:00:00.000Z", older: 0, beforeDone: true },
    });
    expect(w.control.collectionCalls("tenants")).toBe(0);
    expect(w.us.collectionCalls("usage_meters")).toBe(0);
    expect(w.us.collectionCalls("loop_days")).toBe(0);
    expect(line(purpose, c)).toBe(
      `Work counted about 1,800 AI calls for suggesting angles across brands in the 2 weeks from 16 Nov to 29 Nov, from at least 12 organisations a week. The first week includes days before Done. The week of 30 Nov isn't over yet, so it isn't counted. ${LOOPS_COUNT_NOTE}`,
    );
  });

  it("counts a type and a LOOPS kind, which Work v1 couldn't, with an image kind counted as the image pool", async () => {
    // Image kinds are counted only with image style versions on (decision 22).
    vi.stubEnv("BRAND_STYLE_LOOP_ENABLED", "true");
    vi.stubEnv("BRAND_IMAGE_STYLE_ENABLED", "true");
    vi.stubEnv("IMAGE_STYLE_VERSIONS_ENABLED", "true");
    const w = world({
      "fh:_types:2026-W48": { orgs: { content_plan: 10 }, made: { content_plan: 64 } },
      "fh:image_style:2026-W47": { orgs: 14, week: { orgs: 11 }, made: { orgs: 11 }, out: { learned: { made: 30 } } },
      "fh:image_style:2026-W48": { orgs: 14, week: { orgs: 12 }, made: { orgs: 12 }, out: { learned: { made: 117 }, holdback: { made: 8 } } },
    });
    const type = usedOf({ type: "content_plan" });
    const t = await countForCheck(taskOf(type), lumen, w.deps, now);
    expect(t).toMatchObject({ n: 64, weeks: { read: 2, shown: 1, orgs: 10, open: 1, older: 0 } });
    // The week Done fell in had no organisations, so nothing says it reaches back before Done.
    expect(t?.weeks?.beforeDone).toBeUndefined();
    expect(line(type, t)).toBe(
      `Work counted about 64 content plan records made across brands in 1 of the 2 weeks from 16 Nov to 29 Nov, from 10 organisations. Each organisation counts up to 20 a week. The other week didn't have counts from 10 organisations yet, so it is left out. The week of 30 Nov isn't over yet, so it isn't counted. ${LOOPS_COUNT_NOTE}`,
    );
    const kind = usedOf({ loopKind: "post_image" });
    const k = await countForCheck(taskOf(kind), lumen, w.deps, now);
    // 30, and 117 and 8 made by both arms (130 as the week shows): 160.
    expect(k).toMatchObject({ n: 160, weeks: { read: 2, shown: 2, orgs: 11, row: "image_style", beforeDone: true } });
    expect(line(kind, k)).toMatch(/^Work counted about 160 images made of every image kind across brands in the 2 weeks from 16 Nov to 29 Nov, from at least 11 organisations a week\. Each organisation counts up to 20 a week\./);
    const ownRow = usedOf({ loopKind: "next_up" });
    const o = await countForCheck(taskOf(ownRow), lumen, w.deps, now);
    expect(o?.weeks?.row).toBeUndefined();
    expect(line(ownRow, o)).toMatch(/^Work counted things made for next up/);
    expect(w.control.collectionCalls("tenants")).toBe(0);
  });

  it("hides the number below 10 organisations a week, as Work hides it", async () => {
    const w = world({ "fh:_calls:2026-W47": calls(9, 640), "fh:_calls:2026-W48": calls(4, 1234) });
    const c = await countForCheck(taskOf(purpose), lumen, w.deps, now);
    expect(c).toEqual({
      hidden: true,
      from: "2026-11-16T00:00:00.000Z",
      to: "2026-11-29T23:59:59.999Z",
      at: now.toISOString(),
      weeks: { read: 2, shown: 0, open: 1, openFrom: "2026-11-30T00:00:00.000Z", older: 0 },
    });
    const said = line(purpose, c);
    expect(said).toBe(
      `Work counted AI calls for suggesting angles across brands in the 2 weeks from 16 Nov to 29 Nov. How many isn't shown: no week had counts from 10 organisations yet. The week of 30 Nov isn't over yet, so it isn't counted. ${LOOPS_COUNT_NOTE}`,
    );
    expect(said).not.toMatch(/\b(?:9|4|640|1,2\d\d)\b/);
  });

  it("with none of its weeks over, reads nothing and says the week isn't over yet", async () => {
    const w = world({ "fh:_calls:2026-W49": calls(15, 5000) });
    const short = usedOf({ purpose: "content_angle" }, 2);
    const at = "2026-12-03T13:00:00.000Z";
    const c = await countForCheck(taskOf(short, { closedAt: "2026-12-01T10:00:00.000Z", check: { ...check, at, setAt: "2026-12-01T10:00:00.000Z" } }), lumen, w.deps, new Date("2026-12-04T09:00:00.000Z"));
    expect(c).toEqual({ from: "2026-12-01T10:00:00.000Z", to: at, at: "2026-12-04T09:00:00.000Z", weeks: { read: 0, shown: 0, open: 1, openFrom: "2026-11-30T00:00:00.000Z", older: 0 } });
    expect(w.control.collectionCalls("fleet_cells")).toBe(0);
    expect(line(short, c)).toBe("Work counts AI calls for suggesting angles across brands in whole weeks, and the week of 30 Nov isn't over yet, so your read is the record.");
  });

  it("reads the newest 13 closed weeks at most, and says the older ones are left out", async () => {
    // Done on 20 Aug (2026-W34): W34 to W48 are 15 closed weeks, so W34 and W35 are left out.
    const rows: Record<string, Record<string, unknown>> = {};
    for (let week = 34; week <= 48; week++) rows[`fh:_calls:2026-W${week}`] = calls(20, 100);
    const w = world(rows);
    const long = usedOf({ purpose: "content_angle" }, 106);
    const c = await countForCheck(taskOf(long, { closedAt: "2026-08-20T10:00:00.000Z" }), lumen, w.deps, now);
    expect(COUNTED_WEEKS_MAX).toBe(USED_WEEKS_MAX);
    expect(c).toMatchObject({ n: 1300, from: "2026-08-31T00:00:00.000Z", to: "2026-11-29T23:59:59.999Z", weeks: { read: 13, shown: 13, orgs: 20, open: 1, older: 2 } });
    expect(c?.weeks?.beforeDone).toBeUndefined();
    expect(line(long, c)).toContain("in the 13 weeks from 31 Aug to 29 Nov, from at least 20 organisations a week. Work reads the newest 13 weeks, so the 2 weeks before them are left out.");
  });

  it("counts no image kind while image style versions are off, which count no images, and says so instead of a hidden count", async () => {
    // LOOPS_ENABLED on alone: rows for the image pool could hold numbers, but this copy writes none.
    const w = world({ "fh:image_style:2026-W48": { orgs: 14, week: { orgs: 12 }, made: { orgs: 12 }, out: { learned: { made: 117 } } } });
    const kind = usedOf({ loopKind: "post_image" });
    expect(await countForCheck(taskOf(kind), lumen, w.deps, now)).toBeNull();
    expect(w.control.collectionCalls("fleet_cells")).toBe(0);
    const said = countedLine({ part: kind as Extract<Measure, { kind: "used" }>, counted: null, brandName: null, timeZone: "UTC", loopsOn: true, imagesOff: true });
    expect(said).toBe(IMAGES_OFF_LINE);
    expect(said).toBe("Work can't count images while image learning is off on this copy, so your read is the record.");
    // Words kinds are still counted.
    expect(await countForCheck(taskOf(usedOf({ loopKind: "next_up" })), lumen, w.deps, now)).toMatchObject({ weeks: { read: 2 } });
  });

  it("counts no purpose while the usage meter is off, which keeps no calls, but still counts a type", async () => {
    vi.stubEnv("USAGE_METER_ENABLED", "false");
    const w = world({ "fh:_calls:2026-W48": calls(14, 1234), "fh:_types:2026-W48": { orgs: { content_plan: 10 }, made: { content_plan: 64 } } });
    expect(await countForCheck(taskOf(purpose), lumen, w.deps, now)).toBeNull();
    expect(await countForCheck(taskOf(usedOf({ type: "content_plan" })), lumen, w.deps, now)).toMatchObject({ n: 64 });
  });

  it("with the loops off, counts no type or LOOPS kind, and a purpose walks the meters as Work v1 did", async () => {
    vi.stubEnv("LOOPS_ENABLED", "false");
    const w = world({ "fh:_calls:2026-W48": calls(14, 1234), "fh:_types:2026-W48": { orgs: { content_plan: 10 }, made: { content_plan: 64 } } });
    expect(await countForCheck(taskOf(usedOf({ type: "content_plan" })), lumen, w.deps, now)).toBeNull();
    expect(await countForCheck(taskOf(usedOf({ loopKind: "next_up" })), lumen, w.deps, now)).toBeNull();
    expect(await countForCheck(taskOf(purpose), lumen, w.deps, now)).toEqual({ units: 12 * 9, brands: 12, from: "2026-11-01T00:00:00.000Z", to: "2026-12-31T23:59:59.999Z", at: now.toISOString() });
    expect(w.control.collectionCalls("fleet_cells")).toBe(0);
  });

  it("still reads a check counted before the loops' fields, as it read then", () => {
    const old = {
      ...check,
      counted: { units: 900, hidden: true, from: "2026-11-01T00:00:00.000Z", to: "2026-11-30T23:59:59.999Z", at: "2026-12-05T00:00:00.000Z" },
    };
    const parsed = CheckSchema.parse(old);
    expect(parsed.counted).toEqual(old.counted);
    const said = "Work counted 900 tokens spent on suggesting angles in Nov 2026. How many brands used it stays hidden until they come from 10 organisations. The month totals include days before Done.";
    expect(countedLine({ part: purpose as Extract<Measure, { kind: "used" }>, counted: parsed.counted ?? null, brandName: null, timeZone: "UTC", loopsOn: true })).toBe(said);
    expect(countedLine({ part: purpose as Extract<Measure, { kind: "used" }>, counted: parsed.counted ?? null, brandName: null, timeZone: "UTC" })).toBe(said);
    // A count from the loops reads as one after the loops go off, as the record it is.
    const fromLoops = CheckSchema.parse({ ...check, counted: { n: 64, from: "2026-11-23T00:00:00.000Z", to: "2026-11-29T23:59:59.999Z", at: now.toISOString(), weeks: { read: 1, shown: 1, orgs: 10, open: 0, older: 0 } } });
    const type = usedOf({ type: "content_plan" }) as Extract<Measure, { kind: "used" }>;
    expect(countedLine({ part: type, counted: fromLoops.counted ?? null, brandName: null, timeZone: "UTC" })).toMatch(/^Work counted about 64 content plan records made across brands in the week of 23 Nov, from 10 organisations\./);
  });
});
