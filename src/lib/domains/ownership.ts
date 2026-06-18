import { randomBytes } from "node:crypto";
import { resolveTxt } from "node:dns/promises";
import { getTenantByOrigin } from "@/lib/tenant";
import type { FirestoreLike } from "@/lib/tenant/types";
import {
  normalizeHost,
  registrableDomain,
  sameRegistrableDomain,
  isPublicEmailProvider,
} from "./registrableDomain";

/**
 * Domain-ownership proofs that gate the web-routing capability (writing an origin
 * into tenant.allowedOrigins + the reCAPTCHA key). Two tiers, no universal DNS
 * burden:
 *  - email-match FAST PATH: the verified admin's email registrable-domain equals
 *    the claimed domain (and isn't a public provider);
 *  - DNS-TXT fallback: the admin publishes our challenge record.
 * (A domain already email-verified via Mandrill DKIM/SPF is handled by the
 * caller as a third proof — publishing those records also proves DNS control.)
 */

export const DNS_CHALLENGE_PREFIX = "_vizzybl-challenge";
const DNS_CHALLENGE_VALUE_PREFIX = "vizzybl-site-verification";

export interface FastPathResult {
  ok: boolean;
  /** The matched email registrable-domain, for the audit trail. */
  evidence?: string;
  /** Why the fast path didn't apply (for diagnostics, never user-facing trust). */
  reason?: string;
}

/**
 * The email-match fast path. Requires a VERIFIED email whose registrable domain
 * equals the claimed domain's, excluding public/free providers. Returns ok=false
 * (with a reason) when it doesn't apply — the caller then falls back to DNS-TXT.
 */
export function tryEmailFastPath(
  claimedHost: string,
  ctx: { email?: string; emailVerified?: boolean },
): FastPathResult {
  if (!ctx.email) return { ok: false, reason: "no_email" };
  if (ctx.emailVerified !== true) return { ok: false, reason: "email_unverified" };
  const emailDomain = ctx.email.split("@")[1];
  if (!emailDomain) return { ok: false, reason: "bad_email" };
  if (isPublicEmailProvider(emailDomain)) return { ok: false, reason: "public_provider" };
  if (!sameRegistrableDomain(emailDomain, claimedHost)) {
    return { ok: false, reason: "domain_mismatch" };
  }
  return { ok: true, evidence: registrableDomain(emailDomain) ?? undefined };
}

/** A fresh, unguessable DNS-TXT challenge token. */
export function issueDnsTxtToken(): string {
  return randomBytes(24).toString("hex");
}

/** The DNS-TXT record the admin must publish to prove ownership of `host`. */
export function dnsChallengeRecord(
  host: string,
  token: string,
): { type: "TXT"; host: string; value: string } {
  const base = registrableDomain(host) ?? normalizeHost(host);
  return {
    type: "TXT",
    host: `${DNS_CHALLENGE_PREFIX}.${base}`,
    value: `${DNS_CHALLENGE_VALUE_PREFIX}=${token}`,
  };
}

/** Resolve the challenge TXT and confirm it carries our token. */
export async function verifyDnsTxt(
  host: string,
  token: string,
  lookup: (name: string) => Promise<string[][]> = resolveTxt,
): Promise<{ ok: boolean; detail?: string }> {
  const rec = dnsChallengeRecord(host, token);
  try {
    const chunks = await lookup(rec.host);
    // Each TXT record is an array of strings that DNS may split; join per record.
    const found = chunks.some((parts) => parts.join("").trim() === rec.value);
    return found ? { ok: true } : { ok: false, detail: "txt_not_found" };
  } catch (err) {
    const code = (err as { code?: string }).code;
    return { ok: false, detail: code === "ENOTFOUND" || code === "ENODATA" ? "txt_not_found" : "dns_error" };
  }
}

/**
 * Global uniqueness guard: an origin may belong to at most one tenant. Returns
 * true when `origin` already routes to a DIFFERENT tenant (so claiming it would
 * hijack their traffic). Reuses the host→tenant registry query.
 */
export async function globalOriginConflict(
  origin: string,
  selfTenantId: string,
  db?: FirestoreLike,
): Promise<boolean> {
  const existing = db
    ? await getTenantByOrigin(origin, db)
    : await getTenantByOrigin(origin);
  return existing !== null && existing.id !== selfTenantId;
}
