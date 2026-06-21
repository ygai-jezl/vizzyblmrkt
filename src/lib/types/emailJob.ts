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
  // CRM (Unified CRM feature) — ride the same cron-drained worker + queue.
  // Engagement (opens/clicks) is captured by the Mandrill webhook → email_events,
  // so the CRM needs no polling job here.
  "contact_enrich", // payload: { companyId, domain, sampleEmail?, campaignId }
  "contact_erase", // payload: { contactId } — GDPR Art.17 cascade
]);
export type EmailJobType = z.infer<typeof EmailJobType>;

export const EmailJobStatus = z.enum([
  "pending",
  "processing",
  "done",
  "failed",
]);
export type EmailJobStatus = z.infer<typeof EmailJobStatus>;

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
  /** Journey steps: which A/B arm this recipient was allocated ("control" or a
   *  variant id). Deterministic per (node, recipient); see lib/journey/allocation.ts. */
  variantId: z.string().nullable().optional(),
  /** Job-type-specific payload (broadcastId, or journeyId+nodeId+signupId). */
  payload: z.record(z.string(), z.unknown()),
  lastError: z.string().nullable().optional(),
  createdAt: z.string(),
  processedAt: z.string().nullable().optional(),
});
export type EmailJob = z.infer<typeof EmailJobSchema>;
