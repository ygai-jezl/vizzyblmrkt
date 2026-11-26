import { isoWeekOf } from "@/lib/connectors/period";
import { isImageStyleVersionsOn } from "@/lib/content/imageStyle/flags";
import { addToLoopDay, loopDayId, loopDayTtlAt } from "@/lib/tenant/loops";
import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import { LOOP_SIGNALS, type CounterTree, type LoopSignal } from "@/lib/types/loopDay";
import { LoopStampSchema, UNSTAMPED_REASONS, type LoopStamp, type Made, type UnstampedReason } from "@/lib/types/loopStamp";
import { LEARN_REASONS, type LearnReason } from "./learnLog";
import { isImageKind } from "./read";
import { isVoteReason } from "./reasons";
import { LOOP_RULES, LOOPS, type LoopKind } from "./registry";
import { STAMP_REFUSALS, type StampRefusal } from "./stamp";

/**
 * The Count step (learning loops step 4, 3.1 of the plan for steps 4 and 5): what happened to the
 * things YouGrow made, added to the brand's week in `loop_days` (src/lib/tenant/loops.ts). Each
 * count is one merged write of increments to one of the week's LOOP_RULES.shards shards, picked
 * at random: never a read, never a transaction, and it never fails the work it counts (the
 * meter's rule), so a count that can't be written is logged and let go.
 *
 * Under the shard's `d`:
 * - `c.<scope>.<kind>.v<v>.<arm>.<signal>`: a made thing's signals, by its stamp. The signals are
 *   LOOP_SIGNALS, plus `liked.<reason>` and `disliked.<reason>` for the why behind a vote (3.11),
 *   keyed by VOTE_REASONS (./reasons.ts). A changed vote adds a negative amount, so each thing
 *   counts once whatever week it moved in.
 * - `t.<type>.made`: made, by ontology type.
 * - `u.<kind>.<reason>`: saved with no stamp, by UNSTAMPED_REASONS, plus `stamp_lost` (a record
 *   lost after its output was used) and `token_<refusal>` (a stamp token a save brought back that
 *   was refused).
 * - `r.<kind>.<outcome>`: what a learner did, `learned` or a LEARN_REASONS refusal.
 * - `k.<kind>.<signal>`: what happened to a learning card.
 * - `o.image.<signal>`: votes on a person's own images (uploads), which no kind made, so they have
 *   no stamp: voted and liked only. The votes learner reads their likes, as every image teaches
 *   the brand look, so a new upload is noticed without reading image rows.
 *
 * Decision 22: image kinds (and the image learner's own loop_learn) count only with
 * IMAGE_STYLE_VERSIONS_ENABLED on; every other kind counts nothing until step 5 brings
 * LOOPS_ENABLED. Notes and words are never counted. Server only.
 */

const KIND_KEY = /^[a-z0-9_]+(?:\.[a-z0-9_]+)?$/;

/** Whether this kind's counts are written at all (decision 22). */
export function countsFor(kind: LoopKind): boolean {
  // Step 5 turns every other kind on behind LOOPS_ENABLED.
  if (isImageKind(kind) || kind === "loop_learn") return isImageStyleVersionsOn();
  return false;
}

/** A made thing's signal, or the why behind a vote: `liked.<reason>` or `disliked.<reason>`. */
export type CountedSignal = LoopSignal | `liked.${string}` | `disliked.${string}`;

const REASON_SIGNAL = /^(liked|disliked)\.([a-z_]+)$/;

/** Whether a signal can be counted for this kind: a LOOP_SIGNALS key, or a reason this kind's votes can carry in that direction. */
export function isCountedSignal(kind: LoopKind, signal: string): signal is CountedSignal {
  if ((LOOP_SIGNALS as readonly string[]).includes(signal)) return true;
  const m = REASON_SIGNAL.exec(signal);
  // Only image votes carry reasons until step 7 adds them for posts and drafts.
  return Boolean(m && isImageKind(kind) && isVoteReason("image", m[1] === "liked" ? "up" : "down", m[2]!));
}

/** Why a saved thing has no stamp, as counted: an UNSTAMPED_REASONS key, a stamp lost, or a refused token. */
export const UNSTAMPED_COUNTS = [...UNSTAMPED_REASONS, "stamp_lost", ...STAMP_REFUSALS.map((r) => `token_${r}` as const)] as const;
export type UnstampedCount = UnstampedReason | "stamp_lost" | `token_${StampRefusal}`;

/** What a learner did, as counted. */
export type LearnOutcome = "learned" | LearnReason;
const LEARN_OUTCOMES: readonly string[] = ["learned", ...LEARN_REASONS];

/** What happened to a learning card (Go back cards from step 4; the attention rule reads these). */
export const CARD_SIGNALS = ["proposed", "expired", "acted", "declined", "ignored"] as const;
export type CardSignal = (typeof CARD_SIGNALS)[number];

export interface CountDeps {
  db?: FirestoreLike;
  /** The time the count belongs to, which picks the week. */
  now?: Date;
  /** A number from 0 up to 1 that picks the shard; Math.random by default. */
  random?: () => number;
}

/** The week a moment falls in, as `loop_days` names it: `2026-W48`. */
export const loopWeekOf = (now: Date): string => isoWeekOf(now.toISOString().slice(0, 10));

/** One of the week's shards, at random. */
export function shardOf(random: () => number = Math.random): number {
  const n = Math.floor(random() * LOOP_RULES.shards);
  return Number.isInteger(n) && n >= 0 && n < LOOP_RULES.shards ? n : 0;
}

/** Amounts worth writing: whole, finite and not zero. */
function amounts<K extends string>(deltas: Partial<Record<K, number>>, keep: (key: string) => boolean): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, n] of Object.entries(deltas) as Array<[string, number | undefined]>) {
    if (typeof n === "number" && Number.isInteger(n) && n !== 0 && keep(k)) out[k] = n;
  }
  return out;
}

const isLoopKind = (k: string): k is LoopKind => Object.prototype.hasOwnProperty.call(LOOPS, k);

/** Add to this week's counters in one shard. Never throws. */
async function addToWeek(ctx: TenantContext, kind: LoopKind, tree: CounterTree, what: string, deps: CountDeps): Promise<void> {
  if (!isLoopKind(kind) || !countsFor(kind)) return;
  try {
    const week = loopWeekOf(deps.now ?? new Date());
    await addToLoopDay(ctx, loopDayId.week(ctx.tenantId, week, shardOf(deps.random)), tree, { ttlAt: loopDayTtlAt("week", week) }, deps.db);
  } catch (err) {
    // A count never fails the work it counts: the meter's rule.
    console.warn(`[loops] counting ${what} for ${kind} failed`, err instanceof Error ? err.message.slice(0, 200) : "error");
  }
}

/** A stamp whose parts can name counters, or null (with a warning) for one that can't. */
function countableStamp(stamp: LoopStamp): LoopStamp | null {
  const p = LoopStampSchema.safeParse(stamp);
  if (p.success && KIND_KEY.test(p.data.kind)) return p.data as LoopStamp;
  console.warn("[loops] a count was given a stamp it can't use, so nothing was counted");
  return null;
}

/**
 * Add to a made thing's signals by its stamp, in one write: `{ voted: 1, liked: 1 }`, or a changed
 * vote's `{ liked: -1, "liked.colours": -1 }`. Signals this kind can't carry are left out.
 */
export async function countSignals(ctx: TenantContext, stamp: LoopStamp, deltas: Partial<Record<CountedSignal, number>>, deps: CountDeps = {}): Promise<void> {
  const s = countableStamp(stamp);
  if (!s) return;
  const add = amounts(deltas, (k) => isCountedSignal(s.kind, k));
  if (Object.keys(add).length === 0) return;
  await addToWeek(ctx, s.kind, { c: { [s.scope]: { [s.kind]: { [`v${s.v}`]: { [s.arm]: add } } } } }, "signals", deps);
}

/** Add one to a made thing's signal. */
export function countSignal(ctx: TenantContext, stamp: LoopStamp, signal: CountedSignal, deps: CountDeps = {}): Promise<void> {
  return countSignals(ctx, stamp, { [signal]: 1 } as Partial<Record<CountedSignal, number>>, deps);
}

/**
 * Count a thing made and saved (or handed back to be saved): made against its stamp, or why it has
 * none, and made for its ontology type, in one write.
 */
export async function countMade(ctx: TenantContext, kind: LoopKind, made: Made, opts: CountDeps & { type?: string } = {}): Promise<void> {
  const type: CounterTree = opts.type && KIND_KEY.test(opts.type) ? { t: { [opts.type]: { made: 1 } } } : {};
  if ("unstamped" in made) {
    await addToWeek(ctx, kind, { u: { [kind]: { [made.unstamped]: 1 } }, ...type }, "made", opts);
    return;
  }
  const s = countableStamp(made);
  if (!s) return;
  await addToWeek(ctx, s.kind, { c: { [s.scope]: { [s.kind]: { [`v${s.v}`]: { [s.arm]: { made: 1 } } } } }, ...type }, "made", opts);
}

/** The signals a person's own image can count: it was never made, kept or edited by YouGrow. */
const OWN_IMAGE_SIGNALS: ReadonlySet<string> = new Set(["voted", "liked"]);

/**
 * Count a vote on a person's own image (an upload), which has no stamp: `{ voted: 1, liked: 1 }`,
 * or a changed vote's negative amounts. With image style versions on only. Never throws.
 */
export async function countOwnImage(ctx: TenantContext, deltas: Partial<Record<CountedSignal, number>>, deps: CountDeps = {}): Promise<void> {
  const add = amounts(deltas, (k) => OWN_IMAGE_SIGNALS.has(k));
  if (Object.keys(add).length === 0) return;
  // An own image teaches only the image learner: it counts while image style versions are on.
  await addToWeek(ctx, "loop_learn", { o: { image: add } }, "an own image's vote", deps);
}

/** Count a save with no stamp: an UNSTAMPED_REASONS reason, a stamp lost, or a refused token. */
export async function countUnstamped(ctx: TenantContext, kind: LoopKind, reason: UnstampedCount, deps: CountDeps = {}): Promise<void> {
  if (!(UNSTAMPED_COUNTS as readonly string[]).includes(reason)) return;
  await addToWeek(ctx, kind, { u: { [kind]: { [reason]: 1 } } }, "unstamped", deps);
}

/** Count a stamp token a save brought back and stamp.ts refused, by its reason. */
export function countRefusedToken(ctx: TenantContext, kind: LoopKind, refusal: StampRefusal, deps: CountDeps = {}): Promise<void> {
  return countUnstamped(ctx, kind, `token_${refusal}`, deps);
}

/** Count what a learner did for a kind: learned, or why it refused. */
export async function countLearnOutcome(ctx: TenantContext, kind: LoopKind, outcome: LearnOutcome, deps: CountDeps = {}): Promise<void> {
  if (!LEARN_OUTCOMES.includes(outcome)) return;
  await addToWeek(ctx, kind, { r: { [kind]: { [outcome]: 1 } } }, "a learn", deps);
}

/** Count what happened to a learning card for a kind. */
export async function countCard(ctx: TenantContext, kind: LoopKind, signal: CardSignal, deps: CountDeps = {}): Promise<void> {
  if (!(CARD_SIGNALS as readonly string[]).includes(signal)) return;
  await addToWeek(ctx, kind, { k: { [kind]: { [signal]: 1 } } }, "a card", deps);
}
