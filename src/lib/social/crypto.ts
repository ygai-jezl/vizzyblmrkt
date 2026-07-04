import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

/**
 * Encryption + OAuth-state signing for SOCIAL connections (X / Instagram /
 * LinkedIn). Deliberately separate from the git crypto (src/lib/integrations/
 * crypto.ts) with its own root secret `SOCIAL_TOKEN_ENC_KEY`, so social + git token
 * material never share a key. A single root is stretched into purpose sub-keys via
 * HMAC. The root MUST be high-entropy random (≥32 bytes, `openssl rand -base64 32`),
 * NOT a passphrase — there is no salted KDF stretch, so a weak key makes leaked
 * ciphertext AND the state HMAC brute-forceable.
 *
 * This MIRRORS the algorithm in src/lib/integrations/crypto.ts (only the env key +
 * sub-key labels differ). Any hardening fix here must be mirrored there; a shared
 * parameterized factory (keeping the two keys distinct) is a documented follow-up.
 */

function rootKey(): Buffer | null {
  const k = process.env.SOCIAL_TOKEN_ENC_KEY;
  if (!k) return null;
  return createHash("sha256").update(k).digest();
}

function subKey(purpose: string): Buffer {
  const root = rootKey();
  if (!root) throw new Error("social_enc_key_unconfigured");
  return createHmac("sha256", root).update(purpose).digest();
}

export function isSocialCryptoConfigured(): boolean {
  return rootKey() !== null;
}

export interface EncryptedBlob {
  ct: string;
  iv: string;
  tag: string;
}

export function encryptToken(plaintext: string): EncryptedBlob {
  const key = subKey("social-token-enc-v1");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    ct: ct.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
  };
}

export function decryptToken(blob: EncryptedBlob): string {
  const key = subKey("social-token-enc-v1");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(blob.iv, "base64"));
  decipher.setAuthTag(Buffer.from(blob.tag, "base64"));
  const pt = Buffer.concat([
    decipher.update(Buffer.from(blob.ct, "base64")),
    decipher.final(),
  ]);
  return pt.toString("utf8");
}

/** Sign a short-lived OAuth `state` (CSRF) — brace-free `<b64url>.<hmac>`. */
export function signState(payload: Record<string, unknown>): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = createHmac("sha256", subKey("social-oauth-state-v1")).update(body).digest("base64url");
  return `${body}.${sig}`;
}

export function verifyState(token: string): Record<string, unknown> | null {
  if (typeof token !== "string" || !token.includes(".")) return null;
  if (!isSocialCryptoConfigured()) return null; // fail closed on unset/rotated key
  const dot = token.indexOf(".");
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!body || !sig) return null;
  const expected = createHmac("sha256", subKey("social-oauth-state-v1")).update(body).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    return JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}
