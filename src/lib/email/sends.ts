import { createHash } from "node:crypto";
import { forTenant } from "@/lib/tenant";
import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import type { EmailSend, EmailSendEngine } from "@/lib/types/emailSend";
import { emailEventKeyBase } from "./events";
import { isEmailSendRecordsEnabled, isTransactionalTenantTagEnabled } from "./flags";
import type { EventMetadata, MandrillEvent } from "./mandrillWebhook";
import type { ContactPersonId } from "@/lib/ontology/person";
import { personStamp } from "@/lib/ontology/personRef";
import { countUnstamped, type CountBuffer } from "@/lib/loops/count";
import { keptMade } from "@/lib/loops/made";
import type { LoopKind } from "@/lib/loops/registry";
import type { Made } from "@/lib/types/loopStamp";

/**
 * A record per email sent (EMAIL_SEND_RECORDS_ENABLED): the email carries only its brand and the
 * record's id as Mandrill metadata, and the webhook reads who and what it was from the record.
 * Mandrill throws away metadata over 250 bytes, and the long form could go over with long ids.
 */

export function sendIdOf(tenantId: string, keyBase: string): string {
  return `es_${createHash("sha256").update(`${tenantId}|${keyBase}`).digest("base64url").slice(0, 22)}`;
}

/** The attribution in the long metadata form (the keys `readEventMetadata` reads), or null. */
function attributionOf(long: Record<string, string>): Omit<EventMetadata, "tenantId"> | null {
  const g = (k: string) => (typeof long[k] === "string" ? long[k]! : "");
  if (!g("journeyId") || !g("nodeId") || !g("signupId")) return null;
  return {
    campaignId: g("campaignId"),
    journeyId: g("journeyId"),
    nodeId: g("nodeId"),
    signupId: g("signupId"),
    variantId: g("variantId") || "control",
    ...(g("recipientKind") === "product_user" ? { recipientKind: "product_user" as const, connectionId: g("connectionId") } : {}),
    ...(g("recipientKind") === "signup" ? { recipientKind: "signup" as const } : {}),
    ...(g("enrolmentId") ? { enrolmentId: g("enrolmentId") } : {}),
  };
}

/**
 * The metadata for an attributed email. Switch off: the long form, exactly as the engine built it.
 * Switch on: writes (or finds) the email's send record and returns {t, s}. If the record can't be
 * written, the long form goes out, so nothing is worse than before.
 *
 * `personId` (ONTOLOGY_PERSON_IDS_ENABLED) goes on a new record only: never into the metadata,
 * which Mandrill drops whole past 250 bytes, and never onto a record that was already there.
 *
 * `made` (learning loops step 5, decision 19) is required: what made the email, its stamp or why
 * it has none, kept on a new record with LOOPS_ENABLED on and never in the metadata. The sender
 * counts made itself; a stamp whose record couldn't be written counts `stamp_lost` here, and one
 * with no record to keep it (send records off) counts `records_off`, in the run's CountBuffer
 * when one is given.
 */
export async function sendMetadata(
  ctx: Pick<TenantContext, "tenantId" | "region">,
  long: Record<string, string>,
  engine: EmailSendEngine,
  deps: {
    db?: FirestoreLike;
    now?: () => Date;
    personId?: ContactPersonId | null;
    made: Made;
    /** The kind the email counts under, for `stamp_lost`. */
    kind: LoopKind;
    counts?: CountBuffer;
  },
): Promise<Record<string, string>> {
  if (!isEmailSendRecordsEnabled()) {
    await countSendUnrecorded(ctx, deps.made, deps.kind, deps);
    return long;
  }
  const a = attributionOf(long);
  if (!a) {
    await countSendUnrecorded(ctx, deps.made, deps.kind, deps);
    return long;
  }
  const id = sendIdOf(ctx.tenantId, emailEventKeyBase(a));
  const now = (deps.now ?? (() => new Date()))().toISOString();
  const made = keptMade(deps.made);
  try {
    await forTenant({ ...ctx, source: "system" }, deps.db).emailSends.upsert(
      id,
      () => ({ engine, ...a, ...personStamp(deps.personId), mandrillMessageId: null, ...(made ? { made } : {}), createdAt: now, updatedAt: now }) as never,
      () => null,
    );
    return { t: ctx.tenantId, s: id };
  } catch (err) {
    console.warn("[email] couldn't write the send record; sending the long metadata:", err instanceof Error ? err.message.slice(0, 160) : "error");
    // The email still goes, so its stamp is lost with the record (4.1).
    if (made && !("unstamped" in made)) {
      const full: TenantContext = { ...ctx, source: "system" };
      if (deps.counts) deps.counts.unstamped(full, deps.kind, "stamp_lost");
      else await countUnstamped(full, deps.kind, "stamp_lost", { db: deps.db });
    }
    return long;
  }
}

/**
 * An email that goes with a stamp but no record to keep it on (4.2 row 4): send records are off,
 * or a product journey's email names its enrolment instead (LIFECYCLE_SEND_TRACKING). The sender
 * still counts it made, as the plan says, and this counts `records_off` beside it, so coverage
 * shows the gap instead of reading 100%. Nothing for an email with no stamp. Never throws.
 */
export async function countSendUnrecorded(
  ctx: Pick<TenantContext, "tenantId" | "region">,
  made: Made,
  kind: LoopKind,
  deps: { db?: FirestoreLike; counts?: CountBuffer } = {},
): Promise<void> {
  if ("unstamped" in made) return;
  const full: TenantContext = { ...ctx, source: "system" };
  if (deps.counts) deps.counts.unstamped(full, kind, "records_off");
  else await countUnstamped(full, kind, "records_off", { db: deps.db });
}

/**
 * The webhook's record of an email sent before send records were on, or whose record failed: the
 * only other way an email send record is created, so every create stays in this file (the create
 * scan, learning loops step 5). It has no stamp: send records were off when it went
 * (`records_off`), and its made was counted when it was sent.
 */
export async function upsertEarlierSend(
  ctx: TenantContext,
  id: string,
  create: () => Omit<EmailSend, "id" | "tenantId" | "made">,
  patch: (current: EmailSend) => Partial<EmailSend> | null,
  db?: FirestoreLike,
): Promise<void> {
  const made = keptMade({ unstamped: "records_off" });
  await forTenant(ctx, db).emailSends.upsert(id, () => ({ ...create(), ...(made ? { made } : {}) }) as never, (current) => patch(current) as never);
}

/**
 * For a transactional email (verification, offboarding, site confirmation): its brand as Mandrill
 * metadata, so a hard bounce or a complaint suppresses the address (EMAIL_TRANSACTIONAL_TENANT_TAG_ENABLED).
 * Spread into the message. Off: nothing, as before.
 */
export function transactionalTag(tenantId: string): { metadata?: Record<string, string> } {
  return isTransactionalTenantTagEnabled() && tenantId ? { metadata: { t: tenantId } } : {};
}

/** Read {t, s} metadata, or null when the message carries another form (or none). */
export function readSendRef(ev: MandrillEvent): { tenantId: string; sendId: string } | null {
  const m = ev.msg?.metadata;
  if (!m) return null;
  const t = typeof m.t === "string" ? m.t : "";
  const s = typeof m.s === "string" ? m.s : "";
  return t && /^es_[A-Za-z0-9_-]{10,40}$/.test(s) ? { tenantId: t, sendId: s } : null;
}

/** Read metadata that names only the brand ({t}), or "". */
export function readTenantTag(ev: MandrillEvent): string {
  const m = ev.msg?.metadata;
  return m && typeof m.t === "string" ? m.t : "";
}

/** The attribution stored on a send record (null when it has gone: the person was erased). */
export async function attributionOfSend(
  ctx: TenantContext,
  sendId: string,
  opts: { cache?: Map<string, EventMetadata | null>; db?: FirestoreLike } = {},
): Promise<EventMetadata | null> {
  if (opts.cache?.has(sendId)) return opts.cache.get(sendId) ?? null;
  const s: EmailSend | null = await forTenant(ctx, opts.db).emailSends.getById(sendId);
  const meta: EventMetadata | null = s
    ? {
        tenantId: ctx.tenantId,
        campaignId: s.campaignId,
        journeyId: s.journeyId,
        nodeId: s.nodeId,
        signupId: s.signupId,
        variantId: s.variantId || "control",
        ...(s.recipientKind ? { recipientKind: s.recipientKind } : {}),
        ...(s.connectionId ? { connectionId: s.connectionId } : {}),
        ...(s.enrolmentId ? { enrolmentId: s.enrolmentId } : {}),
        ...(s.personId ? { personId: s.personId } : {}),
      }
    : null;
  opts.cache?.set(sendId, meta);
  return meta;
}

/** Totals over a group of send records (EMAIL_ENGAGEMENT_DETAIL_ENABLED keeps what they count). */
export interface SendTotals {
  sends: number;
  delivered: number;
  totalOpens: number;
  totalClicks: number;
  hardBounces: number;
  softBounces: number;
  deferrals: number;
  complaints: number;
  unsubscribes: number;
}

/** Most send records one summary reads. */
export const SEND_SUMMARY_MAX = 5000;

/**
 * Totals over the brand's send records for one journey or one launch (or all of them), reading at
 * most SEND_SUMMARY_MAX. Equality filters only. `complete` is false when there may be more.
 */
export async function summariseEmailSends(
  ctx: TenantContext,
  filter: { journeyId?: string; campaignId?: string },
  db?: FirestoreLike,
): Promise<{ totals: SendTotals; complete: boolean }> {
  const where: Array<[string, "==", string]> = [];
  if (filter.journeyId) where.push(["journeyId", "==", filter.journeyId]);
  if (filter.campaignId) where.push(["campaignId", "==", filter.campaignId]);
  const rows = await forTenant(ctx, db).emailSends.find({ where, limit: SEND_SUMMARY_MAX });
  const totals: SendTotals = { sends: 0, delivered: 0, totalOpens: 0, totalClicks: 0, hardBounces: 0, softBounces: 0, deferrals: 0, complaints: 0, unsubscribes: 0 };
  for (const r of rows) {
    totals.sends += 1;
    if (r.deliveredAt) totals.delivered += 1;
    totals.totalOpens += r.opens?.count ?? 0;
    totals.totalClicks += r.clicks?.count ?? 0;
    if (r.bounce?.kind === "hard") totals.hardBounces += 1;
    if (r.bounce?.kind === "soft") totals.softBounces += 1;
    totals.deferrals += r.deferrals?.count ?? 0;
    if (r.spamAt) totals.complaints += 1;
    if (r.unsubAt) totals.unsubscribes += 1;
  }
  return { totals, complete: rows.length < SEND_SUMMARY_MAX };
}
