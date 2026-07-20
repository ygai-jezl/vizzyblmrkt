"use client";

import type { User } from "firebase/auth";
import { getClientAuth } from "./firebaseClient";

/**
 * Browser-side session-cookie lifecycle. The server's __session cookie is a
 * Firebase session cookie with a hard 5-day expiry that cannot be extended in
 * place — the only keep-alive is re-minting a fresh cookie from the client's
 * persisted Google sign-in (IndexedDB), which survives far beyond 5 days.
 *
 * Two layers use these helpers (wired up by SessionKeeper in the admin shell):
 *  - PROACTIVE: re-mint whenever the last mint is older than REMINT_AFTER_MS,
 *    so an active operator's session slides and never hits the 5-day cliff.
 *  - REACTIVE: a fetch interceptor catches a 401 from an admin API, re-mints
 *    silently, and replays the rejected call — a stale tab self-heals without
 *    losing canvas state. Only when the silent path fails (no persisted user,
 *    allowlist removal) does the user see a re-auth prompt.
 */

/** Re-mint when the session cookie is older than this (≪ the 5-day TTL). */
export const REMINT_AFTER_MS = 12 * 60 * 60 * 1000;

/** Fired on window when a 401 could not be healed silently. */
export const SESSION_EXPIRED_EVENT = "vzb:session-expired";

const MINT_STAMP_KEY = "vzb.sessionMintedAt";

export type MintResult = "ok" | "forbidden" | "error";

/** Record a successful mint (localStorage, shared across tabs). */
export function stampSessionMinted(now = Date.now()): void {
  try {
    window.localStorage.setItem(MINT_STAMP_KEY, String(now));
  } catch {
    // Storage unavailable (SSR, private mode) — proactive refresh degrades to
    // "always stale", which is safe: re-minting is idempotent.
  }
}

/** Milliseconds since the last recorded mint, or null when unknown. */
export function msSinceSessionMint(now = Date.now()): number | null {
  try {
    const at = Number(window.localStorage.getItem(MINT_STAMP_KEY) ?? NaN);
    return Number.isFinite(at) ? Math.max(0, now - at) : null;
  } catch {
    return null;
  }
}

/**
 * Exchange the signed-in user's ID token for a fresh __session cookie,
 * handling the first-sign-in claims bootstrap (needsRefresh → force-refresh
 * the token so it carries tenant_id/region, then POST again).
 */
export async function mintSession(user: User): Promise<MintResult> {
  let r = await postIdToken(await user.getIdToken());
  if (r.needsRefresh) r = await postIdToken(await user.getIdToken(true));
  if (r.ok) {
    stampSessionMinted();
    return "ok";
  }
  return r.status === 403 ? "forbidden" : "error";
}

async function postIdToken(
  idToken: string,
): Promise<{ ok: boolean; needsRefresh: boolean; status: number }> {
  const res = await fetch("/api/auth/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ idToken }),
  });
  const body = (await res.json().catch(() => ({}))) as {
    ok?: boolean;
    needsRefresh?: boolean;
  };
  return { ok: body.ok === true, needsRefresh: body.needsRefresh === true, status: res.status };
}

let inflightRefresh: Promise<boolean> | null = null;

/**
 * Silently re-mint the session cookie from the persisted Google user.
 * Single-flight: concurrent 401s (or a 401 racing the proactive timer) share
 * one mint. Resolves false when there is no persisted user or the mint was
 * rejected — the caller decides whether to surface a re-auth prompt.
 */
export function refreshSession(): Promise<boolean> {
  inflightRefresh ??= silentRefresh().finally(() => {
    inflightRefresh = null;
  });
  return inflightRefresh;
}

async function silentRefresh(): Promise<boolean> {
  try {
    const auth = getClientAuth();
    if (!auth.currentUser) await auth.authStateReady();
    const user = auth.currentUser;
    if (!user) return false;
    return (await mintSession(user)) === "ok";
  } catch {
    return false; // missing client config / network failure — not silently healable
  }
}

/**
 * Should a 401 from this URL trigger the silent re-mint? Only same-origin API
 * calls, and never the mint endpoint itself (its 401 means "bad ID token" —
 * re-minting from it would recurse).
 */
export function shouldInterceptApi(url: string, origin: string): boolean {
  try {
    const u = new URL(url, origin);
    return (
      u.origin === origin &&
      u.pathname.startsWith("/api/") &&
      u.pathname !== "/api/auth/session"
    );
  } catch {
    return false;
  }
}

/**
 * Validate a post-login return path: internal absolute paths only, so a
 * crafted link can never bounce a fresh sign-in to another origin. /login
 * itself is rejected to avoid a redirect loop.
 */
export function safeNextPath(raw: string | null | undefined): string | null {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/login")) {
    return null;
  }
  return raw;
}

declare global {
  interface Window {
    __vzbSessionFetchInstalled?: boolean;
  }
}

/**
 * Patch window.fetch once so EVERY admin surface — ~50 components use bare
 * fetch — heals from session expiry without per-call-site changes. On a 401
 * from an admin API: re-mint silently, then replay the rejected call once.
 * The replay cannot double-apply work: admin routes authenticate before doing
 * anything, so the 401'd attempt had no effect. When the silent re-mint fails,
 * dispatch SESSION_EXPIRED_EVENT (SessionKeeper shows the re-auth prompt) and
 * return the original 401 to the caller's normal error handling.
 */
export function installSessionFetchInterceptor(): void {
  if (typeof window === "undefined" || window.__vzbSessionFetchInstalled) return;
  window.__vzbSessionFetchInstalled = true;
  const origFetch = window.fetch.bind(window);
  window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const res = await origFetch(input, init);
    if (res.status !== 401) return res;
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!shouldInterceptApi(url, window.location.origin)) return res;
    if (!(await refreshSession())) {
      window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT));
      return res;
    }
    // Request objects and stream bodies are one-shot — can't be replayed. The
    // admin codebase always calls fetch(url, init) with string/FormData bodies,
    // so in practice every call is replayable.
    if (input instanceof Request || init?.body instanceof ReadableStream) return res;
    return origFetch(input, init);
  }) as typeof window.fetch;
}
