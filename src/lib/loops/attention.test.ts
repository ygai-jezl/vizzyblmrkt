import { beforeEach, describe, expect, it } from "vitest";
import { addToLoopDay, loopDayId, loopDayTtlAt, setLoopDayTx, runLoopsTransaction } from "@/lib/tenant/loops";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { TenantContext } from "@/lib/tenant/types";
import { cardAttention, readAttention, readRecentWeeks, reasonAttention } from "./attention";
import { loopWeekOf } from "./count";
import { weekBefore } from "./fold";

/** The attention rule (learning loops step 4, 3.5 and 3.11): cards to a notice, and the reason row closed. */

const hearth: TenantContext = { tenantId: "ten_hearth", region: "us", source: "system" };
const NOW = new Date("2026-12-16T09:00:00.000Z");
const NATURAL = "image_style.natural_photo";
const week = (counts: Record<string, unknown>) => ({ week: "2026-W50", ds: [counts] });

let db: FakeFirestore;
beforeEach(() => {
  db = new FakeFirestore();
});

describe("cardAttention", () => {
  it("drops to a notice when more than half the cards went unanswered", () => {
    expect(cardAttention([week({ k: { loop_learn: { proposed: 3, ignored: 2, acted: 1 } } })]).noticeOnly).toBe(true);
    expect(cardAttention([week({ k: { loop_learn: { ignored: 1, declined: 1 } } })]).noticeOnly).toBe(false);
    expect(cardAttention([]).noticeOnly).toBe(false);
    // Another kind's cards don't count.
    expect(cardAttention([week({ k: { edit_mode: { ignored: 5 } } })]).noticeOnly).toBe(false);
  });
});

describe("reasonAttention", () => {
  const down = (voted: number, liked: number, reasons: Record<string, number>) => week({ c: { [NATURAL]: { post_image: { v1: { learned: { voted, liked, ...reasons } } } } } });

  it("closes the reason row when 8 of 10 or more thumbs down came with no reason", () => {
    expect(reasonAttention([down(12, 2, { "disliked.wrong_mood": 2 })]).startClosed).toBe(true);
    expect(reasonAttention([down(12, 2, { "disliked.wrong_mood": 3 })]).startClosed).toBe(false);
    // Fewer than 10 thumbs down never close it.
    expect(reasonAttention([down(9, 0, {})]).startClosed).toBe(false);
    // Reasons on likes don't count as reasons on thumbs down.
    expect(reasonAttention([down(12, 2, { "liked.colours": 2 })]).withReason).toBe(0);
  });
});

describe("readRecentWeeks and readAttention", () => {
  it("reads the open week's shards, and each earlier week folded or not, in one read", async () => {
    const open = loopWeekOf(NOW);
    const last = weekBefore(open);
    const older = weekBefore(last);
    await addToLoopDay(hearth, loopDayId.week("ten_hearth", open, 0), { k: { loop_learn: { ignored: 1 } } }, { ttlAt: loopDayTtlAt("week", open) }, db);
    // Last week isn't folded yet: its shards are read.
    await addToLoopDay(hearth, loopDayId.week("ten_hearth", last, 2), { k: { loop_learn: { ignored: 1 } } }, { ttlAt: loopDayTtlAt("week", last) }, db);
    // The week before is folded: its folded copy is read, not its shards.
    await runLoopsTransaction(hearth, async (txn) => setLoopDayTx(txn, hearth, loopDayId.folded("ten_hearth", older), { k: { loop_learn: { acted: 1 } } }, {}, db), db);
    await addToLoopDay(hearth, loopDayId.week("ten_hearth", older, 1), { k: { loop_learn: { acted: 1 } } }, { ttlAt: loopDayTtlAt("week", older) }, db);

    const weeks = await readRecentWeeks(hearth, { now: NOW, weeks: 4, db });
    expect(weeks.map((w) => w.week)).toEqual([open, last, older, weekBefore(older)]);
    const a = await readAttention(hearth, { now: NOW, db });
    expect(a.cards).toMatchObject({ ignored: 2, acted: 1, noticeOnly: true });
    // After a person resumed suggestions, only weeks since count.
    expect((await readAttention(hearth, { now: NOW, cardsResumedAt: NOW.toISOString(), db })).cards.noticeOnly).toBe(false);
  });
});
