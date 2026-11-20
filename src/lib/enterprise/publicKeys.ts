/**
 * The public keys that verify Enterprise licence keys (src/lib/enterprise/licence.ts).
 *
 * Each entry is an Ed25519 public key as a JWK (RFC 8037), and its kid is the key's RFC 7638
 * thumbprint (okpThumbprint in licence.ts), so a key's id comes from the key itself.
 *
 * - The owner adds the production public key here: only its public x value.
 * - The private key never enters any repository. It stays offline, or in Cloud KMS as an
 *   Ed25519 signing key.
 * - Rotation adds the new key beside the old one, then signs with the new one. The old key stays
 *   until every licence key signed with it has expired.
 *
 * Empty: no licence key verifies, so every Enterprise feature stays off. Everything else works.
 */
export interface LicencePublicJwk {
  kty: "OKP";
  crv: "Ed25519";
  /** The 32 byte public key, base64url without padding. */
  x: string;
  /** okpThumbprint of this key. */
  kid: string;
}

export const LICENCE_PUBLIC_KEYS: readonly LicencePublicJwk[] = [];
