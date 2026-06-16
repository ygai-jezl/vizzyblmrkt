import { z } from "zod";

/**
 * Email delivery job — the unit of work drained by the delivery worker
 * (src/lib/email/delivery.ts). Lives in the tenant-scoped `email_jobs`
 * collection. Idempotent: the document id IS the `dedupeKey`, so the same job
 * can never be enqueued twice (atomic create rejects duplicates).
 */
export const EmailJobType = z.enum(["broadcast", "journey_step"]);
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
  /** Job-type-specific payload (broadcastId, or journeyId+nodeId+signupId). */
  payload: z.record(z.string(), z.unknown()),
  lastError: z.string().nullable().optional(),
  createdAt: z.string(),
  processedAt: z.string().nullable().optional(),
});
export type EmailJob = z.infer<typeof EmailJobSchema>;
