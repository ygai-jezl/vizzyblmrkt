import { createHash, createPublicKey, verify as cryptoVerify } from "node:crypto";

/**
 * Verifies the token YouGrow puts on every request it sends your server
 * (context pulls, webhooks):
 *
 *   Authorization: Bearer <JWT>     alg ES256, kid = one of YouGrow's published keys
 *   iss  YouGrow's origin (its keys are at `${iss}/.well-known/jwks.json`)
 *   aud  your connection's key id
 *   dir  "context" | "webhook"
 *   iat / exp   at most 5 minutes apart
 *   jti  unique per request
 *   body_sha256  base64url SHA-256 of the exact raw body
 *
 * Signature first, then every claim. Pinned by test/vectors.json.
 */

export type RequestDirection = "context" | "webhook";

export interface Jwk {
  kty: string;
  crv?: string;
  x?: string;
  y?: string;
  kid?: string;
  alg?: string;
  use?: string;
}

export type JwtFailure =
  | "missing_token"
  | "malformed"
  | "unsupported_alg"
  | "unknown_key"
  | "bad_signature"
  | "wrong_issuer"
  | "wrong_audience"
  | "wrong_direction"
  | "expired"
  | "not_yet_valid"
  | "body_mismatch";

export interface YouGrowClaims {
  iss: string;
  aud: string;
  iat: number;
  exp: number;
  jti: string;
  dir: RequestDirection;
  body_sha256: string;
}

export type JwtResult = { ok: true; claims: YouGrowClaims } | { ok: false; reason: JwtFailure };

const MAX_LIFETIME_SEC = 300;
const LEEWAY_SEC = 60;

function decodeJson(part: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
    return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function tokenFromAuthorization(value: string | null | undefined): string | null {
  const m = /^Bearer\s+([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\s*$/.exec(value ?? "");
  return m ? m[1]! : null;
}

/** The kid in a token's header, without trusting anything else in it. */
export function tokenKid(token: string): string | null {
  const header = decodeJson(token.split(".")[0] ?? "");
  return header && typeof header.kid === "string" ? header.kid : null;
}

export function verifyJwt(input: {
  token: string | null;
  keys: Jwk[];
  issuer: string;
  audience: string;
  direction: RequestDirection;
  rawBody: string;
  nowMs?: number;
}): JwtResult {
  if (!input.token) return { ok: false, reason: "missing_token" };
  const parts = input.token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed" };
  const [h, p, s] = parts as [string, string, string];
  const header = decodeJson(h);
  if (!header) return { ok: false, reason: "malformed" };
  // Pin the algorithm: never let the token choose (no "none", no HMAC).
  if (header.alg !== "ES256") return { ok: false, reason: "unsupported_alg" };
  const jwk = input.keys.find((k) => k.kid === header.kid && k.kty === "EC" && k.crv === "P-256");
  if (!jwk?.x || !jwk.y) return { ok: false, reason: "unknown_key" };

  const signature = Buffer.from(s, "base64url");
  let valid = false;
  try {
    const key = createPublicKey({ key: { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y }, format: "jwk" });
    valid =
      signature.length === 64 &&
      cryptoVerify("sha256", Buffer.from(`${h}.${p}`), { key, dsaEncoding: "ieee-p1363" }, signature);
  } catch {
    valid = false;
  }
  if (!valid) return { ok: false, reason: "bad_signature" };

  const c = decodeJson(p);
  if (!c) return { ok: false, reason: "malformed" };
  if (c.iss !== input.issuer) return { ok: false, reason: "wrong_issuer" };
  if (c.aud !== input.audience) return { ok: false, reason: "wrong_audience" };
  if (c.dir !== input.direction) return { ok: false, reason: "wrong_direction" };
  if (typeof c.iat !== "number" || typeof c.exp !== "number" || typeof c.jti !== "string") {
    return { ok: false, reason: "malformed" };
  }
  if (c.exp - c.iat > MAX_LIFETIME_SEC) return { ok: false, reason: "malformed" };
  const nowSec = Math.floor((input.nowMs ?? Date.now()) / 1000);
  if (nowSec > c.exp + LEEWAY_SEC) return { ok: false, reason: "expired" };
  if (nowSec < c.iat - LEEWAY_SEC) return { ok: false, reason: "not_yet_valid" };
  const hash = createHash("sha256").update(input.rawBody, "utf8").digest("base64url");
  if (c.body_sha256 !== hash) return { ok: false, reason: "body_mismatch" };
  return { ok: true, claims: c as unknown as YouGrowClaims };
}
