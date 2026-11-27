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
  planKeyOf,
  weeksToReport,
  type WeekReportInput,
} from "./heartbeat";
import { LOOP_RULES } from "./registry";
import { aiUsage } from "@/lib/plans/meter";
import { looksInUse } from "./stages";

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
    // Emails sent with send records off count made and records_off for the same email: none is stamped.
    const off = brandWeekReport(input({ window: [undefined, undefined, undefined, words("send_time", { made: 10 }, { u: { send_time: { records_off: 10 } } })] }));
    expect(off.things).toMatchObject({ "send_time/cov/unstamped": 10 });
    expect(off.things).not.toHaveProperty("send_time/cov/stamped");
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

  it("floors this week's numbers on the organisations whose week has them, not every one seen in the 28 days", () => {
    const earlier = brandWeekReport(input({ window: [words("next_up", { made: 2 }), undefined, undefined, undefined] }));
    expect(earlier.orgCells).toContain("next_up/orgs");
    expect(earlier.orgCells).not.toContain("next_up/week/orgs");
    expect(earlier.things).toEqual({});
    const now = brandWeekReport(input({ window: [undefined, undefined, undefined, words("next_up", { made: 2 })] }));
    expect(now.orgCells).toEqual(expect.arrayContaining(["next_up/orgs", "next_up/week/orgs", "next_up/st/stamped/all"]));
  });

  it("counts organisations per image style, and each refusal reason once for the copy however many kinds refused it", () => {
    const week = {
      c: { [NATURAL]: { post_image: { v1: { learned: { made: 2, voted: 1 } } } } },
      r: { edit_mode: { plan: 1 }, content_write: { plan: 1 } },
    };
    const r = brandWeekReport(input({ window: [undefined, undefined, undefined, week] }));
    expect(r.orgCells).toEqual(expect.arrayContaining(["image_style/styles/natural_photo", "edit_mode/refused/plan", "content_write/refused/plan", "_orgs/refused/plan"]));
    expect(r.orgCells.filter((k) => k === "_orgs/refused/plan")).toHaveLength(1);
    // Images with no learned look yet (arm none) add nothing to a style's holdback line, so they don't count behind it.
    const none = brandWeekReport(input({ window: [undefined, undefined, undefined, { c: { [NATURAL]: { post_image: { v0: { none: { made: 3, voted: 2, liked: 1 } } } } } }] }));
    expect(none.things).toMatchObject({ "image_style/scope/natural_photo/none/made": 3 });
    expect(none.orgCells).not.toContain("image_style/styles/natural_photo");
  });

  it("counts posts that went out with no AI draft kept, and names it where a brand is stuck at Stamped", () => {
    const week = words("content_write", { made: 3, no_draft: 3 });
    const r = brandWeekReport(input({ window: [week, week, week, week] }));
    expect(r.stuck).toEqual(["content_write:stamped"]);
    // Once in all as well as under its plan, so an organisation on two plans is one stuck organisation.
    expect(r.orgCells).toEqual(expect.arrayContaining(["content_write/stuck/stamped/all", "content_write/stuck/stamped/p/pro", "content_write/stuck/stamped/nodraft"]));
    expect(r.things["content_write/nodraft"]).toBe(3);
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

  it("counts an organisation with two brands once in a cell, and caps its outputs at 20 a signal", () => {
    const a = creditMark(null, report(["next_up/st/stamped/p/pro", "_orgs/orgs"], { "next_up/out/none/made": 15 }), "t1");
    expect(a).toMatchObject({ late: false, orgCells: ["next_up/st/stamped/p/pro", "_orgs/orgs"], things: { "next_up/out/none/made": 15 } });
    if (a.late) throw new Error("late");
    const b = creditMark(a.mark, report(["next_up/st/stamped/p/pro", "next_up/st/signalled/p/pro"], { "next_up/out/none/made": 15 }), "t2");
    expect(b).toMatchObject({ late: false, orgCells: ["next_up/st/signalled/p/pro"], things: { "next_up/out/none/made": 5 } });
    if (b.late) throw new Error("late");
    // The budget is kept on the mark only, for every arm at once.
    expect(b.mark.outputs["next_up/out/*/made"]).toBe(LOOP_RULES.orgOutputsCap);
    const c = creditMark(b.mark, report(["next_up/st/stamped/p/pro"], { "next_up/out/none/made": 3 }), "t3");
    expect(c).toMatchObject({ late: false, orgCells: [], things: {} });
  });

  it("keeps one week only: a newer week replaces the mark, and an older one is dropped as late", () => {
    const old = creditMark(null, report(["_orgs/orgs"], { "next_up/out/none/made": 20 }, weekBefore(W)), "t1");
    if (old.late) throw new Error("late");
    const next = creditMark(old.mark, report(["_orgs/orgs"], { "next_up/out/none/made": 4 }), "t2");
    expect(next).toMatchObject({ late: false, orgCells: ["_orgs/orgs"], things: { "next_up/out/none/made": 4 }, mark: { week: W, cells: ["_orgs/orgs"], outputs: { "next_up/out/*/made": 4 } } });
    if (next.late) throw new Error("late");
    expect(creditMark(next.mark, report(["_orgs/orgs"], {}, weekBefore(W)), "t3")).toEqual({ late: true });
  });

  it("counts at most 20 made a kind however it was made, with its arms' shares kept", () => {
    const c = creditMark(null, report([], { "post_image/out/learned/made": 100, "post_image/out/holdback/made": 10, "post_image/out/none/made": 30 }), "t");
    if (c.late) throw new Error("late");
    const made = Object.values(c.things).reduce((a, b) => a + b, 0);
    expect(made).toBeLessThanOrEqual(LOOP_RULES.orgOutputsCap);
    expect(c.things).toEqual({ "post_image/out/learned/made": 14, "post_image/out/holdback/made": 1, "post_image/out/none/made": 4 });
    // A second brand of the organisation adds nothing once the budget is spent.
    const d = creditMark(c.mark, report([], { "post_image/out/holdback/made": 5 }), "t2");
    expect(d).toMatchObject({ late: false, things: { "post_image/out/holdback/made": 1 } });
  });

  it("scales signals that go together by one factor, so liked against voted reads the same capped as not", () => {
    const c = creditMark(
      null,
      report([], {
        "image_style/out/learned/made": 60,
        "image_style/out/learned/voted": 50,
        "image_style/out/learned/liked": 25,
        "image_style/scope/natural_photo/learned/voted": 50,
        "image_style/scope/natural_photo/learned/liked": 25,
      }),
      "t",
    );
    if (c.late) throw new Error("late");
    expect(c.things["image_style/out/learned/liked"]! / c.things["image_style/out/learned/voted"]!).toBe(0.5);
    expect(c.things).toMatchObject({ "image_style/out/learned/made": 20, "image_style/out/learned/voted": 16, "image_style/out/learned/liked": 8 });
    // Each style has its own budget, scaled the same way.
    expect(c.things).toMatchObject({ "image_style/scope/natural_photo/learned/voted": 20, "image_style/scope/natural_photo/learned/liked": 10 });
    // Coverage shares one budget in all.
    const cov = creditMark(null, report([], { "next_up/cov/stamped": 18, "next_up/cov/unstamped": 2 }), "t");
    const cov2 = cov.late ? null : creditMark(cov.mark, report([], { "next_up/cov/stamped": 10, "next_up/cov/unstamped": 10 }), "t2");
    expect(cov2).toMatchObject({ late: false, things: {} });
  });

  it("scales the reasons given with thumbs down by the votes' factor, so 'No reason given' keeps its share", () => {
    // 100 voted, 50 liked: 50 thumbs down, 10 of them with a reason and 40 with none.
    const c = creditMark(
      null,
      report([], { "image/out/learned/voted": 100, "image/out/learned/liked": 50, "image/why/disliked/fake": 10, "image/why/liked/warm": 5 }),
      "t",
    );
    if (c.late) throw new Error("late");
    const voted = c.things["image/out/learned/voted"]!;
    const downs = voted - c.things["image/out/learned/liked"]!;
    const given = c.things["image/why/disliked/fake"]!;
    expect({ voted, downs, given }).toEqual({ voted: 20, downs: 10, given: 2 });
    expect((downs - given) / downs).toBe(0.8);
    expect(c.things["image/why/liked/warm"]).toBe(1);
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

describe("calls by purpose, as the meter counts them", () => {
  const ctx: TenantContext = { tenantId: "ten_lumen", region: "us", source: "system" };
  beforeEach(() => {
    vi.stubEnv("USAGE_METER_ENABLED", "true");
    vi.stubEnv("LOOPS_ENABLED", "true");
  });

  it("counts a grounded call once, though it records its searches and its tokens", async () => {
    const db = new FakeFirestore();
    const usage = aiUsage(ctx, "situations", { db, now: () => NOW });
    vi.spyOn(console, "info").mockImplementation(() => {});
    // What one grounded call records, and then a second call with no search.
    await usage.recordSearches(3);
    await usage.recordModel(1200, "gemini-x");
    expect((await callsSince(ctx, {}, { now: NOW, db }))?.seen).toEqual({ situations: 1 });
    await usage.recordModel(400, "gemini-x");
    expect((await callsSince(ctx, {}, { now: NOW, db }))?.seen).toEqual({ situations: 2 });
  });

  it("counts a chat turn once, however many models answered in it", async () => {
    const db = new FakeFirestore();
    const usage = aiUsage(ctx, "vizzy_chat", { db, now: () => NOW });
    vi.spyOn(console, "info").mockImplementation(() => {});
    await usage.recordModel(900, "gemini-x");
    await usage.recordModel(300, "gemini-y", { sameCall: true });
    expect((await callsSince(ctx, {}, { now: NOW, db }))?.seen).toEqual({ vizzy_chat: 1 });
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
    // Only the visit is counted, against brands listed, as listed counts every brand: nothing of the brand's.
    expect(buffer.cells()).toEqual([{ id: fleetCellId.orgs(W), n: { visited: 1 } }]);
    expect(db.dump(LOOP_LANE)).toEqual([]);
    expect((await readLaneState(lumen, db)).heartbeatWeek).toBe(W);
  });

  it("sends nothing from a brand's time opted out once it opts back in: no calls, things, stages or unused from those weeks", async () => {
    vi.stubEnv("USAGE_METER_ENABLED", "true");
    const meters = (calls: Record<string, number>) => ({ model_tokens: { total: 0, calls: 0, lostCalls: 0, byPurpose: {}, callsByPurpose: calls } });
    let total = 5;
    const usage = async () => meters({ blog_write: total });
    const at = (iso: string) => new Date(iso);
    const t1 = at("2026-12-09T09:00:00.000Z");
    const t2 = at("2026-12-16T09:00:00.000Z");
    const t3 = at("2026-12-23T09:00:00.000Z");
    const [w1, w2, w3] = [t1, t2, t3].map((t) => weekBefore(loopWeekOf(t))) as [string, string, string];
    const out = { scopes: {}, fleetOptOut: { at: "2026-12-01T00:00:00.000Z" } };
    // Reported in, then opted out for a week in which it makes 7 picks and 500 calls.
    seedWeek(lumen, w1, words("next_up", { made: 1 }));
    await heartbeat(lumen, row("ten_lumen"), state({ foldedThrough: w1 }), new FleetBuffer(), { db, controlDb: db, now: t1, usage });
    total = 505;
    seedWeek(lumen, w2, words("next_up", { made: 7 }, { r: { edit_mode: { plan: 1 } } }));
    const away = new FleetBuffer();
    await heartbeat(lumen, row("ten_lumen"), state({ lane: await readLaneState(lumen, db), pointers: out, foldedThrough: w2 }), away, { db, controlDb: db, now: t2, usage });
    expect(away.cells()).toEqual([{ id: fleetCellId.orgs(w2), n: { visited: 1 } }]);
    expect(await readLaneState(lumen, db)).toMatchObject({ heartbeatWeek: w2, optedOutThrough: w2 });
    // Back in: 2 more calls, and nothing made.
    total = 507;
    const back = new FleetBuffer();
    await heartbeat(lumen, row("ten_lumen"), state({ lane: await readLaneState(lumen, db), foldedThrough: w3 }), back, { db, controlDb: db, now: t3, usage });
    const cells = Object.fromEntries(back.cells().map((c) => [c.id, c.n]));
    expect(cells[fleetCellId.calls(w3)]).toBeUndefined();
    expect(cells[fleetCellId.kind("next_up", w3)]).toBeUndefined();
    expect(cells[fleetCellId.kind("edit_mode", w3)]).toBeUndefined();
    expect(cells[fleetCellId.orgs(w3)]).toMatchObject({ reported: 1, visited: 1 });
    expect(cells[fleetCellId.orgs(w3)]).not.toHaveProperty("refused");
    // The meter's totals are kept, so the next week counts only calls made since.
    expect(await readLaneState(lumen, db)).toMatchObject({ heartbeatWeek: w3, meterSeen: { blog_write: 507 } });
    // Two weeks on, the weeks it was out are still out of every window: the 7 picks never read as unused.
    total = 510;
    const t4 = at("2026-12-30T09:00:00.000Z");
    const w4 = weekBefore(loopWeekOf(t4));
    seedWeek(lumen, w4, words("next_up", { made: 1 }));
    const later = new FleetBuffer();
    await heartbeat(lumen, row("ten_lumen"), state({ lane: await readLaneState(lumen, db), foldedThrough: w4 }), later, { db, controlDb: db, now: t4, usage });
    const next = Object.fromEntries(later.cells().map((c) => [c.id, c.n]));
    expect(next[fleetCellId.calls(w4)]).toMatchObject({ calls: { blog_write: 3 } });
    expect(next[fleetCellId.kind("next_up", w4)]).not.toHaveProperty("unused");
  });

  it("reports a brand back after weeks it never reported (the switch was off) as a first report", async () => {
    vi.stubEnv("USAGE_METER_ENABLED", "true");
    const usage = async () => ({ model_tokens: { total: 0, calls: 0, lostCalls: 0, byPurpose: {}, callsByPurpose: { blog_write: 900 } } });
    // Last reported 8 weeks ago; made things in the weeks since, while nothing was reported.
    let old = W;
    for (let i = 0; i < 8; i++) old = weekBefore(old);
    for (let w = weekBefore(W), i = 0; i < 4; i++, w = weekBefore(w)) seedWeek(lumen, w, words("next_up", { made: 4 }));
    seedWeek(lumen, W, words("next_up", { made: 1 }));
    const lane = { heartbeatWeek: old, meterMonth: "2026-10", meterSeen: { blog_write: 10 } };
    const buffer = new FleetBuffer();
    const r = await heartbeat(lumen, row("ten_lumen"), state({ lane }), buffer, { db, controlDb: db, now: NOW, usage });
    expect(r.weeks).toBe(2);
    const cells = buffer.cells();
    // No calls from the weeks it was away, and no unused from the weeks before the first it reports.
    expect(cells.filter((c) => c.id.startsWith("fh:_calls:"))).toEqual([]);
    for (const c of cells.filter((x) => x.id.startsWith("fh:next_up:"))) expect(c.n).not.toHaveProperty("unused");
  });

  it("sends no week from before a brand's first report: image counts kept while only image style versions were on stay out", async () => {
    const img = { c: { [NATURAL]: { post_image: { v0: { none: { made: 4 } } } } }, r: { loop_learn: { budget: 1 } } };
    for (let w = weekBefore(W), i = 0; i < 3; i++, w = weekBefore(w)) seedWeek(lumen, w, img);
    const buffer = new FleetBuffer();
    expect(await heartbeat(lumen, row("ten_lumen"), state(), buffer, { db, controlDb: db, now: NOW })).toEqual({ weeks: 1, late: 0 });
    const cells = Object.fromEntries(buffer.cells().map((c) => [c.id, c.n]));
    expect(cells[fleetCellId.kind("image_style", W)]).toBeUndefined();
    expect(cells[fleetCellId.orgs(W)]).not.toHaveProperty("refused");
    // Kept, so no later report's window reaches back before it either.
    expect(await readLaneState(lumen, db)).toMatchObject({ heartbeatWeek: W, reportsFromWeek: W });
  });

  it("keeps where reporting started again after a gap, so the second visit's windows hold no gap week either", async () => {
    const back = (n: number) => {
      let w = W;
      for (let i = 0; i < n; i++) w = weekBefore(w);
      return w;
    };
    // Images made only in a week inside the gap, the week before the first one reported after it.
    seedWeek(lumen, back(4), { c: { [NATURAL]: { post_image: { v0: { none: { made: 4 } } } } } });
    const first = new FleetBuffer();
    expect((await heartbeat(lumen, row("ten_lumen"), state({ lane: { heartbeatWeek: back(8) } }), first, { db, controlDb: db, now: NOW })).weeks).toBe(2);
    const lane = await readLaneState(lumen, db);
    expect(lane).toMatchObject({ heartbeatWeek: back(2), reportsFromWeek: back(3) });
    const second = new FleetBuffer();
    expect((await heartbeat(lumen, row("ten_lumen"), state({ lane }), second, { db, controlDb: db, now: NOW })).weeks).toBe(2);
    for (const c of [...first.cells(), ...second.cells()]) expect(c.id, c.id).not.toMatch(/^fh:image_style:/);
    // The visit after keeps the week it started from.
    expect((await readLaneState(lumen, db)).reportsFromWeek).toBe(back(3));
  });

  it("counts no look in use while image style versions are off, whatever the pointers still hold", async () => {
    const pointers = { scopes: { [NATURAL]: { v: 1, setBy: "learned" as const, adoptedAt: "2026-10-01T00:00:00.000Z" } } };
    db.seed("loop_days", loopDayId.version(lumen.tenantId, NATURAL, 1), {
      tenantId: lumen.tenantId,
      d: { c: { post_image: { learned: { made: 20 } } }, looks: { "10": { call: "better" } } },
    });
    seedWeek(lumen, W, words("next_up", { made: 1 }));
    // Each run starts from the same lane and a mark of its own, so both report the week.
    const run = async () => {
      const buffer = new FleetBuffer();
      await heartbeat(lumen, row("ten_lumen"), state({ pointers }), buffer, { db, controlDb: new FakeFirestore(), now: NOW });
      return Object.fromEntries(buffer.cells().map((c) => [c.id, c.n]));
    };
    // Only LOOPS_ENABLED on: images use the brand record's look, so Image style reaches no stage.
    expect((await run())[fleetCellId.kind("image_style", W)]).toBeUndefined();
    // With versions on, the same pointers are a look in use that a check has read.
    vi.stubEnv("BRAND_STYLE_LOOP_ENABLED", "true");
    vi.stubEnv("BRAND_IMAGE_STYLE_ENABLED", "true");
    vi.stubEnv("IMAGE_STYLE_VERSIONS_ENABLED", "true");
    expect((await run())[fleetCellId.kind("image_style", W)]).toMatchObject({ st: { checked: { all: 1 } } });
  });

  it("records the week on the brand first, so a run cut off before the mark moves undercounts and never counts twice", async () => {
    seedWeek(lumen, W, words("next_up", { made: 2 }));
    const buffer = new FleetBuffer();
    const fails = new FakeFirestore();
    vi.spyOn(fails, "runTransaction").mockRejectedValue(new Error("unavailable"));
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(await heartbeat(lumen, row("ten_lumen"), state(), buffer, { db, controlDb: fails, now: NOW })).toEqual({ weeks: 1, late: 0 });
    // The brand was visited for the week; nothing it reported was credited.
    expect(buffer.cells()).toEqual([{ id: fleetCellId.orgs(W), n: { visited: 1 } }]);
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
    expect(mark.outputs["next_up/out/*/made"]).toBe(20);
    const cells = Object.fromEntries(buffer.cells().map((c) => [c.id, c.n]));
    expect(cells[fleetCellId.kind("next_up", W)]).toMatchObject({ orgs: 1, week: { orgs: 1 }, out: { none: { made: 20 } }, st: { stamped: { all: 1, p: { open: 1 }, i: { unknown: 1 } } } });
    expect(cells[fleetCellId.orgs(W)]).toEqual({ orgs: 1, p: { open: 1 }, i: { unknown: 1 }, reported: 1, visited: 1 });
  });
});
