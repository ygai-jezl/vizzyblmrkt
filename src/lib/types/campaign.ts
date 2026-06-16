import { z } from "zod";

/**
 * Campaign (a single waitlist). Lives in the root-level `campaigns` collection,
 * partitioned by `tenantId`. Holds branding, the question builder, widget rules,
 * and gamification physics.
 */
export const RequiredContactDetail = z.enum(["EMAIL", "PHONE", "BOTH", "EITHER"]);
export type RequiredContactDetail = z.infer<typeof RequiredContactDetail>;

/**
 * AI Strategy & Context enums. These are NOT cosmetic labels — each value is a
 * distinct system behaviour the background agents key off, so the moment a
 * founder picks one the analytics/optimisation engines recalibrate:
 *
 *  - `CampaignGoalType` selects the GTM playbook (gamified waitlist vs. lead
 *    routing vs. cohort waves vs. open GA vs. event countdown). It drives which
 *    success metric Performance Analytics (Agent 5) optimises and how the
 *    Journey Canvas sequences messages.
 *  - `BrandToneType` is the foundational system-prompt constraint for the
 *    Creative Director / Copywriter (Agent 3); ENTERPRISE_TRUST additionally
 *    raises the Model-Armor / QA-gate brand-safety filter to its strictest tier.
 *  - `TargetAudienceType` seeds the CRM segment / enrichment filter used to
 *    flag and route inbound leads.
 */
export const CampaignGoalType = z.enum([
  "PRE_LAUNCH_WAITLIST", // Viral growth: gamification, referrals, viral coefficient
  "ENTERPRISE_LEAD_GEN", // High-touch: reverse-IP enrichment + AE routing, skip waitlist delays
  "COHORT_WAVE_RELEASE", // Graduate top-N off the leaderboard into Active in batched invite waves
  "GENERAL_AVAILABILITY", // Open signups: classic conversion-funnel tracking + ad-copy optimisation
  "EVENT_REGISTRATION", // Time-decay countdown sequences toward a fixed calendar date
]);
export type CampaignGoalType = z.infer<typeof CampaignGoalType>;

export const TargetAudienceType = z.enum([
  "DEVELOPERS_TECHNICAL_FOUNDERS",
  "ENTERPRISE_DECISION_MAKERS",
  "STARTUPS_INDIE_HACKERS",
  "PRODUCT_GROWTH_TEAMS",
  "GENERAL_CONSUMERS",
]);
export type TargetAudienceType = z.infer<typeof TargetAudienceType>;

export const BrandToneType = z.enum([
  "TECHNICAL_PEER", // Zero fluff, high technical depth, markdown/code-friendly syntax
  "BOLD_CHALLENGER", // Punchy, confident, witty, high conversational energy
  "ENTERPRISE_TRUST", // Formal, security/compliance-led; pairs with the strictest QA gate
  "PRODUCT_LED_CASUAL", // Warm, empathetic, frictionless-onboarding focus
  "FOMO_EXCLUSIVE", // Scarcity/urgency optimised around waitlist rank & exclusivity
]);
export type BrandToneType = z.infer<typeof BrandToneType>;

/** A configured survey question. `answer_value: null` => render a free-text input. */
export const QuestionSchema = z.object({
  question_value: z.string(),
  optional: z.boolean(),
  answer_value: z.array(z.string()).nullable(),
});
export type Question = z.infer<typeof QuestionSchema>;

export const ConfigurationStyleSchema = z.object({
  widgetBackgroundColor: z.string().optional(),
  widgetButtonColor: z.string().optional(),
  widgetFontColor: z.string().optional(),
  statusDescription: z.string().optional(),
  socialLinks: z.record(z.string(), z.string()).optional(),
});
export type ConfigurationStyle = z.infer<typeof ConfigurationStyleSchema>;

/**
 * AI Strategy & Context — the GTM strategy + brand-voice constraints the
 * background agents read. Stored as a single nested object on the campaign
 * (alongside `configurationStyleJson`), so the strategy knobs travel together
 * and add no extra top-level surface.
 */
export const StrategySchema = z.object({
  campaignGoal: CampaignGoalType,
  targetCount: z.number().int().min(0).max(1_000_000_000),
  targetAudience: TargetAudienceType,
  brandTone: BrandToneType,
  customToneInstructions: z.string().optional(),
});
export type Strategy = z.infer<typeof StrategySchema>;

export const CampaignSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  waitlistName: z.string(),
  waitlistUrlLocation: z.string().nullable().optional(),

  // Gamification physics. `spotsToMoveUponReferral` is the founder's
  // admin-editable "spots skipped per referral" knob (integer, 0..1000).
  spotsToMoveUponReferral: z.number().int().min(0).max(1000),

  // Behaviour toggles
  usesFirstnameLastname: z.boolean(),
  usesLeaderboard: z.boolean(),
  usesSignupVerification: z.boolean(),
  hideCounts: z.boolean(),
  removeWidgetHeaders: z.boolean(),
  requiredContactDetail: RequiredContactDetail,

  // Form builder
  questions: z.array(QuestionSchema),

  // Marketing / notifications
  twitterMessage: z.string().optional(),
  sendEmailCongratulationsOnReferral: z.boolean(),
  // Capped to match the admin-editable range (CampaignSettingsSchema) so the
  // stored shape can never exceed what the settings editor can round-trip.
  leaderboardLength: z.number().int().min(0).max(1000),

  // UI customization
  configurationStyleJson: ConfigurationStyleSchema,

  // AI Strategy & Context. OPTIONAL on the stored shape so campaigns created
  // before this field existed still read cleanly (reads are not re-parsed; see
  // TenantCollection.find/getById). The settings editor always writes it, and
  // `toCampaignSettings` backfills defaults for any legacy doc that lacks it.
  strategy: StrategySchema.optional(),

  createdAt: z.string(),
});

export type Campaign = z.infer<typeof CampaignSchema>;
