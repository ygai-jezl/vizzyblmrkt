import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { Region } from "@/lib/types/tenant";
import type { TenantRole } from "@/lib/types/tenantUser";
import type { TenantContext } from "@/lib/tenant";

/**
 * Canvas capability token — the auth that lets the Campaign Ops Agent call back
 * into this app to save a journey draft. The admin-chat proxy mints it from a
 * VERIFIED TenantContext; the agent echoes it back; the canvas endpoint verifies
 * it and reconstructs the tenant scope from the TOKEN'S claims, never the body.
 *
 * Signed + verified entirely in-app with a server-only HMAC key, so the token is
 * unforgeable and the agent can't widen beyond the human's session. It is
 * deliberately BRACE-FREE (`<base64url-claims>.<base64url-hmac>`) because it
 * rides inside the `[ctx:{...}]` message envelope, whose parser regex is
 * non-greedy and would truncate at a nested `}` (see context_envelope.py).
 */

export interface CanvasContextClaims {
  tenantId: string;
  region: Region;
  userId: string;
  role: TenantRole;
  /** Unique token id (replay auditing). */
  jti: string;
  /** Issued-at / expiry, epoch seconds. */
  iat: number;
  exp: number;
}

const DEFAULT_TTL_SECONDS = 15 * 60;
const INSECURE_LOCAL_KEY = "insecure-local-dev-only-key";

/** The HMAC key, or null when unconfigured (and not in the local bypass). */
function resolveKey(): string | null {
  const key = process.env.CANVAS_CONTEXT_SIGNING_KEY;
  if (key) return key;
  if (
    process.env.NODE_ENV !== "production" &&
    process.env.CANVAS_ALLOW_INSECURE_LOCAL === "1"
  ) {
    return INSECURE_LOCAL_KEY;
  }
  return null;
}

/** Whether the capability-token path can mint/verify in this environment. */
export function isCanvasAuthConfigured(): boolean {
  return resolveKey() !== null;
}

function hmac(payloadB64: string, key: string): string {
  return createHmac("sha256", key).update(payloadB64).digest("base64url");
}

/** Mint a short-lived signed token from a verified context. Throws if unconfigured. */
export function signCanvasContext(
  ctx: TenantContext,
  opts: { ttlSeconds?: number; now?: number } = {},
): string {
  const key = resolveKey();
  if (!key) throw new Error("canvas_auth_unconfigured");
  if (!ctx.userId) throw new Error("signCanvasContext requires ctx.userId");

  const nowSec = Math.floor((opts.now ?? Date.now()) / 1000);
  const claims: CanvasContextClaims = {
    tenantId: ctx.tenantId,
    region: ctx.region,
    userId: ctx.userId,
    role: ctx.role ?? "member",
    jti: randomUUID(),
    iat: nowSec,
    exp: nowSec + (opts.ttlSeconds ?? DEFAULT_TTL_SECONDS),
  };
  const payloadB64 = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${payloadB64}.${hmac(payloadB64, key)}`;
}

/** Mint a token, or null if the key is unconfigured — keeps the chat proxy
 *  resilient (a missing secret degrades agent authoring, never breaks chat). */
export function mintCanvasContextOrNull(ctx: TenantContext): string | null {
  if (!isCanvasAuthConfigured() || !ctx.userId) return null;
  try {
    return signCanvasContext(ctx);
  } catch {
    return null;
  }
}

export type VerifyCanvasResult =
  | { ok: true; claims: CanvasContextClaims }
  | {
      ok: false;
      error: "not_configured" | "malformed" | "bad_signature" | "expired" | "invalid_claims";
    };

export function verifyCanvasContext(
  token: string,
  opts: { now?: number } = {},
): VerifyCanvasResult {
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

  let claims: CanvasContextClaims;
  try {
    claims = JSON.parse(
      Buffer.from(payloadB64, "base64url").toString("utf8"),
    ) as CanvasContextClaims;
  } catch {
    return { ok: false, error: "malformed" };
  }
  if (
    !claims ||
    typeof claims.tenantId !== "string" ||
    typeof claims.region !== "string" ||
    typeof claims.userId !== "string" ||
    typeof claims.exp !== "number"
  ) {
    return { ok: false, error: "invalid_claims" };
  }

  const nowSec = Math.floor((opts.now ?? Date.now()) / 1000);
  if (nowSec >= claims.exp) return { ok: false, error: "expired" };

  return { ok: true, claims };
}

/** Reconstruct the trusted TenantContext from verified token claims. Mirrors
 *  tenantContextFromClaims — the tenant scope comes from the signed token, NOT
 *  from any request field. */
export function tenantContextFromCanvasToken(
  claims: CanvasContextClaims,
): TenantContext {
  return {
    tenantId: claims.tenantId,
    region: claims.region,
    userId: claims.userId,
    role: claims.role,
    source: "agent",
  };
}
