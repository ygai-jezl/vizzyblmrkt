import { z } from "zod";

/**
 * Email delivery job — the unit of work drained by the delivery worker
 * (src/lib/email/delivery.ts). Lives in the tenant-scoped `email_jobs`
 * collection. Idempotent: the document id IS the `dedupeKey`, so the same job
 * can never be enqueued twice (atomic create rejects duplicates).
 */
export const EmailJobType = z.enum([
  "broadcast",
  "journey_step",
  // Transactional lifecycle email (e.g. offboarding). payload: { signupId }.
  // Async so a bulk offboard (up to 500) never blocks the admin request.
  "lifecycle",
  // CRM (Unified CRM feature) — ride the same cron-drained worker + queue.
  // Engagement (opens/clicks) is captured by the Mandrill webhook → email_events,
  // so the CRM needs no polling job here.
  "contact_enrich", // payload: { companyId, domain, sampleEmail?, campaignId }
  "contact_erase", // payload: { contactId } — GDPR Art.17 cascade
  // Invite your waitlist (nav v2 phase 4): one per person. payload: { inviteId }.
  "invite",
]);
export type EmailJobType = z.infer<typeof EmailJobType>;

export const EmailJobStatus = z.enum([
  "pending",
  "processing",
  "done",
  "failed",
  // Waitlist journey step waiting while its journey is paused or its launch is
  // archived (engine move D1). The worker never claims it; resuming releases it.
  "held",
]);
export type EmailJobStatus = z.infer<typeof EmailJobStatus>;

/** Why a waitlist journey step is held. */
export const HeldReason = z.enum(["journey_paused", "journey_draft", "launch_archived"]);
export type HeldReason = z.infer<typeof HeldReason>;

/** Why a waitlist journey step ended without sending (the person left the journey). */
export const EndedReason = z.enum(["hold_expired", "step_removed"]);
export type EndedReason = z.infer<typeof EndedReason>;

export const EmailJobSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  campaignId: z.string(),
  type: EmailJobType,
  status: EmailJobStatus,
  /** Equal to the document id; the idempotency key. */
  dedupeKey: z.string(),
  /** ISO time the job becomes eligible to run (journey waits set this future). */
  scheduledAt: z.string(),
  attempts: z.number().int().nonnegative(),
  /** Set while status==="processing"; lets the worker reclaim stale (crashed) claims. */
  claimedAt: z.string().nullable().optional(),
  /** Journey steps: stamped once the recipient email is dispatched, so a retry
   *  after a post-send failure does not re-send the same email. */
  emailSentAt: z.string().nullable().optional(),
  /** Journey steps: the Mandrill message id returned at send time (audit/debug
   *  backstop; event attribution itself rides on per-message metadata). */
  mandrillMessageId: z.string().nullable().optional(),
  /** Set when the provider's answer was AMBIGUOUS (timeout, dropped connection,
   *  unreadable response): the email may have gone out, so it was treated as sent
   *  and never retried. Holds the provider reason, for audit. */
  sendAmbiguous: z.string().nullable().optional(),
  /** Journey steps: which A/B arm this recipient was allocated ("control" or a
   *  variant id). Deterministic per (node, recipient); see lib/journey/allocation.ts. */
  variantId: z.string().nullable().optional(),
  /** Held journey steps: why, and since when (the 90-day limit counts from here). */
  heldReason: HeldReason.nullable().optional(),
  heldAt: z.string().nullable().optional(),
  /** Set when a step ended without sending because the person left the journey. */
  endedReason: EndedReason.nullable().optional(),
  /** Job-type-specific payload (broadcastId, or journeyId+nodeId+signupId). */
  payload: z.record(z.string(), z.unknown()),
  lastError: z.string().nullable().optional(),
  createdAt: z.string(),
  processedAt: z.string().nullable().optional(),
});
export type EmailJob = z.infer<typeof EmailJobSchema>;
