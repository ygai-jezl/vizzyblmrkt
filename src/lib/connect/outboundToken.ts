import { createHash, createPublicKey, verify as cryptoVerify, type JsonWebKey } from "node:crypto";

/**
 * The token on every request the PLATFORM sends to a product (context pulls and
 * webhooks) — Google's pattern for calling customer endpoints (Pub/Sub push,
 * Chat apps, Cross-Account Protection): a short-lived JWT signed with OUR
 * private key (Cloud KMS, never exported), verified against the public keys we
 * publish at `${issuer}/.well-known/jwks.json`. A product holds nothing that can
 * forge our requests, so a leak of the connection secrets we store can't be
 * used against its endpoints.
 *
 *   Authorization: Bearer <JWT>        header: { alg: ES256, typ: JWT, kid }
 *   claims: iss   the platform origin (where the JWKS lives)
 *           aud   the connection's public key id (stable across secret rotation)
 *           iat / exp   exp = iat + 300 s
 *           jti   requestId / webhook id (unique per request)
 *           dir   "context" | "webhook" — a token for one can't be replayed as the other
 *           body_sha256   base64url SHA-256 of the exact raw body (a bearer JWT
 *                         alone doesn't cover the body)
 *
 * Pure and dependency-free. The Node SDK implements the same checks
 * independently; both are pinned by sdk/node/test/vectors.json.
 */

export const OUTBOUND_ALG = "ES256";
export const OUTBOUND_TOKEN_TTL_SEC = 300;
/** Clock skew tolerated on iat/exp. */
export const OUTBOUND_LEEWAY_SEC = 60;
export const JWKS_PATH = "/.well-known/jwks.json";

export type OutboundDirection = "context" | "webhook";

export interface OutboundClaims {
  iss: string;
  aud: string;
  iat: number;
  exp: number;
  jti: string;
  dir: OutboundDirection;
  body_sha256: string;
}

/** A published public key (RFC 7517, EC P-256). */
export interface PublicJwk {
  kty: "EC";
  crv: "P-256";
  x: string;
  y: string;
  kid: string;
  alg: "ES256";
  use: "sig";
}

// ---- Encoding ------------------------------------------------------------------

export function b64url(buf: Buffer | string): string {
  return Buffer.from(buf).toString("base64url");
}

export function bodyHash(rawBody: string): string {
  return b64url(createHash("sha256").update(rawBody, "utf8").digest());
}

/** RFC 7638 thumbprint — the kid, so a key's id is derived from the key itself. */
export function jwkThumbprint(jwk: { crv: string; kty: string; x: string; y: string }): string {
  const canonical = `{"crv":"${jwk.crv}","kty":"${jwk.kty}","x":"${jwk.x}","y":"${jwk.y}"}`;
  return b64url(createHash("sha256").update(canonical).digest());
}

/** A PEM (SPKI) P-256 public key → a published JWK with its thumbprint kid. */
export function pemToPublicJwk(pem: string): PublicJwk {
  const jwk = createPublicKey(pem).export({ format: "jwk" }) as JsonWebKey;
  if (jwk.kty !== "EC" || jwk.crv !== "P-256" || !jwk.x || !jwk.y) throw new Error("not_p256_key");
  const base = { kty: "EC" as const, crv: "P-256" as const, x: jwk.x, y: jwk.y };
  return { ...base, kid: jwkThumbprint(base), alg: "ES256", use: "sig" };
}

/**
 * ECDSA signatures come back from Cloud KMS DER-encoded; JWS ES256 needs the
 * 64-byte r‖s form (RFC 7518 §3.4).
 */
export function derToJose(der: Buffer): Buffer {
  let i = 0;
  const expect = (b: number) => {
    if (der[i++] !== b) throw new Error("bad_der");
  };
  const len = () => {
    const l = der[i++]!;
    if (l < 0x80) return l;
    if (l === 0x81) return der[i++]!;
    throw new Error("bad_der");
  };
  const int = () => {
    expect(0x02);
    const l = len();
    let v = der.subarray(i, i + l);
    i += l;
    while (v.length > 32 && v[0] === 0) v = v.subarray(1);
    if (v.length > 32) throw new Error("bad_der");
    return Buffer.concat([Buffer.alloc(32 - v.length), v]);
  };
  expect(0x30);
  const total = len();
  if (i + total !== der.length) throw new Error("bad_der");
  const r = int();
  const s = int();
  if (i !== der.length) throw new Error("bad_der");
  return Buffer.concat([r, s]);
}

// CRC32C (Castagnoli) — Cloud KMS's end-to-end integrity check on requests/responses.
const CRC32C_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0x82f63b78 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32c(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC32C_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ---- Building ------------------------------------------------------------------

export function outboundClaims(input: {
  issuer: string;
  audience: string;
  direction: OutboundDirection;
  jti: string;
  rawBody: string;
  nowMs: number;
}): OutboundClaims {
  const iat = Math.floor(input.nowMs / 1000);
  return {
    iss: input.issuer,
    aud: input.audience,
    iat,
    exp: iat + OUTBOUND_TOKEN_TTL_SEC,
    jti: input.jti,
    dir: input.direction,
    body_sha256: bodyHash(input.rawBody),
  };
}

/** `header.payload` — the bytes the signature covers. */
export function signingInput(kid: string, claims: OutboundClaims): string {
  return `${b64url(JSON.stringify({ alg: OUTBOUND_ALG, typ: "JWT", kid }))}.${b64url(JSON.stringify(claims))}`;
}

// ---- Verifying -------------------------------------------------------------------

export type OutboundVerifyFailure =
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

export type OutboundVerifyResult =
  | { ok: true; claims: OutboundClaims }
  | { ok: false; reason: OutboundVerifyFailure };

/** The token from `Authorization: Bearer <jwt>`, or null. */
export function bearerToken(authorization: string | null | undefined): string | null {
  const m = /^Bearer\s+([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\s*$/.exec(authorization ?? "");
  return m ? m[1]! : null;
}

function parseJson(part: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Verify a platform→product token. Signature FIRST (against the published keys,
 * by kid), then every claim the signature doesn't cover by itself: issuer,
 * audience, direction, lifetime, and the body hash.
 */
export function verifyOutboundToken(input: {
  token: string | null;
  jwks: PublicJwk[];
  issuer: string;
  audience: string;
  direction: OutboundDirection;
  rawBody: string;
  nowMs?: number;
}): OutboundVerifyResult {
  if (!input.token) return { ok: false, reason: "missing_token" };
  const parts = input.token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed" };
  const [h, p, s] = parts as [string, string, string];
  const header = parseJson(h);
  if (!header) return { ok: false, reason: "malformed" };
  if (header.alg !== OUTBOUND_ALG) return { ok: false, reason: "unsupported_alg" };
  const jwk = input.jwks.find((k) => k.kid === header.kid);
  if (!jwk) return { ok: false, reason: "unknown_key" };

  const sig = Buffer.from(s, "base64url");
  let valid = false;
  try {
    const key = createPublicKey({ key: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y }, format: "jwk" });
    valid = sig.length === 64 && cryptoVerify("sha256", Buffer.from(`${h}.${p}`), { key, dsaEncoding: "ieee-p1363" }, sig);
  } catch {
    valid = false;
  }
  if (!valid) return { ok: false, reason: "bad_signature" };

  const c = parseJson(p);
  if (!c) return { ok: false, reason: "malformed" };
  if (c.iss !== input.issuer) return { ok: false, reason: "wrong_issuer" };
  if (c.aud !== input.audience) return { ok: false, reason: "wrong_audience" };
  if (c.dir !== input.direction) return { ok: false, reason: "wrong_direction" };
  if (typeof c.iat !== "number" || typeof c.exp !== "number" || typeof c.jti !== "string") {
    return { ok: false, reason: "malformed" };
  }
  const nowSec = Math.floor((input.nowMs ?? Date.now()) / 1000);
  if (c.exp - c.iat > OUTBOUND_TOKEN_TTL_SEC) return { ok: false, reason: "malformed" };
  if (nowSec > c.exp + OUTBOUND_LEEWAY_SEC) return { ok: false, reason: "expired" };
  if (nowSec < c.iat - OUTBOUND_LEEWAY_SEC) return { ok: false, reason: "not_yet_valid" };
  if (c.body_sha256 !== bodyHash(input.rawBody)) return { ok: false, reason: "body_mismatch" };
  return { ok: true, claims: c as unknown as OutboundClaims };
}
