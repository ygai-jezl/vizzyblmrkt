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

/** The 5 standard UTM parameters captured at signup, for marketing attribution. */
export const UtmSchema = z.object({
  source: z.string().optional(),
  medium: z.string().optional(),
  campaign: z.string().optional(),
  content: z.string().optional(),
  term: z.string().optional(),
});
export type Utm = z.infer<typeof UtmSchema>;

/** A user's answer to a configured campaign question. */
export const AnswerSchema = z.object({
  question_value: z.string(),
  optional: z.boolean(),
  answer_value: z.string(),
});
export type Answer = z.infer<typeof AnswerSchema>;

/** One turn of the post-signup AI voice conversation transcript. */
export const ConversationTurnSchema = z.object({
  role: z.enum(["user", "model"]),
  text: z.string(),
});
export type ConversationTurn = z.infer<typeof ConversationTurnSchema>;

/**
 * Captured "golden data" from a completed Gemini Live voice conversation: the
 * full transcript (built from input/output audio transcriptions) plus an
 * optional summary. `bonusApplied` guards the one-time leaderboard boost so a
 * re-submitted completion can't double-credit.
 */
export const AiConversationDataSchema = z.object({
  completed: z.boolean(),
  transcript: z.array(ConversationTurnSchema).max(200),
  summary: z.string().optional(),
  capturedAt: z.string(), // ISO 8601
  bonusApplied: z.boolean(),
});
export type AiConversationData = z.infer<typeof AiConversationDataSchema>;

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
  /** Double opt-in token; set while unverified, cleared on verification. */
  verificationToken: z.string().nullable().optional(),

  // Sortable queue score (higher = closer to front). See lib/waitlist/scoring.ts
  score: z.number().int(),

  // Offboarding history
  removedDate: z.string().nullable().optional(),
  removedPriority: z.number().int().nullable().optional(),

  // Arbitrary developer payload + form answers
  metadata: z.record(z.string(), z.unknown()).optional(),
  answers: z.array(AnswerSchema).optional(),

  // Post-signup AI voice conversation: captured transcript/summary + the
  // referral-equivalent boost folded into ranking. Both optional so existing
  // signups read cleanly; see lib/waitlist/rank.ts for how the bonus is applied.
  aiConversation: AiConversationDataSchema.optional(),
  engagementBonus: z.number().int().min(0).optional(),

  // Marketing attribution captured at signup.
  utm: UtmSchema.optional(),
  referrerUrl: z.string().nullable().optional(),

  createdAt: z.string(),
});

export type Signup = z.infer<typeof SignupSchema>;
