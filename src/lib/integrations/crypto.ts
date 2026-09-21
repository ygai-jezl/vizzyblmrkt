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

export function encryptToken(plaintext: string): EncryptedBlob {
  return box.seal(plaintext);
}

export function decryptToken(blob: EncryptedBlob): string {
  return box.open(blob);
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
