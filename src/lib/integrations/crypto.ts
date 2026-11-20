import { createSecretBox, type EncryptedBlob } from "@/lib/security/secretBox";

/**
 * Encryption + OAuth-state signing for git integrations. A single root secret
 * `GIT_TOKEN_ENC_KEY` is stretched into purpose-specific 32-byte sub-keys (HMAC
 * over a fixed root) so the same secret safely serves both AES-256-GCM token
 * encryption and the CSRF state HMAC. The root MUST be a high-entropy random
 * value (≥32 bytes, e.g. `openssl rand -base64 32`), NOT a human-chosen
 * passphrase — see src/lib/security/secretBox.ts.
 *
 * The WORKER re-implements decryptToken (it can't import @/lib) — keep them in sync.
 */
const box = createSecretBox({
  envVar: "GIT_TOKEN_ENC_KEY",
  encPurpose: "token-enc-v1",
  statePurpose: "oauth-state-v1",
  unconfiguredError: "git_enc_key_unconfigured",
});

export type { EncryptedBlob };

export function isGitCryptoConfigured(): boolean {
  return box.isConfigured();
}

/**
 * `aad` binds a ciphertext to its brand and purpose (see gitRefreshAad), so a copy
 * pasted onto another brand's record won't open. Leave it out for `enc`, the
 * access token the worker decrypts: the worker opens it without AAD. A blob sealed
 * without AAD opens without it, so existing ciphertexts are unchanged.
 */
export function encryptToken(plaintext: string, aad?: string): EncryptedBlob {
  return box.seal(plaintext, aad);
}

export function decryptToken(blob: EncryptedBlob, aad?: string): string {
  return box.open(blob, aad);
}

/** The AAD for a git connection's sealed refresh token: `<tenantId>:<provider>:refresh`.
 *  Only the app reads refresh tokens, so they can be bound to the brand (the same
 *  pattern as sealMailchimpKey in src/lib/mailchimp/keyBox.ts). */
export function gitRefreshAad(tenantId: string, provider: string): string {
  return `${tenantId}:${provider}:refresh`;
}

/** Sign a short-lived OAuth `state` (CSRF) — brace-free `<b64url>.<hmac>`. */
export function signState(payload: Record<string, unknown>): string {
  return box.signState(payload);
}

/** Fails closed (null, not throw) if the root key is unset/rotated between /start
 *  and /callback — the callback turns null into a friendly ?status=error, not a 500. */
export function verifyState(token: string): Record<string, unknown> | null {
  return box.verifyState(token);
}
