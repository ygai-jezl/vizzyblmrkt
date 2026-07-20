"use client";

import { useEffect, useState } from "react";
import { signInWithPopup } from "firebase/auth";
import { getClientAuth, googleProvider } from "@/lib/auth/firebaseClient";
import {
  installSessionFetchInterceptor,
  mintSession,
  msSinceSessionMint,
  refreshSession,
  REMINT_AFTER_MS,
  SESSION_EXPIRED_EVENT,
} from "@/lib/auth/clientSession";

/** How often the proactive timer re-checks the mint age. */
const REFRESH_CHECK_MS = 10 * 60 * 1000;

/**
 * Keeps the admin session alive and recovers when it dies (the __session
 * cookie has a hard 5-day expiry; see clientSession.ts). Mounted once in the
 * admin layout. Proactively re-mints on mount / tab focus / a slow timer, and
 * installs the 401 fetch interceptor. Only when silent recovery is impossible
 * does it overlay a re-auth prompt — in place, so a canvas full of unsaved
 * work survives the sign-in and the operator can simply retry their action.
 */
export function SessionKeeper() {
  const [expired, setExpired] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    installSessionFetchInterceptor();
    const onExpired = () => setExpired(true);
    window.addEventListener(SESSION_EXPIRED_EVENT, onExpired);

    const maybeRefresh = () => {
      const age = msSinceSessionMint();
      // Unknown age (fresh browser / pre-existing login) counts as stale: an
      // extra re-mint is idempotent and stamps the age for next time.
      if (age === null || age >= REMINT_AFTER_MS) void refreshSession();
    };
    maybeRefresh();
    const onVisibility = () => {
      if (document.visibilityState === "visible") maybeRefresh();
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", maybeRefresh);
    const timer = window.setInterval(maybeRefresh, REFRESH_CHECK_MS);
    return () => {
      window.removeEventListener(SESSION_EXPIRED_EVENT, onExpired);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", maybeRefresh);
      window.clearInterval(timer);
    };
  }, []);

  async function signBackIn() {
    setBusy(true);
    setError(null);
    try {
      const cred = await signInWithPopup(getClientAuth(), googleProvider());
      const result = await mintSession(cred.user);
      if (result === "ok") {
        setExpired(false);
        setBusy(false);
        return;
      }
      setError(
        result === "forbidden"
          ? "Access denied. Sign in with your @yougrow.ai account."
          : "Sign-in failed. Please try again.",
      );
    } catch {
      setError("Sign-in failed. Please try again.");
    }
    setBusy(false);
  }

  if (!expired) return null;

  const next = encodeURIComponent(window.location.pathname + window.location.search);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-sm space-y-4 rounded-lg border border-neutral-200 bg-white p-6 shadow-xl dark:border-neutral-700 dark:bg-neutral-900">
        <div className="space-y-1">
          <h2 className="text-lg font-semibold">Your session has expired</h2>
          <p className="text-sm text-neutral-500 dark:text-neutral-400">
            Sign back in to continue — your unsaved work stays right here.
          </p>
        </div>
        <button
          onClick={signBackIn}
          disabled={busy}
          className="w-full rounded-md bg-neutral-900 px-4 py-2.5 text-sm font-medium text-white hover:bg-neutral-700 disabled:opacity-60 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
        >
          {busy ? "Signing in…" : "Sign in with Google"}
        </button>
        {error ? <p className="text-sm text-red-600">{error}</p> : null}
        <p className="text-center text-xs text-neutral-400">
          <a href={`/login?next=${next}`} className="underline hover:text-neutral-600">
            Go to the sign-in page instead
          </a>{" "}
          (unsaved changes will be lost)
        </p>
      </div>
    </div>
  );
}
