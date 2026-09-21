import { createHash } from "node:crypto";
import { forTenant, TenantIsolationError, type TenantContext } from "@/lib/tenant";
import type { FirestoreLike } from "@/lib/tenant/types";
import type { LifecycleWebhook } from "@/lib/types/lifecycle";

/**
 * Outbound webhooks to connected products (e.g. "this user unsubscribed from
 * onboarding tips", so the product can mirror it). Queued here and delivered by
 * the lifecycle runner's tick with backoff (1 min → 6 h), expiring after 24 h.
 * The payload never carries an email address — only the product's own user id.
 */

export const WEBHOOK_EXPIRY_MS = 24 * 3600_000;

export async function enqueueConnectionWebhook(
  ctx: TenantContext,
  input: {
    connectionId: string;
    type: LifecycleWebhook["type"];
    data: Record<string, unknown>;
    /** Stable key so a repeated cause (a double click) queues one webhook. */
    dedupeKey: string;
  },
  db?: FirestoreLike,
  nowMs = Date.now(),
): Promise<"queued" | "duplicate"> {
  const id = `whq_${createHash("sha256").update(`${input.connectionId}\n${input.dedupeKey}`).digest("hex").slice(0, 32)}`;
  const now = new Date(nowMs).toISOString();
  try {
    await forTenant(ctx, db).lifecycleWebhooks.create(id, {
      connectionId: input.connectionId,
      type: input.type,
      data: input.data,
      status: "pending",
      attempts: 0,
      nextAttemptAt: now,
      lastError: null,
      expiresAt: new Date(nowMs + WEBHOOK_EXPIRY_MS).toISOString(),
      createdAt: now,
    });
    return "queued";
  } catch (err) {
    if (err instanceof TenantIsolationError) return "duplicate";
    throw err;
  }
}
