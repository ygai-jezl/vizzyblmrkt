import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

/**
 * One factory for every at-rest secret (OAuth tokens, connection signing secrets)
 * and its matching OAuth-state signer. Each box has its OWN root env var and
 * purpose labels, so git, social and connection material never share a key.
 *
 * The root secret is SHA-256'd and split into purpose sub-keys with HMAC. There is
 * no salted KDF stretch, so the root MUST be high-entropy random (≥32 bytes, e.g.
 * `openssl rand -base64 32`), never a human-chosen passphrase — otherwise leaked
 * ciphertext and the state HMAC are brute-forceable.
 *
 * `aad` (additional authenticated data) binds a ciphertext to its context, e.g.
 * `tenantId:connectionId`: opening it anywhere else fails, so a ciphertext copied
 * onto another record is useless. A blob sealed without AAD opens without it, which
 * keeps the existing git/social ciphertexts working byte-for-byte.
 *
 * The knowledge-scraper worker re-implements `open` for the git box (it can't
 * import @/lib) — keep the algorithm in sync with workers/knowledge-scraper.
 */

export interface EncryptedBlob {
  ct: string; // base64 ciphertext
  iv: string; // base64 12-byte nonce
  tag: string; // base64 GCM auth tag
}

export interface SecretBoxConfig {
  /** Env var holding the root secret (read on every call, so rotation applies). */
  envVar: string;
  /** Sub-key label for encryption. Changing it orphans every existing ciphertext. */
  encPurpose: string;
  /** Sub-key label for OAuth-state signing. */
  statePurpose: string;
  /** Error message thrown when the root secret is unset. */
  unconfiguredError: string;
}

export interface SecretBox {
  isConfigured(): boolean;
  seal(plaintext: string, aad?: string): EncryptedBlob;
  open(blob: EncryptedBlob, aad?: string): string;
  /** Sign a short-lived OAuth `state` (CSRF) — brace-free `<b64url>.<hmac>`. */
  signState(payload: Record<string, unknown>): string;
  /** Verify a signed state. Fails closed (null, never throws), including when the
   *  root key was unset or rotated between signing and verifying. */
  verifyState(token: string): Record<string, unknown> | null;
}

export function createSecretBox(cfg: SecretBoxConfig): SecretBox {
  function rootKey(): Buffer | null {
    const k = process.env[cfg.envVar];
    if (!k) return null;
    return createHash("sha256").update(k).digest(); // 32 bytes
  }

  function subKey(purpose: string): Buffer {
    const root = rootKey();
    if (!root) throw new Error(cfg.unconfiguredError);
    return createHmac("sha256", root).update(purpose).digest(); // 32 bytes
  }

  function isConfigured(): boolean {
    return rootKey() !== null;
  }

  function stateSig(body: string): string {
    return createHmac("sha256", subKey(cfg.statePurpose)).update(body).digest("base64url");
  }

  return {
    isConfigured,

    seal(plaintext, aad) {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", subKey(cfg.encPurpose), iv);
      if (aad !== undefined) cipher.setAAD(Buffer.from(aad, "utf8"));
      const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      return {
        ct: ct.toString("base64"),
        iv: iv.toString("base64"),
        tag: cipher.getAuthTag().toString("base64"),
      };
    },

    open(blob, aad) {
      const decipher = createDecipheriv(
        "aes-256-gcm",
        subKey(cfg.encPurpose),
        Buffer.from(blob.iv, "base64"),
      );
      if (aad !== undefined) decipher.setAAD(Buffer.from(aad, "utf8"));
      decipher.setAuthTag(Buffer.from(blob.tag, "base64"));
      const pt = Buffer.concat([
        decipher.update(Buffer.from(blob.ct, "base64")),
        decipher.final(),
      ]);
      return pt.toString("utf8");
    },

    signState(payload) {
      const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
      return `${body}.${stateSig(body)}`;
    },

    verifyState(token) {
      if (typeof token !== "string" || !token.includes(".")) return null;
      if (!isConfigured()) return null;
      const dot = token.indexOf(".");
      const body = token.slice(0, dot);
      const sig = token.slice(dot + 1);
      if (!body || !sig) return null;
      const a = Buffer.from(sig);
      const b = Buffer.from(stateSig(body));
      if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
      try {
        return JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Record<
          string,
          unknown
        >;
      } catch {
        return null;
      }
    },
  };
}
