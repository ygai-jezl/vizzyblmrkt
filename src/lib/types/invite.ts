import { z } from "zod";

/**
 * "Invite your waitlist" (nav v2 phase 4). A wave invites the top of one launch's
 * waitlist into a connected product. Each person gets at most ONE invite per
 * launch (the invite id is derived from launch + signup), so re-sending a wave or
 * starting a new one can never email someone twice.
 *
 * An invite stores no plaintext email: it keeps a tenant-salted hash for matching
 * product sign-ups, and a random `code` — the only value the product ever sees.
 */

export const INVITE_LIMITS = {
  maxWaveSize: 1000,
  minExpiryDays: 7,
  maxExpiryDays: 90,
  defaultExpiryDays: 30,
} as const;

export const InviteWaveStatus = z.enum(["draft", "sending", "sent", "cancelled"]);
export type InviteWaveStatus = z.infer<typeof InviteWaveStatus>;

export const InviteWaveSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  campaignId: z.string(),
  /** The product people are invited into (a custom, non-staging connection). */
  connectionId: z.string(),
  name: z.string().max(120),
  status: InviteWaveStatus,
  /** How many people to invite, from the top of the ranking, after exclusions. */
  size: z.number().int().min(1).max(INVITE_LIMITS.maxWaveSize),
  /** Leave out people who already use the product (matched by email). */
  excludeExistingUsers: z.boolean(),
  subject: z.string().min(1).max(200),
  /** Email body (Markdown-ish, like journey emails). Must contain {{invite_link}}. */
  body: z.string().min(1).max(20_000),
  heroImageUrl: z.string().url().max(2000).nullable().optional(),
  expiresInDays: z.number().int().min(INVITE_LIMITS.minExpiryDays).max(INVITE_LIMITS.maxExpiryDays),
  authoredBy: z.enum(["human", "agent"]),
  counts: z.object({
    selected: z.number().int().nonnegative(),
    created: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
  }),
  createdBy: z.string().nullable().optional(),
  sentBy: z.string().nullable().optional(),
  sentAt: z.string().nullable().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type InviteWave = z.infer<typeof InviteWaveSchema>;

export const InviteStatus = z.enum(["queued", "invited", "skipped", "failed", "cancelled"]);
export type InviteStatus = z.infer<typeof InviteStatus>;

export const InviteSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  campaignId: z.string(),
  waveId: z.string(),
  signupId: z.string(),
  connectionId: z.string(),
  /** sha256(tenantId:normalised email) — matching only; never the address itself. */
  emailHash: z.string(),
  /** Random, URL-safe. Travels to the product as `yg_invite`; nothing else does. */
  code: z.string(),
  status: InviteStatus,
  /** Why it wasn't sent: "unsubscribed", "left_waitlist", "no_email", "cancelled". */
  skipReason: z.string().nullable().optional(),
  // Funnel flags — they only ever move forward (false → true), so counts are equality queries.
  invited: z.boolean(),
  invitedAt: z.string().nullable().optional(),
  clicked: z.boolean(),
  clickedAt: z.string().nullable().optional(),
  clickCount: z.number().int().nonnegative(),
  signedUp: z.boolean(),
  signedUpAt: z.string().nullable().optional(),
  activated: z.boolean(),
  activatedAt: z.string().nullable().optional(),
  /** The product user it turned into, and how we matched them. */
  productUserId: z.string().nullable().optional(),
  matchedBy: z.enum(["code", "email"]).nullable().optional(),
  /** After this, the link shows a plain "go to the product" page (attribution by email still works). */
  expiresAt: z.string().nullable().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Invite = z.infer<typeof InviteSchema>;
