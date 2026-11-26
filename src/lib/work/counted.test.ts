import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { shapeRecordingFirestore } from "@/lib/tenant/testing/queryShape";
import { COUNT_ROWS, countForCheck, countProductEventsExact, monthsBetween, productEventCount, purposeCount } from "./counted";
import { aStoredTask, LUMEN_US } from "./testing/fixtures";
import type { WorkBrand } from "./scope";
import type { Measure, WorkCheck } from "./types";

afterEach(() => vi.unstubAllEnvs());

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

describe("the product event count (the fallback, wired)", () => {
  it("counts the connection's track events with that name between the two times, exactly under 2,000", async () => {
    const db = new FakeFirestore();
    seedEvents(db, 70, "2026-11-21T00:00:00.000Z", { every: 2 });
    seedEvents(db, 20, "2026-11-10T00:00:00.000Z");
    seedEvents(db, 20, "2026-12-05T00:00:00.000Z");
    seedEvents(db, 20, "2026-11-22T00:00:00.000Z", { connectionId: "pc_other" });
    seedEvents(db, 20, "2026-11-22T00:00:00.000Z", { tenantId: "ten_fernhill" });
    // 70 rows: 10 identify; of the 60 tracks the even ones are named.
    const r = await productEventCount(ctx, ask, db);
    const expected = Array.from({ length: 70 }, (_, i) => i).filter((i) => i % 7 !== 6 && i % 2 === 0).length;
    expect(r).toEqual({ n: expected, capped: false, backTo: null });
  });

  it("past 2,000 rows says at least N, back to the oldest row read", async () => {
    const db = new FakeFirestore();
    seedEvents(db, COUNT_ROWS + 300, "2026-11-21T00:00:00.000Z");
    const r = await productEventCount(ctx, ask, db);
    expect(r.capped).toBe(true);
    // The newest 2,000 are read: the oldest of them is row 300.
    expect(r.backTo).toBe(new Date(Date.parse("2026-11-21T00:00:00.000Z") + 300 * 60_000).toISOString());
    const tracks = Array.from({ length: COUNT_ROWS }, (_, i) => i + 300).filter((i) => i % 7 !== 6).length;
    expect(r.n).toBe(tracks);
  });

  it("reads through the existing (tenantId, connectionId, receivedAt desc) index: equality on the connection, a range and order on receivedAt", async () => {
    const ops: string[] = [];
    await productEventCount(ctx, ask, shapeRecordingFirestore(new FakeFirestore(), ops));
    expect(ops).toEqual(["where tenantId ==", "where connectionId ==", "where receivedAt >=", "where receivedAt <=", "orderBy receivedAt"]);
  });

  it("keeps the exact count apart: count() with the event name, which needs the index that isn't approved", async () => {
    const db = new FakeFirestore();
    seedEvents(db, COUNT_ROWS + 300, "2026-11-21T00:00:00.000Z", { every: 3 });
    const ops: string[] = [];
    const exact = await countProductEventsExact(ctx, ask, shapeRecordingFirestore(db, ops));
    expect(ops).toEqual(["where tenantId ==", "where connectionId ==", "where event ==", "where receivedAt >=", "where receivedAt <="]);
    expect(exact).toBe(Array.from({ length: COUNT_ROWS + 300 }, (_, i) => i).filter((i) => i % 7 !== 6 && i % 3 === 0).length);
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
