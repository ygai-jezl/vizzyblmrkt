import { applyProductMessage, forTenant, type TenantContext } from "@/lib/tenant";
import type { FirestoreLike } from "@/lib/tenant/types";
import type { ProductConnection } from "@/lib/types/productConnection";
import type { ConnectionDiagnostics } from "@/lib/types/productEvent";
import {
  IngestMessageSchema,
  LIMITS,
  RESERVED_EVENTS,
  zodReason,
  type IngestMessage,
} from "./protocol";
import { applyMessage, productEventDocId, productUserDocId, toUtcIso } from "./profile";
import { eraseProductUserHistory } from "./erase";
import { enrolOnEvents, type TriggerEvent } from "@/lib/lifecycle/enrol";
import { isLifecycleEnabled } from "@/lib/lifecycle/flags";
import { isInvitesEnabled } from "@/lib/invites/flags";
import { inviteCodeOf, recordInviteProgress, type TouchedUser } from "@/lib/invites/attribution";

/**
 * Ingest one verified batch from a connected product. Each message is validated
 * and applied on its own (one bad message never sinks the batch), atomically and
 * idempotently (see applyProductMessage). The caller has ALREADY verified the
 * request signature and resolved `ctx` from the key — nothing here trusts the body
 * for tenant scope.
 */

export interface IngestRejection {
  index: number;
  messageId: string | null;
  reason: string;
}

export interface IngestSummary {
  accepted: number;
  duplicates: number;
  rejected: IngestRejection[];
}

/** Product events are kept this long for the debugger and analytics. */
export const EVENT_TTL_MS = 90 * 24 * 3600_000;
const MAX_OBSERVED = 200;
const MAX_REJECTIONS = 50;
/** Don't rewrite health.lastEventAt more often than this. */
const HEALTH_WRITE_INTERVAL_MS = 60_000;

function messageIdOf(raw: unknown): string | null {
  if (raw && typeof raw === "object" && "messageId" in raw) {
    const v = (raw as { messageId?: unknown }).messageId;
    if (typeof v === "string") return v.slice(0, 128);
  }
  return null;
}

function traitType(v: unknown): string {
  return v === null ? "null" : typeof v;
}

export async function ingestBatch(
  ctx: TenantContext,
  connection: ProductConnection,
  batch: unknown[],
  opts: { db?: FirestoreLike; nowMs?: number } = {},
): Promise<IngestSummary> {
  const nowMs = opts.nowMs ?? Date.now();
  const now = new Date(nowMs).toISOString();
  const summary: IngestSummary = { accepted: 0, duplicates: 0, rejected: [] };
  const observedEvents = new Map<string, number>();
  const observedTraits = new Map<string, string>();
  const deletedUsers: string[] = [];
  const triggers: TriggerEvent[] = [];
  const touched: TouchedUser[] = [];

  for (const [index, raw] of batch.entries()) {
    const reject = (reason: string) =>
      summary.rejected.push({ index, messageId: messageIdOf(raw), reason });

    const parsed = IngestMessageSchema.safeParse(raw);
    if (!parsed.success) {
      reject(zodReason(parsed.error));
      continue;
    }
    const msg: IngestMessage = { ...parsed.data, timestamp: toUtcIso(parsed.data.timestamp) };
    if (Date.parse(msg.timestamp) > nowMs + LIMITS.maxFutureSkewMs) {
      reject("timestamp_in_future");
      continue;
    }
    const isDelete = msg.type === "track" && msg.event === RESERVED_EVENTS.userDeleted;
    // A deletion's own event row keeps no payload (it would outlive the erasure).
    const payload = isDelete ? {} : msg.type === "track" ? msg.properties : msg.traits;
    if (Buffer.byteLength(JSON.stringify(payload), "utf8") > LIMITS.maxPayloadBytes) {
      reject("payload_too_large");
      continue;
    }

    const userDocId = productUserDocId(connection.id, msg.userId);
    const result = await applyProductMessage(
      ctx,
      {
        eventId: productEventDocId(connection.id, msg.messageId),
        userDocId,
        mutate: (current) => applyMessage(current, msg, { connection, nowMs }),
        buildEvent: (applied) => ({
          connectionId: connection.id,
          productUserId: userDocId,
          externalUserId: msg.userId,
          messageId: msg.messageId,
          type: msg.type,
          event: msg.type === "track" ? msg.event : null,
          payload,
          timestamp: msg.timestamp,
          receivedAt: now,
          applied,
          ttlAt: new Date(nowMs + EVENT_TTL_MS),
        }),
      },
      opts.db,
    );

    if (result.outcome === "rejected") {
      reject(result.reason);
      continue;
    }
    if (result.outcome === "duplicate") {
      summary.duplicates += 1;
      continue;
    }
    summary.accepted += 1;
    if (msg.type === "track") {
      observedEvents.set(msg.event, (observedEvents.get(msg.event) ?? 0) + 1);
    }
    for (const [k, v] of Object.entries(msg.traits ?? {})) observedTraits.set(k, traitType(v));
    if (isDelete && result.outcome === "applied") deletedUsers.push(userDocId);
    // A new event may enrol the user in a journey it triggers (checked after the batch).
    if (msg.type === "track" && !isDelete && result.outcome === "applied" && result.user) {
      triggers.push({ user: result.user, event: msg.event, timestamp: msg.timestamp });
    }
    // Invite sign-ups and activation are matched after the batch (identify or track).
    if (!isDelete && result.outcome === "applied" && result.user) {
      touched.push({ user: result.user, code: inviteCodeOf(msg) });
    }
  }

  // Erasure cascade: a deleted user's history goes too — events, journey
  // enrolments, email engagement (their tombstone stays, PII-free, to block
  // stale re-creation). Best-effort: a failure is logged and the next
  // user.deleted retry repeats it.
  for (const productUserId of deletedUsers) {
    await eraseProductUserHistory(ctx, productUserId, opts.db).catch((err) => {
      const m = err instanceof Error ? err.message.slice(0, 200) : "error";
      console.error(`[connect] erase cascade failed for ${ctx.tenantId}/${productUserId}: ${m}`);
    });
  }

  // Lifecycle journeys triggered by this batch's events (users deleted in the
  // same batch are skipped). Never fails the ingest: enrolment errors are logged.
  const live = triggers.filter((t) => !deletedUsers.includes(t.user.id));
  if (live.length > 0 && isLifecycleEnabled()) {
    await enrolOnEvents(ctx, connection, live, { db: opts.db, nowMs }).catch((err) => {
      const m = err instanceof Error ? err.message.slice(0, 200) : "error";
      console.error(`[connect] journey enrolment failed for ${ctx.tenantId}/${connection.id}: ${m}`);
    });
  }

  // Invites (nav v2 phase 4): new sign-ups and activation from invited waitlist
  // members. Never fails the ingest.
  const invitees = touched.filter((t) => !deletedUsers.includes(t.user.id));
  if (invitees.length > 0 && isInvitesEnabled()) {
    await recordInviteProgress(ctx, connection.id, invitees, { db: opts.db, nowMs }).catch((err) => {
      const m = err instanceof Error ? err.message.slice(0, 200) : "error";
      console.error(`[connect] invite progress failed for ${ctx.tenantId}/${connection.id}: ${m}`);
    });
  }

  await recordDiagnostics(ctx, connection, { observedEvents, observedTraits, summary, now }, opts.db);
  await touchHealth(ctx, connection, summary, nowMs, opts.db);
  return summary;
}

/** Observed catalog + recent rejections for the setup wizard and debugger. */
export async function recordDiagnostics(
  ctx: TenantContext,
  connection: ProductConnection,
  seen: {
    observedEvents: Map<string, number>;
    observedTraits: Map<string, string>;
    summary: IngestSummary;
    now: string;
  },
  db?: FirestoreLike,
): Promise<void> {
  if (seen.observedEvents.size === 0 && seen.observedTraits.size === 0 && seen.summary.rejected.length === 0) {
    return;
  }
  const merge = (cur: Omit<ConnectionDiagnostics, "id" | "tenantId">) => {
    const events = { ...cur.observedEvents };
    for (const [name, n] of seen.observedEvents) {
      if (!events[name] && Object.keys(events).length >= MAX_OBSERVED) continue;
      events[name] = { count: (events[name]?.count ?? 0) + n, lastAt: seen.now };
    }
    const traits = { ...cur.observedTraits };
    for (const [key, type] of seen.observedTraits) {
      if (!traits[key] && Object.keys(traits).length >= MAX_OBSERVED) continue;
      traits[key] = { type, lastAt: seen.now };
    }
    const rejections = [
      ...seen.summary.rejected.map((r) => ({ at: seen.now, messageId: r.messageId, reason: r.reason })),
      ...cur.recentRejections,
    ].slice(0, MAX_REJECTIONS);
    return { observedEvents: events, observedTraits: traits, recentRejections: rejections, updatedAt: seen.now };
  };
  try {
    await forTenant(ctx, db).connectionDiagnostics.upsert(
      connection.id,
      () => merge({ observedEvents: {}, observedTraits: {}, recentRejections: [], updatedAt: seen.now }),
      (cur) => merge(cur),
    );
  } catch (err) {
    const m = err instanceof Error ? err.message.slice(0, 200) : "error";
    console.warn(`[connect] diagnostics write failed for ${ctx.tenantId}/${connection.id}: ${m}`);
  }
}

/** Stamp health.lastEventAt (throttled — at most once a minute). */
export async function touchHealth(
  ctx: TenantContext,
  connection: ProductConnection,
  summary: IngestSummary,
  nowMs: number,
  db?: FirestoreLike,
): Promise<void> {
  if (summary.accepted + summary.duplicates === 0) return;
  const last = connection.health?.lastEventAt ? Date.parse(connection.health.lastEventAt) : 0;
  if (nowMs - last < HEALTH_WRITE_INTERVAL_MS) return;
  await forTenant(ctx, db)
    .productConnections.update(connection.id, {
      health: { ...connection.health, lastEventAt: new Date(nowMs).toISOString() },
    })
    .catch(() => {});
}
