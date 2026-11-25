import { z } from "zod";

/**
 * The brand's profile (ONBOARDING_ENABLED): what an admin told Vizzy about the business on the
 * welcome (the 4 quick questions, or later a call) or in Settings, About your business. It is on
 * the tenant doc (control plane), like the brand voice: four fixed choices about the business,
 * never a person's words. Those (transcripts and quotes) live in the brand's own region.
 *
 * `stage` here is where the business is today. It is not the growth path's StageKey
 * (src/lib/nav/growth.ts): keep ProfileStage and StageKey apart.
 */

export const PROFILE_KEYS = ["who", "run", "stage", "want"] as const;
export type ProfileKey = (typeof PROFILE_KEYS)[number];

/** Each answer's choices, in the order the questions show them. */
export const PROFILE_CHOICES = {
  who: ["solo", "team", "agency"],
  run: ["app", "shop", "service"],
  stage: ["idea", "launched", "established"],
  want: ["waitlist", "audience", "customers"],
} as const;

export const ProfileWho = z.enum(PROFILE_CHOICES.who);
export const ProfileRun = z.enum(PROFILE_CHOICES.run);
export const ProfileStage = z.enum(PROFILE_CHOICES.stage);
export const ProfileWant = z.enum(PROFILE_CHOICES.want);
export type ProfileWho = z.infer<typeof ProfileWho>;
export type ProfileRun = z.infer<typeof ProfileRun>;
export type ProfileStage = z.infer<typeof ProfileStage>;
export type ProfileWant = z.infer<typeof ProfileWant>;

/** The answers as stored: a damaged answer reads as unanswered, on its own. */
export const ProfileAnswersSchema = z.object({
  who: ProfileWho.optional().catch(undefined),
  run: ProfileRun.optional().catch(undefined),
  stage: ProfileStage.optional().catch(undefined),
  want: ProfileWant.optional().catch(undefined),
});
export type ProfileAnswers = z.infer<typeof ProfileAnswersSchema>;

/** Answers as a screen sends them: any of the four, nothing else. An answer is changed, never cleared. */
export const ProfileAnswersInputSchema = z
  .object({
    who: ProfileWho.optional(),
    run: ProfileRun.optional(),
    stage: ProfileStage.optional(),
    want: ProfileWant.optional(),
  })
  .strict();
export type ProfileAnswersInput = z.infer<typeof ProfileAnswersInputSchema>;

/**
 * - `started`: Home sent a new brand's first admin to the welcome (it shows once per brand).
 * - `done`: the questions were finished, a call was confirmed, or answers came from Settings.
 * - `skipped`: Skip for now on the welcome. It only replaces `started`; `done` never goes back.
 */
export const ProfileStatus = z.enum(["started", "done", "skipped"]);
export type ProfileStatus = z.infer<typeof ProfileStatus>;

/** The way the answers last came: the call, the 4 quick questions, or Settings. */
export const ProfileVia = z.enum(["voice", "questions", "settings"]);
export type ProfileVia = z.infer<typeof ProfileVia>;

/**
 * `tenant.businessProfile`. `rev` goes up whenever the answers (or, later, the kept facts) change,
 * so Vizzy knows when to read the profile again. No user ids: it belongs to the brand.
 * An unknown status drops the whole profile (it reads as none).
 */
export const BusinessProfileSchema = z.object({
  status: ProfileStatus,
  via: ProfileVia.optional().catch(undefined),
  answers: ProfileAnswersSchema.default({}).catch({}),
  rev: z.number().int().min(0).catch(0).default(0),
  startedAt: z.string().max(40),
  updatedAt: z.string().max(40).optional().catch(undefined),
});
export type BusinessProfile = z.infer<typeof BusinessProfileSchema>;
