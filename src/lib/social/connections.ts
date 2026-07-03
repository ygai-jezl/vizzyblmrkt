import type { Tenant, SocialConnection } from "@/lib/types/tenant";
import { decryptToken, isSocialCryptoConfigured } from "./crypto";

/** Read a tenant's social connection for a platform (or null). */
export function getSocialConnection(
  tenant: Tenant | null,
  platform: string,
): SocialConnection | null {
  return tenant?.socialConnections?.[platform] ?? null;
}

export interface SocialTokens {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: string | null;
  handle: string | null;
}

/**
 * Decrypt a tenant's stored social tokens, or null if not connected / crypto
 * unset / the ciphertext is tampered (fail-soft — never throws).
 */
export function getDecryptedSocialTokens(
  tenant: Tenant | null,
  platform: string,
): SocialTokens | null {
  const conn = getSocialConnection(tenant, platform);
  if (!conn || !isSocialCryptoConfigured()) return null;
  try {
    return {
      accessToken: decryptToken(conn.enc),
      refreshToken: conn.refreshEnc ? decryptToken(conn.refreshEnc) : null,
      expiresAt: conn.expiresAt ?? null,
      handle: conn.handle ?? null,
    };
  } catch {
    return null;
  }
}
