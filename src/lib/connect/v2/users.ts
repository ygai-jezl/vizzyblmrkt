import { randomUUID } from "node:crypto";
import { applyProductMessage, forTenant, TenantIsolationError, type TenantContext } from "@/lib/tenant";
import type { FirestoreLike } from "@/lib/tenant/types";
import type { ProductConnection } from "@/lib/types/productConnection";
import type { ProductUser } from "@/lib/types/productUser";
import { activeJourneysFor, enrolOnEvents, enrolOnSignup } from "@/lib/lifecycle/enrol";
import { isLifecycleConsentAtSendEnabled, isLifecycleEnabled } from "@/lib/lifecycle/flags";
import { allowsMarketing } from "@/lib/lifecycle/policy";
import { isInvitesEnabled } from "@/lib/invites/flags";
import { inviteCodeFromTraits, recordInviteProgress, type TouchedUser } from "@/lib/invites/attribution";
import { eraseProductUserHistory, scrubSuppressionEmails } from "../erase";
import { EVENT_TTL_MS, recordDiagnostics, touchHealth, type IngestSummary } from "../ingest";
import { RESERVED_EVENTS } from "../protocol";
import {
  applyMessage,
  applyUserPatch,
  newTombstone,
  productEventDocId,
  productUserDocId,
  tombstoneOf,
  toUtcIso,
  userStateOf,
  type PatchResult,
} from "../profile";
import {
  BatchItemSchema,
  fieldErrors,
  parseUserPatch,
  V2_LIMITS,
  type BatchResponse,
  type EventRequest,
  type PatchResponse,
  type UserPatch,
  type UserView,
} from "./contract";

/**
 * API v2 operations — what the routes do once the caller is authenticated.
 * `ctx` and `connection` come ONLY from the key; the body never sets scope.
 *
 * Every write is one Firestore transaction (applyProductMessage): the user's
 * profile and a row for the connection's Events tab commit together. After it,
 * best-effort side effects that never fail the write: sign-up enrolment,
 * invite attribution, diagnostics and health.
 */

export interface V2Deps {
  db?: FirestoreLike;
  nowMs?: number;
}

type Journeys = Awaited<ReturnType<typeof activeJourneysFor>>;

/** What a write left behind, for the caller and the side effects. */
type WriteOutcome =
  /** `consentGranted`: someone YouGrow already knew moved to a basis the connection accepts for marketing. */
  | { kind: "applied"; user: ProductUser; consentGranted: boolean }
  | { kind: "skipped"; reason: "stale_write" | "deleted_later"; storedUpdatedAt: string | null; user: ProductUser | null }
  | { kind: "invalid"; fields: Array<{ path: string; message: string }> };

/** The Events tab keeps a summary when a write is big (the profile holds the rest). */
function eventPayload(patch: UserPatch): Record<string, unknown> {
  const text = JSON.stringify(patch);
  return Buffer.byteLength(text, "utf8") <= 4 * 1024 ? { ...patch } : { truncated: true, fields: Object.keys(patch) };
}

async function writeUser(
  ctx: TenantContext,
  connection: ProductConnection,
  userId: string,
  patch: UserPatch,
  nowMs: number,
  db?: FirestoreLike,
  ignoredFields: string[] = [],
): Promise<WriteOutcome> {
  const now = new Date(nowMs).toISOString();
  const userDocId = productUserDocId(connection.id, userId);
  const messageId = `v2:${randomUUID()}`;
  let result: PatchResult | null = null;
  let seen: ProductUser | null = null;
  const applied = await applyProductMessage(
    ctx,
    {
      eventId: productEventDocId(connection.id, messageId),
      userDocId,
      mutate: (current) => {
        seen = current;
        result = applyUserPatch(current, userId, patch, { connection, nowMs });
        if ("next" in result) return { next: result.next, applied: true };
        // A skipped write changes nothing but leaves a row, so the Events tab shows it
        // arrived. An invalid one changes nothing at all (it's a 400, in rejections).
        return "skipped" in result ? { next: null, applied: false } : { reject: "not_applied" };
      },
      buildEvent: (wasApplied) => {
        const skipped = result && "skipped" in result ? result.skipped : null;
        // After an erasure, a late write keeps no user id or data, only that it came.
        const erased = skipped === "deleted_later";
        return {
          connectionId: connection.id,
          productUserId: erased ? "" : userDocId,
          externalUserId: erased ? "" : userId,
          messageId,
          type: "identify",
          event: null,
          payload: erased ? {} : eventPayload(patch),
          timestamp: now,
          receivedAt: now,
          applied: wasApplied,
          ...(skipped ? { skipped } : {}),
          ...(ignoredFields.length ? { ignoredFields } : {}),
          ttlAt: new Date(nowMs + EVENT_TTL_MS),
        };
      },
    },
    db,
  );
  const r = result as PatchResult | null;
  if (r && "invalid" in r) return { kind: "invalid", fields: r.invalid };
  if (r && "skipped" in r) return { kind: "skipped", reason: r.skipped, storedUpdatedAt: r.storedUpdatedAt, user: seen };
  if (applied.outcome !== "applied" || !applied.user) throw new Error(`unexpected write outcome: ${applied.outcome}`);
  // A user's first write (a sign-up or a backfill) never counts as a grant: consent
  // at sign-up is what consent-only journeys are for.
  const before = seen as ProductUser | null;
  const consentGranted =
    before?.status === "active" &&
    !allowsMarketing(connection.consentPolicy, before.consent?.basis) &&
    allowsMarketing(connection.consentPolicy, applied.user.consent?.basis);
  return { kind: "applied", user: applied.user, consentGranted };
}

/** Enrolment, invites, diagnostics and health for the writes that applied. Never throws. */
async function afterWrites(
  ctx: TenantContext,
  connection: ProductConnection,
  writes: Array<{ user: ProductUser; patch: UserPatch; consentGranted?: boolean }>,
  rejected: IngestSummary["rejected"],
  nowMs: number,
  db?: FirestoreLike,
  journeys?: Journeys,
): Promise<void> {
  const users = writes.map((w) => w.user);
  if (users.length > 0 && isLifecycleEnabled()) {
    await enrolOnSignup(ctx, connection, users, { db, nowMs, journeys }).catch((err) => {
      console.error(`[api-v2] enrolment failed for ${ctx.tenantId}/${connection.id}: ${err instanceof Error ? err.message.slice(0, 200) : "error"}`);
    });
  }
  // The opt-in trigger, for sequences meant for people who consent later.
  const granted = writes.filter((w) => w.consentGranted).map((w) => w.user);
  if (granted.length > 0 && isLifecycleEnabled() && isLifecycleConsentAtSendEnabled()) {
    const at = new Date(nowMs).toISOString();
    const events = granted.map((user) => ({ user, event: RESERVED_EVENTS.marketingConsentGranted, timestamp: at }));
    await enrolOnEvents(ctx, connection, events, { db, nowMs }).catch((err) => {
      console.error(`[api-v2] opt-in enrolment failed for ${ctx.tenantId}/${connection.id}: ${err instanceof Error ? err.message.slice(0, 200) : "error"}`);
    });
  }
  const touched: TouchedUser[] = writes.map((w) => ({
    user: w.user,
    code: inviteCodeFromTraits(w.patch.traits),
  }));
  if (touched.length > 0 && isInvitesEnabled()) {
    await recordInviteProgress(ctx, connection.id, touched, { db, nowMs }).catch((err) => {
      console.error(`[api-v2] invite progress failed for ${ctx.tenantId}/${connection.id}: ${err instanceof Error ? err.message.slice(0, 200) : "error"}`);
    });
  }
  const observedTraits = new Map<string, string>();
  for (const w of writes) {
    for (const [k, v] of Object.entries(w.patch.traits ?? {})) observedTraits.set(k, v === null ? "null" : typeof v);
  }
  const summary: IngestSummary = { accepted: writes.length, duplicates: 0, rejected };
  const now = new Date(nowMs).toISOString();
  await recordDiagnostics(ctx, connection, { observedEvents: new Map(), observedTraits, summary, now }, db);
  await touchHealth(ctx, connection, summary, nowMs, db);
}

const reasonOf = (fields: Array<{ path: string; message: string }>) =>
  `invalid: ${fields.map((f) => `${f.path}: ${f.message}`).join("; ")}`.slice(0, 200);

/** PATCH /api/v2/users/{userId}. `invalid` → the caller answers 400. */
export async function patchUser(
  ctx: TenantContext,
  connection: ProductConnection,
  userId: string,
  patch: UserPatch,
  deps: V2Deps = {},
  opts: { ignoredFields?: string[] } = {},
): Promise<PatchResponse | { invalid: Array<{ path: string; message: string }> }> {
  const nowMs = deps.nowMs ?? Date.now();
  const w = await writeUser(ctx, connection, userId, patch, nowMs, deps.db, opts.ignoredFields);
  if (w.kind === "invalid") {
    await afterWrites(ctx, connection, [], [{ index: 0, messageId: null, reason: reasonOf(w.fields) }], nowMs, deps.db);
    return { invalid: w.fields };
  }
  if (w.kind === "skipped") {
    const live = w.user && w.user.status === "active" ? userStateOf(w.user) : undefined;
    return { applied: false, reason: w.reason, storedUpdatedAt: w.storedUpdatedAt, ...(live ? { user: live } : {}) };
  }
  await afterWrites(ctx, connection, [{ user: w.user, patch, consentGranted: w.consentGranted }], [], nowMs, deps.db);
  return { applied: true, user: userStateOf(w.user) };
}

/** POST /api/v2/users/batch — item by item, never all-or-nothing; `results` lists ignored and failed items, and applied ones with ignored fields. */
export async function patchBatch(
  ctx: TenantContext,
  connection: ProductConnection,
  items: unknown[],
  deps: V2Deps = {},
): Promise<BatchResponse> {
  const nowMs = deps.nowMs ?? Date.now();
  const out: BatchResponse = { applied: 0, ignored: 0, failed: 0, results: [] };
  const writes: Array<{ user: ProductUser; patch: UserPatch; consentGranted: boolean }> = [];
  const rejected: IngestSummary["rejected"] = [];
  for (const [index, raw] of items.slice(0, V2_LIMITS.maxBatch).entries()) {
    const head = BatchItemSchema.safeParse(raw);
    if (!head.success) {
      const fields = fieldErrors(head.error);
      out.failed += 1;
      out.results.push({ index, userId: null, status: "failed", reason: "invalid", fields });
      rejected.push({ index, messageId: null, reason: reasonOf(fields) });
      continue;
    }
    const { userId, ...rest } = head.data;
    const parsed = parseUserPatch(rest);
    if (!parsed.ok) {
      const fields = parsed.fields;
      out.failed += 1;
      out.results.push({ index, userId, status: "failed", reason: "invalid", fields });
      rejected.push({ index, messageId: null, reason: reasonOf(fields) });
      continue;
    }
    try {
      const w = await writeUser(ctx, connection, userId, parsed.patch, nowMs, deps.db, parsed.ignoredFields.map((f) => f.path));
      if (w.kind === "applied") {
        out.applied += 1;
        writes.push({ user: w.user, patch: parsed.patch, consentGranted: w.consentGranted });
        if (parsed.ignoredFields.length) out.results.push({ index, userId, status: "applied", reason: "fields_ignored", fields: parsed.ignoredFields });
      } else if (w.kind === "skipped") {
        out.ignored += 1;
        out.results.push({ index, userId, status: "ignored", reason: w.reason });
      } else {
        out.failed += 1;
        out.results.push({ index, userId, status: "failed", reason: "invalid", fields: w.fields });
        rejected.push({ index, messageId: null, reason: reasonOf(w.fields) });
      }
    } catch (err) {
      // One user's write failing (e.g. contention) doesn't sink the rest; it's safe to resend.
      console.error(`[api-v2] batch write failed for ${ctx.tenantId}/${connection.id}: ${err instanceof Error ? err.message.slice(0, 200) : "error"}`);
      out.failed += 1;
      out.results.push({ index, userId, status: "failed", reason: "internal_error" });
    }
  }
  const journeys = writes.length > 0 && isLifecycleEnabled() ? await activeJourneysFor(ctx, connection.id, deps.db).catch(() => undefined) : undefined;
  await afterWrites(ctx, connection, writes, rejected, nowMs, deps.db, journeys);
  return out;
}

/** GET /api/v2/users/{userId} — null when YouGrow doesn't hold them (unknown or deleted). */
export async function getUserView(
  ctx: TenantContext,
  connection: ProductConnection,
  userId: string,
  deps: V2Deps = {},
): Promise<UserView | null> {
  const repo = forTenant(ctx, deps.db);
  const user = await repo.productUsers.getById(productUserDocId(connection.id, userId));
  if (!user || user.status !== "active" || user.connectionId !== connection.id) return null;
  const [enrolments, optOuts] = await Promise.all([
    repo.lifecycleEnrolments.find({ where: [["productUserId", "==", user.id]], limit: 50 }),
    user.emailNormalized
      ? repo.emailSuppressions.find({ where: [["normalizedEmail", "==", user.emailNormalized]], limit: 50 })
      : Promise.resolve([]),
  ]);
  return {
    ...userStateOf(user),
    enrolments: enrolments.map((e) => ({ journeyId: e.journeyId, status: e.status, mode: e.mode, enrolledAt: e.createdAt })),
    optOuts: optOuts.map((s) => ({ scope: s.scope ?? "all", category: s.category ?? null, at: s.createdAt ?? null })),
  };
}

/**
 * DELETE /api/v2/users/{userId} — erase the user. Safe to repeat: every call
 * re-runs the erasure of their history, and a user we never saw gets a
 * tombstone so an older late write can't create them.
 */
export async function deleteUser(
  ctx: TenantContext,
  connection: ProductConnection,
  userId: string,
  deps: V2Deps = {},
): Promise<void> {
  const nowMs = deps.nowMs ?? Date.now();
  const repo = forTenant(ctx, deps.db);
  const id = productUserDocId(connection.id, userId);
  const user = await repo.productUsers.getById(id);
  if (!user) {
    await repo.productUsers.create(id, newTombstone(connection, nowMs)).catch((err) => {
      if (!(err instanceof TenantIsolationError)) throw err; // created meanwhile: fine
    });
  } else if (user.status === "active") {
    await repo.productUsers.claim(id, (cur) => (cur.status === "deleted" ? null : tombstoneOf(cur, nowMs)));
  }
  await eraseProductUserHistory(ctx, id, deps.db);
  if (user?.status === "active" && user.emailNormalized) await scrubSuppressionEmails(ctx, user.emailNormalized, deps.db);
  // The Events tab shows that an erasure arrived — without the user id.
  const messageId = `v2:erase:${randomUUID()}`;
  const now = new Date(nowMs).toISOString();
  await repo.productEvents
    .create(productEventDocId(connection.id, messageId), {
      connectionId: connection.id,
      productUserId: "",
      externalUserId: "",
      messageId,
      type: "erase",
      event: null,
      payload: {},
      timestamp: now,
      receivedAt: now,
      applied: true,
      ttlAt: new Date(nowMs + EVENT_TTL_MS),
    })
    .catch((err) => {
      console.warn(`[api-v2] erase row failed for ${ctx.tenantId}/${connection.id}: ${err instanceof Error ? err.message.slice(0, 200) : "error"}`);
    });
}

/**
 * A request refused with a 400 before any write, for the Events tab's rejections
 * (`what` names the call). Field paths and messages only, never values. Never throws.
 */
export async function recordRejected(
  ctx: TenantContext,
  connection: ProductConnection,
  what: string,
  fields: Array<{ path: string; message: string }> | null,
  nowMs: number,
  db?: FirestoreLike,
): Promise<void> {
  const reason = `${what}: ${fields ? reasonOf(fields) : "invalid JSON"}`.slice(0, 300);
  await afterWrites(ctx, connection, [], [{ index: 0, messageId: null, reason }], nowMs, db).catch(() => undefined);
}

/** POST /api/v2/users/{userId}/events — a milestone for a user YouGrow already holds. */
export async function recordUserEvent(
  ctx: TenantContext,
  connection: ProductConnection,
  userId: string,
  body: EventRequest,
  deps: V2Deps = {},
): Promise<{ recorded: boolean; duplicate: boolean } | { notFound: true }> {
  const nowMs = deps.nowMs ?? Date.now();
  const now = new Date(nowMs).toISOString();
  const messageId = body.idempotencyKey ?? `v2e:${randomUUID()}`;
  const timestamp = toUtcIso(body.occurredAt ?? now);
  const msg = { type: "track" as const, messageId, userId, timestamp, event: body.event, properties: body.properties ?? {} };
  const userDocId = productUserDocId(connection.id, userId);
  const result = await applyProductMessage(
    ctx,
    {
      eventId: productEventDocId(connection.id, messageId),
      userDocId,
      mutate: (current) =>
        !current || current.status !== "active" ? { reject: "not_found" } : applyMessage(current, msg, { connection, nowMs }),
      buildEvent: (applied) => ({
        connectionId: connection.id,
        productUserId: userDocId,
        externalUserId: userId,
        messageId,
        type: "track",
        event: body.event,
        payload: msg.properties,
        timestamp,
        receivedAt: now,
        applied,
        ttlAt: new Date(nowMs + EVENT_TTL_MS),
      }),
    },
    deps.db,
  );
  if (result.outcome === "rejected") return { notFound: true };
  if (result.outcome === "duplicate") return { recorded: false, duplicate: true };
  if (result.outcome === "applied" && result.user && isLifecycleEnabled()) {
    await enrolOnEvents(ctx, connection, [{ user: result.user, event: body.event, timestamp }], { db: deps.db, nowMs }).catch((err) => {
      console.error(`[api-v2] event enrolment failed for ${ctx.tenantId}/${connection.id}: ${err instanceof Error ? err.message.slice(0, 200) : "error"}`);
    });
  }
  // A milestone can activate the user (onboarding.completed) — invites count that.
  if (result.outcome === "applied" && result.user && isInvitesEnabled()) {
    await recordInviteProgress(ctx, connection.id, [{ user: result.user, code: null }], { db: deps.db, nowMs }).catch((err) => {
      console.error(`[api-v2] invite progress failed for ${ctx.tenantId}/${connection.id}: ${err instanceof Error ? err.message.slice(0, 200) : "error"}`);
    });
  }
  const summary: IngestSummary = { accepted: 1, duplicates: 0, rejected: [] };
  await recordDiagnostics(ctx, connection, { observedEvents: new Map([[body.event, 1]]), observedTraits: new Map(), summary, now }, deps.db);
  await touchHealth(ctx, connection, summary, nowMs, deps.db);
  return { recorded: true, duplicate: false };
}
