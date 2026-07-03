import { z } from "zod";

/**
 * Social engagement event — one row per discrete inbound interaction on a connected
 * social account (a reply/mention/quote/repost/like/follow/DM). Mirrors
 * `emailEvent.ts`: lives in the tenant-scoped `social_events` collection (regional DB
 * — engagement is marketing PII), and the document id IS the dedupe key, so a replayed
 * webhook batch collapses to a single row (atomic create rejects the duplicate — see
 * lib/social/socialEvents.ts).
 *
 * The actor (who engaged) is denormalised onto the row so the CRM "Engaged" tab and
 * the comment→lead→DM funnel need no second lookup. `targetRemoteId` links a
 * reply/quote back to OUR post (its publishedRef.remoteId) when the platform tells us.
 */
export const SocialPlatform = z.enum(["x", "instagram", "linkedin"]);
export type SocialPlatform = z.infer<typeof SocialPlatform>;

export const SocialEventType = z.enum([
  "reply",
  "mention",
  "quote",
  "repost",
  "like",
  "follow",
  "dm",
]);
export type SocialEventType = z.infer<typeof SocialEventType>;

export const SocialEventSchema = z.object({
  /** = `sev:{platform}:{type}:{remoteId}` (the dedupe key). */
  id: z.string(),
  tenantId: z.string(),
  platform: SocialPlatform,
  type: SocialEventType,
  /**
   * A value UNIQUE per real-world event, used for dedupe: the reply/quote tweet id,
   * the DM id, or a synthesized `{targetRemoteId}:{actorId}` for likes/follows (which
   * carry no event id of their own — a user can only like/follow a thing once).
   */
  remoteId: z.string().max(200),
  /** The engaging account (denormalised for the Engaged CRM). */
  actorId: z.string().max(200),
  actorHandle: z.string().max(200).nullable().optional(),
  actorName: z.string().max(300).nullable().optional(),
  /** OUR post's remote id (publishedRef.remoteId) this engages with, when resolvable. */
  targetRemoteId: z.string().max(200).nullable().optional(),
  /** Reply/mention/DM text — the comment→lead→DM keyword trigger reads this. Capped. */
  text: z.string().max(2000).nullable().optional(),
  /** ISO timestamp of the platform event. */
  ts: z.string(),
  createdAt: z.string(),
});
export type SocialEvent = z.infer<typeof SocialEventSchema>;
