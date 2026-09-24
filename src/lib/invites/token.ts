import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/**
 * Invite link token — `/invite/<payload>.<signature>` (nav v2 phase 4).
 *
 * Follows Google's signed-URL pattern (Cloud CDN "Use signed URLs"): the expiry
 * and the key's name are inside the signed part; more than one named key can be
 * live, so keys rotate without breaking links already sent; keys live in secret
 * storage (Secret Manager); lifetimes are as short as the use allows (30 days by
 * default, since people open invites days later); links are https; and every
 * request is verified.
 *
 * The token only NAMES an invite ({tenant, invite}). It grants nothing on our
 * side, and the redirect target comes from the server (the product's saved
 * sign-up URL), never from the link, so it can't become an open redirect.
 *
 * The HMAC input starts with a purpose string, so a key shared with another token
 * type by mistake still couldn't mint invite links. `kid` is a fingerprint of the
 * key itself (not a slot name), so after a rotation the old key — kept as
 * INVITE_LINK_SIGNING_KEY_PREVIOUS — still verifies the links it signed.
 */

export interface InviteClaims {
  v: 1;
  /** Tenant id. */
  t: string;
  /** Invite id. */
  i: string;
  /** Expiry, epoch seconds. */
  exp: number;
  /** Fingerprint of the signing key. */
  kid: string;
}

const PURPOSE = "invite.v1.";
const INSECURE_LOCAL_KEY = "insecure-local-dev-only-invite-key";
const ID_RE = /^[A-Za-z0-9_-]{1,80}$/;

function keyId(key: string): string {
  return createHash("sha256").update(`invite-kid:${key}`).digest("hex").slice(0, 8);
}

/** The key new links are signed with, or null when unconfigured (outside local dev). */
function currentKey(): string | null {
  const key = process.env.INVITE_LINK_SIGNING_KEY;
  if (key) return key;
  if (process.env.NODE_ENV !== "production") return INSECURE_LOCAL_KEY;
  return null;
}

/** Every key a link may have been signed with, by fingerprint. */
function verifyingKeys(): Map<string, string> {
  const out = new Map<string, string>();
  const current = currentKey();
  if (current) out.set(keyId(current), current);
  const previous = process.env.INVITE_LINK_SIGNING_KEY_PREVIOUS;
  if (previous) out.set(keyId(previous), previous);
  return out;
}

function sign(payloadB64: string, key: string): string {
  return createHmac("sha256", key).update(PURPOSE + payloadB64).digest("base64url");
}

/** Whether invite links can be minted here (the Invite button stays locked if not). */
export function isInviteLinksConfigured(): boolean {
  return currentKey() !== null;
}

/** Mint a signed invite token. Throws when unconfigured. */
export function signInviteToken(input: { tenantId: string; inviteId: string; expiresAtMs: number }): string {
  const key = currentKey();
  if (!key) throw new Error("invite_links_unconfigured");
  const claims: InviteClaims = {
    v: 1,
    t: input.tenantId,
    i: input.inviteId,
    exp: Math.floor(input.expiresAtMs / 1000),
    kid: keyId(key),
  };
  const payloadB64 = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${payloadB64}.${sign(payloadB64, key)}`;
}

export type VerifyInviteResult =
  | { ok: true; claims: InviteClaims; expired: boolean }
  | { ok: false; error: "not_configured" | "malformed" | "bad_signature" | "invalid_claims" };

function asClaims(c: Record<string, unknown>): InviteClaims | null {
  if (c.v !== 1) return null;
  if (typeof c.t !== "string" || !ID_RE.test(c.t)) return null;
  if (typeof c.i !== "string" || !ID_RE.test(c.i)) return null;
  if (typeof c.exp !== "number" || !Number.isFinite(c.exp)) return null;
  if (typeof c.kid !== "string") return null;
  return { v: 1, t: c.t, i: c.i, exp: c.exp, kid: c.kid };
}

/**
 * Check a token's signature, then its claims. An expired token still verifies
 * (`expired: true`) so the caller can show a "this invite has expired" page.
 */
export function verifyInviteToken(token: string, nowMs: number = Date.now()): VerifyInviteResult {
  const keys = verifyingKeys();
  if (keys.size === 0) return { ok: false, error: "not_configured" };
  if (typeof token !== "string" || token.length > 1024) return { ok: false, error: "malformed" };
  const dot = token.indexOf(".");
  if (dot <= 0 || dot === token.length - 1) return { ok: false, error: "malformed" };
  const payloadB64 = token.slice(0, dot);
  const sig = token.slice(dot + 1);

  let payload: Record<string, unknown>;
  try {
    const parsed = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8")) as unknown;
    if (!parsed || typeof parsed !== "object") return { ok: false, error: "malformed" };
    payload = parsed as Record<string, unknown>;
  } catch {
    return { ok: false, error: "malformed" };
  }
  // `kid` only selects which key to check against; a forged kid just fails the check.
  const key = typeof payload.kid === "string" ? keys.get(payload.kid) : undefined;
  if (!key) return { ok: false, error: "bad_signature" };
  const a = Buffer.from(sig);
  const b = Buffer.from(sign(payloadB64, key));
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, error: "bad_signature" };

  const claims = asClaims(payload);
  if (!claims) return { ok: false, error: "invalid_claims" };
  return { ok: true, claims, expired: claims.exp * 1000 < nowMs };
}

/** The public link for a token (on EMAIL_LINK_ORIGIN, like unsubscribe links). */
export function inviteLinkUrl(origin: string, token: string): string {
  return `${origin.replace(/\/+$/, "")}/invite/${token}`;
}
