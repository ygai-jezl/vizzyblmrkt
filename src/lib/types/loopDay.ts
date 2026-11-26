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
});
export type BrandPointers = z.infer<typeof BrandPointersSchema>;

/** `ls:`, the lane's own state. */
export const LaneStateSchema = z.object({
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
});
export type LaneState = z.infer<typeof LaneStateSchema>;

/** `lk:`, the key that signs stamps. Never shown, logged or sent back. */
export const StampKeySchema = z.object({ key: z.string().min(32).max(128) });
export type StampKey = z.infer<typeof StampKeySchema>;
