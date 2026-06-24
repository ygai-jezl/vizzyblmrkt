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
  // Label for the primary "join" CTA on the hosted/embed full form; defaults to
  // "Join the waitlist" when unset. The compact mini/docked variants keep "Join".
  joinButtonLabel: z.string().optional(),
  socialLinks: z.record(z.string(), z.string()).optional(),
  // Post-signup viral sharing. `shareMessage` is a {{token}} template (same
  // vocabulary as the email merge vars); `enabledSharePlatforms` lists the
  // platform ids whose share buttons appear on the success screen. Kept loose
  // here (any string) — the admin settings schema tightens both (see
  // lib/admin/campaignSettings.ts). Distinct from the legacy `twitterMessage`.
  shareMessage: z.string().optional(),
  enabledSharePlatforms: z.array(z.string()).optional(),
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
  // Multilingual content config. `defaultLocale` is the base content language the
  // agents author in when nothing else resolves; `supportedLocales` is the
  // admin-defined set a visitor can be resolved into (Phase 5). BCP-47 base codes
  // (e.g. "fr"). OPTIONAL + loose (any string) on the stored shape so legacy docs
  // parse; the settings editor (src/lib/admin/campaignSettings.ts) validates them
  // against SUPPORTED_LOCALES, and resolveCampaignLocale normalises at read time.
  // CONTENT LANGUAGE ONLY — never coupled to the tenant's immutable `region`.
  defaultLocale: z.string().optional(),
  supportedLocales: z.array(z.string()).optional(),
});
export type Strategy = z.infer<typeof StrategySchema>;

/**
 * Conversation modality. Voice-only today (the Gemini Live API real-time audio
 * session); declared as an enum so a future TEXT mode can be added without a
 * schema migration.
 */
export const AiConversationModality = z.enum(["VOICE"]);
export type AiConversationModality = z.infer<typeof AiConversationModality>;

/**
 * Post-signup AI conversation — the optional, per-launch Gemini Live voice chat
 * that quizzes a fresh signup on *why* they want the product (capturing "golden
 * data") and, on completion, boosts their waitlist queue position. Stored as a
 * single nested object alongside `strategy`/`configurationStyleJson`; OPTIONAL on
 * the stored shape so legacy campaigns read cleanly (`toCampaignSettings`
 * backfills defaults). The system prompt the model actually runs is built
 * server-side from `strategy` + these fields and never reaches the browser.
 */
export const AiConversationSchema = z.object({
  enabled: z.boolean(),
  // CTA framing shown on the public page ("Boost your spot — talk to us for 60s").
  introLine: z.string().max(280).optional(),
  // What the AI should try to learn — seeds the server-side system instruction.
  conversationGoal: z.string().max(1000).optional(),
  // Topics the AI gently probes, one at a time.
  probeTopics: z.array(z.string().max(200)).max(10).optional(),
  // Referral-equivalent boost applied to the signup's queue rank on completion.
  leaderboardBonus: z.number().int().min(0).max(1000),
});
export type AiConversation = z.infer<typeof AiConversationSchema>;

/**
 * Offboarding lifecycle email — sent automatically when an admin offboards a
 * signup (PRD "Agentic Email Hub" §4.4). Default OFF so no surprise sends.
 * `subject`/`body` support merge tokens ({{first_name}}, {{waitlist_name}}, …);
 * blank falls back to default copy (see src/lib/email/templates.ts). OPTIONAL on
 * the stored shape so legacy campaigns read cleanly.
 */
export const OffboardingEmailSchema = z.object({
  enabled: z.boolean(),
  subject: z.string().optional(),
  body: z.string().optional(),
});
export type OffboardingEmail = z.infer<typeof OffboardingEmailSchema>;

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

  // Per-launch email sender OVERRIDES (optional). When unset, the launch
  // inherits the tenant-level default sender (Account Settings → Domains). A
  // From address is only honoured if its domain is verified at the tenant level
  // (see src/lib/email/sender.ts). The editor UI for these is the launch's
  // Communication settings.
  emailFromName: z.string().optional(),
  emailFromAddress: z.string().optional(),
  emailReplyTo: z.string().optional(),

  // Offboarding lifecycle email (optional; default-off when absent).
  offboardingEmail: OffboardingEmailSchema.optional(),
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

  // Post-signup Gemini Live voice conversation. OPTIONAL on the stored shape for
  // the same backward-compatibility reason as `strategy` above.
  aiConversation: AiConversationSchema.optional(),

  createdAt: z.string(),

  // Archived ("closed") state. Set to an ISO-8601 timestamp when the launch is
  // archived; null/absent means active (the only value every legacy doc has).
  // Presence STOPS public signups, pauses the active journey, and moves the
  // launch out of the admin "Active Launches" list — the launch's data is fully
  // preserved (nothing purged) and stays readable for agents/analytics. Cleared
  // by writing `null` on restore (NOT undefined — `ignoreUndefinedProperties`
  // would drop the key and silently fail the clear). Treat presence as the
  // archived test everywhere: `!!campaign.archivedAt`.
  archivedAt: z.string().nullable().optional(),
});

export type Campaign = z.infer<typeof CampaignSchema>;
