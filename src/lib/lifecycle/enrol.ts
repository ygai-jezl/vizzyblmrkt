import { createHash } from "node:crypto";
import { forTenant, TenantIsolationError, type TenantContext } from "@/lib/tenant";
import type { FirestoreLike } from "@/lib/tenant/types";
import type { ProductConnection } from "@/lib/types/productConnection";
import type { ProductUser } from "@/lib/types/productUser";
import type { LifecycleJourney, LifecycleVersion } from "@/lib/types/lifecycle";
import { RESERVED_EVENTS } from "@/lib/connect/protocol";
import { entryCursor } from "./planner";
import { isTestRecipient } from "./policy";

/**
 * Enrolment: a product user entering a published lifecycle journey. The
 * enrolment document IS the runner's queue item, created atomically with a
 * deterministic id per (journey, user) — so a user enters a journey at most
 * once, however many times the trigger event arrives (re-entry: never).
 */

const DAY_MS = 86_400_000;
export const COUNTER_TTL_MS = 40 * DAY_MS;

export function enrolmentDocId(journeyId: string, productUserId: string): string {
  return `enr_${createHash("sha256").update(`${journeyId}\n${productUserId}`).digest("hex").slice(0, 40)}`;
}

/** UTC day key for the daily counters, e.g. "20260921". */
export function utcDayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10).replace(/-/g, "");
}

export function counterDocId(journeyId: string, ms: number): string {
  return `${journeyId}_${utcDayKey(ms)}`;
}

export function versionDocId(journeyId: string, version: number): string {
  return `${journeyId}_v${version}`;
}

export type EnrolOutcome =
  | { outcome: "enrolled"; enrolmentId: string }
  | { outcome: "duplicate"; enrolmentId: string }
  | { outcome: "skipped"; reason: string };

export async function enrolUser(
  ctx: TenantContext,
  a: {
    journey: LifecycleJourney;
    version: LifecycleVersion;
    user: ProductUser;
    source: "trigger" | "manual" | "backfill";
    /** When the journey clock starts (the trigger event's time). */
    anchorAt: string;
    requireApproval?: boolean;
  },
  deps: { db?: FirestoreLike; nowMs?: number } = {},
): Promise<EnrolOutcome> {
  const nowMs = deps.nowMs ?? Date.now();
  const now = new Date(nowMs).toISOString();
  const { journey, version, user } = a;
  if (journey.status !== "active") return { outcome: "skipped", reason: "journey_not_active" };
  if (user.status !== "active") return { outcome: "skipped", reason: "user_deleted" };
  if (user.connectionId !== journey.connectionId) return { outcome: "skipped", reason: "wrong_connection" };
  // API v2: the product's own "never email" and opt-out apply to every journey.
  if (user.excluded) return { outcome: "skipped", reason: "excluded" };
  if (user.subscribed === false) return { outcome: "skipped", reason: "unsubscribed_in_product" };
  if (journey.deliveryMode === "test" && !isTestRecipient(journey, user)) {
    return { outcome: "skipped", reason: "not_a_test_recipient" };
  }

  const repo = forTenant(ctx, deps.db);
  const counterId = counterDocId(journey.id, nowMs);
  const counter = await repo.lifecycleCounters.getById(counterId);
  if ((counter?.enrolments ?? 0) >= journey.caps.enrolmentsPerDay) {
    console.warn(`[lifecycle] enrolment cap reached: ${ctx.tenantId}/${journey.id}`);
    return { outcome: "skipped", reason: "enrolment_cap" };
  }

  const id = enrolmentDocId(journey.id, user.id);
  const cursor = entryCursor(version.graph);
  try {
    await repo.lifecycleEnrolments.create(id, {
      journeyId: journey.id,
      versionId: version.id,
      connectionId: journey.connectionId,
      productUserId: user.id,
      externalUserId: user.externalUserId,
      mode: journey.deliveryMode,
      status: cursor ? "active" : "completed",
      stopReason: null,
      source: a.source,
      requireApproval: a.requireApproval ?? a.source === "backfill",
      anchorAt: a.anchorAt,
      lastSentAt: null,
      cursor: cursor ? { nodeId: cursor } : null,
      nextRunAt: cursor ? now : null,
      windowExemptUntil: null,
      leaseId: null,
      leaseUntil: null,
      pendingSend: null,
      sentItems: [],
      usedInsightIds: [],
      failures: 0,
      log: [{ at: now, event: "enrolled", detail: `${a.source} · ${journey.deliveryMode}` }],
      createdAt: now,
      updatedAt: now,
    });
  } catch (err) {
    if (err instanceof TenantIsolationError) return { outcome: "duplicate", enrolmentId: id };
    throw err;
  }

  await repo.lifecycleCounters
    .upsert(
      counterId,
      () => ({ journeyId: journey.id, day: utcDayKey(nowMs), sends: 0, enrolments: 1, ttlAt: new Date(nowMs + COUNTER_TTL_MS) }),
      (cur) => ({ enrolments: (cur.enrolments ?? 0) + 1 }),
    )
    .catch((err) => {
      console.warn(`[lifecycle] enrolment counter failed: ${err instanceof Error ? err.message.slice(0, 200) : "error"}`);
    });
  return { outcome: "enrolled", enrolmentId: id };
}

/** Active journeys on a connection, each with its published version. */
export async function activeJourneysFor(
  ctx: TenantContext,
  connectionId: string,
  db?: FirestoreLike,
): Promise<Array<{ journey: LifecycleJourney; version: LifecycleVersion }>> {
  const repo = forTenant(ctx, db);
  const journeys = await repo.lifecycleJourneys.find({
    where: [
      ["connectionId", "==", connectionId],
      ["status", "==", "active"],
    ],
    limit: 20,
  });
  const out: Array<{ journey: LifecycleJourney; version: LifecycleVersion }> = [];
  for (const journey of journeys) {
    if (!journey.publishedVersion) continue;
    const version = await repo.lifecycleVersions.getById(versionDocId(journey.id, journey.publishedVersion));
    if (version) out.push({ journey, version });
  }
  return out;
}

/**
 * API v2: enrol users in the active sign-up journeys (triggered by
 * `user.signed_up`) whose window their `signedUpAt` is still inside. It runs on
 * EVERY write, so a retry, a late write, or a journey that goes live later still
 * enrols the people inside its window — and it's idempotent (one enrolment per
 * journey and user). Best-effort per user, like enrolOnEvents.
 */
export async function enrolOnSignup(
  ctx: TenantContext,
  connection: Pick<ProductConnection, "id" | "status">,
  users: ProductUser[],
  deps: { db?: FirestoreLike; nowMs?: number; journeys?: Array<{ journey: LifecycleJourney; version: LifecycleVersion }> } = {},
): Promise<{ enrolled: number }> {
  const candidates = users.filter((u) => u.status === "active" && u.signedUpAt);
  if (candidates.length === 0 || connection.status !== "active") return { enrolled: 0 };
  const nowMs = deps.nowMs ?? Date.now();
  const journeys = (deps.journeys ?? (await activeJourneysFor(ctx, connection.id, deps.db))).filter(
    ({ version }) => version.settings.trigger.event === RESERVED_EVENTS.signedUp,
  );
  const repo = forTenant(ctx, deps.db);
  let enrolled = 0;
  for (const user of candidates) {
    const signedUpMs = Date.parse(user.signedUpAt!);
    for (const { journey, version } of journeys) {
      if (nowMs - signedUpMs > version.settings.trigger.maxEventAgeHours * 3600_000) continue;
      try {
        // Already in: one read, no write (this runs on every write for the whole window).
        if (await repo.lifecycleEnrolments.getById(enrolmentDocId(journey.id, user.id))) continue;
        const r = await enrolUser(
          ctx,
          { journey, version, user, source: "trigger", anchorAt: user.signedUpAt! },
          { db: deps.db, nowMs },
        );
        if (r.outcome === "enrolled") enrolled += 1;
      } catch (err) {
        const m = err instanceof Error ? err.message.slice(0, 200) : "error";
        console.error(`[lifecycle] sign-up enrol failed ${ctx.tenantId}/${journey.id}/${user.id}: ${m}`);
      }
    }
  }
  return { enrolled };
}

export interface TriggerEvent {
  user: ProductUser;
  event: string;
  /** The event's own time (UTC ISO). */
  timestamp: string;
}

/**
 * The ingest hook: enrol users whose event just triggered an active journey on
 * this connection. Events older than the journey's `maxEventAgeHours` (e.g. a
 * backfill replay) don't enrol. Best-effort per user — one failure never fails
 * the ingest batch (it's logged; a manual enrol can repair it).
 */
export async function enrolOnEvents(
  ctx: TenantContext,
  connection: Pick<ProductConnection, "id" | "status">,
  events: TriggerEvent[],
  deps: { db?: FirestoreLike; nowMs?: number } = {},
): Promise<{ enrolled: number }> {
  if (events.length === 0 || connection.status !== "active") return { enrolled: 0 };
  const nowMs = deps.nowMs ?? Date.now();
  const journeys = await activeJourneysFor(ctx, connection.id, deps.db);
  let enrolled = 0;
  for (const e of events) {
    for (const { journey, version } of journeys) {
      const trigger = version.settings.trigger;
      if (trigger.event !== e.event) continue;
      if (nowMs - Date.parse(e.timestamp) > trigger.maxEventAgeHours * 3600_000) continue;
      try {
        const r = await enrolUser(
          ctx,
          { journey, version, user: e.user, source: "trigger", anchorAt: e.timestamp },
          { db: deps.db, nowMs },
        );
        if (r.outcome === "enrolled") enrolled += 1;
      } catch (err) {
        const m = err instanceof Error ? err.message.slice(0, 200) : "error";
        console.error(`[lifecycle] enrol failed ${ctx.tenantId}/${journey.id}/${e.user.id}: ${m}`);
      }
    }
  }
  return { enrolled };
}
