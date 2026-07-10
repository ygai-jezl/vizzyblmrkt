import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Unsubscribe token — the auth for the one-click / hosted unsubscribe flow. A
 * self-contained, tamper-proof credential naming WHO to suppress. The email
 * footer's Unsubscribe / Manage-preferences links (journey path) and the RFC
 * 8058 List-Unsubscribe-Post header carry it; the /api/unsubscribe route + the
 * /unsubscribe page verify it and suppress from the TOKEN's claims, never a
 * request field.
 *
 * Signed + verified in-app with a server-only HMAC key (mirrors canvas/auth.ts),
 * so it's unforgeable. Deliberately NO expiry — an unsubscribe link must keep
 * working on months-old mail. The recipient email is IN the signed claims, so
 * suppression works even if the signup document is later deleted.
 */

export interface UnsubscribeClaims {
  tenantId: string;
  campaignId: string;
  signupId: string;
  /** The recipient address to suppress (already normalized at mint time). */
  email: string;
  /** Issued-at, epoch seconds (audit only — there is no expiry check). */
  iat: number;
}

const INSECURE_LOCAL_KEY = "insecure-local-dev-only-unsub-key";

/** The HMAC key, or null when unconfigured (and not in the local dev bypass). */
function resolveKey(): string | null {
  const key = process.env.UNSUBSCRIBE_SIGNING_KEY;
  if (key) return key;
  if (process.env.NODE_ENV !== "production") return INSECURE_LOCAL_KEY;
  return null;
}

/** Whether the unsubscribe token path can mint/verify in this environment. */
export function isUnsubscribeConfigured(): boolean {
  return resolveKey() !== null;
}

function hmac(payloadB64: string, key: string): string {
  return createHmac("sha256", key).update(payloadB64).digest("base64url");
}

export interface SignUnsubscribeInput {
  tenantId: string;
  campaignId: string;
  signupId: string;
  email: string;
  now?: number;
}

/** Mint a signed unsubscribe token. Throws if the signing key is unconfigured. */
export function signUnsubscribeToken(input: SignUnsubscribeInput): string {
  const key = resolveKey();
  if (!key) throw new Error("unsubscribe_auth_unconfigured");
  const claims: UnsubscribeClaims = {
    tenantId: input.tenantId,
    campaignId: input.campaignId,
    signupId: input.signupId,
    email: input.email.trim().toLowerCase(),
    iat: Math.floor((input.now ?? Date.now()) / 1000),
  };
  const payloadB64 = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${payloadB64}.${hmac(payloadB64, key)}`;
}

/** Mint a token, or null if unconfigured — keeps the send path resilient (a
 *  missing secret degrades the unsubscribe link, never breaks the send). */
export function mintUnsubscribeTokenOrNull(input: SignUnsubscribeInput): string | null {
  if (!isUnsubscribeConfigured()) return null;
  try {
    return signUnsubscribeToken(input);
  } catch {
    return null;
  }
}

export type VerifyUnsubscribeResult =
  | { ok: true; claims: UnsubscribeClaims }
  | { ok: false; error: "not_configured" | "malformed" | "bad_signature" | "invalid_claims" };

export function verifyUnsubscribeToken(token: string): VerifyUnsubscribeResult {
  const key = resolveKey();
  if (!key) return { ok: false, error: "not_configured" };
  if (typeof token !== "string" || !token.includes(".")) {
    return { ok: false, error: "malformed" };
  }
  const dot = token.indexOf(".");
  const payloadB64 = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!payloadB64 || !sig) return { ok: false, error: "malformed" };

  const expected = hmac(payloadB64, key);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, error: "bad_signature" };
  }

  let claims: UnsubscribeClaims;
  try {
    claims = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8")) as UnsubscribeClaims;
  } catch {
    return { ok: false, error: "malformed" };
  }
  if (
    !claims ||
    typeof claims.tenantId !== "string" ||
    typeof claims.campaignId !== "string" ||
    typeof claims.signupId !== "string" ||
    typeof claims.email !== "string" ||
    !claims.email
  ) {
    return { ok: false, error: "invalid_claims" };
  }
  return { ok: true, claims };
}
