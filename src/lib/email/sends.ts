import { createHash } from "node:crypto";
import { forTenant } from "@/lib/tenant";
import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import type { EmailSend, EmailSendEngine } from "@/lib/types/emailSend";
import { emailEventKeyBase } from "./events";
import { isEmailSendRecordsEnabled, isTransactionalTenantTagEnabled } from "./flags";
import type { EventMetadata, MandrillEvent } from "./mandrillWebhook";

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
 */
export async function sendMetadata(
  ctx: Pick<TenantContext, "tenantId" | "region">,
  long: Record<string, string>,
  engine: EmailSendEngine,
  deps: { db?: FirestoreLike; now?: () => Date } = {},
): Promise<Record<string, string>> {
  if (!isEmailSendRecordsEnabled()) return long;
  const a = attributionOf(long);
  if (!a) return long;
  const id = sendIdOf(ctx.tenantId, emailEventKeyBase(a));
  const now = (deps.now ?? (() => new Date()))().toISOString();
  try {
    await forTenant({ ...ctx, source: "system" }, deps.db).emailSends.upsert(
      id,
      () => ({ engine, ...a, mandrillMessageId: null, createdAt: now, updatedAt: now }) as never,
      () => null,
    );
    return { t: ctx.tenantId, s: id };
  } catch (err) {
    console.warn("[email] couldn't write the send record; sending the long metadata:", err instanceof Error ? err.message.slice(0, 160) : "error");
    return long;
  }
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
      }
    : null;
  opts.cache?.set(sendId, meta);
  return meta;
}
