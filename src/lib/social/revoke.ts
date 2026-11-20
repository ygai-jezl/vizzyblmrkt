import { getTenantById } from "@/lib/tenant";
import { isConnectorRevokeXEnabled } from "@/lib/integrations/flags";
import { REVOKE_TIMEOUT_MS, type RevokeDeps, type RevokeResult } from "@/lib/integrations/revoke";
import { getDecryptedSocialTokens } from "./connections";
import { basicAuthHeader, xClientId, xClientSecret } from "./x/oauth";

/**
 * Cancel YouGrow's access at a social platform when its connection goes away. Callers
 * check isConnectorRevokeEnabled() and call this only AFTER the local delete, so a slow
 * or failing platform never keeps a connection.
 *
 * Policy, in this one place:
 *  - X: revoked only when isConnectorRevokeXEnabled() (CONNECTOR_REVOKE_X_ENABLED and
 *    CONNECTOR_REVOKE_ENABLED). The refresh token first, then the access token. X has
 *    its own switch because one X account connected to two brands may share a grant,
 *    so revoking for one brand could cut off the other.
 *  - LinkedIn and LinkedIn Pages: always skipped. LinkedIn may hand the same member the
 *    same token across authorisations, so a revoke could cut off another brand
 *    connected with the same LinkedIn account.
 *
 * Best effort: never throws, gives up after REVOKE_TIMEOUT_MS for the whole revoke.
 * Logs say "[revoke]" and the reason, never a token.
 */

export const X_REVOKE_URL = "https://api.x.com/2/oauth2/revoke";

export type RevocablePlatform = "x" | "linkedin" | "linkedin_org";

export interface SocialTokensToRevoke {
  accessToken: string;
  refreshToken: string | null;
}

const skipped = (reason: string): RevokeResult => ({ result: "skipped", reason });

function errName(e: unknown): string {
  return e instanceof Error ? e.name : "error";
}

/**
 * A brand's stored social tokens, decrypted in memory, read before a Disconnect deletes
 * them. null when not connected, unreadable, or the read fails: the Disconnect still goes
 * ahead, there is just nothing to revoke.
 */
export async function storedSocialTokens(
  tenantId: string,
  platform: RevocablePlatform,
): Promise<SocialTokensToRevoke | null> {
  try {
    const tokens = getDecryptedSocialTokens(await getTenantById(tenantId), platform);
    return tokens ? { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken } : null;
  } catch {
    return null;
  }
}

async function revokeX(tenantId: string, tokens: SocialTokensToRevoke, deps: RevokeDeps): Promise<RevokeResult> {
  const cid = xClientId();
  const csec = xClientSecret();
  if (!cid || !csec) return skipped("not_configured");
  const signal = AbortSignal.timeout(deps.timeoutMs ?? REVOKE_TIMEOUT_MS);
  const doFetch = deps.fetch ?? fetch;
  const calls: Array<[string, "refresh_token" | "access_token"]> = [];
  if (tokens.refreshToken) calls.push([tokens.refreshToken, "refresh_token"]);
  calls.push([tokens.accessToken, "access_token"]);

  const failures: string[] = [];
  for (const [token, hint] of calls) {
    try {
      const res = await doFetch(X_REVOKE_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
          Authorization: basicAuthHeader(cid, csec),
        },
        body: new URLSearchParams({ token, token_type_hint: hint, client_id: cid }).toString(),
        signal,
      });
      if (!res.ok) failures.push(`${hint}:api_${res.status}`);
    } catch (e) {
      const name = errName(e);
      failures.push(`${hint}:${name === "TimeoutError" || name === "AbortError" ? "timeout" : `network:${name}`}`);
    }
  }
  if (failures.length === 0) return { result: "done" };
  const reason = failures.join(",");
  console.warn(`[revoke] x revoke failed for ${tenantId}: ${reason}`);
  return { result: "failed", reason };
}

/**
 * Revoke a social connection's tokens at its platform, per the policy above. Pass the
 * tokens as they were read before the local delete. Never throws.
 */
export async function revokeSocialConnection(
  tenantId: string,
  platform: RevocablePlatform,
  tokens: SocialTokensToRevoke | null,
  deps: RevokeDeps = {},
): Promise<RevokeResult> {
  try {
    if (platform !== "x") return skipped("linkedin_policy");
    if (!isConnectorRevokeXEnabled()) return skipped("x_switch_off");
    if (!tokens?.accessToken) return skipped("not_connected");
    return await revokeX(tenantId, tokens, deps);
  } catch (e) {
    console.warn(`[revoke] ${platform} revoke failed for ${tenantId}: ${errName(e)}`);
    return { result: "failed", reason: "exception" };
  }
}
