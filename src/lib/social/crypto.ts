import { createSecretBox, type EncryptedBlob } from "@/lib/security/secretBox";

/**
 * Encryption + OAuth-state signing for SOCIAL connections (X / Instagram /
 * LinkedIn). Deliberately separate from the git crypto (src/lib/integrations/
 * crypto.ts) with its own root secret `SOCIAL_TOKEN_ENC_KEY`, so social + git token
 * material never share a key. Same algorithm, via the shared factory in
 * src/lib/security/secretBox.ts; the root MUST be high-entropy random (≥32 bytes,
 * `openssl rand -base64 32`), NOT a passphrase.
 */
const box = createSecretBox({
  envVar: "SOCIAL_TOKEN_ENC_KEY",
  encPurpose: "social-token-enc-v1",
  statePurpose: "social-oauth-state-v1",
  unconfiguredError: "social_enc_key_unconfigured",
});

export type { EncryptedBlob };

export function isSocialCryptoConfigured(): boolean {
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

/** Fails closed (null, not throw) on an unset/rotated key. */
export function verifyState(token: string): Record<string, unknown> | null {
  return box.verifyState(token);
}
