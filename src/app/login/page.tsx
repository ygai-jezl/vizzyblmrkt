"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { signInWithPopup } from "firebase/auth";
import { getClientAuth, googleProvider } from "@/lib/auth/firebaseClient";
import { mintSession, safeNextPath } from "@/lib/auth/clientSession";

export default function LoginPage() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function signIn() {
    setBusy(true);
    setError(null);
    try {
      const cred = await signInWithPopup(getClientAuth(), googleProvider());
      const result = await mintSession(cred.user);
      if (result === "forbidden") {
        setError("Access denied. Sign in with your @yougrow.ai account.");
        setBusy(false);
        return;
      }
      if (result !== "ok") throw new Error("session");
      // Return to where the session expired (validated, internal paths only);
      // read at click time so the client page needs no useSearchParams Suspense.
      const next = safeNextPath(
        new URLSearchParams(window.location.search).get("next"),
      );
      router.push(next ?? "/admin/signups");
      router.refresh();
    } catch {
      setError("Sign-in failed. Please try again.");
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-6 px-6">
      <div className="space-y-1 text-center">
        <p className="text-sm font-medium uppercase tracking-widest text-neutral-500">
          vizzybl-marketing
        </p>
        <h1 className="text-2xl font-semibold">Admin sign in</h1>
      </div>
      <button
        onClick={signIn}
        disabled={busy}
        className="flex w-full items-center justify-center gap-3 rounded-md border border-neutral-300 px-4 py-2.5 text-sm font-medium hover:bg-neutral-50 disabled:opacity-60 dark:border-neutral-700 dark:hover:bg-neutral-900"
      >
        <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden>
          <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.71-1.57 2.68-3.89 2.68-6.62Z" />
          <path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.02-3.7H.96v2.34A9 9 0 0 0 9 18Z" />
          <path fill="#FBBC05" d="M3.98 10.72A5.4 5.4 0 0 1 3.7 9c0-.6.1-1.18.28-1.72V4.94H.96A9 9 0 0 0 0 9c0 1.45.35 2.82.96 4.06l3.02-2.34Z" />
          <path fill="#EA4335" d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58C13.47.9 11.43 0 9 0A9 9 0 0 0 .96 4.94L3.98 7.28C4.68 5.16 6.66 3.58 9 3.58Z" />
        </svg>
        {busy ? "Signing in…" : "Sign in with Google"}
      </button>
      {error ? <p className="text-center text-sm text-red-600">{error}</p> : null}
      <p className="text-center text-xs text-neutral-400">
        Restricted to your Google Workspace accounts.
      </p>
    </main>
  );
}
