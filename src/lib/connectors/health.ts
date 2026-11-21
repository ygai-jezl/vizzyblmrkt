import type { ConnectionHealth, DataConnection, HealthState } from "@/lib/types/dataConnection";
import type { ConnectorErrorCode } from "./messages";

/**
 * A connection's health, worked out from what its calls return.
 *
 * - A call that works sets ok and clears any failure count and pause.
 * - The provider turning the connection down (a refused token, an account it can't read, a token
 *   YouGrow can't open, Google ending a sign in) sets broken: it needs connecting again.
 * - A provider's rate limit pauses calls for its Retry-After (15 minutes when it gives none,
 *   between 1 and 60 minutes), and FAILURES_BEFORE_PAUSE failures in a row pause them for an hour.
 *   isRateLimited fails open (src/lib/tenant/rateLimit.ts), so this pause is the hard stop.
 * - Anything else that may pass (the provider down or slow) sets check.
 * - YouGrow's own refusals (busy, paused, an undeclared host, no vault key, no Google client, no
 *   site picked yet) change nothing.
 */

export const FAILURES_BEFORE_PAUSE = 5;
const MIN = 60_000;
const RATE_PAUSE_MS = 15 * MIN;
const FAILURE_PAUSE_MS = 60 * MIN;

const BROKEN: ReadonlySet<ConnectorErrorCode> = new Set(["token_refused", "account_refused", "secret_unopenable", "signin_refused"]);
const OURS: ReadonlySet<ConnectorErrorCode> = new Set(["busy", "paused", "host_not_allowed", "vault_unconfigured", "disconnected", "signin_unconfigured", "account_needed"]);

/** A new connection's health, after the check that let it be saved. */
export function healthyAt(now: Date): ConnectionHealth {
  const at = now.toISOString();
  return { state: "ok", lastOkAt: at, lastCheckedAt: at, lastErrorCode: null, failures: 0, pausedUntil: null };
}

/** True while no call may go out: an admin paused it, or a pause after failures hasn't ended. */
export function isCallPaused(conn: Pick<DataConnection, "pausedAt" | "health">, now: Date): boolean {
  if (conn.pausedAt) return true;
  return conn.health.pausedUntil !== null && Date.parse(conn.health.pausedUntil) > now.getTime();
}

/** The state to show: paused while calls are paused, else the last call's state. */
export function shownState(conn: Pick<DataConnection, "pausedAt" | "health" | "status">, now: Date): HealthState | "disconnected" {
  if (conn.status === "disconnected") return "disconnected";
  return isCallPaused(conn, now) ? "paused" : conn.health.state === "paused" ? "check" : conn.health.state;
}

export function healthAfterSuccess(_h: ConnectionHealth, now: Date): ConnectionHealth {
  return healthyAt(now);
}

/** True when a code is about the provider or the connection, not one of YouGrow's own refusals. */
export function countsAsFailure(code: ConnectorErrorCode): boolean {
  return !OURS.has(code);
}

/**
 * Health after a failed call, and whether calls are now paused. Null for YouGrow's own refusals,
 * which leave health alone.
 */
export function healthAfterFailure(
  h: ConnectionHealth,
  code: ConnectorErrorCode,
  now: Date,
  retryAfterSec: number | null = null,
): { health: ConnectionHealth; pausedNow: boolean } | null {
  if (!countsAsFailure(code)) return null;
  const failures = h.failures + 1;
  const base = { ...h, lastCheckedAt: now.toISOString(), lastErrorCode: code, failures };
  if (BROKEN.has(code)) return { health: { ...base, state: "broken", pausedUntil: null }, pausedNow: false };
  let pauseMs = 0;
  if (code === "rate_limited") pauseMs = retryAfterSec ? Math.min(60 * MIN, Math.max(MIN, retryAfterSec * 1000)) : RATE_PAUSE_MS;
  else if (failures >= FAILURES_BEFORE_PAUSE) pauseMs = FAILURE_PAUSE_MS;
  if (pauseMs) {
    return { health: { ...base, state: "paused", pausedUntil: new Date(now.getTime() + pauseMs).toISOString() }, pausedNow: true };
  }
  return { health: { ...base, state: "check" }, pausedNow: false };
}
