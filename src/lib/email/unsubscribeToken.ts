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

type DecodeResult =
  | { ok: true; payload: Record<string, unknown> }
  | { ok: false; error: "not_configured" | "malformed" | "bad_signature" };

/** Check the HMAC and decode the claims object (any version). */
function decodeToken(token: string): DecodeResult {
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
  try {
    const payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8")) as unknown;
    if (!payload || typeof payload !== "object") return { ok: false, error: "malformed" };
    return { ok: true, payload: payload as Record<string, unknown> };
  } catch {
    return { ok: false, error: "malformed" };
  }
}

function asV1(c: Record<string, unknown>): UnsubscribeClaims | null {
  if (
    typeof c.tenantId !== "string" ||
    typeof c.campaignId !== "string" ||
    typeof c.signupId !== "string" ||
    typeof c.email !== "string" ||
    !c.email
  ) {
    return null;
  }
  return c as unknown as UnsubscribeClaims;
}

/** Verify a v1 (waitlist) token. v2 tokens are not accepted here. */
export function verifyUnsubscribeToken(token: string): VerifyUnsubscribeResult {
  const d = decodeToken(token);
  if (!d.ok) return d;
  if (d.payload.v === 2) return { ok: false, error: "invalid_claims" };
  const claims = asV1(d.payload);
  return claims ? { ok: true, claims } : { ok: false, error: "invalid_claims" };
}

// ---- v2: lifecycle (connected-product) recipients --------------------------------

/**
 * v2 claims name a connected product's user and ONE email category (e.g.
 * "onboarding"). A one-click unsubscribe stops that category only; the hosted
 * page also offers "unsubscribe from all". The label rides in the token so the
 * page can say what the category is without a lookup.
 */
export interface UnsubscribeClaimsV2 {
  v: 2;
  tenantId: string;
  email: string;
  recipientKind: "product_user";
  recipientId: string;
  connectionId: string;
  category: string;
  categoryLabel: string;
  iat: number;
}

export interface SignUnsubscribeV2Input {
  tenantId: string;
  email: string;
  recipientId: string;
  connectionId: string;
  category: string;
  categoryLabel: string;
  now?: number;
}

export function signUnsubscribeTokenV2(input: SignUnsubscribeV2Input): string {
  const key = resolveKey();
  if (!key) throw new Error("unsubscribe_auth_unconfigured");
  const claims: UnsubscribeClaimsV2 = {
    v: 2,
    tenantId: input.tenantId,
    email: input.email.trim().toLowerCase(),
    recipientKind: "product_user",
    recipientId: input.recipientId,
    connectionId: input.connectionId,
    category: input.category,
    categoryLabel: input.categoryLabel.slice(0, 80),
    iat: Math.floor((input.now ?? Date.now()) / 1000),
  };
  const payloadB64 = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${payloadB64}.${hmac(payloadB64, key)}`;
}

export function mintUnsubscribeTokenV2OrNull(input: SignUnsubscribeV2Input): string | null {
  if (!isUnsubscribeConfigured()) return null;
  try {
    return signUnsubscribeTokenV2(input);
  } catch {
    return null;
  }
}

function asV2(c: Record<string, unknown>): UnsubscribeClaimsV2 | null {
  if (
    c.v !== 2 ||
    c.recipientKind !== "product_user" ||
    typeof c.tenantId !== "string" ||
    typeof c.email !== "string" ||
    !c.email ||
    typeof c.recipientId !== "string" ||
    typeof c.connectionId !== "string" ||
    typeof c.category !== "string" ||
    !/^[a-z0-9_-]{1,64}$/.test(c.category) ||
    typeof c.categoryLabel !== "string"
  ) {
    return null;
  }
  return c as unknown as UnsubscribeClaimsV2;
}

export type VerifyAnyUnsubscribeResult =
  | { ok: true; version: 1; claims: UnsubscribeClaims }
  | { ok: true; version: 2; claims: UnsubscribeClaimsV2 }
  | { ok: false; error: "not_configured" | "malformed" | "bad_signature" | "invalid_claims" };

/** Verify a token of either version (the unsubscribe route + page). */
export function verifyUnsubscribeTokenAny(token: string): VerifyAnyUnsubscribeResult {
  const d = decodeToken(token);
  if (!d.ok) return d;
  if (d.payload.v === 2) {
    const v2 = asV2(d.payload);
    return v2 ? { ok: true, version: 2, claims: v2 } : { ok: false, error: "invalid_claims" };
  }
  const v1 = asV1(d.payload);
  return v1 ? { ok: true, version: 1, claims: v1 } : { ok: false, error: "invalid_claims" };
}
