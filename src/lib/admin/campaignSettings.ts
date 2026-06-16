import { z } from "zod";
import {
  BrandToneType,
  CampaignGoalType,
  ConfigurationStyleSchema,
  RequiredContactDetail,
  TargetAudienceType,
  type Campaign,
} from "@/lib/types/campaign";

/**
 * The admin-editable subset of a Campaign — everything that drives the hosted
 * waitlist page, minus the immutable/identity fields (`id`, `tenantId`,
 * `createdAt`) which are set once at creation and stamped server-side.
 *
 * This schema is the single validation contract for the settings editor: it is
 * shared by the PUT API route (server enforcement) and the form component (its
 * inferred type). `.strict()` rejects unknown keys so a caller can't smuggle
 * `tenantId`/`id`/`createdAt` — or any other field — into the update path.
 */

/**
 * A survey question in the form builder. Stricter than the stored
 * `QuestionSchema`: question text must be non-empty, and an `answer_value` of
 * an EMPTY array (a "multiple choice" with no options) collapses to `null`
 * (free-text) so the hosted form never renders an empty dropdown.
 */
export const SettingsQuestionSchema = z.object({
  question_value: z.string().trim().min(1, "question text is required").max(500),
  optional: z.boolean(),
  answer_value: z
    .array(z.string().trim().min(1).max(200))
    .max(50)
    .nullable()
    .transform((v) => (v && v.length > 0 ? v : null)),
});

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
const COLOR_FIELDS = [
  "widgetBackgroundColor",
  "widgetButtonColor",
  "widgetFontColor",
] as const;

/**
 * Branding config with the editable colour fields constrained to 6-digit hex.
 * The stored ConfigurationStyleSchema is intentionally loose (any string); the
 * settings editor must not be able to persist an invalid CSS colour that the
 * swatch silently renders as black.
 */
const StyleSettingsSchema = ConfigurationStyleSchema.refine(
  (s) => COLOR_FIELDS.every((k) => !s[k] || HEX_COLOR.test(s[k] as string)),
  { message: "widget colours must be a 6-digit hex value like #4937E7" },
);

/**
 * Editable AI Strategy & Context. The enums (+ target count) carry sensible
 * defaults so a payload that omits the whole `strategy` object — or any field in
 * it — still saves cleanly; the free-text instructions are optional and may be
 * cleared to "".
 */
const StrategySettingsSchema = z.object({
  campaignGoal: CampaignGoalType.default("PRE_LAUNCH_WAITLIST"),
  targetCount: z.number().int().min(0).max(1_000_000_000).default(10_000),
  targetAudience: TargetAudienceType.default("DEVELOPERS_TECHNICAL_FOUNDERS"),
  brandTone: BrandToneType.default("TECHNICAL_PEER"),
  customToneInstructions: z.string().trim().max(2000).optional(),
});

export const CampaignSettingsSchema = z
  .object({
    waitlistName: z.string().trim().min(1, "name is required").max(120),
    waitlistUrlLocation: z.string().trim().max(2000).nullable().optional(),

    // Gamification physics — the "spots skipped per referral" knob.
    spotsToMoveUponReferral: z.number().int().min(0).max(1000),

    // Behaviour toggles
    usesFirstnameLastname: z.boolean(),
    usesLeaderboard: z.boolean(),
    usesSignupVerification: z.boolean(),
    hideCounts: z.boolean(),
    removeWidgetHeaders: z.boolean(),
    requiredContactDetail: RequiredContactDetail,

    // Form builder
    questions: z.array(SettingsQuestionSchema).max(50),

    // Marketing / notifications
    twitterMessage: z.string().trim().max(280).optional(),
    sendEmailCongratulationsOnReferral: z.boolean(),
    leaderboardLength: z.number().int().min(0).max(1000),

    // Branding
    configurationStyleJson: StyleSettingsSchema,

    // AI Strategy & Context (nested, mirrors configurationStyleJson). A wholly
    // omitted `strategy` falls back to the all-defaults object.
    strategy: StrategySettingsSchema.default(() => StrategySettingsSchema.parse({})),
  })
  .strict();

export type CampaignSettings = z.infer<typeof CampaignSettingsSchema>;

/**
 * A safe default settings object for a brand-new launch — the caller fills in
 * the name (and may tweak a few knobs); everything else gets a sensible default
 * that mirrors the seeded demo campaign. The full editor lives in the launch's
 * Settings tab afterward.
 */
export function defaultCampaignSettings(): CampaignSettings {
  return {
    waitlistName: "",
    waitlistUrlLocation: null,
    spotsToMoveUponReferral: 10,
    usesFirstnameLastname: false,
    usesLeaderboard: true,
    usesSignupVerification: false,
    hideCounts: false,
    removeWidgetHeaders: false,
    requiredContactDetail: "EMAIL",
    questions: [],
    sendEmailCongratulationsOnReferral: true,
    leaderboardLength: 5,
    configurationStyleJson: {
      widgetButtonColor: "#111827",
      statusDescription: "You're on the list!",
    },
    strategy: {
      campaignGoal: "PRE_LAUNCH_WAITLIST",
      targetCount: 10000,
      targetAudience: "DEVELOPERS_TECHNICAL_FOUNDERS",
      brandTone: "TECHNICAL_PEER",
    },
  };
}

/**
 * Build a URL-safe campaign id (slug) from a launch name: lowercase, hyphenated,
 * trimmed to a Firestore-friendly length. May return "" for an all-symbol name —
 * callers must handle that (the create API rejects an empty/invalid id).
 */
export function slugifyCampaignId(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
}

/** Ids reserved because they collide with static routes under /admin/launches. */
const RESERVED_CAMPAIGN_IDS = new Set(["new"]);

/**
 * Validate a NORMALISED (already lowercased) campaign id used as the Firestore
 * document id and the public `/waitlist/<id>` slug.
 */
export const CampaignIdSchema = z
  .string()
  .regex(
    /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/,
    "use lowercase letters, numbers and hyphens (3–64 chars)",
  )
  .refine((s) => !RESERVED_CAMPAIGN_IDS.has(s), { message: "that id is reserved" });

/** Project a stored Campaign down to its editable settings (form defaults). */
export function toCampaignSettings(campaign: Campaign): CampaignSettings {
  return {
    waitlistName: campaign.waitlistName,
    waitlistUrlLocation: campaign.waitlistUrlLocation ?? null,
    spotsToMoveUponReferral: campaign.spotsToMoveUponReferral,
    usesFirstnameLastname: campaign.usesFirstnameLastname,
    usesLeaderboard: campaign.usesLeaderboard,
    usesSignupVerification: campaign.usesSignupVerification,
    hideCounts: campaign.hideCounts,
    removeWidgetHeaders: campaign.removeWidgetHeaders,
    requiredContactDetail: campaign.requiredContactDetail,
    questions: campaign.questions.map((q) => ({
      question_value: q.question_value,
      optional: q.optional,
      answer_value: q.answer_value,
    })),
    twitterMessage: campaign.twitterMessage,
    sendEmailCongratulationsOnReferral: campaign.sendEmailCongratulationsOnReferral,
    leaderboardLength: campaign.leaderboardLength,
    configurationStyleJson: campaign.configurationStyleJson,
    // Backfill defaults for any campaign created before `strategy` existed.
    strategy: {
      campaignGoal: campaign.strategy?.campaignGoal ?? "PRE_LAUNCH_WAITLIST",
      targetCount: campaign.strategy?.targetCount ?? 10000,
      targetAudience: campaign.strategy?.targetAudience ?? "DEVELOPERS_TECHNICAL_FOUNDERS",
      brandTone: campaign.strategy?.brandTone ?? "TECHNICAL_PEER",
      customToneInstructions: campaign.strategy?.customToneInstructions,
    },
  };
}
