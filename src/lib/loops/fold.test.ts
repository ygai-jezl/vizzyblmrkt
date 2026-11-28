import { beforeEach, describe, expect, it } from "vitest";
import { addToLoopDay, LOOP_DAYS, loopDayId, loopDayTtlAt, readLaneState, readLoopDays } from "@/lib/tenant/loops";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { TenantContext } from "@/lib/tenant/types";
import { VersionTotalsSchema } from "@/lib/types/loopDay";
import { loopWeekOf } from "./count";
import { foldClosedWeeks, lastClosedWeek, oldestKeptWeek, versionAdds, weekAfter, weekBefore } from "./fold";

/** The fold (learning loops step 4, 4.5): closed weeks into `lt:` and the learning versions' `lv:`, once. */

const hearth: TenantContext = { tenantId: "ten_hearth", region: "us", source: "system" };
const lumen: TenantContext = { tenantId: "ten_lumen", region: "eu", source: "system" };
const NOW = new Date("2026-12-16T09:00:00.000Z");
const NATURAL = "image_style.natural_photo";

let db: FakeFirestore;
beforeEach(() => {
  db = new FakeFirestore();
});

const shard = (ctx: TenantContext, week: string, n: number, tree: Record<string, unknown>) =>
  addToLoopDay(ctx, loopDayId.week(ctx.tenantId, week, n), tree as never, { ttlAt: loopDayTtlAt("week", week) }, db);

describe("weeks", () => {
  it("steps across a year's end, and keeps 10 weeks of shards", () => {
    expect(weekAfter("2026-W53")).toBe("2027-W01");
    expect(weekBefore("2027-W01")).toBe("2026-W53");
    expect(lastClosedWeek(NOW)).toBe(weekBefore(loopWeekOf(NOW)));
    let w = oldestKeptWeek(NOW);
    let n = 1;
    while (w !== lastClosedWeek(NOW)) {
      w = weekAfter(w);
      n++;
    }
    expect(n).toBe(10);
  });

  it("adds a week's learning scopes into their versions, and nothing else", () => {
    const adds = versionAdds({
      c: {
        [NATURAL]: { post_image: { v1: { learned: { made: 2, liked: 1 } }, v0: { none: { made: 1 } } } },
        "image_style.headline_card": { post_image: { v0: { none: { made: 3 } } } },
      },
    });
    expect([...adds.keys()].sort()).toEqual([`${NATURAL}|0`, `${NATURAL}|1`]);
    expect(adds.get(`${NATURAL}|1`)).toEqual({ post_image: { learned: { made: 2, liked: 1 } } });
  });
});

describe("foldClosedWeeks", () => {
  const last = lastClosedWeek(NOW);
  const before = weekBefore(last);

  it("folds each closed week once, with its time to live, into lt: and lv:, own images too", async () => {
    await shard(hearth, last, 0, { c: { [NATURAL]: { post_image: { v1: { learned: { made: 2, voted: 1, liked: 1, "liked.colours": 1 } } } } }, o: { image: { voted: 1, liked: 1 } } });
    await shard(hearth, last, 3, { c: { [NATURAL]: { post_image: { v1: { learned: { made: 1 } } } } }, r: { loop_learn: { learned: 1 } } });
    await shard(hearth, before, 1, { c: { [NATURAL]: { blog_hero: { v1: { learned: { made: 4 } } } } } });
    // The open week is never folded.
    await shard(hearth, loopWeekOf(NOW), 2, { c: { [NATURAL]: { post_image: { v1: { learned: { made: 9 } } } } } });
    // Another brand's counts stay its own.
    await shard(lumen, last, 0, { c: { [NATURAL]: { post_image: { v1: { learned: { made: 50 } } } } } });

    const r = await foldClosedWeeks(hearth, undefined, { db, now: NOW });
    expect(r.folded).toBe(2);
    expect(r.foldedThrough).toBe(last);

    const [lt, ltBefore, lv] = await readLoopDays(hearth, [loopDayId.folded("ten_hearth", last), loopDayId.folded("ten_hearth", before), loopDayId.version("ten_hearth", NATURAL, 1)], db);
    expect(lt?.d).toEqual({
      c: { [NATURAL]: { post_image: { v1: { learned: { made: 3, voted: 1, liked: 1, "liked.colours": 1 } } } } },
      o: { image: { voted: 1, liked: 1 } },
      r: { loop_learn: { learned: 1 } },
    });
    expect((db.raw(LOOP_DAYS, loopDayId.folded("ten_hearth", last))?.ttlAt as Date).toISOString()).toBe(loopDayTtlAt("folded", last).toISOString());
    expect(ltBefore?.d).toEqual({ c: { [NATURAL]: { blog_hero: { v1: { learned: { made: 4 } } } } } });
    const totals = VersionTotalsSchema.parse(lv?.d);
    expect(totals.throughWeek).toBe(last);
    expect(totals.c).toEqual({ post_image: { learned: { made: 3, voted: 1, liked: 1, "liked.colours": 1 } }, blog_hero: { learned: { made: 4 } } });
    expect((await readLaneState(hearth, db)).foldedThrough).toBe(last);

    // A rerun adds nothing, and nor does a fold from an older mark.
    expect((await foldClosedWeeks(hearth, last, { db, now: NOW })).folded).toBe(0);
    expect((await foldClosedWeeks(hearth, before, { db, now: NOW })).folded).toBe(0);
    const [again] = await readLoopDays(hearth, [loopDayId.version("ten_hearth", NATURAL, 1)], db);
    expect(VersionTotalsSchema.parse(again?.d).c.post_image?.learned?.made).toBe(3);
  });

  it("keeps the version's own check and reads when it adds counts", async () => {
    db.seed(LOOP_DAYS, loopDayId.version("ten_hearth", NATURAL, 1), { tenantId: "ten_hearth", d: { c: {}, check: { counted: 4, settled: false, at: NOW.toISOString() } } });
    await shard(hearth, last, 0, { c: { [NATURAL]: { post_image: { v1: { learned: { made: 1 } } } } } });
    await foldClosedWeeks(hearth, before, { db, now: NOW });
    const [lv] = await readLoopDays(hearth, [loopDayId.version("ten_hearth", NATURAL, 1)], db);
    expect(VersionTotalsSchema.parse(lv?.d).check?.counted).toBe(4);
  });

  it("moves the mark over weeks with no counts, and says how far behind it was", async () => {
    const r = await foldClosedWeeks(hearth, undefined, { db, now: NOW });
    expect(r.folded).toBe(0);
    expect(r.foldedThrough).toBe(last);
    expect(r.behindDays).toBeGreaterThan(60);
    // Only the lane's own state was written.
    expect(db.dump(LOOP_DAYS)).toHaveLength(1);
    expect((await readLaneState(hearth, db)).foldedThrough).toBe(last);
  });
});
