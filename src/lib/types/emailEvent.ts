import { z } from "zod";

/**
 * Email engagement event — one row per (journey step, recipient, A/B arm,
 * event type), recorded from Mandrill's open/click/send/bounce webhooks. Lives
 * in the tenant-scoped `email_events` collection (regional DB — engagement is
 * marketing PII). Counts are UNIQUE-per-recipient: the document id IS the dedupe
 * key, so a replayed Mandrill batch or a recipient's repeat opens/clicks collapse
 * to a single row (atomic create rejects duplicates — see lib/email/events.ts).
 */
export const EmailEventType = z.enum([
  "send",
  "open",
  "click",
  "bounce",
  "soft_bounce",
  "spam",
  "reject",
  "unsub",
]);
export type EmailEventType = z.infer<typeof EmailEventType>;

export const EmailEventSchema = z.object({
  /** = `evt:{journeyId}:{nodeId}:{signupId}:{variantId}:{type}` (the dedupe key). */
  id: z.string(),
  tenantId: z.string(),
  /** Denormalised from the send metadata so the launch roll-up needs no join. */
  campaignId: z.string(),
  journeyId: z.string(),
  nodeId: z.string(),
  signupId: z.string(),
  /** "control" or a variant id (which A/B arm the recipient was sent). */
  variantId: z.string(),
  type: EmailEventType,
  /** Mandrill message id (msg._id), for audit/debug. */
  mandrillMessageId: z.string().nullable().optional(),
  /** ISO timestamp of the Mandrill event. */
  ts: z.string(),
  /** Click target URL (click events only). */
  url: z.string().nullable().optional(),
  createdAt: z.string(),
});
export type EmailEvent = z.infer<typeof EmailEventSchema>;
