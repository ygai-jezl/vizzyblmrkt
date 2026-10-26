import { z } from "zod";

/**
 * POST /api/v2/signups (LAUNCH_SITE_SIGNUPS_ENABLED): what a brand's server sends to
 * add one email to the launch its site key belongs to, and what it gets back. One
 * module shared by the route, the service, the OpenAPI spec and the docs.
 */

export const SITE_SIGNUPS_PATH = "/api/v2/signups";

export const SITE_SIGNUP_LIMITS = {
  /** Request body. */
  maxBodyBytes: 8 * 1024,
  /** Calls per key. */
  perMinute: 60,
  perHour: 1_000,
  /** One confirmation email per address per launch in this window. */
  resendAfterMs: 24 * 3600_000,
} as const;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const SiteSignupRequestSchema = z
  .object({
    email: z.string().trim().max(320).regex(EMAIL_RE, "not an email address"),
    firstName: z.string().trim().min(1).max(100).optional(),
    /** The language of their emails, e.g. en-GB. Kept when the launch offers it. */
    locale: z.string().trim().max(35).optional(),
    /** Where on your site they signed up, e.g. blog/gemini-utms. */
    source: z.string().trim().min(1).max(200).optional(),
  })
  .strict();
export type SiteSignupRequest = z.infer<typeof SiteSignupRequestSchema>;

export const SiteSignupReplySchema = z.union([
  z.object({ status: z.literal("confirmation_sent") }),
  z.object({ status: z.literal("already_confirmed") }),
  z.object({
    status: z.literal("not_sent"),
    /** recently_sent: one email per address a day. blocked: bounced or reported as spam. removed: taken off the launch. */
    reason: z.enum(["recently_sent", "blocked", "removed"]),
  }),
]);
export type SiteSignupReply = z.infer<typeof SiteSignupReplySchema>;
