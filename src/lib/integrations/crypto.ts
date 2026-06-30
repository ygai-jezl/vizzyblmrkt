import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

/**
 * Encryption + OAuth-state signing for git integrations. A single root secret
 * `GIT_TOKEN_ENC_KEY` is stretched into purpose-specific 32-byte sub-keys (HMAC
 * over a fixed root) so the same secret safely serves both AES-256-GCM token
 * encryption and the CSRF state HMAC. There is no salted KDF stretch, so the root
 * MUST be a high-entropy random value (≥32 bytes, e.g. `openssl rand -base64 32`),
 * NOT a human-chosen passphrase — otherwise leaked ciphertext is brute-forceable.
 *
 * The WORKER re-implements decryptToken (it can't import @/lib) — keep them in sync.
 */

function rootKey(): Buffer | null {
  const k = process.env.GIT_TOKEN_ENC_KEY;
  if (!k) return null;
  return createHash("sha256").update(k).digest(); // 32 bytes
}

function subKey(purpose: string): Buffer {
  const root = rootKey();
  if (!root) throw new Error("git_enc_key_unconfigured");
  return createHmac("sha256", root).update(purpose).digest(); // 32 bytes
}

export function isGitCryptoConfigured(): boolean {
  return rootKey() !== null;
}

export interface EncryptedBlob {
  ct: string; // base64 ciphertext
  iv: string; // base64 12-byte nonce
  tag: string; // base64 GCM auth tag
}

export function encryptToken(plaintext: string): EncryptedBlob {
  const key = subKey("token-enc-v1");
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
  const key = subKey("token-enc-v1");
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
  const sig = createHmac("sha256", subKey("oauth-state-v1")).update(body).digest("base64url");
  return `${body}.${sig}`;
}

export function verifyState(token: string): Record<string, unknown> | null {
  if (typeof token !== "string" || !token.includes(".")) return null;
  // Fail closed (null, not throw) if the root key is unset/rotated between /start
  // and /callback — the callback turns null into a friendly ?status=error, not a 500.
  if (!isGitCryptoConfigured()) return null;
  const dot = token.indexOf(".");
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!body || !sig) return null;
  const expected = createHmac("sha256", subKey("oauth-state-v1")).update(body).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    return JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}
