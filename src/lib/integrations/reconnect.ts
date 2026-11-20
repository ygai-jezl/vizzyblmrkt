import type { GitConnection, SocialConnection } from "@/lib/types/tenant";

/**
 * When a connection needs an admin to reconnect it, worked out at read time from what is
 * stored. Pure: the status API (src/app/api/admin/integrations/route.ts) reports it per
 * provider, and the Connections panel and the ingest hint show "This connection needs
 * reconnecting." Nothing is written to older documents, so there is no backfill.
 *
 * An uninstalled GitHub App is not part of this: Learn from repo already shows it
 * (src/components/admin/connect/GitHubRepoChooser.tsx).
 */

/** How long a GitLab access token lasts. */
export const GITLAB_ACCESS_TTL_MS = 2 * 60 * 60 * 1000;

/**
 * True when the connection is marked (a refused refresh, or the provider rejected the
 * token), or it is an older GitLab connection with no refresh token whose access token
 * has expired (connected over 2 hours ago). Never for a GitHub App.
 */
export function gitNeedsReconnect(conn: GitConnection | null | undefined, nowMs: number): boolean {
  if (!conn || conn.kind === "app") return false;
  if (conn.reconnect) return true;
  if (conn.provider !== "gitlab" || conn.refreshEnc) return false;
  const connectedMs = Date.parse(conn.connectedAt);
  return !Number.isFinite(connectedMs) || nowMs - connectedMs > GITLAB_ACCESS_TTL_MS;
}

/**
 * True when the access token has expired and there is no refresh token to renew it,
 * for example LinkedIn without a refresh token after about 60 days.
 */
export function socialNeedsReconnect(conn: SocialConnection | null | undefined, nowMs: number): boolean {
  if (!conn?.expiresAt || conn.refreshEnc) return false;
  const expMs = Date.parse(conn.expiresAt);
  return Number.isFinite(expMs) && expMs <= nowMs;
}
