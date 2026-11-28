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

/** Why a stamped email's send record doesn't keep its stamp: send records are off, or the record couldn't be written. */
export type SendUnrecorded = "records_off" | "stamp_lost";

/** What sendMetadata gives the sender: the email's metadata, and what to count beside made once it has gone. */
export interface SendMetadata {
  metadata: Record<string, string>;
  /**
   * Counted by the sender beside made, only once the email went (never for a send that failed, and
   * once however many attempts it took); null when the record keeps the stamp, or there is none.
   */
  unrecorded: SendUnrecorded | null;
}

/** The reason a stamped email's record doesn't keep its stamp, or null for an email with no stamp. */
function unrecordedOf(made: Made, why: SendUnrecorded): SendUnrecorded | null {
  const kept = keptMade(made);
  return kept && !("unstamped" in kept) ? why : null;
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
 * it has none, kept on a new record with LOOPS_ENABLED on and never in the metadata. This counts
 * nothing, as it runs before the send: it says in `unrecorded` whether a stamp went without a
 * record to keep it (`records_off`) or lost its record (`stamp_lost`), and the sender counts that
 * beside made once the email has gone (countSendUnrecorded).
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
  },
): Promise<SendMetadata> {
  if (!isEmailSendRecordsEnabled()) return { metadata: long, unrecorded: unrecordedOf(deps.made, "records_off") };
  const a = attributionOf(long);
  if (!a) return { metadata: long, unrecorded: unrecordedOf(deps.made, "records_off") };
  const id = sendIdOf(ctx.tenantId, emailEventKeyBase(a));
  const now = (deps.now ?? (() => new Date()))().toISOString();
  const made = keptMade(deps.made);
  try {
    await forTenant({ ...ctx, source: "system" }, deps.db).emailSends.upsert(
      id,
      () => ({ engine, ...a, ...personStamp(deps.personId), mandrillMessageId: null, ...(made ? { made } : {}), createdAt: now, updatedAt: now }) as never,
      () => null,
    );
    return { metadata: { t: ctx.tenantId, s: id }, unrecorded: null };
  } catch (err) {
    console.warn("[email] couldn't write the send record; sending the long metadata:", err instanceof Error ? err.message.slice(0, 160) : "error");
    // The email still goes, so its stamp is lost with the record (4.1).
    return { metadata: long, unrecorded: unrecordedOf(deps.made, "stamp_lost") };
  }
}

/**
 * An email that went with a stamp but no record to keep it on (4.2 row 4): send records are off,
 * a product journey's email names its enrolment instead (LIFECYCLE_SEND_TRACKING), or the record
 * couldn't be written (`stamp_lost`). The sender counts it made, as the plan says, and calls this
 * beside it, only once the email went, so coverage shows the gap instead of reading 100%. Nothing
 * for an email with no stamp. Never throws.
 */
export async function countSendUnrecorded(
  ctx: Pick<TenantContext, "tenantId" | "region">,
  made: Made,
  kind: LoopKind,
  deps: { db?: FirestoreLike; counts?: CountBuffer } = {},
  why: SendUnrecorded = "records_off",
): Promise<void> {
  if (!unrecordedOf(made, why)) return;
  const full: TenantContext = { ...ctx, source: "system" };
  if (deps.counts) deps.counts.unstamped(full, kind, why);
  else await countUnstamped(full, kind, why, { db: deps.db });
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
