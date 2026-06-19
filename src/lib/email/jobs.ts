import { forTenant, TenantIsolationError } from "@/lib/tenant";
import type { TenantContext, FirestoreLike } from "@/lib/tenant/types";
import type { EmailJobType } from "@/lib/types/emailJob";

/**
 * The email delivery queue (Firestore `email_jobs`, tenant-scoped). Enqueue is
 * idempotent: the document id IS the dedupeKey, so an atomic create rejects a
 * duplicate (same broadcast / same journey step+recipient can't double-send).
 */
export interface EnqueueInput {
  type: EmailJobType;
  campaignId: string;
  dedupeKey: string;
  payload: Record<string, unknown>;
  /** ISO time the job becomes eligible; defaults to now. */
  scheduledAt?: string;
}

export async function enqueueEmailJob(
  ctx: TenantContext,
  input: EnqueueInput,
  db?: FirestoreLike,
): Promise<"enqueued" | "duplicate"> {
  const now = new Date().toISOString();
  try {
    await forTenant(ctx, db).emailJobs.create(input.dedupeKey, {
      campaignId: input.campaignId,
      type: input.type,
      status: "pending",
      dedupeKey: input.dedupeKey,
      scheduledAt: input.scheduledAt ?? now,
      attempts: 0,
      claimedAt: null,
      emailSentAt: null,
      payload: input.payload,
      lastError: null,
      createdAt: now,
      processedAt: null,
    });
    return "enqueued";
  } catch (err) {
    // Atomic create collides → this job was already enqueued. That's the point.
    if (err instanceof TenantIsolationError) return "duplicate";
    throw err;
  }
}
