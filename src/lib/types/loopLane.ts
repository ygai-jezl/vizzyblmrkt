import { z } from "zod";
import { ISO_WEEK_RE } from "./loopDay";

/**
 * The loops lane's own bookkeeping in the control plane (`loop_lane`, src/lib/tenant/loopLane.ts),
 * each document with everything under the one map `d` so one field exemption covers it. No people,
 * no words. Pure: shapes only.
 *
 * - `lane`: the lane's cursor, the brand count its page size follows and the learner calls made
 *   today (learning loops step 4).
 * - `o:<organisationId>`, or `o:t:<tenantId>` for a brand with no organisation: one mark per
 *   organisation (step 5, departure 4 of the plan for steps 4 and 5), so an organisation with
 *   several brands counts once in each cell across brands. A mark holds only its newest week.
 */
export const LaneDocSchema = z.object({
  /** The last brand id the lane visited, in document id order; null starts again from the first. */
  cursor: z.string().max(160).nullable().default(null),
  /** Brands in the registry, counted about weekly, and when. */
  n: z.number().int().min(0).optional(),
  nAt: z.string().max(40).optional(),
  /** The day (YYYY-MM-DD, UTC) the learner calls below were made. */
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  /** Learner calls made that day across the copy (LOOP_RULES.learnCallsPerDay). */
  calls: z.number().int().min(0).optional(),
  /** When a run last wrote it. */
  at: z.string().max(40).optional(),
  /**
   * The last closed week whose brands listed (`n`) went to the counts across brands (learning
   * loops step 5), so each week's listed count is added once.
   */
  listedWeek: z.string().regex(ISO_WEEK_RE).optional(),
});
export type LaneDoc = z.infer<typeof LaneDocSchema>;

/** A cell key on a mark: the counter path a cell across brands is kept under, never an id. */
export const MARK_KEY_CHARS = 120;
/**
 * Cell keys credited in one week, at most: about 15 for each of the 98 kinds, with room, so a mark
 * stays far below Firestore's 1 MiB a document whatever the heartbeat counts.
 */
export const MARK_CELLS_MAX = 3_000;
/** Output cells counted in one week, at most: a few arms for each kind, and each image style. */
export const MARK_OUTPUTS_MAX = 1_000;

const MarkKey = z.string().min(1).max(MARK_KEY_CHARS);

/**
 * One organisation's mark for its newest reported week: the cells it is already counted in, and
 * the outputs counted so far in each against LOOP_RULES.orgOutputsCap. A report for a newer week
 * replaces it; one for the same week adds only what isn't credited yet; one for an older week is
 * dropped and counted as late, so an organisation is undercounted, never counted twice.
 */
export const LaneMarkSchema = z.object({
  week: z.string().regex(ISO_WEEK_RE),
  cells: z.array(MarkKey).max(MARK_CELLS_MAX).default([]),
  outputs: z
    .record(MarkKey, z.number().int().min(0))
    .default({})
    .refine((o) => Object.keys(o).length <= MARK_OUTPUTS_MAX, `a mark counts at most ${MARK_OUTPUTS_MAX} output cells`),
  /** When the lane last wrote it. */
  at: z.string().max(40).optional(),
});
export type LaneMark = z.infer<typeof LaneMarkSchema>;
