import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FLEET_CELLS, fleetCellId } from "@/lib/tenant/fleetCells";
import { laneMarkId, LOOP_LANE } from "@/lib/tenant/loopLane";
import { loopDayId, readLaneState } from "@/lib/tenant/loops";
import type { TenantPageRow } from "@/lib/tenant/registry";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { TenantContext } from "@/lib/tenant/types";
import { MARK_OUTPUTS_MAX, type LaneMark } from "@/lib/types/loopLane";
import { loopWeekOf } from "./count";
import { weekBefore } from "./fold";
import {
  brandWeekReport,
  callsSince,
  cellKey,
  creditMark,
  FleetBuffer,
  heartbeat,
  HEARTBEAT,
  holdsOldLook,
  looksInUse,
  planKeyOf,
  weeksToReport,
  type WeekReportInput,
} from "./heartbeat";
import { LOOP_RULES } from "./registry";

/** The heartbeat (learning loops step 5, 4.6): each brand's closed week, counted once per organisation through its mark. */

const NOW = new Date("2026-12-16T09:00:00.000Z");
const W = weekBefore(loopWeekOf(NOW));
const NATURAL = "image_style.natural_photo";

const words = (kind: string, signals: Record<string, number>, more: Record<string, unknown> = {}) => ({ c: { [kind]: { [kind]: { v0: { none: signals } } } }, ...more });
const input = (over: Partial<WeekReportInput> = {}): WeekReportInput => ({ week: W, window: [undefined, undefined, undefined, undefined], looks: [], plan: "pro", industry: "unknown", calls: {}, oldCopy: false, ...over });

function row(id: string, over: Partial<TenantPageRow> = {}): TenantPageRow {
  return { id, region: "us", status: "active", organisationId: null, orgPlan: null, grantedFeatures: [], learnedImageStyle: null, learnedImageStyleUpdatedAt: null, styleLooks: {}, ...over };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("a brand's week", () => {
  it("counts its organisation as Declared, and on each kind at every step it reached, by plan and industry", () => {
    const r = brandWeekReport(input({ window: [undefined, undefined, undefined, words("next_up", { made: 3, kept: 1 })] }));
    expect(r.orgCells).toEqual(
      expect.arrayContaining(["_orgs/orgs", "_orgs/p/pro", "_orgs/i/unknown", "next_up/orgs", "next_up/st/stamped/p/pro", "next_up/st/stamped/i/unknown"]),
    );
    expect(r.orgCells.some((k) => k.startsWith("next_up/st/signalled"))).toBe(false);
    expect(r.things).toMatchObject({ "next_up/out/none/made": 3, "next_up/out/none/kept": 1, "next_up/cov/stamped": 3 });
    expect(r.plain).toEqual({ "_orgs/reported": 1 });
    expect(r.reached).toEqual(["next_up:stamped"]);
  });

  it("names where the brand is stuck by plan with its top refusal reason, its refusals and its Go back cards", () => {
    const refused = words("edit_mode", { made: 1 }, { r: { edit_mode: { plan: 2 } } });
    const r = brandWeekReport(input({ window: [refused, refused, refused, refused] }));
    expect(r.orgCells).toEqual(expect.arrayContaining(["edit_mode/stuck/signalled/p/pro", "edit_mode/stuck/signalled/why/pro/plan", "edit_mode/refused/plan", "edit_mode/st/signalled/p/pro"]));
    expect(r.stuck).toEqual(["edit_mode:signalled"]);
    const cards = brandWeekReport(input({ window: [undefined, { k: { loop_learn: { proposed: 1 } } }, undefined, { k: { loop_learn: { acted: 1 } } }] }));
    expect(cards.orgCells).toContain("image_style/cards/orgs");
    expect(cards.things).toEqual({ "image_style/cards/acted": 1 });
  });

  it("counts the wait for a check in whole months, the why behind votes, declines by why, unstamped saves and made per type", () => {
    const week = {
      c: { [NATURAL]: { post_image: { v1: { learned: { made: 2, voted: 2, liked: 1, "disliked.looks_fake": 1 } } } }, next_up: { next_up: { v0: { none: { made: 1, declined: 1, "declined.not_for_us": 1 } } } } },
      u: { next_up: { stamp_lost: 1 } },
      t: { content_plan: { made: 2 } },
    };
    const r = brandWeekReport(input({ window: [undefined, undefined, undefined, week], looks: [{ scope: NATURAL, adoptedAt: "2026-10-01T00:00:00.000Z", checked: false }], calls: { blog_write: 4 } }));
    expect(r.orgCells).toEqual(expect.arrayContaining(["image_style/wait/orgs", "image_style/wait/m/m2", "_types/orgs/content_plan", "_calls/orgs/blog_write"]));
    expect(r.things).toMatchObject({
      "image_style/scope/natural_photo/learned/liked": 1,
      "image_style/why/disliked/looks_fake": 1,
      "next_up/declined/not_for_us": 1,
      "next_up/u/stamp_lost": 1,
      "next_up/cov/lost": 1,
      "_types/made/content_plan": 2,
    });
    // Calls are uses, added as they are.
    expect(r.plain).toMatchObject({ "_calls/calls/blog_write": 4 });
  });

  it("counts unused things two weeks on, and scales coverage to the cap with its share kept", () => {
    const r = brandWeekReport(input({ window: [undefined, words("next_up", { made: 5, kept: 1 }), words("next_up", { declined: 1 }), words("next_up", { made: 90 }, { u: { next_up: { records_off: 10 } } })] }));
    expect(r.things["next_up/unused"]).toBe(3);
    expect(r.things["next_up/cov/stamped"]).toBe(18);
    expect(r.things["next_up/cov/unstamped"]).toBe(2);
  });

  it("says when the brand record still holds an old look, and which plan a brand counts under", () => {
    expect(brandWeekReport(input({ oldCopy: true })).plain).toEqual({ "_orgs/reported": 1, "_orgs/oldCopy": 1 });
    expect(holdsOldLook(row("a", { learnedImageStyle: "Warm light." }))).toBe(true);
    expect(holdsOldLook(row("a", { styleLooks: { natural_photo: { directive: null, updatedAt: null } } }))).toBe(false);
    expect(planKeyOf(row("a", { orgPlan: "pro" }))).toBe("open");
    vi.stubEnv("PLANS_ENABLED", "true");
    expect(planKeyOf(row("a", { orgPlan: "pro" }))).toBe("pro");
    expect(planKeyOf(row("a", { orgPlan: "pro", grantedFeatures: ["edit_vizzy_learning"] }))).toBe("granted");
    expect(planKeyOf(row("a"))).toBe("open");
  });

  it("builds cell keys only from parts that can be counter keys", () => {
    expect(cellKey("next_up", "out", "none", "made")).toBe("next_up/out/none/made");
    expect(cellKey("next_up", "a/b")).toBeNull();
    expect(cellKey("next_up")).toBeNull();
    expect(cellKey("x".repeat(80), "y".repeat(50))).toBeNull();
  });
});

describe("an organisation's mark", () => {
  const report = (cells: string[], things: Record<string, number>, week = W) => ({ week, orgCells: cells, things });

  it("counts an organisation with two brands once in a cell, and caps its outputs at 20 a cell", () => {
    const a = creditMark(null, report(["next_up/st/stamped/p/pro", "_orgs/orgs"], { "next_up/out/none/made": 15 }), "t1");
    expect(a).toMatchObject({ late: false, orgCells: ["next_up/st/stamped/p/pro", "_orgs/orgs"], things: { "next_up/out/none/made": 15 } });
    if (a.late) throw new Error("late");
    const b = creditMark(a.mark, report(["next_up/st/stamped/p/pro", "next_up/st/signalled/p/pro"], { "next_up/out/none/made": 15 }), "t2");
    expect(b).toMatchObject({ late: false, orgCells: ["next_up/st/signalled/p/pro"], things: { "next_up/out/none/made": 5 } });
    if (b.late) throw new Error("late");
    expect(b.mark.outputs["next_up/out/none/made"]).toBe(LOOP_RULES.orgOutputsCap);
    const c = creditMark(b.mark, report(["next_up/st/stamped/p/pro"], { "next_up/out/none/made": 3 }), "t3");
    expect(c).toMatchObject({ late: false, orgCells: [], things: {} });
  });

  it("keeps one week only: a newer week replaces the mark, and an older one is dropped as late", () => {
    const old = creditMark(null, report(["_orgs/orgs"], { "next_up/out/none/made": 20 }, weekBefore(W)), "t1");
    if (old.late) throw new Error("late");
    const next = creditMark(old.mark, report(["_orgs/orgs"], { "next_up/out/none/made": 4 }), "t2");
    expect(next).toMatchObject({ late: false, orgCells: ["_orgs/orgs"], things: { "next_up/out/none/made": 4 }, mark: { week: W, cells: ["_orgs/orgs"], outputs: { "next_up/out/none/made": 4 } } });
    if (next.late) throw new Error("late");
    expect(creditMark(next.mark, report(["_orgs/orgs"], {}, weekBefore(W)), "t3")).toEqual({ late: true });
  });

  it("never grows past its bounds", () => {
    const things = Object.fromEntries(Array.from({ length: MARK_OUTPUTS_MAX + 50 }, (_, i) => [`next_up/scope/s${i}/none/made`, 1]));
    const c = creditMark(null, report([], things), "t");
    if (c.late) throw new Error("late");
    expect(Object.keys(c.mark.outputs)).toHaveLength(MARK_OUTPUTS_MAX);
  });
});

describe("the run's buffer", () => {
  it("adds increments up by row, and writes them in one go", async () => {
    const db = new FakeFirestore();
    const buffer = new FleetBuffer();
    buffer.add(W, "next_up/st/stamped/p/pro", 1);
    buffer.add(W, "next_up/st/stamped/p/pro", 1);
    buffer.add(W, "_orgs/orgs", 2);
    buffer.add(W, "_types/made/content_plan", 3);
    buffer.add(W, "next_up/st", 1); // a cell that would be both a map and an amount is left out
    buffer.add(W, "bad row/x", 1);
    buffer.add(W, "next_up/x", 0);
    expect(buffer.size).toBe(3);
    expect(await buffer.flush(db)).toBe(3);
    expect(db.raw(FLEET_CELLS, fleetCellId.kind("next_up", W))).toEqual({ n: { st: { stamped: { p: { pro: 2 } } } } });
    expect(db.raw(FLEET_CELLS, fleetCellId.orgs(W))).toEqual({ n: { orgs: 2 } });
    expect(db.raw(FLEET_CELLS, fleetCellId.types(W))).toEqual({ n: { made: { content_plan: 3 } } });
    expect(buffer.size).toBe(0);
  });
});

describe("which weeks a brand reports", () => {
  it("starts a brand that never reported at its newest folded week, catches up at most 2 a visit from 4 back, and waits for the fold", () => {
    expect(weeksToReport(undefined, W, NOW)).toEqual([W]);
    expect(weeksToReport(W, W, NOW)).toEqual([]);
    expect(weeksToReport(undefined, undefined, NOW)).toEqual([]);
    const w2 = weekBefore(W);
    const w3 = weekBefore(w2);
    const w4 = weekBefore(w3);
    expect(weeksToReport(weekBefore(weekBefore(w4)), W, NOW)).toEqual([w4, w3]);
    expect(weeksToReport(w4, w2, NOW)).toEqual([w3, w2]);
    expect(HEARTBEAT.WEEKS_PER_VISIT).toBe(2);
  });
});

describe("the learned looks in use", () => {
  it("counts a learned or carried over look that reached an image, never a person's own words or a Forget's version", () => {
    const at = "2026-10-01T00:00:00.000Z";
    const reached = { c: { post_image: { learned: { made: 3 } } }, looks: { "10": { call: "too_few" } } };
    const pointers = {
      scopes: {
        [NATURAL]: { v: 2, setBy: "learned" as const, adoptedAt: at },
        "image_style.brand": { v: 1, setBy: "seeded" as const, adoptedAt: at },
        "image_style.illustration": { v: 3, setBy: "person" as const, adoptedAt: at },
        "image_style.soft_3d": { v: 4, setBy: "learned" as const, adoptedAt: at },
      },
      forgot: { "image_style.soft_3d": { at } },
    };
    const totals = new Map<string, unknown>([
      [NATURAL, { c: { post_image: { learned: { made: 3 } } }, looks: { "0": { call: "too_few" } } }],
      ["image_style.brand", { c: { blog_hero: { holdback: { made: 1 } } } }],
      ["image_style.illustration", reached],
      ["image_style.soft_3d", reached],
    ]);
    expect(looksInUse(pointers, totals)).toEqual([{ scope: NATURAL, adoptedAt: at, checked: false }]);
  });
});

describe("calls since the last report", () => {
  const ctx: TenantContext = { tenantId: "ten_lumen", region: "us", source: "system" };
  const meters = (calls: Record<string, number>) => ({ model_tokens: { total: 0, calls: 0, lostCalls: 0, byPurpose: {}, callsByPurpose: calls } });

  it("counts nothing with the meter off, nothing on a first look, then only calls since, across a month's turn", async () => {
    expect(await callsSince(ctx, {}, { now: NOW })).toBeNull();
    vi.stubEnv("USAGE_METER_ENABLED", "true");
    const usage = vi.fn(async (_c: TenantContext, month: string) => (month === "2026-12" ? meters({ blog_write: 5 }) : meters({ blog_write: 9, trending: 2 })));
    expect(await callsSince(ctx, {}, { now: NOW, usage })).toEqual({ delta: {}, seen: { blog_write: 5 }, month: "2026-12" });
    expect(await callsSince(ctx, { meterMonth: "2026-12", meterSeen: { blog_write: 3 } }, { now: NOW, usage })).toEqual({ delta: { blog_write: 2 }, seen: { blog_write: 5 }, month: "2026-12" });
    // November had 9 and 2, 7 and 0 of them seen; December has 5 so far. A purpose no longer seen is kept at 0.
    expect(await callsSince(ctx, { meterMonth: "2026-11", meterSeen: { blog_write: 7, trending: 2, judge: 1 } }, { now: NOW, usage })).toEqual({
      delta: { blog_write: 7 },
      seen: { blog_write: 5, trending: 0, judge: 0 },
      month: "2026-12",
    });
  });
});

describe("a brand's heartbeat", () => {
  let db: FakeFirestore;
  const lumen: TenantContext = { tenantId: "ten_lumen", region: "us", source: "system" };
  const seedWeek = (ctx: TenantContext, week: string, d: Record<string, unknown>) => db.seed("loop_days", loopDayId.folded(ctx.tenantId, week), { tenantId: ctx.tenantId, d });
  const state = (over: Partial<Parameters<typeof heartbeat>[2]> = {}): Parameters<typeof heartbeat>[2] => ({ lane: {}, pointers: { scopes: {} }, foldedThrough: W, ...over });

  beforeEach(() => {
    db = new FakeFirestore();
    vi.stubEnv("LOOPS_ENABLED", "true");
  });

  it("sends nothing with LOOPS_ENABLED off", async () => {
    vi.stubEnv("LOOPS_ENABLED", "");
    seedWeek(lumen, W, words("next_up", { made: 2 }));
    const buffer = new FleetBuffer();
    expect(await heartbeat(lumen, row("ten_lumen"), state(), buffer, { db, controlDb: db, now: NOW })).toEqual({ weeks: 0, late: 0 });
    expect(buffer.size).toBe(0);
    expect(db.dump(LOOP_LANE)).toEqual([]);
    expect((await readLaneState(lumen, db)).heartbeatWeek).toBeUndefined();
  });

  it("sends nothing for a brand that opted out, and marks its weeks done", async () => {
    seedWeek(lumen, W, words("next_up", { made: 2 }));
    const buffer = new FleetBuffer();
    const r = await heartbeat(lumen, row("ten_lumen"), state({ pointers: { scopes: {}, fleetOptOut: { at: "2026-12-01T00:00:00.000Z" } } }), buffer, { db, controlDb: db, now: NOW });
    expect(r).toEqual({ weeks: 0, late: 0, optedOut: true });
    expect(buffer.size).toBe(0);
    expect(db.dump(LOOP_LANE)).toEqual([]);
    expect((await readLaneState(lumen, db)).heartbeatWeek).toBe(W);
  });

  it("records the week on the brand first, so a run cut off before the mark moves undercounts and never counts twice", async () => {
    seedWeek(lumen, W, words("next_up", { made: 2 }));
    const buffer = new FleetBuffer();
    const fails = new FakeFirestore();
    vi.spyOn(fails, "runTransaction").mockRejectedValue(new Error("unavailable"));
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(await heartbeat(lumen, row("ten_lumen"), state(), buffer, { db, controlDb: fails, now: NOW })).toEqual({ weeks: 1, late: 0 });
    expect(buffer.size).toBe(0);
    const lane = await readLaneState(lumen, db);
    expect(lane.heartbeatWeek).toBe(W);
    expect(lane.beat).toMatchObject({ week: W, reached: ["next_up:stamped"], stuck: [] });
    // The next visit has nothing to report.
    expect(await heartbeat(lumen, row("ten_lumen"), state({ lane }), buffer, { db, controlDb: db, now: NOW })).toEqual({ weeks: 0, late: 0 });
  });

  it("moves the organisation's mark and buffers what it credited", async () => {
    seedWeek(lumen, W, words("next_up", { made: 25 }));
    const buffer = new FleetBuffer();
    const lumenRow = row("ten_lumen", { organisationId: "org_lumen" });
    expect(await heartbeat(lumen, lumenRow, state(), buffer, { db, controlDb: db, now: NOW })).toEqual({ weeks: 1, late: 0 });
    const mark = (db.raw(LOOP_LANE, laneMarkId({ tenantId: "ten_lumen", organisationId: "org_lumen" })) as { d: LaneMark }).d;
    expect(mark.week).toBe(W);
    expect(mark.outputs["next_up/out/none/made"]).toBe(20);
    const cells = Object.fromEntries(buffer.cells().map((c) => [c.id, c.n]));
    expect(cells[fleetCellId.kind("next_up", W)]).toMatchObject({ orgs: 1, out: { none: { made: 20 } }, st: { stamped: { p: { open: 1 }, i: { unknown: 1 } } } });
    expect(cells[fleetCellId.orgs(W)]).toEqual({ orgs: 1, p: { open: 1 }, i: { unknown: 1 }, reported: 1 });
  });
});
