import { z } from "zod";

/**
 * The loops lane's own bookkeeping in the control plane (`loop_lane`, src/lib/tenant/loopLane.ts):
 * the `lane` document, with everything under the one map `d` so one field exemption covers it.
 * Learning loops step 4 keeps only the lane's cursor, the brand count its page size follows and
 * the learner calls made today; step 5 adds one mark per organisation beside it. No people, no
 * words. Pure: shapes only.
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
});
export type LaneDoc = z.infer<typeof LaneDocSchema>;
