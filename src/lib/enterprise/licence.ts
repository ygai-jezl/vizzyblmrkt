import { createHash, createPublicKey, verify as cryptoVerify } from "node:crypto";
import { LICENCE_PUBLIC_KEYS, type LicencePublicJwk } from "./publicKeys";

/**
 * Enterprise licence keys, checked offline: no network call and nothing stored.
 *
 *   ygel_<h>.<p>.<s>   each part base64url without padding
 *   h  the header { alg: "EdDSA", typ: "ygel1", kid }, where kid is the RFC 7638 thumbprint
 *      of the public key that verifies it (a key in LICENCE_PUBLIC_KEYS)
 *   p  the claims { v: 1, lid, licensee, seats, features, iat, nbf?, exp }, times in seconds
 *   s  the Ed25519 signature over the ASCII bytes of "ygel_<h>.<p>"
 *
 * Modelled on verifyOutboundToken (src/lib/connect/outboundToken.ts), but stricter: Buffer's
 * base64url decoder skips characters it doesn't know, so every part must use only the base64url
 * alphabet and encode back to exactly itself. The signature is checked before any claim is read.
 * Feature ids this copy doesn't know are kept and never match anything, so a newer key still
 * works here.
 *
 * The key itself is never logged. Node runtime only (node:crypto): never import this from
 * middleware or a client component.
 */

export const LICENCE_PREFIX = "ygel_";
export const MAX_LICENCE_KEY_LENGTH = 4096;
export const LICENCE_ALG = "EdDSA";
export const LICENCE_TYP = "ygel1";
export const LICENCE_VERSION = 1;
/** Clock skew allowed on iat and nbf, in seconds. */
export const LICENCE_LEEWAY_SEC = 300;
export const MAX_LICENCE_SEATS = 1_000_000;
export const MAX_LICENCE_FEATURES = 64;

export interface LicenceHeader {
  alg: typeof LICENCE_ALG;
  typ: typeof LICENCE_TYP;
  kid: string;
}

export interface LicenceClaims {
  v: typeof LICENCE_VERSION;
  /** The licence's id, for the issuer's records. */
  lid: string;
  /** Who the licence is for, as people read it. */
  licensee: string;
  seats: number;
  /** Enterprise feature ids (src/lib/enterprise/features.ts). */
  features: readonly string[];
  iat: number;
  nbf?: number;
  exp: number;
}

export type LicenceFailure =
  | "no_key"
  | "malformed"
  | "unsupported_alg"
  | "unknown_key"
  | "bad_signature"
  | "wrong_version"
  | "bad_claims"
  | "not_yet_valid"
  | "expired";

/** A verified licence, or why not. An expired licence keeps its claims, so a screen can say when it ended. */
export type LicenceResult =
  | { ok: true; claims: LicenceClaims }
  | { ok: false; reason: "expired"; claims: LicenceClaims }
  | { ok: false; reason: Exclude<LicenceFailure, "expired">; claims?: undefined };

// ---- Format ----------------------------------------------------------------------

function b64urlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

/** "ygel_<h>.<p>": the ASCII text the signature covers. The issuing tool builds keys with this. */
export function licenceSigningInput(header: LicenceHeader, claims: LicenceClaims): string {
  return `${LICENCE_PREFIX}${b64urlJson(header)}.${b64urlJson(claims)}`;
}

/** RFC 7638 thumbprint of an OKP key (crv, kty and x in that order): the kid. */
export function okpThumbprint(jwk: { crv: string; kty: string; x: string }): string {
  const canonical = JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x });
  return createHash("sha256").update(canonical, "utf8").digest("base64url");
}

// ---- Verifying ---------------------------------------------------------------------

const KEY_SHAPE = /^ygel_([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/;
const utf8 = new TextDecoder("utf-8", { fatal: true });

/** The bytes of a canonical base64url part, or null. */
function decodePart(part: string): Buffer | null {
  const bytes = Buffer.from(part, "base64url");
  return bytes.toString("base64url") === part ? bytes : null;
}

function jsonObject(bytes: Buffer): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(utf8.decode(bytes));
    return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function finite(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n);
}

/** The claims in their checked shape, or null. */
function claimsShape(c: Record<string, unknown>): LicenceClaims | null {
  const { lid, licensee, seats, features, iat, nbf, exp } = c;
  if (typeof lid !== "string" || lid.length > 100) return null;
  if (typeof licensee !== "string" || licensee.length < 1 || licensee.length > 200) return null;
  if (typeof seats !== "number" || !Number.isInteger(seats) || seats < 1 || seats > MAX_LICENCE_SEATS) return null;
  if (!Array.isArray(features) || features.length > MAX_LICENCE_FEATURES) return null;
  if (!features.every((f) => typeof f === "string" && f.length <= 64)) return null;
  if (!finite(iat) || !finite(exp) || !(exp > iat)) return null;
  if (nbf !== undefined && !finite(nbf)) return null;
  return Object.freeze({
    v: LICENCE_VERSION,
    lid,
    licensee,
    seats,
    features: Object.freeze([...(features as string[])]),
    iat,
    ...(nbf !== undefined ? { nbf } : {}),
    exp,
  });
}

type SignedCheck =
  | { ok: true; claims: LicenceClaims }
  | { ok: false; reason: Exclude<LicenceFailure, "not_yet_valid" | "expired"> };

/** Every check that doesn't depend on the time: format, header, signature, claims. */
function checkSigned(key: unknown, keys: readonly LicencePublicJwk[]): SignedCheck {
  const text = typeof key === "string" ? key.trim() : "";
  if (!text) return { ok: false, reason: "no_key" };
  if (text.length > MAX_LICENCE_KEY_LENGTH) return { ok: false, reason: "malformed" };
  const m = KEY_SHAPE.exec(text);
  if (!m) return { ok: false, reason: "malformed" };
  const [, h, p, s] = m as unknown as [string, string, string, string];
  const headerBytes = decodePart(h);
  const claimBytes = decodePart(p);
  const sig = decodePart(s);
  if (!headerBytes || !claimBytes || !sig) return { ok: false, reason: "malformed" };

  const header = jsonObject(headerBytes);
  if (!header) return { ok: false, reason: "malformed" };
  if (header.alg !== LICENCE_ALG || header.typ !== LICENCE_TYP) return { ok: false, reason: "unsupported_alg" };
  const jwk = typeof header.kid === "string" ? keys.find((k) => k.kid === header.kid) : undefined;
  if (!jwk) return { ok: false, reason: "unknown_key" };

  let valid = false;
  try {
    if (sig.length === 64 && jwk.kty === "OKP" && jwk.crv === "Ed25519") {
      const publicKey = createPublicKey({ key: { kty: jwk.kty, crv: jwk.crv, x: jwk.x }, format: "jwk" });
      valid =
        publicKey.asymmetricKeyType === "ed25519" &&
        cryptoVerify(null, Buffer.from(`${LICENCE_PREFIX}${h}.${p}`, "ascii"), publicKey, sig);
    }
  } catch {
    valid = false;
  }
  if (!valid) return { ok: false, reason: "bad_signature" };

  const c = jsonObject(claimBytes);
  if (!c) return { ok: false, reason: "malformed" };
  if (c.v !== LICENCE_VERSION) return { ok: false, reason: "wrong_version" };
  const claims = claimsShape(c);
  if (!claims) return { ok: false, reason: "bad_claims" };
  return { ok: true, claims };
}

/** The time checks, written so a time that isn't a number fails. */
function checkTimes(claims: LicenceClaims, nowMs: number): LicenceResult {
  const now = Math.floor(nowMs / 1000);
  const started = now + LICENCE_LEEWAY_SEC >= claims.iat && (claims.nbf === undefined || now + LICENCE_LEEWAY_SEC >= claims.nbf);
  if (!started) return { ok: false, reason: "not_yet_valid" };
  if (!(now < claims.exp)) return { ok: false, reason: "expired", claims };
  return { ok: true, claims };
}

/**
 * Verify a licence key, in this order: no_key, malformed, unsupported_alg, unknown_key,
 * bad_signature, malformed (claims), wrong_version, bad_claims, not_yet_valid, expired.
 * Surrounding spaces are ignored. Never throws.
 */
export function verifyLicenceKey(input: {
  key: string | null | undefined;
  keys?: readonly LicencePublicJwk[];
  nowMs?: number;
}): LicenceResult {
  const signed = checkSigned(input.key, input.keys ?? LICENCE_PUBLIC_KEYS);
  if (!signed.ok) return { ok: false, reason: signed.reason };
  return checkTimes(signed.claims, input.nowMs ?? Date.now());
}

/** This deployment's licence key setting, trimmed, or null when it is unset or empty. */
export function licenceKeySetting(): string | null {
  const value = (process.env.ENTERPRISE_LICENCE_KEY ?? "").trim();
  return value === "" ? null : value;
}

let signedCache: { key: string; keys: readonly LicencePublicJwk[]; result: SignedCheck } | null = null;

/**
 * This deployment's licence. The signature check is kept for one key string; the times are
 * checked on every call, so a licence expires while the server runs.
 */
export function currentLicence(nowMs: number = Date.now(), keys: readonly LicencePublicJwk[] = LICENCE_PUBLIC_KEYS): LicenceResult {
  const key = licenceKeySetting();
  if (key === null) return { ok: false, reason: "no_key" };
  if (!signedCache || signedCache.key !== key || signedCache.keys !== keys) {
    signedCache = { key, keys, result: checkSigned(key, keys) };
  }
  const signed = signedCache.result;
  if (!signed.ok) return { ok: false, reason: signed.reason };
  return checkTimes(signed.claims, nowMs);
}
