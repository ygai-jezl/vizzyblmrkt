import { isoWeekStart, loopDayId, readLoopDays } from "@/lib/tenant/loops";
import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import { loopWeekOf } from "./count";
import { weekBefore } from "./fold";
import { LOOP_RULES } from "./registry";

/**
 * The attention rule (learning loops step 4, 3.5 and 3.11 of the plan for steps 4 and 5), read
 * from the counters in `loop_days` over the last 4 weeks, the open one included:
 * - Go back cards: when more than half of a kind's cards were left unanswered (ignored), the kind
 *   drops to a notice on the What it learned card, with "Resume suggestions", and the lane stops
 *   putting cards in Review (LOOP_RULES.noticeOnly). Only weeks since a person resumed count.
 * - The why behind a vote: when a brand gave no reason on 8 or more of every 10 thumbs down, over
 *   at least 10 of them, the reason row starts closed ("Say what's off") instead of open
 *   (LOOP_RULES.reasonFatigue). It never nags twice for one image either way.
 * Pure rules over counter trees, and one batched read for them. Server only for the read.
 */

type Tree = Record<string, unknown>;
const isObj = (v: unknown): v is Tree => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** One week's counters: its folded copy's `d`, or its shards' `d`s while it isn't folded yet. */
export interface WeekCounts {
  week: string;
  ds: unknown[];
}

export interface CardAttention {
  acted: number;
  declined: number;
  ignored: number;
  /** More than half the cards were left unanswered: suggestions drop to a notice. */
  noticeOnly: boolean;
}

/** Go back cards for a kind (the image learner's, `loop_learn`) over the weeks given. */
export function cardAttention(weeks: readonly WeekCounts[], kind = "loop_learn"): CardAttention {
  let acted = 0;
  let declined = 0;
  let ignored = 0;
  for (const w of weeks) {
    for (const d of w.ds) {
      const k = isObj(d) && isObj(d.k) && isObj(d.k[kind]) ? (d.k[kind] as Tree) : {};
      acted += num(k.acted);
      declined += num(k.declined);
      ignored += num(k.ignored);
    }
  }
  const total = acted + declined + ignored;
  return { acted, declined, ignored, noticeOnly: total > 0 && ignored / total > LOOP_RULES.noticeOnly.ignoredShare };
}

export interface ReasonAttention {
  /** Thumbs down on images YouGrow made, net of changed votes. */
  downVotes: number;
  /** Of those, the ones given a reason. */
  withReason: number;
  /** The reason row starts closed. */
  startClosed: boolean;
}

/**
 * Thumbs down and their reasons on images YouGrow made, over the weeks given: every `c` leaf's
 * voted less liked, and its `disliked.<reason>` leaves. A person's own images (uploads) count no
 * reasons, so they are left out.
 */
export function reasonAttention(weeks: readonly WeekCounts[]): ReasonAttention {
  let down = 0;
  let withReason = 0;
  const walk = (node: unknown) => {
    if (!isObj(node)) return;
    if (typeof node.voted === "number" || typeof node.liked === "number") {
      down += num(node.voted) - num(node.liked);
      for (const [key, n] of Object.entries(node)) if (key.startsWith("disliked.")) withReason += num(n);
      return;
    }
    for (const child of Object.values(node)) walk(child);
  };
  for (const w of weeks) for (const d of w.ds) if (isObj(d)) walk(d.c);
  const downVotes = Math.max(0, down);
  const skipped = Math.max(0, downVotes - withReason);
  const rule = LOOP_RULES.reasonFatigue;
  return { downVotes, withReason, startClosed: downVotes >= rule.downVotes && skipped / downVotes >= rule.skipped };
}

/**
 * The last `weeks` weeks of a brand's counters, the open one first: each closed week's folded copy,
 * or its shards when the fold hasn't reached it yet, and the open week's shards. One batched read.
 */
export async function readRecentWeeks(ctx: TenantContext, opts: { now: Date; weeks: number; db?: FirestoreLike }): Promise<WeekCounts[]> {
  const weeks: string[] = [];
  for (let w = loopWeekOf(opts.now); weeks.length < opts.weeks; w = weekBefore(w)) weeks.push(w);
  const shardIds = (w: string) => Array.from({ length: LOOP_RULES.shards }, (_, i) => loopDayId.week(ctx.tenantId, w, i));
  const ids = weeks.flatMap((w, i) => (i === 0 ? shardIds(w) : [loopDayId.folded(ctx.tenantId, w), ...shardIds(w)]));
  const docs = await readLoopDays(ctx, ids, opts.db);
  const out: WeekCounts[] = [];
  let at = 0;
  weeks.forEach((w, i) => {
    if (i === 0) {
      out.push({ week: w, ds: docs.slice(0, LOOP_RULES.shards).map((d) => d?.d) });
      at = LOOP_RULES.shards;
      return;
    }
    const folded = docs[at];
    const shards = docs.slice(at + 1, at + 1 + LOOP_RULES.shards);
    at += 1 + LOOP_RULES.shards;
    out.push({ week: w, ds: folded ? [folded.d] : shards.map((d) => d?.d) });
  });
  return out;
}

/** Both attention rules for a brand, from its last LOOP_RULES.noticeOnly.weeks weeks. */
export async function readAttention(
  ctx: TenantContext,
  opts: { now: Date; cardsResumedAt?: string | null; db?: FirestoreLike },
): Promise<{ cards: CardAttention; reasons: ReasonAttention }> {
  const all = await readRecentWeeks(ctx, { now: opts.now, weeks: Math.max(LOOP_RULES.noticeOnly.weeks, LOOP_RULES.reasonFatigue.weeks), db: opts.db });
  const since = opts.cardsResumedAt ? Date.parse(opts.cardsResumedAt) : null;
  const cardWeeks = all.slice(0, LOOP_RULES.noticeOnly.weeks).filter((w) => since === null || isoWeekStart(w.week).getTime() >= since);
  return { cards: cardAttention(cardWeeks), reasons: reasonAttention(all.slice(0, LOOP_RULES.reasonFatigue.weeks)) };
}
