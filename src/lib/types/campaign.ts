import { z } from "zod";

/**
 * Campaign (a single waitlist). Lives in the root-level `campaigns` collection,
 * partitioned by `tenantId`. Holds branding, the question builder, widget rules,
 * and gamification physics.
 */
export const RequiredContactDetail = z.enum(["EMAIL", "PHONE", "BOTH", "EITHER"]);
export type RequiredContactDetail = z.infer<typeof RequiredContactDetail>;

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

  createdAt: z.string(),
});

export type Campaign = z.infer<typeof CampaignSchema>;
