import { z } from "zod";

/**
 * Signup (a waitlist member). Lives in the root-level `signups` collection,
 * partitioned by `tenantId` (and `campaignId`). Fuses identity, fraud/state
 * flags, referral mechanics, the sortable queue `score`, and open-ended
 * developer/answers payloads into one cost-effective serverless document.
 */
export const SignupStatus = z.enum([
  "verified_active",
  "unverified",
  "offboarded",
  "deleted",
]);
export type SignupStatus = z.infer<typeof SignupStatus>;

/** A user's answer to a configured campaign question. */
export const AnswerSchema = z.object({
  question_value: z.string(),
  optional: z.boolean(),
  answer_value: z.string(),
});
export type Answer = z.infer<typeof AnswerSchema>;

export const SignupSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  campaignId: z.string(),

  // Core identity (nullable: requiredContactDetail decides what's mandatory)
  firstName: z.string().nullable().optional(),
  lastName: z.string().nullable().optional(),
  email: z.string().nullable().optional(),
  phone: z.string().nullable().optional(),

  // Structural security & state
  verified: z.boolean(),
  captchaValid: z.boolean(),
  isSpam: z.boolean(),
  status: SignupStatus,

  // Referral mechanics
  amountReferred: z.number().int().min(0),
  referralToken: z.string(),
  referralLink: z.string(),
  referredBySignupToken: z.string().nullable().optional(),

  // Sortable queue score (higher = closer to front). See lib/waitlist/scoring.ts
  score: z.number().int(),

  // Offboarding history
  removedDate: z.string().nullable().optional(),
  removedPriority: z.number().int().nullable().optional(),

  // Arbitrary developer payload + form answers
  metadata: z.record(z.string(), z.unknown()).optional(),
  answers: z.array(AnswerSchema).optional(),

  createdAt: z.string(),
});

export type Signup = z.infer<typeof SignupSchema>;
