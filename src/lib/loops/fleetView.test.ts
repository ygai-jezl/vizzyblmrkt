import { afterEach, describe, expect, it, vi } from "vitest";
import { aiTellsIn, dashesIn } from "@/lib/content/writingRules";
import { addToFleetCells, fleetCellId } from "@/lib/tenant/fleetCells";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { brandWeekReport, creditMark, FleetBuffer } from "./heartbeat";
import { kindView, namedCount, orgsView, ORG_COUNTS_BELOW_FLOOR, roundTwo, showsThings } from "./fleetView";
import { LOOP_RULES } from "./registry";
import { usedAcrossBrands, USED_NOTE } from "./used";

/**
 * The floors on the counts across brands (learning loops step 5, 4.7): numbers of things from 10
 * organisations, counts of organisations below 10 for the people who run the copy (question 4).
 */

const W = "2026-W50";

/** The counts many organisations' reports add up to, through their marks, as the lane would write them. */
function rowsFrom(reports: Array<{ week?: string; window: unknown[]; plan: string; looks?: Parameters<typeof brandWeekReport>[0]["looks"] }>): Map<string, Record<string, unknown>> {
  const buffer = new FleetBuffer();
  for (const r of reports) {
    const report = brandWeekReport({ week: r.week ?? W, window: r.window, looks: r.looks ?? [], plan: r.plan, industry: "unknown", calls: {}, oldCopy: false });
    const c = creditMark(null, report, "t");
    if (c.late) continue;
    for (const k of c.orgCells) buffer.add(report.week, k, 1);
    for (const [k, n] of Object.entries(c.things)) buffer.add(report.week, k, n);
  }
  return new Map(buffer.cells().map((x) => [x.id, x.n as Record<string, unknown>]));
}

const memoryBank = (learned: boolean) => {
  const week = { c: { edit_mode: { edit_mode: { v0: { none: { made: 3 } } } } }, r: { edit_mode: learned ? { learned: 1 } : { plan: 2 } } };
  return [week, week, week, week];
};

afterEach(() => vi.unstubAllEnvs());

describe("the floors", () => {
  it("shows numbers of things only from 10 organisations, and rounds them to 2 significant figures", () => {
    expect(LOOP_RULES.cellOrgs).toBe(10);
    expect(showsThings(9)).toBe(false);
    expect(showsThings(10)).toBe(true);
    expect([roundTwo(1_234), roundTwo(87), roundTwo(5), roundTwo(0), roundTwo(99_500)]).toEqual([1_200, 87, 5, 0, 100_000]);
  });

  it("hides made, kept, liked and declined counts, and the wait, under 10 organisations, and shows them from 10", () => {
    const nine = rowsFrom(Array.from({ length: 9 }, () => ({ window: [undefined, undefined, undefined, { c: { next_up: { next_up: { v0: { none: { made: 3, kept: 1 } } } } } }], plan: "pro" })));
    const v9 = kindView(nine.get(fleetCellId.kind("next_up", W)));
    expect(v9.orgs).toBe(9);
    expect(v9.things).toBeNull();
    // Nobody waits for a check on Next up.
    expect(v9.waiting).toEqual({ orgs: 0, longestMonths: null });
    // Counts of organisations still show below 10, to the people who run the copy.
    expect(v9.stages.stamped).toBe(9);
    expect(v9.plans.pro?.reached.stamped).toBe(9);

    const ten = rowsFrom(Array.from({ length: 10 }, () => ({ window: [undefined, undefined, undefined, { c: { next_up: { next_up: { v0: { none: { made: 3, kept: 1 } } } } } }], plan: "pro" })));
    const v10 = kindView(ten.get(fleetCellId.kind("next_up", W)));
    expect(v10.things?.out).toEqual({ none: { made: 30, kept: 10 } });
    expect(v10.things?.coverage).toBe(1);
  });

  it("floors this week's numbers on the organisations whose week has them: one organisation's week never shows behind 9 that made things earlier", () => {
    const earlier = { c: { "image_style.natural_photo": { post_image: { v1: { learned: { made: 2 } } } } } };
    const now = { c: { "image_style.natural_photo": { post_image: { v1: { learned: { made: 7, voted: 5, liked: 1, "disliked.looks_fake": 4 } } } } } };
    const rows = rowsFrom([
      ...Array.from({ length: 9 }, () => ({ window: [earlier, undefined, undefined, undefined], plan: "free" })),
      { window: [undefined, undefined, undefined, now], plan: "free" },
    ]);
    const v = kindView(rows.get(fleetCellId.kind("image_style", W)));
    expect(v.orgs).toBe(10);
    expect(v.weekOrgs).toBe(1);
    expect(v.things).toBeNull();
    expect(v.styleOrgs).toEqual({ natural_photo: 1 });
  });

  it("shows the longest wait for a check only from 10 organisations that wait", () => {
    const looks = [{ scope: "image_style.natural_photo", adoptedAt: "2026-09-01T00:00:00.000Z", checked: false }];
    const made = { c: { "image_style.natural_photo": { post_image: { v1: { learned: { made: 1 } } } } } };
    const three = rowsFrom(Array.from({ length: 12 }, (_, i) => ({ window: [undefined, undefined, undefined, made], plan: "free", looks: i < 3 ? looks : [] })));
    expect(kindView(three.get(fleetCellId.kind("image_style", W))).waiting).toBeNull();
    const ten = rowsFrom(Array.from({ length: 12 }, (_, i) => ({ window: [undefined, undefined, undefined, made], plan: "free", looks: i < 10 ? looks : [] })));
    expect(kindView(ten.get(fleetCellId.kind("image_style", W))).waiting).toMatchObject({ orgs: 10 });
  });

  it("counts an organisation once in a step's total even when its brands count under two plans", () => {
    const buffer = new FleetBuffer();
    let mark: Parameters<typeof creditMark>[0] = null;
    for (const plan of ["pro", "granted"]) {
      const report = brandWeekReport({ week: W, window: [undefined, undefined, undefined, { c: { next_up: { next_up: { v0: { none: { made: 1 } } } } } }], looks: [], plan, industry: "unknown", calls: {}, oldCopy: false });
      const c = creditMark(mark, report, "t");
      if (c.late) throw new Error("late");
      mark = c.mark;
      for (const k of c.orgCells) buffer.add(W, k, 1);
    }
    const v = kindView(buffer.cells().find((x) => x.id === fleetCellId.kind("next_up", W))!.n);
    expect(v.orgs).toBe(1);
    expect(v.stages.stamped).toBe(1);
    // Each plan's row still holds it.
    expect([v.plans.pro?.reached.stamped, v.plans.granted?.reached.stamped]).toEqual([1, 1]);
  });

  it("shows counts of organisations below 10 in exactly the four places question 4 names", () => {
    expect(ORG_COUNTS_BELOW_FLOOR).toEqual(["stages", "stuck", "refused", "cards"]);
    const two = rowsFrom([
      { window: memoryBank(false), plan: "pro" },
      { window: [undefined, { k: { loop_learn: { proposed: 1 } } }, undefined, undefined], plan: "pro" },
    ]);
    const mb = kindView(two.get(fleetCellId.kind("edit_mode", W)));
    expect(mb.refused).toEqual({ plan: 1 });
    expect(mb.plans.pro?.stuck.signalled).toBe(1);
    expect(kindView(two.get(fleetCellId.kind("image_style", W))).cardOrgs).toBe(1);
  });
});

describe("stuck per plan", () => {
  it("reads a whole plan stuck at Signalled with none learning as amber, with its top refusal reason: the Memory Bank shape", () => {
    const rows = rowsFrom([
      ...Array.from({ length: 3 }, () => ({ window: memoryBank(false), plan: "pro" })),
      ...Array.from({ length: 2 }, () => ({ window: memoryBank(true), plan: "ultra" })),
    ]);
    const v = kindView(rows.get(fleetCellId.kind("edit_mode", W)));
    expect(v.plans.pro).toEqual({
      reached: { stamped: 3, signalled: 3, learning: 0, checked: 0 },
      stuck: { stamped: 0, signalled: 3 },
      topReason: { signalled: "plan" },
      why: { stamped: {}, signalled: { plan: 3 } },
      amber: ["signalled"],
    });
    expect(v.plans.ultra).toMatchObject({ reached: { learning: 2 }, stuck: { signalled: 0 }, amber: [] });
    // Free has no Vizzy in Edit mode, so it never reaches Stamped: no row at all.
    expect(v.plans.free).toBeUndefined();
  });

  it("counts a partial stall, 2 of 3 organisations, as 2 and not amber", () => {
    const rows = rowsFrom([{ window: memoryBank(false), plan: "pro" }, { window: memoryBank(false), plan: "pro" }, { window: memoryBank(true), plan: "pro" }]);
    const v = kindView(rows.get(fleetCellId.kind("edit_mode", W)));
    expect(v.plans.pro).toMatchObject({ reached: { signalled: 3, learning: 1 }, stuck: { signalled: 2 }, amber: [] });
  });
});

describe("industries and the copy's own row", () => {
  it("splits by industry only where an industry and the rest both have 10 organisations, so Unknown alone never splits", () => {
    const rows = rowsFrom(Array.from({ length: 12 }, () => ({ window: [undefined, undefined, undefined, { c: { next_up: { next_up: { v0: { none: { made: 1 } } } } } }], plan: "free" })));
    expect(kindView(rows.get(fleetCellId.kind("next_up", W))).industries).toEqual({});
    const mixed = { orgs: 25, st: { stamped: { all: 25, p: { free: 25 }, i: { unknown: 12, bakery: 13 } } } };
    expect(Object.keys(kindView(mixed).industries).sort()).toEqual(["bakery", "unknown"]);
    const o = orgsView({ orgs: 12, p: { free: 12 }, i: { unknown: 12 }, visited: 18, reported: 14, listed: 20, late: 1, oldCopy: 2, foldBehind: { w7: 1, w10: 1 }, refused: { plan: 3 } });
    expect(o).toEqual({
      orgs: 12,
      plans: { free: 12 },
      industries: {},
      industryCounts: { unknown: 12 },
      visited: 18,
      reported: 14,
      listed: 20,
      late: 1,
      oldCopy: 2,
      foldBehindWeeks: 10,
      refused: { plan: 3 },
    });
    // The table shows each industry from 10 organisations, Unknown alone included; below 10 it is null.
    expect(orgsView({ orgs: 21, i: { unknown: 12, bakery: 9 } }).industryCounts).toEqual({ unknown: 12, bakery: null });
  });

  it("hides a type's or a purpose's count under 10 organisations", () => {
    expect(namedCount({ orgs: { content_plan: 9 }, made: { content_plan: 40 } }, "types", "content_plan")).toEqual({ orgs: 9, count: null });
    expect(namedCount({ orgs: { blog_write: 11 }, calls: { blog_write: 1_234 } }, "calls", "blog_write")).toEqual({ orgs: 11, count: 1_200 });
  });
});

describe("Work's Used counts", () => {
  it("reads nothing with LOOPS_ENABLED off", async () => {
    const db = new FakeFirestore();
    expect(await usedAcrossBrands({ loopKind: "next_up" }, [W], { db })).toEqual({ off: "loops_off" });
    expect(db.collectionCalls("fleet_cells")).toBe(0);
  });

  it("reads closed weeks by id, with made added up before rounding and nothing below 10 organisations", async () => {
    vi.stubEnv("LOOPS_ENABLED", "true");
    const db = new FakeFirestore();
    await addToFleetCells(
      [
        { id: fleetCellId.kind("image_style", W), n: { orgs: 14, week: { orgs: 13 }, made: { orgs: 12 }, out: { learned: { made: 117 }, holdback: { made: 8 } } } },
        // 11 organisations over the 28 days, 10 with numbers this week, but only 4 made images: the floor is theirs.
        { id: fleetCellId.kind("image_style", "2026-W49"), n: { orgs: 11, week: { orgs: 10 }, made: { orgs: 4 }, out: { learned: { made: 30 } } } },
        { id: fleetCellId.types(W), n: { orgs: { content_plan: 10 }, made: { content_plan: 64 } } },
      ],
      db,
    );
    const kind = await usedAcrossBrands({ loopKind: "post_image" }, [W, "2026-W49", "not a week"], { db });
    expect(kind).toEqual({ note: USED_NOTE, weeks: [{ week: "2026-W49", orgs: 4, count: null }, { week: W, orgs: 12, count: 130 }] });
    expect(await usedAcrossBrands({ type: "content_plan" }, [W], { db })).toEqual({ note: USED_NOTE, weeks: [{ week: W, orgs: 10, count: 64 }] });
    expect(await usedAcrossBrands({ purpose: "blog_write" }, [W], { db })).toEqual({ note: USED_NOTE, weeks: [{ week: W, orgs: 0, count: null }] });
    expect([...dashesIn(USED_NOTE), ...aiTellsIn(USED_NOTE)]).toEqual([]);
  });

  it("floors a kind's made count on the organisations that made it that week, never on those with only answers or unused things", async () => {
    vi.stubEnv("LOOPS_ENABLED", "true");
    const db = new FakeFirestore();
    const made = (n: number) => ({ c: { next_up: { next_up: { v0: { none: { made: n } } } } } });
    const kept = { c: { next_up: { next_up: { v0: { none: { kept: 1 } } } } } };
    // Hearth Bakery makes 20 this week. Nine others made 3 two weeks before, left unused, and one of them kept one this week.
    const rows = rowsFrom([
      { window: [undefined, undefined, undefined, made(20)], plan: "free" },
      ...Array.from({ length: 9 }, (_, i) => ({ window: [undefined, made(3), undefined, i === 0 ? kept : undefined], plan: "free" })),
    ]);
    const n = rows.get(fleetCellId.kind("next_up", W))!;
    expect(n).toMatchObject({ week: { orgs: 10 }, made: { orgs: 1 }, cov: { orgs: 1 }, out: { none: { made: 20 } } });
    expect(kindView(n)).toMatchObject({ weekOrgs: 10, madeOrgs: 1, covOrgs: 1 });
    await addToFleetCells([{ id: fleetCellId.kind("next_up", W), n: n as never }], db);
    expect(await usedAcrossBrands({ loopKind: "next_up" }, [W], { db })).toEqual({ note: USED_NOTE, weeks: [{ week: W, orgs: 1, count: null }] });
  });
});
