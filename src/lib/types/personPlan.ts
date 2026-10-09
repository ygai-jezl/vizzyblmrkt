import { z } from "zod";

/**
 * A plan for ONE product user (LIFECYCLE_PERSON_PLANS): what to help them do next
 * and how to put it to them. Vizzy drafts it from the person's situation (or staff
 * write it), and staff approve it on the person's page. Lives in the tenant-scoped
 * `person_plans` collection (regional DB, beside the person). Id = `pp_<product
 * user id>`: one per person.
 *
 * `draft` waits for a decision; `approved` is the plan in force, which steers that
 * person's AI line (lifecycle/prepare.ts) — still through Approvals. Approving
 * moves the draft there. The text never names the person: a save that does is
 * refused (audience/personPlans.ts). Erased with the person (connect/erase.ts).
 */

export const PLAN_LIMITS = { goal: 200, angle: 600, step: 240, steps: 6 } as const;

export const PlanBodySchema = z.object({
  /** What we want them to do next: "Connect their site". */
  goal: z.string().trim().min(1).max(PLAN_LIMITS.goal),
  /** How to put it to them: what to lead with, the tone, what to leave out. */
  angle: z.string().trim().min(1).max(PLAN_LIMITS.angle),
  /** The next few things to do, in order. */
  next: z.array(z.string().trim().min(1).max(PLAN_LIMITS.step)).max(PLAN_LIMITS.steps).default([]),
  /** When to look at them again (a day, YYYY-MM-DD). */
  reviewOn: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .default(null),
});
export type PlanBody = z.infer<typeof PlanBodySchema>;

export const PersonPlanSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  connectionId: z.string(),
  productUserId: z.string(),
  /** Waiting for staff: who wrote it (Vizzy or a person on the team) and when. */
  draft: PlanBodySchema.extend({ by: z.enum(["agent", "human"]), at: z.string() }).nullable(),
  /** In force: who wrote it, who approved it and when. */
  approved: PlanBodySchema.extend({ by: z.enum(["agent", "human"]), approvedBy: z.string().max(254).nullable(), at: z.string() }).nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type PersonPlan = z.infer<typeof PersonPlanSchema>;
