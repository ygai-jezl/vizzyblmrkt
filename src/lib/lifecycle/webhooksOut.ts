import { createHash } from "node:crypto";
import { forTenant, TenantIsolationError, type TenantContext } from "@/lib/tenant";
import type { FirestoreLike } from "@/lib/tenant/types";
import type { LifecycleWebhook } from "@/lib/types/lifecycle";
import type { ProductConnection } from "@/lib/types/productConnection";
import { sendConnectionWebhook } from "@/lib/connect/webhookClient";

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

// ---- Delivery (run by the lifecycle tick) -------------------------------------------------

export interface WebhookDrainResult {
  delivered: number;
  failed: number;
  expired: number;
}

/** 1 min, 2, 4 … capped at 6 h. */
export function webhookBackoffMs(attempts: number): number {
  return Math.min(60_000 * 2 ** Math.max(0, attempts - 1), 6 * 3600_000);
}

/**
 * Deliver due webhooks for one tenant. Each is claimed first (its next attempt
 * pushed out by the backoff), so overlapping ticks never double-send one; a
 * success marks it done, a failure leaves it for the next attempt, and anything
 * past its 24 h expiry is dropped.
 */
export async function drainConnectionWebhooks(
  ctx: TenantContext,
  deps: {
    db?: FirestoreLike;
    now?: () => number;
    deadlineAt?: number;
    send?: typeof sendConnectionWebhook;
    limit?: number;
  } = {},
): Promise<WebhookDrainResult> {
  const clock = deps.now ?? Date.now;
  const repo = forTenant(ctx, deps.db);
  const result: WebhookDrainResult = { delivered: 0, failed: 0, expired: 0 };
  const nowIso = new Date(clock()).toISOString();
  const due = await repo.lifecycleWebhooks.find({
    where: [
      ["status", "==", "pending"],
      ["nextAttemptAt", "<=", nowIso],
    ],
    orderBy: [["nextAttemptAt", "asc"]],
    limit: deps.limit ?? 25,
  });
  const connections = new Map<string, Promise<ProductConnection | null>>();

  for (const w of due) {
    if (deps.deadlineAt !== undefined && clock() >= deps.deadlineAt) break;
    const nowMs = clock();
    const at = new Date(nowMs).toISOString();
    if (w.expiresAt <= at) {
      const done = await repo.lifecycleWebhooks.claim(w.id, (cur) => (cur.status === "pending" ? { status: "expired" } : null));
      if (done) result.expired += 1;
      continue;
    }
    const claimed = await repo.lifecycleWebhooks.claim(w.id, (cur) =>
      cur.status === "pending" && cur.nextAttemptAt <= at
        ? { attempts: cur.attempts + 1, nextAttemptAt: new Date(nowMs + webhookBackoffMs(cur.attempts + 1)).toISOString() }
        : null,
    );
    if (!claimed) continue;

    let conn = connections.get(w.connectionId);
    if (!conn) {
      conn = repo.productConnections.getById(w.connectionId);
      connections.set(w.connectionId, conn);
    }
    const connection = await conn;
    if (!connection || connection.status === "revoked") {
      await repo.lifecycleWebhooks.update(w.id, { status: "expired", lastError: "connection_gone" });
      result.expired += 1;
      continue;
    }
    // The same id on every attempt, so the product can drop a retry it already handled.
    const event = { id: w.id.replace(/^whq_/, "wh_"), createdAt: w.createdAt, type: w.type, data: w.data };
    const res = await (deps.send ?? sendConnectionWebhook)(connection, event, { db: deps.db, nowMs });
    if (res.ok) {
      await repo.lifecycleWebhooks.update(w.id, { status: "done", lastError: null });
      result.delivered += 1;
    } else {
      await repo.lifecycleWebhooks.update(w.id, { lastError: res.error.slice(0, 300) });
      result.failed += 1;
    }
  }
  return result;
}
