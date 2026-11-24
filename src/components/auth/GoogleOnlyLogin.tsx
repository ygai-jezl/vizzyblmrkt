"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { signInWithPopup, signOut } from "firebase/auth";
import { getClientAuth, googleProvider } from "@/lib/auth/firebaseClient";
import { accessDeniedMessage, WORKSPACE_NOT_SET_UP_MESSAGE, signInNote } from "@/lib/auth/accessDenied";
import { mintSession } from "@/lib/auth/clientSession";
import { afterSignInPath } from "@/lib/auth/passwordClient";
import { GoogleMark } from "./parts";

/**
 * The sign-in page while password sign-in is unavailable: Google only, the same page and
 * behaviour as before password sign-in existed.
 */
export function GoogleOnlyLogin() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function signIn() {
    setBusy(true);
    setError(null);
    try {
      const cred = await signInWithPopup(getClientAuth(), googleProvider());
      const result = await mintSession(cred.user);
      if (result === "forbidden" || result === "not_set_up") {
        setError(result === "forbidden" ? accessDeniedMessage() : WORKSPACE_NOT_SET_UP_MESSAGE);
        setBusy(false);
        return;
      }
      // The door removed an account it couldn't trust: drop the sign-in so the next try starts fresh.
      if (result === "sign_in_again") await signOut(getClientAuth()).catch(() => undefined);
      if (result !== "ok") throw new Error("session");
      // Return to where the session expired (validated, internal paths only);
      // read at click time so the client page needs no useSearchParams Suspense.
      router.push(afterSignInPath(window.location.search));
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
          YouGrow
        </p>
        <h1 className="text-2xl font-semibold">Admin sign in</h1>
      </div>
      <button
        onClick={signIn}
        disabled={busy}
        className="flex w-full items-center justify-center gap-3 rounded-md border border-neutral-300 px-4 py-2.5 text-sm font-medium hover:bg-neutral-50 disabled:opacity-60 dark:border-neutral-700 dark:hover:bg-neutral-900"
      >
        <GoogleMark />
        {busy ? "Signing in…" : "Sign in with Google"}
      </button>
      {error ? <p className="text-center text-sm text-red-600">{error}</p> : null}
      <p className="text-center text-xs text-neutral-400">
        {signInNote()}
      </p>
    </main>
  );
}
