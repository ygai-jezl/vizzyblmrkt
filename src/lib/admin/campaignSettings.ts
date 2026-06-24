import { z } from "zod";
import {
  BrandToneType,
  CampaignGoalType,
  ConfigurationStyleSchema,
  RequiredContactDetail,
  TargetAudienceType,
  type Campaign,
} from "@/lib/types/campaign";
import {
  SHARE_PLATFORM_IDS,
  isSharePlatformId,
} from "@/lib/waitlist/socialPlatforms";
import {
  DEFAULT_LOCALE,
  SUPPORTED_LOCALES,
  isSupportedLocale,
  normalizeLocale,
} from "@/lib/i18n/locale";

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

/** True for a syntactically valid http(s) URL — used to validate the Waitlist URL. */
function isHttpUrl(s: string): boolean {
  try {
    const u = new URL(s);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/** Lenient single-address email check — used for the optional sender overrides. */
function isEmail(s: string): boolean {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s);
}

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
 * swatch silently renders as black. The two share fields are tightened too:
 * `shareMessage` is length-capped, and `enabledSharePlatforms` rejects unknown
 * ids and is normalised to the canonical order (deduped) via parseEnabledPlatforms.
 */
const StyleSettingsSchema = ConfigurationStyleSchema.extend({
  // `.optional()` stays outermost on both so the keys remain optional in the
  // inferred CampaignSettings type (matching the loose stored shape) — the
  // unknown-id check lives in the object-level refine below, not as a per-field
  // effect, which would otherwise force the key to be required.
  shareMessage: z.string().trim().max(280).optional(),
  enabledSharePlatforms: z.array(z.string()).max(SHARE_PLATFORM_IDS.length).optional(),
})
  .refine(
    (s) => COLOR_FIELDS.every((k) => !s[k] || HEX_COLOR.test(s[k] as string)),
    { message: "widget colours must be a 6-digit hex value like #4937E7" },
  )
  .refine(
    (s) => !s.enabledSharePlatforms || s.enabledSharePlatforms.every(isSharePlatformId),
    { message: "enabledSharePlatforms contains an unknown platform id" },
  );

/**
 * Editable AI Strategy & Context. The enums (+ target count) carry sensible
 * defaults so a payload that omits the whole `strategy` object — or any field in
 * it — still saves cleanly; the free-text instructions are optional and may be
 * cleared to "".
 */
const StrategySettingsSchema = z
  .object({
    campaignGoal: CampaignGoalType.default("PRE_LAUNCH_WAITLIST"),
    targetCount: z.number().int().min(0).max(1_000_000_000).default(10_000),
    targetAudience: TargetAudienceType.default("DEVELOPERS_TECHNICAL_FOUNDERS"),
    brandTone: BrandToneType.default("TECHNICAL_PEER"),
    customToneInstructions: z.string().trim().max(2000).optional(),
    // Content language(s) the agents author in. `defaultLocale` is the base
    // content language; the multi-language picker + per-visitor resolution land
    // in Phase 5, so today `supportedLocales` tracks [defaultLocale]. Both are
    // validated against the curated SUPPORTED_LOCALES set. CONTENT LANGUAGE ONLY
    // — orthogonal to the tenant's immutable data-residency `region`.
    defaultLocale: z
      .string()
      .trim()
      .default(DEFAULT_LOCALE)
      .refine(isSupportedLocale, { message: "unsupported language" }),
    supportedLocales: z
      .array(z.string().trim())
      .max(SUPPORTED_LOCALES.length)
      .default([DEFAULT_LOCALE])
      .refine((arr) => arr.every(isSupportedLocale), {
        message: "supportedLocales contains an unsupported language",
      }),
  })
  .refine((s) => s.supportedLocales.includes(s.defaultLocale), {
    message: "the default language must be one of the supported languages",
    path: ["supportedLocales"],
  });

/**
 * Editable post-signup AI conversation config. Defaulted (disabled, no bonus) so
 * a payload that omits the whole `aiConversation` object still saves cleanly. The
 * free-text framing/goal may be cleared to ""; probe topics default to an empty
 * array. Mirrors the `strategy` defaulting above.
 */
const AiConversationSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  introLine: z.string().trim().max(280).optional(),
  conversationGoal: z.string().trim().max(1000).optional(),
  probeTopics: z.array(z.string().trim().min(1).max(200)).max(10).default([]),
  leaderboardBonus: z.number().int().min(0).max(1000).default(0),
});

// Offboarding lifecycle email. Subject/body accept merge tokens; blank → default
// copy at send time. Default-off so enabling is an explicit admin choice.
const OffboardingEmailSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  subject: z.string().trim().max(200).optional(),
  body: z.string().trim().max(5000).optional(),
});

export const CampaignSettingsSchema = z
  .object({
    waitlistName: z.string().trim().min(1, "name is required").max(120),
    // The public URL where this waitlist lives. Blank → the default hosted page
    // (`{origin}/waitlist/<slug>`). When set (e.g. a brand who embedded the widget
    // on their own site), it is used VERBATIM as the referral/share-link base, so
    // it must be a full http(s) URL. An empty string is treated as blank.
    waitlistUrlLocation: z
      .string()
      .trim()
      .max(2048)
      .refine((s) => s === "" || isHttpUrl(s), {
        message: "enter a full URL like https://yourbrand.com/early-access",
      })
      .nullable()
      .optional(),

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

    // Per-launch email sender OVERRIDES. Blank/omitted → inherit the tenant
    // default (Account Settings → Domains). The address must be a valid email
    // (and its domain verified at the tenant level to actually be used). The
    // Communication settings UI binds these; they are optional here so existing
    // payloads that omit them still validate.
    emailFromName: z.string().trim().max(120).optional(),
    emailFromAddress: z
      .string()
      .trim()
      .max(254)
      .refine((s) => s === "" || isEmail(s), {
        message: "enter a valid email address like hello@mail.yourbrand.com",
      })
      .optional(),
    emailReplyTo: z
      .string()
      .trim()
      .max(254)
      .refine((s) => s === "" || isEmail(s), {
        message: "enter a valid email address like replies@mail.yourbrand.com",
      })
      .optional(),

    // Offboarding lifecycle email (default-off). A wholly omitted object falls
    // back to the disabled all-defaults object.
    offboardingEmail: OffboardingEmailSettingsSchema.default(() =>
      OffboardingEmailSettingsSchema.parse({}),
    ),

    // Branding
    configurationStyleJson: StyleSettingsSchema,

    // AI Strategy & Context (nested, mirrors configurationStyleJson). A wholly
    // omitted `strategy` falls back to the all-defaults object.
    strategy: StrategySettingsSchema.default(() => StrategySettingsSchema.parse({})),

    // Post-signup AI conversation (nested). A wholly omitted object falls back to
    // the disabled all-defaults object.
    aiConversation: AiConversationSettingsSchema.default(() =>
      AiConversationSettingsSchema.parse({}),
    ),
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
      enabledSharePlatforms: ["twitter", "whatsapp", "telegram", "email"],
    },
    strategy: {
      campaignGoal: "PRE_LAUNCH_WAITLIST",
      targetCount: 10000,
      targetAudience: "DEVELOPERS_TECHNICAL_FOUNDERS",
      brandTone: "TECHNICAL_PEER",
      defaultLocale: DEFAULT_LOCALE,
      supportedLocales: [DEFAULT_LOCALE],
    },
    aiConversation: {
      enabled: false,
      probeTopics: [],
      leaderboardBonus: 0,
    },
    offboardingEmail: { enabled: false },
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

/**
 * Append a numeric suffix (`-2`, `-3`, …) to a base slug to escape a collision,
 * trimming the base so the result stays within the 64-char CampaignIdSchema cap.
 * Callers must re-validate the result (a trim can land on a hyphen).
 */
export function suffixedCampaignId(base: string, n: number): string {
  const suffix = `-${n}`;
  return `${base.slice(0, 64 - suffix.length)}${suffix}`;
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
    emailFromName: campaign.emailFromName,
    emailFromAddress: campaign.emailFromAddress,
    emailReplyTo: campaign.emailReplyTo,
    offboardingEmail: {
      enabled: campaign.offboardingEmail?.enabled ?? false,
      subject: campaign.offboardingEmail?.subject,
      body: campaign.offboardingEmail?.body,
    },
    configurationStyleJson: campaign.configurationStyleJson,
    // Backfill defaults for any campaign created before `strategy` existed.
    strategy: {
      campaignGoal: campaign.strategy?.campaignGoal ?? "PRE_LAUNCH_WAITLIST",
      targetCount: campaign.strategy?.targetCount ?? 10000,
      targetAudience: campaign.strategy?.targetAudience ?? "DEVELOPERS_TECHNICAL_FOUNDERS",
      brandTone: campaign.strategy?.brandTone ?? "TECHNICAL_PEER",
      customToneInstructions: campaign.strategy?.customToneInstructions,
      // Normalise stored codes and guarantee the default is in the supported set.
      defaultLocale: normalizeLocale(campaign.strategy?.defaultLocale) ?? DEFAULT_LOCALE,
      supportedLocales: (() => {
        const def = normalizeLocale(campaign.strategy?.defaultLocale) ?? DEFAULT_LOCALE;
        const extra = (campaign.strategy?.supportedLocales ?? [])
          .map((c) => normalizeLocale(c))
          .filter((c): c is string => !!c);
        return Array.from(new Set([def, ...extra]));
      })(),
    },
    // Backfill defaults for any campaign created before `aiConversation` existed.
    aiConversation: {
      enabled: campaign.aiConversation?.enabled ?? false,
      introLine: campaign.aiConversation?.introLine,
      conversationGoal: campaign.aiConversation?.conversationGoal,
      probeTopics: campaign.aiConversation?.probeTopics ?? [],
      leaderboardBonus: campaign.aiConversation?.leaderboardBonus ?? 0,
    },
  };
}
