import { z } from "zod";
import { VERSION_SET_BY } from "./learnedPatternVersion";

/**
 * What the learning loops keep per brand in `loop_days` (regional, src/lib/tenant/loops.ts), as
 * counts and pointers with no words and no person. Each document is `{tenantId, d, ttlAt?}`, with
 * all its data under the one map `d`, so one field exemption covers it. Six kinds of document,
 * told apart by the prefix of the id:
 *
 * - `lw:<tenant>:<isoWeek>:<shard>`: a week's counters, in one of LOOP_RULES.shards shards picked
 *   at random, so many writers at once never wait on one document; gone 70 days after the week ends.
 * - `lt:<tenant>:<isoWeek>`: the week folded from its shards; gone 2 years after the week ends.
 * - `lv:<tenant>:<scope>:<v>`: one learned version's totals, for scopes whose line learns.
 * - `lb:<tenant>`: which version each scope uses, the pause and the opt out (BrandPointers).
 * - `ls:<tenant>`: the lane's own state (LaneState), so the lane never contends with a person's Undo.
 * - `lk:<tenant>`: the stamp key (StampKey), read only by src/lib/loops/stamp.ts.
 *
 * Pure: shapes only.
 */

export const LOOP_DOC_PREFIXES = { week: "lw", folded: "lt", version: "lv", brand: "lb", lane: "ls", key: "lk" } as const;
export type LoopDocKind = keyof typeof LOOP_DOC_PREFIXES;

/**
 * What people did with something YouGrow made, as the counters name it. Liked counts a first up
 * vote only, and a changed vote moves the counts, so each image counts once.
 */
export const LOOP_SIGNALS = ["made", "kept", "edited", "declined", "voted", "liked", "remade", "undone", "reversed"] as const;
export type LoopSignal = (typeof LOOP_SIGNALS)[number];

/** A week as ISO 8601 names it: `2026-W48`. */
export const ISO_WEEK_RE = /^\d{4}-W(?:0[1-9]|[1-4]\d|5[0-3])$/;

/** Counters to add: nested maps whose leaves are amounts. A key may hold dots (a scope), never a path. */
export interface CounterTree {
  [key: string]: number | CounterTree;
}

/** One loop document as stored. */
export interface LoopDayDoc {
  id: string;
  tenantId: string;
  d: Record<string, unknown>;
  /** For the time to live policy on lw: and lt: documents; the others never expire. */
  ttlAt?: Date | { toDate(): Date };
}

const Iso = z.string().min(1).max(40);

/** The version a scope uses, who set it, since when, and when a person kept it. */
export const ScopePointerSchema = z.object({
  v: z.number().int().min(0),
  setBy: z.enum(VERSION_SET_BY),
  adoptedAt: Iso,
  keptAt: Iso.optional(),
  /**
   * The look of the worse read a person kept the version at (decision 16), from a Go back card or
   * from the card's own notice: no card is offered again unless a later look reads worse.
   */
  keptLook: z.number().int().min(0).optional(),
});
export type ScopePointer = z.infer<typeof ScopePointerSchema>;

/**
 * `lb:`, pointers only: no words and no member ids (a pause shows its date only). Written only in
 * the same transaction as the version row it points to, by the learner's one writer, the person
 * actions and the seed, so the two never disagree.
 */
export const BrandPointersSchema = z.object({
  /** By scope, such as `image_style.natural_photo`. */
  scopes: z.record(z.string().max(40), ScopePointerSchema).default({}),
  /** Image learning paused: whatever look is in use stays in use, and nothing new is learned. */
  pause: z.object({ image_style: z.object({ at: Iso }).optional() }).optional(),
  /** The brand turned off the holdback, and from step 5 counts across brands. */
  fleetOptOut: z.object({ at: Iso }).optional(),
  /** When the looks on the brand record were copied into versions. */
  seededAt: Iso.optional(),
  /**
   * By scope, when a person last forgot its look (3.5): the lane clears the scope's old copy on the
   * brand record if it was written before then, and tries again on each visit until it is gone.
   */
  forgot: z.record(z.string().max(40), z.object({ at: Iso })).optional(),
  /** When a person resumed Go back suggestions, so the attention rule reads only weeks since (3.5). */
  cardsResumedAt: Iso.optional(),
});
export type BrandPointers = z.infer<typeof BrandPointersSchema>;

/**
 * A version's own check, as the verdict run keeps it on `lv:` (learning loops step 4): what the
 * votes learner's hold reads (src/lib/loops/learners/votes.ts, versionCheckOf). The verdict run
 * refreshes it whenever the version's votes moved since `at`, so a hold can end between looks.
 */
export const VersionCheckSchema = z.object({
  /**
   * The version's votes that count toward checking the next change: images voted within
   * LOOP_RULES.outcomeDays of being made, the holdback, person off and customised images left
   * out, and the scope's first LOOP_RULES.warmUp votes never counted.
   */
  counted: z.number().int().min(0),
  /** Its own check has settled: it read better, same or worse, reached the last look it can get, or can't be checked. */
  settled: z.boolean(),
  at: Iso,
  /** The version's made and voted counters when it was read, so the next read waits until they move. */
  seen: z.number().optional(),
  /** Some of its images were too new to read then, so it is read again once they are 14 days old. */
  pending: z.boolean().optional(),
});
export type VersionCheck = z.infer<typeof VersionCheckSchema>;

const TallySchema = z.object({ hits: z.number().int().min(0), n: z.number().int().min(0) });

/**
 * One read of a version's check at a look (the verdict run, 3.8), kept on `lv:` under `looks` by
 * the look, so the card and History say it in words (src/lib/loops/verdictWords.ts). Counts only.
 */
export const LookReadSchema = z.object({
  call: z.enum(["better", "same", "worse", "too_few"]),
  decidedBy: z.enum(["check", "guard"]),
  /** Votes a side the call was read at (the guard's images on a guard worse), or null below the first look. */
  look: z.number().int().min(0).nullable(),
  /** The liked counts at the check's look, before and since. */
  check: z.object({ before: TallySchema, after: TallySchema }).nullable(),
  /** The remade counts at the guard's look, before and since. */
  guard: z.object({ before: TallySchema, after: TallySchema }).nullable(),
  /** The check's votes before the change that count, its warm up left out. */
  usableBefore: z.number().int().min(0),
  /** Its votes since the change that count. */
  after: z.number().int().min(0),
  /** The check's next look, or null at the last one this change can reach. */
  next: z.number().int().min(0).nullable(),
  /** At a too few look: the likes since that would have read better, or null when none could. */
  need: z.number().int().min(0).nullable(),
  at: Iso,
});
export type LookRead = z.infer<typeof LookReadSchema>;

/** A counter tree's leaves by kind, arm and signal: `c.<kind>.<arm>.<signal>`. */
const KindArmSignals = z.record(z.string().max(40), z.record(z.string().max(20), z.record(z.string().max(60), z.number())));

/**
 * `lv:`, one learned version's totals: its counters by kind, arm and signal, folded through
 * `throughWeek`, and its own check (VersionCheck). The fold (src/lib/loops/tick.ts) writes the
 * counters and the verdict run the check.
 */
export const VersionTotalsSchema = z.object({
  throughWeek: z.string().regex(ISO_WEEK_RE).optional(),
  c: KindArmSignals.default({}),
  check: VersionCheckSchema.optional(),
  /** Its reads, by the look each was read at ("0" below the first look): the newest is what the card says. */
  looks: z.record(z.string().max(8), LookReadSchema).optional(),
  /** The Go back card the verdict run proposed for it, by the look that read worse. */
  card: z.object({ id: z.string().max(64), look: z.number().int().min(0), at: Iso }).optional(),
});
export type VersionTotals = z.infer<typeof VersionTotalsSchema>;

/**
 * What the votes learner saw the last time it read image rows (src/lib/loops/learners/votes.ts),
 * so a visit with no new likes and no scope newly free to learn reads none: the open week, the
 * likes counted in it then, and the scopes that were free to learn and found too few likes.
 */
export const LearnReadSchema = z.object({
  week: z.string().regex(ISO_WEEK_RE),
  liked: z.number(),
  open: z.array(z.string().max(40)).max(16),
  at: Iso,
});
export type LearnRead = z.infer<typeof LearnReadSchema>;

/** `ls:`, the lane's own state. */
export const LaneStateSchema = z.object({
  /** The votes learner's last read of image rows; null clears it. */
  learnRead: LearnReadSchema.nullable().optional(),
  /** The last week folded into `lt:`; the fold skips weeks at or before it. */
  foldedThrough: z.string().regex(ISO_WEEK_RE).optional(),
  /** How many times the lane visited the brand. */
  runs: z.number().int().min(0).optional(),
  lastRunAt: Iso.optional(),
  /** Days in a row a learner failed (LOOP_RULES.errorDays), and the last of them. */
  failedDays: z.number().int().min(0).optional(),
  lastFailedDay: Iso.optional(),
  /** The last week the heartbeat counted. */
  heartbeatWeek: z.string().regex(ISO_WEEK_RE).optional(),
  /** The usage meter's totals the lane last saw, by purpose. */
  meterSeen: z.record(z.string().max(60), z.number()).optional(),
  /** A hash of the open week's counters and the brand's pointers at the lane's last full visit: unchanged, and the visit can be idle. */
  seen: z.object({ week: z.string().regex(ISO_WEEK_RE), hash: z.string().max(16) }).optional(),
  /** Until when nothing is due by time alone (a look's week, a read waiting on images to age), as the last full visit worked out. */
  quietUntil: Iso.optional(),
});
export type LaneState = z.infer<typeof LaneStateSchema>;

/** `lk:`, the key that signs stamps. Never shown, logged or sent back. */
export const StampKeySchema = z.object({ key: z.string().min(32).max(128) });
export type StampKey = z.infer<typeof StampKeySchema>;
